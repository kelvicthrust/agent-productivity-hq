import { createHash } from 'node:crypto';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceFileRow } from '../../db/queries/ingest.ts';
import { classifyFsError, type FsFailureKind } from './errors.ts';

// Finding the files an adapter reads, and deciding what to read of each (TECH › Persistence: `source_file`, offsets, head hash).
//
//   listFiles      walk a root once, collecting the files that match, and say whether the root itself was there, readable or not
//   headHash       sha256 of the first 4 KiB a file had when it was last read: a different hash means it was replaced
//   planRead       skip, read from the stored offset (it was appended to), or read from the start (new, or replaced)
//
// A refresh that finds every file unchanged does one stat per file and no read, which is what keeps a refresh with no new data
// inside its 3-second budget (C10).

export const HEAD_BYTES = 4096;

export interface ListedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface Listing {
  /** ok: the root was read (some inside may not have been); notfound: it is not there; denied: it is there and unreadable. */
  state: 'ok' | FsFailureKind;
  /** The file system's code when the root itself could not be read. */
  code: string | null;
  files: ListedFile[];
  /** Folders and files below the root that could not be read. A listing with any of these is partial. */
  inaccessible: number;
}

const MAX_DEPTH = 12;
const STAT_BATCH = 64;

/**
 * Every file below `root` that `accept` takes (it gets the path relative to the root, with `/` separators), sorted by path.
 * Symbolic links are followed one step (a linked folder or file counts as what it points to); depth is bounded so a link back
 * up the tree cannot loop. A folder that cannot be read below the root is counted, not fatal: the rest is still returned.
 */
export async function listFiles(
  root: string,
  accept: (relativePath: string) => boolean,
): Promise<Listing> {
  const found: string[] = [];
  let inaccessible = 0;

  try {
    await readdir(root);
  } catch (error) {
    const failure = classifyFsError(error);
    return { state: failure.kind, code: failure.code, files: [], inaccessible: 0 };
  }

  async function walk(directory: string, relative: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (classifyFsError(error).kind !== 'notfound') inaccessible += 1;
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative === '' ? entry.name : `${relative}/${entry.name}`;
      let directoryLike = entry.isDirectory();
      let fileLike = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(path);
          directoryLike = target.isDirectory();
          fileLike = target.isFile();
        } catch (error) {
          if (classifyFsError(error).kind !== 'notfound') inaccessible += 1;
          continue;
        }
      }
      if (directoryLike) {
        if (depth < MAX_DEPTH) await walk(path, rel, depth + 1);
      } else if (fileLike && accept(rel)) found.push(path);
    }
  }
  await walk(root, '', 0);

  const files: ListedFile[] = [];
  for (let at = 0; at < found.length; at += STAT_BATCH) {
    const batch = found.slice(at, at + STAT_BATCH);
    const stats = await Promise.all(
      batch.map(async (path) => {
        try {
          const info = await stat(path);
          return { path, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
        } catch (error) {
          if (classifyFsError(error).kind !== 'notfound') inaccessible += 1;
          return null;
        }
      }),
    );
    for (const item of stats) if (item) files.push(item);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { state: 'ok', code: null, files, inaccessible };
}

/** One file's size and mtime, or null when it is gone. A permission error still rejects. */
export async function statFile(path: string): Promise<ListedFile | null> {
  try {
    const info = await lstat(path);
    const target = info.isSymbolicLink() ? await stat(path) : info;
    return { path, size: target.size, mtimeMs: Math.trunc(target.mtimeMs) };
  } catch (error) {
    if (classifyFsError(error).kind === 'notfound') return null;
    throw error;
  }
}

/**
 * sha256 (hex) of the first `min(size, 4096)` bytes. Pass the size the file had when it was read, so a file that has only been
 * appended to hashes the same bytes it did before (a file under 4 KiB would otherwise change hash with every append).
 */
export async function headHash(path: string, size: number): Promise<string> {
  const length = Math.min(size, HEAD_BYTES);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  } finally {
    await handle.close();
  }
}

export type ReadPlan =
  | { action: 'skip' }
  /** `appended`: the file grew, read from the stored offset. `new`/`replaced`: read from the start. */
  | { action: 'read'; from: number; why: 'new' | 'appended' | 'replaced' | 'retry' };

/**
 * What to do with a file this refresh.
 *   - never seen: read it all
 *   - unreadable last time: read it again (a permission fix does not change a file's size or mtime)
 *   - size and mtime as stored: skip, with no read at all
 *   - shorter than what was read, or the first bytes differ: it was replaced, read it all (dedupe keys keep totals exact)
 *   - otherwise it was appended to: read from the stored offset
 * `unsupported` files are skipped until they change, so a format this adapter does not read is not retried every 15 minutes.
 * The head hash (of the first bytes the stored size had) is computed only when size or mtime moved.
 */
export async function planRead(tracked: SourceFileRow | null, file: ListedFile): Promise<ReadPlan> {
  if (!tracked) return { action: 'read', from: 0, why: 'new' };
  if (tracked.state === 'unreadable') return { action: 'read', from: 0, why: 'retry' };
  if (tracked.size === file.size && tracked.mtimeMs === file.mtimeMs) return { action: 'skip' };
  if (file.size < tracked.readOffset) return { action: 'read', from: 0, why: 'replaced' };
  if ((await headHash(file.path, tracked.size)) !== tracked.headHash) {
    return { action: 'read', from: 0, why: 'replaced' };
  }
  if (tracked.state === 'unsupported') return { action: 'read', from: 0, why: 'replaced' };
  return { action: 'read', from: tracked.readOffset, why: 'appended' };
}
