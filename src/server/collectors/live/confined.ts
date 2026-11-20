import { constants, createReadStream, type Dirent, type ReadStream, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { abortError } from '../../lib/abortable.ts';
import { classifyFsError, type FsFailureKind, type ListedFile } from '../ingest/index.ts';

// Keeping HQ's transcript reads inside the approved provider roots (data-and-sources › Live roster (HQ) › Transcript feeds › Roots,
// files, reading › Containment). The batch importers follow symbolic links, which is fine for a one-off import the owner started; HQ
// reads on a timer for whoever opens the page, so its own rule is stricter and lives here, not in the shared walker.
//
// THE RULE: below a provider root no path component may be a symbolic link, ever. A path P under the root R is acceptable only when
//   realpath(P) is exactly join(realpath(R), relative(R, P))   (which proves that no component below R is a link), and
//   lstat(P) says a regular file (for a file) or a directory (for a folder).
// `checkBelow` is that rule and the only place it is written; the full listing (each folder before it is read, each file before it is
// accepted), the incremental look (each hot folder, each followed file) and the open (`openWithin`) all call it, so they cannot
// diverge. The root itself may be a link: it is the owner's approved location, and its real path is worked out once per listing.
//
// FOLDERS are read through a verified handle (`readDirectoryWithin`): the rule is checked, the folder itself is opened with
// O_DIRECTORY | O_NOFOLLOW, the handle's `fstat` must be that directory (the device and inode of the check's `lstat`), and then the names
// are read THROUGH the handle where the platform allows (`/proc/self/fd/<fd>` on Linux), so a swap of the path or of an ancestor after
// the check cannot redirect the read. Where the platform cannot (macOS refuses a directory by `/dev/fd/<fd>`), the names are read by path
// while the handle is held and DISCARDED unless the path is still the verified directory afterwards (see `enumerationMode`).
//
// The rest is what makes the rule hold at the moment of reading: a file is opened by its ORIGINAL path with O_NOFOLLOW (and
// O_NONBLOCK, so a FIFO cannot hold the loop), the opened handle must be a regular file with the same device and inode as the `lstat`
// of the check just made, and must be the file that was listed; everything is then read through that handle, never by path again.
// `createOpenFiles` owns the handles a feed opens, so a stop can close them all and wait for the closes.
// Errors are the file system's own (or carry a plain code) and no text: nothing here logs.

/** A provider root as configured, and its real path. */
export interface Scope {
  root: string;
  realRoot: string;
}

export interface Guard extends Scope {
  /** The file's identity when it was listed. */
  dev: number;
  ino: number;
}

/** A listed file with what is needed to open it safely. */
export interface ConfinedFile extends ListedFile {
  guard: Guard;
}

export interface ConfinedListing {
  state: 'ok' | FsFailureKind;
  realRoot: string | null;
  files: ConfinedFile[];
}

const MAX_DEPTH = 12;
const STAT_BATCH = 64;

const refusal = (code: string): Error => Object.assign(new Error('refused'), { code });

export type Checked =
  | { kind: 'ok'; info: Stats }
  /** Not there (any more): a path that was, or a link whose target is not. */
  | { kind: 'gone' }
  /** There, and not acceptable: a link anywhere below the root, outside the root, or not the wanted kind. */
  | { kind: 'refused' };

const GONE: Checked = { kind: 'gone' };
const REFUSED: Checked = { kind: 'refused' };

/** What a failed call on a path means: gone, refused (a link loop, a name too long) or a real failure, which is rethrown. */
function verdictOf(error: unknown): Checked {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ELOOP' || code === 'ENAMETOOLONG') return REFUSED;
  if (classifyFsError(error).kind === 'notfound') return GONE;
  throw error;
}

/**
 * THE RULE (see the top of this file) for one path. A path that is not below `scope.root` is refused. Never follows a link, never
 * throws for a dangling link or a path that went away; any other failure (a permission error) rejects with the file system's error.
 */
export async function checkBelow(
  scope: Scope,
  path: string,
  want: 'file' | 'directory',
): Promise<Checked> {
  const rel = relative(scope.root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return REFUSED;
  const expected = rel === '' ? scope.realRoot : join(scope.realRoot, rel);
  try {
    if ((await realpath(path)) !== expected) return REFUSED;
    const info = await lstat(path); // lstat: a link is a link here, never what it points to
    return (want === 'file' ? info.isFile() : info.isDirectory()) ? { kind: 'ok', info } : REFUSED;
  } catch (error) {
    const verdict = verdictOf(error);
    if (verdict.kind !== 'gone') return verdict;
    // `realpath` fails the same way for a path that is not there and for a link whose target is not: only the first is gone.
    return (await lstat(path).then(
      () => true,
      () => false,
    ))
      ? REFUSED
      : GONE;
  }
}

/** Test seam: what a test does at exactly one stage of a folder read (to swap a path between two steps). Never set in production. */
export interface DirectoryHooks {
  /** After the rule's check, before the folder is opened. */
  beforeOpen?: (path: string) => void | Promise<void>;
  /** After the handle was verified, before the names are read. */
  beforeRead?: (path: string) => void | Promise<void>;
  /** After the names were read, before the path is checked again (only the by-path mode checks again). */
  afterRead?: (path: string) => void | Promise<void>;
  /** Forces how the names are read; the default is what `enumerationMode` found for this platform. */
  mode?: EnumerationMode;
}

/** How a folder's names are read: through the verified handle's descriptor path, or by path with the identity checked again afterwards. */
export type EnumerationMode = 'descriptor' | 'recheck';

/** One name in a folder and what its directory entry says it is (an `lstat`: a link is a link, never what it points to). */
export interface DirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'link' | 'other';
}

const kindOf = (entry: Dirent): DirectoryEntry['kind'] =>
  entry.isSymbolicLink()
    ? 'link'
    : entry.isDirectory()
      ? 'directory'
      : entry.isFile()
        ? 'file'
        : 'other';

const DIRECTORY_FLAGS =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** The path through which an open descriptor can be read as a folder on this platform, or null where there is none. */
const descriptorPath = (fd: number): string | null =>
  process.platform === 'linux'
    ? `/proc/self/fd/${fd}`
    : process.platform === 'win32'
      ? null
      : `/dev/fd/${fd}`;

let foundMode: EnumerationMode | null = null;

/**
 * Whether this platform lets a folder be read THROUGH an open handle: a handle is opened on a known folder (this program's own) and its
 * names are read by the descriptor path and by the path; the descriptor path is used only when both give the same, non-empty names.
 * Linux does (`/proc/self/fd/<fd>` is the open directory itself, whatever the path now points to). macOS does not: it answers `ENOTDIR` to
 * a directory at `/dev/fd/<fd>`, so it reads `recheck`. The answer is worked out once per process, by the first folder read, with that read's
 * own handles (so a stop waits for them and closes them); a probe that ends in an error or an abort is not remembered.
 */
export async function enumerationMode(files: OpenFiles): Promise<EnumerationMode> {
  if (foundMode !== null) return foundMode;
  const folder = import.meta.dirname;
  let found: EnumerationMode = 'recheck';
  if (typeof folder === 'string') {
    const opened = await files.openDirectory(folder);
    try {
      const through = descriptorPath(opened.handle.fd);
      if (through !== null) {
        const viaDescriptor = await readdir(through).then(
          (names) => names.sort(),
          () => null,
        );
        const viaPath = (await readdir(folder)).sort();
        if (
          viaDescriptor !== null &&
          viaDescriptor.length > 0 &&
          viaDescriptor.length === viaPath.length &&
          viaDescriptor.every((name, at) => name === viaPath[at])
        )
          found = 'descriptor';
      }
    } finally {
      await opened.close();
    }
  }
  foundMode = found;
  return found;
}

/**
 * The names in `path` (a folder below `scope.root`, or the real root itself with a scope whose root is that real path), read through a
 * handle whose identity has been verified, so that a swap of the path or of any ancestor between the check and the read cannot redirect
 * the read to another folder:
 *   1. THE RULE (`checkBelow`) on the path; its `lstat` gives the folder's device and inode.
 *   2. The folder itself is opened (`O_DIRECTORY | O_NOFOLLOW`, so a link in the last place is refused, and a link in an ancestor opens
 *      another folder) and the handle's `fstat` must be a directory with that device and inode, else the open is refused (`ESTALE`).
 *   3. The names are read through the handle (`descriptor` mode), or by path with the handle held (`recheck` mode), after which the path
 *      is checked again: it must still be this folder (rule, and the device and inode of the held handle), else the names are discarded
 *      (`ESTALE`). The by-path read can in that case have listed another folder's names, which never leave this function.
 *   4. The handle is closed, whatever happened. It is tracked by `files`, so a stop waits for it.
 * Rejects with the file system's error, `ENOENT` (not there), `EACCES` (refused by the rule) or `ESTALE` (not the folder that was checked),
 * or an AbortError once `files` is closed. The names are never used as paths without the rule being applied to each of them.
 */
export async function readDirectoryWithin(
  scope: Scope,
  path: string,
  files: OpenFiles,
  hooks: DirectoryHooks = {},
  signal?: AbortSignal,
): Promise<DirectoryEntry[]> {
  // Once the caller is stopping, no further file system call is started: the step in flight is the last.
  const unlessStopped = (): void => {
    if (signal?.aborted) throw abortError();
  };
  unlessStopped();
  const mode = hooks.mode ?? (await enumerationMode(files));
  unlessStopped();
  const checked = await checkBelow(scope, path, 'directory');
  if (checked.kind === 'gone') throw refusal('ENOENT');
  if (checked.kind === 'refused') throw refusal('EACCES');
  await hooks.beforeOpen?.(path);
  unlessStopped();
  const opened = await files.openDirectory(path, checked.info);
  try {
    await hooks.beforeRead?.(path);
    unlessStopped();
    const through = mode === 'descriptor' ? descriptorPath(opened.handle.fd) : null;
    const entries = await readdir(through ?? path, { withFileTypes: true });
    unlessStopped();
    if (through === null) {
      await hooks.afterRead?.(path);
      const again = await checkBelow(scope, path, 'directory');
      const held = await opened.handle.stat();
      if (
        again.kind !== 'ok' ||
        !held.isDirectory() ||
        again.info.dev !== held.dev ||
        again.info.ino !== held.ino
      )
        throw refusal('ESTALE');
    }
    return entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
  } finally {
    await opened.close();
  }
}

/**
 * Every regular file below `root` that `accept` takes (it gets the path relative to the root, `/` separated), sorted by path. The root's
 * real path is worked out once; each folder is read through a verified handle (`readDirectoryWithin`, which checks the rule first) and
 * each file is checked (`checkBelow`) before it is accepted; a link is never followed, and an entry that is a link is skipped without
 * being resolved. A folder that cannot be read is skipped. Stops at the next folder or file once `signal` aborts (the result is then
 * partial and not to be used). `files` tracks the folder handles (a feed passes its own, so a stop waits for them).
 */
export async function listWithin(
  root: string,
  accept: (relativePath: string) => boolean,
  signal: AbortSignal,
  files: OpenFiles = createOpenFiles(),
  hooks?: DirectoryHooks,
): Promise<ConfinedListing> {
  let realRoot: string;
  let rootEntries: DirectoryEntry[];
  try {
    if (signal.aborted) throw abortError();
    realRoot = await realpath(root);
    // A stop that arrived during that lookup ends the listing here: nothing more is asked of the file system.
    if (signal.aborted) throw abortError();
    // The root may be a link (its real path has none): it is read as the folder at its real path.
    rootEntries = await readDirectoryWithin(
      { root: realRoot, realRoot },
      realRoot,
      files,
      hooks,
      signal,
    );
  } catch (error) {
    return { state: classifyFsError(error).kind, realRoot: null, files: [] };
  }
  const scope: Scope = { root, realRoot };

  const found: string[] = [];
  async function walk(
    directory: string,
    rel: string,
    depth: number,
    known?: DirectoryEntry[],
  ): Promise<void> {
    if (signal.aborted) return;
    let entries: DirectoryEntry[];
    try {
      entries = known ?? (await readDirectoryWithin(scope, directory, files, hooks, signal));
    } catch {
      return; // gone, refused or not allowed: the files below are not followed until a later listing
    }
    for (const entry of entries) {
      if (signal.aborted) return;
      if (entry.kind === 'link') continue;
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.kind === 'directory') {
        if (depth < MAX_DEPTH) await walk(join(directory, entry.name), entryRel, depth + 1);
      } else if (entry.kind === 'file' && accept(entryRel)) found.push(join(directory, entry.name));
    }
  }
  await walk(root, '', 0, rootEntries);

  const checkedFiles: ConfinedFile[] = [];
  for (let at = 0; at < found.length; at += STAT_BATCH) {
    if (signal.aborted) break;
    const checked = await Promise.all(
      found.slice(at, at + STAT_BATCH).map(async (path) => {
        try {
          const result = await checkBelow(scope, path, 'file');
          if (result.kind !== 'ok') return null;
          return {
            path,
            size: result.info.size,
            mtimeMs: Math.trunc(result.info.mtimeMs),
            guard: { ...scope, dev: result.info.dev, ino: result.info.ino },
          };
        } catch {
          return null;
        }
      }),
    );
    for (const item of checked) if (item) checkedFiles.push(item);
  }
  checkedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { state: 'ok', realRoot, files: checkedFiles };
}

