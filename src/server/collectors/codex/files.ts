import { basename, join, relative } from 'node:path';
import { listFiles, type FsFailureKind, type ListedFile } from '../ingest/index.ts';

// Which rollout files of a Codex home are read (data-and-sources › Codex local rollouts › Files). A home holds `sessions/`
// (active, in date folders) and `archived_sessions/`, and a rollout can be there twice: as `.jsonl` and as its `.jsonl.zst`
// twin, or in both folders. Precedence decides which copy is READ; the dedupe keys still protect a copy precedence misses.
//
//   - a plain `.jsonl` beats its `.zst` twin (same folder, same name)
//   - a file in `sessions/` beats `archived_sessions/` for the same rollout. Same relative path is the rule; Codex may also move
//     an archive out of its date folder, so the rollout's file name (its timestamp and thread id) is what is compared across the
//     two folders. A rollout is never dropped for matching another inside the same folder.
//   - precedence applies inside one home; two homes are two machines' worth of history and the keys settle any overlap.

export interface RolloutFile extends ListedFile {
  compressed: boolean;
}

export type RootOutcome =
  | { outcome: 'files'; files: RolloutFile[]; location: string; inaccessible: number }
  | { outcome: 'notfound' }
  | { outcome: Exclude<FsFailureKind, 'notfound'>; location: string; code: string };

const FOLDERS = ['sessions', 'archived_sessions'] as const;
const EXTENSION = /\.jsonl(\.zst)?$/;

const accept = (relativePath: string): boolean => EXTENSION.test(relativePath);
const withoutExtension = (path: string): string => path.replace(EXTENSION, '');
const nameOf = (path: string): string => withoutExtension(basename(path));

/** Plain over compressed, for twins at the same relative path inside one folder. Input and output are in path order. */
function plainBeatsCompressed(root: string, files: ListedFile[]): RolloutFile[] {
  const chosen = new Map<string, RolloutFile>();
  for (const file of files) {
    const key = withoutExtension(relative(root, file.path));
    const compressed = file.path.endsWith('.zst');
    const held = chosen.get(key);
    if (!held || (held.compressed && !compressed)) chosen.set(key, { ...file, compressed });
  }
  return [...chosen.values()];
}

/**
 * Looks in every folder of every home. Some folder readable: the files to read (precedence applied) and how many places could
 * not be read; none readable: why. A folder that does not exist is not a failure, a Codex that has never run has none.
 */
export async function findRollouts(homes: readonly string[]): Promise<RootOutcome> {
  const found = new Map<string, RolloutFile>();
  let location: string | null = null;
  let inaccessible = 0;
  const unreadable: { kind: Exclude<FsFailureKind, 'notfound'>; path: string; code: string }[] = [];

  for (const home of new Set(homes)) {
    const folders: RolloutFile[][] = [];
    for (const folder of FOLDERS) {
      const root = join(home, folder);
      const listing = await listFiles(root, accept);
      if (listing.state === 'ok') {
        location ??= root;
        inaccessible += listing.inaccessible;
        folders.push(plainBeatsCompressed(root, listing.files));
      } else {
        folders.push([]);
        if (listing.state !== 'notfound')
          unreadable.push({ kind: listing.state, path: root, code: listing.code ?? 'unknown' });
      }
    }
    const [active = [], archived = []] = folders;
    const activeNames = new Set(active.map((file) => nameOf(file.path)));
    for (const file of [...active, ...archived.filter((f) => !activeNames.has(nameOf(f.path)))])
      found.set(file.path, file);
  }

  if (location !== null) {
    // Some folder read and another not: carry on, and say so (the result is partial).
    const files = [...found.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    return { outcome: 'files', files, location, inaccessible: inaccessible + unreadable.length };
  }
  const failed = unreadable.find((u) => u.kind === 'failed');
  const first = failed ?? unreadable[0];
  if (!first) return { outcome: 'notfound' };
  return { outcome: failed ? 'failed' : 'denied', location: first.path, code: first.code };
}

const THREAD_ID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

/** The thread id a rollout's file name ends with (`rollout-<time>-<id>.jsonl`), or null. A hint for ordering reads, never an identity. */
export function threadIdFromName(path: string): string | null {
  return path.match(THREAD_ID)?.[1]?.toLowerCase() ?? null;
}