/**
 * A file's size, time and identity, or null when it is gone or the rule refuses it (a link anywhere below the root, not a regular
 * file, not below the root). A permission error still rejects.
 */
export async function statWithin(
  scope: Scope,
  path: string,
): Promise<{ size: number; mtimeMs: number; guard: Guard } | null> {
  const checked = await checkBelow(scope, path, 'file');
  if (checked.kind !== 'ok') return null;
  return {
    size: checked.info.size,
    mtimeMs: Math.trunc(checked.info.mtimeMs),
    guard: { ...scope, dev: checked.info.dev, ino: checked.info.ino },
  };
}

/** A folder's modified time, or null when it is not there or the rule refuses it. */
export async function folderWithin(
  scope: Scope,
  path: string,
): Promise<{ mtimeMs: number } | null> {
  try {
    const checked = await checkBelow(scope, path, 'directory');
    return checked.kind === 'ok' ? { mtimeMs: checked.info.mtimeMs } : null;
  } catch {
    return null; // not allowed: a change shows when it is
  }
}

/**
 * Opens `file` for reading, safely. With a guard: the rule is checked first, then the ORIGINAL path is opened with `O_NOFOLLOW`, and the
 * handle must be a regular file with the identity of the `lstat` the check made and of the listing. Without a guard (a test's own folder)
 * only the regular-file rule applies. Rejects with the file system's error, `ENOENT` (not there), `EACCES` (refused by the rule, or not
 * a regular file) or `ESTALE` (not the file that was checked or listed): none of them says where the file is. The caller closes the handle.
 */
export async function openWithin(file: {
  path: string;
  guard?: Guard | undefined;
}): Promise<FileHandle> {
  const guard = file.guard;
  let checked: Stats | null = null;
  if (guard !== undefined) {
    const result = await checkBelow(guard, file.path, 'file');
    if (result.kind === 'gone') throw refusal('ENOENT');
    if (result.kind === 'refused') throw refusal('EACCES');
    checked = result.info;
  }
  // O_NONBLOCK: opening a FIFO for reading would wait for a writer; it is refused below instead.
  const handle = await open(
    file.path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw refusal('EACCES');
    if (checked !== null && (info.dev !== checked.dev || info.ino !== checked.ino))
      throw refusal('ESTALE');
    if (guard !== undefined && (info.dev !== guard.dev || info.ino !== guard.ino))
      throw refusal('ESTALE');
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** A file or folder opened through `OpenFiles`; `close()` closes it and forgets it, and may be called more than once. */
export interface OpenedFile {
  handle: FileHandle;
  close(): Promise<void>;
}

/** The file and folder handles one feed run has opened: what a stop closes, and waits for. */
export interface OpenFiles {
  /** `openWithin`, tracked. Rejects with an AbortError once `closeAll()` has been called (and closes a file that was being opened). */
  open(file: { path: string; guard?: Guard | undefined }): Promise<OpenedFile>;
  /**
   * Opens a folder itself (`O_DIRECTORY | O_NOFOLLOW`), tracked like `open`. With `identity` (the `lstat` of the rule's check) the handle's
   * `fstat` must be a directory with that device and inode (`ESTALE` otherwise, `EACCES` for not a directory); the handle is closed
   * whenever it is refused, whatever fails after the open.
   */
  openDirectory(path: string, identity?: { dev: number; ino: number }): Promise<OpenedFile>;
  /** Refuses further opens, waits for the opens in flight, then closes every handle that is open and waits for the closes. */
  closeAll(): Promise<void>;
  /** Handles open now, and opens in flight. */
  count(): number;
}

async function openFolder(
  path: string,
  identity: { dev: number; ino: number } | undefined,
): Promise<FileHandle> {
  const handle = await open(path, DIRECTORY_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw refusal('EACCES');
    if (identity !== undefined && (info.dev !== identity.dev || info.ino !== identity.ino))
      throw refusal('ESTALE');
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function createOpenFiles(): OpenFiles {
  const handles = new Set<FileHandle>();
  const opening = new Set<Promise<void>>();
  let closed = false;

  const release = async (handle: FileHandle): Promise<void> => {
    handles.delete(handle);
    await handle.close().catch(() => undefined);
  };

  const track = (opener: () => Promise<FileHandle>): Promise<OpenedFile> => {
    if (closed) return Promise.reject(abortError());
    const run = (async (): Promise<OpenedFile> => {
      const handle = await opener();
      if (closed) {
        await handle.close().catch(() => undefined);
        throw abortError();
      }
      handles.add(handle);
      return { handle, close: () => release(handle) };
    })();
    // The in-flight open is tracked until it has finished, closing included, whatever its outcome.
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    opening.add(done);
    void done.then(() => opening.delete(done));
    return run;
  };

  return {
    open: (file) => track(() => openWithin(file)),
    openDirectory: (path, identity) => track(() => openFolder(path, identity)),
    async closeAll() {
      closed = true;
      while (opening.size > 0) await Promise.all([...opening]);
      await Promise.all([...handles].map(release));
    },
    count: () => handles.size + opening.size,
  };
}

/**
 * A read stream over an opened handle that is destroyed with an AbortError when `signal` aborts (the stream's own `signal` option leaves
 * an unhandled error behind when a handle is given). The handle is not closed by the stream; the caller closes it. Call `release()`
 * once the stream is finished with. Throws an AbortError at once when `signal` has already aborted.
 */
export function streamOf(
  handle: FileHandle,
  range: { start: number; end: number; highWaterMark?: number },
  signal: AbortSignal,
): { stream: ReadStream; release: () => void } {
  if (signal.aborted) throw abortError();
  const stream = createReadStream('', { fd: handle, autoClose: false, ...range });
  const onAbort = () => stream.destroy(abortError());
  signal.addEventListener('abort', onAbort, { once: true });
  return { stream, release: () => signal.removeEventListener('abort', onAbort) };
}
