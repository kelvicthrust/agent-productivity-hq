import { join, relative, sep } from 'node:path';
import type { FsFailureKind } from '../ingest/index.ts';
import {
  createOpenFiles,
  folderWithin,
  listWithin,
  readDirectoryWithin,
  statWithin,
  type ConfinedFile,
  type DirectoryHooks,
  type OpenFiles,
  type Scope,
} from './confined.ts';
import { FULL_LISTING_EVERY_MS, MAX_TRACKED_FILES, RECENT_WINDOW_MS } from './heuristics.ts';
import { liveTime } from '../../lib/liveTime.ts';

// Finding the transcript files that are being written now, cheaply (data-and-sources › Live roster (HQ) › Transcript feeds › Finding files).
//
//  - A full listing of the provider roots at most once a minute (`FULL_LISTING_EVERY_MS`): the files written in the last 15 minutes,
//    newest first, at most `MAX_TRACKED_FILES`.
//  - Between listings only what is already known is looked at: a `stat` of each followed file, and of the few folders where a new
//    session file would appear (`hotDirs`: the folders of followed files, and the provider's own). A folder is listed only when its own
//    modified time has moved (an entry was added or removed), so a folder of thousands of old transcripts costs one `stat` a tick.
//  - A file that was dropped from the set (quiet for the window) and then written again is found by the next full listing.
//  - Everything stays inside the approved roots by the one rule of `confined.ts` (`checkBelow`: no link below a root, ever; regular files
//    and folders only), applied to each followed file's stat and to each hot folder's stamp, and again to each file a folder's
//    listing names before it is followed. A folder's names are only ever read through a verified handle (`readDirectoryWithin`), in
//    the full listing and in the incremental look alike; a hot folder's stamp is only compared with the last one, never used to read.
//  - The roots lookup is given the run's signal and is awaited to its end, never raced: it checks the signal before each root and after
//    each await, so an abort ends it at the step in flight, and the feed's stop waits for exactly that step.
//  - `refresh(signal)` works out the next state in locals and assigns it only if `signal` has not aborted after the last await, so a
//    scan that is still running when the feed stops can never put anything back into this object.
// What is held (paths, sizes, times) lives only in this object; `clear()` drops it, and the feed calls it when it stops.

export interface RecentFile extends ConfinedFile {
  path: string;
  /** The root the file was found below. */
  root: string;
  /** The path below `root`, with `/` separators. */
  rel: string;
  size: number;
  mtimeMs: number;
}

export type RootsState = 'ok' | FsFailureKind;

export interface RecentSnapshot {
  /** ok: some root could be read; otherwise why none could: not there, not allowed, or failed. */
  roots: RootsState;
  /** Followed files, newest first. */
  files: readonly RecentFile[];
}

export interface RecentOptions {
  /**
   * The folders to look in. Asked at every full listing, so a changed environment is seen without a restart. It is given the look's
   * signal and must stop at the step in flight once it aborts (returning what it has, or rejecting): the look waits for it.
   */
  roots: (signal: AbortSignal) => Promise<readonly string[]> | readonly string[];
  /** Whether a path (below its root, `/` separated) is a file to follow: the provider's own rule, which also skips compressed and set-aside copies. */
  accept: (rel: string) => boolean;
  /** The folders, besides those of the followed files, where a new session file may appear now. */
  hotDirs: (
    followed: readonly RecentFile[],
    now: number,
    roots: readonly string[],
  ) => readonly string[];
  now: () => number;
  windowMs?: number;
  cap?: number;
  fullEveryMs?: number;
  /** The handles the look opens for folders (a feed passes its run's, so a stop waits for them). Default: its own. */
  files?: OpenFiles;
  /** A test seam for the stages of a folder read. Never set in production. */
  hooks?: DirectoryHooks;
}

export interface Recent {
  /** Looks again. Resolves with what is followed; if `signal` aborts first nothing is changed and the answer is to be ignored. */
  refresh(signal?: AbortSignal): Promise<RecentSnapshot>;
  clear(): void;
}

const byNewest = (a: RecentFile, b: RecentFile): number =>
  b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function createRecent(options: RecentOptions): Recent {
  const windowMs = options.windowMs ?? RECENT_WINDOW_MS;
  const cap = options.cap ?? MAX_TRACKED_FILES;
  const fullEveryMs = options.fullEveryMs ?? FULL_LISTING_EVERY_MS;
  const folders = options.files ?? createOpenFiles();

  let followed = new Map<string, RecentFile>();
  let roots: readonly string[] = [];
  /** Each root and its real path, as worked out at the last full listing. */
  let scopes = new Map<string, Scope>();
  let rootsState: RootsState = 'notfound';
  let lastFull: number | null = null;
  /**
   * The modified time each hot folder had when it was last looked at (null: not there). Adding or removing an entry changes a folder's
   * time, appending to a file does not, so a folder whose time has not moved has no new file and is not listed again: a Claude Code
   * project folder can hold thousands of old transcripts, and none of them is looked at again between full listings.
   */
  let dirStamps = new Map<string, number | null>();

  const rootOf = (dir: string, among: readonly string[]): string | undefined =>
    among.find((candidate) => dir === candidate || dir.startsWith(candidate + sep));

  /**
   * A file written within the window. A file with a time a little ahead of the clock counts as recent; one whose time is not a time
   * HQ keeps (`liveTime`: before 2000, or more than a day ahead) never does, so it cannot stay on top of the newest-first order.
   */
  const recent = (mtimeMs: number, now: number): boolean => {
    const valid = liveTime(mtimeMs, now);
    return valid !== null && now - valid <= windowMs;
  };

  const trimmed = (files: Map<string, RecentFile>): Map<string, RecentFile> =>
    files.size <= cap
      ? files
      : new Map(
          [...files.values()]
            .sort(byNewest)
            .slice(0, cap)
            .map((file) => [file.path, file]),
        );

  /** A hot folder's modified time; null when it is not there or the rule refuses it. */
  const probe = async (
    dir: string,
    among: readonly string[],
    scopeOf: ReadonlyMap<string, Scope>,
  ): Promise<{ mtimeMs: number } | null> => {
    const root = rootOf(dir, among);
    const scope = root === undefined ? undefined : scopeOf.get(root);
    return scope === undefined ? null : folderWithin(scope, dir);
  };

  /** Returns false when `signal` aborted (and nothing was changed). */
  async function full(now: number, signal: AbortSignal): Promise<boolean> {
    let nextRoots: string[];
    try {
      // Awaited to its end: it is given the signal and ends at the step in flight, so nothing it does outlives the stop that waits for it.
      nextRoots = [...(await options.roots(signal))];
    } catch (error) {
      if (signal.aborted) return false;
      throw error;
    }
    if (signal.aborted) return false;
    const next = new Map<string, RecentFile>();
    const nextScopes = new Map<string, Scope>();
    let denied = false;
    let failed = false;
    let readable = false;
    for (const root of nextRoots) {
      if (signal.aborted) return false;
      const listing = await listWithin(root, options.accept, signal, folders, options.hooks);
      if (signal.aborted) return false;
      if (listing.state === 'ok' && listing.realRoot !== null) {
        readable = true;
        nextScopes.set(root, { root, realRoot: listing.realRoot });
        for (const file of listing.files) {
          if (!recent(file.mtimeMs, now)) continue;
          const rel = relative(root, file.path).split(sep).join('/');
          next.set(file.path, { ...file, root, rel });
        }
      } else if (listing.state === 'denied') denied = true;
      else if (listing.state === 'failed') failed = true;
    }
    const nextFollowed = trimmed(next);
    // The listing has seen everything in the folders where a new file would appear: what they look like now is the baseline.
    const nextStamps = new Map<string, number | null>();
    for (const dir of new Set(options.hotDirs([...nextFollowed.values()], now, nextRoots))) {
      const seen = await probe(dir, nextRoots, nextScopes);
      if (signal.aborted) return false;
      nextStamps.set(dir, seen?.mtimeMs ?? null);
    }
    roots = nextRoots;
    scopes = nextScopes;
    rootsState = readable ? 'ok' : failed ? 'failed' : denied ? 'denied' : 'notfound';
    followed = nextFollowed;
    dirStamps = nextStamps;
    lastFull = now;
    return true;
  }

  /** Returns false when `signal` aborted (and nothing was changed). */
  async function light(now: number, signal: AbortSignal): Promise<boolean> {
    const next = new Map(followed);
    for (const file of [...followed.values()]) {
      if (signal.aborted) return false;
      try {
        const info = await statWithin(file.guard, file.path);
        if (info === null || !recent(info.mtimeMs, now)) next.delete(file.path);
        else next.set(file.path, { ...file, ...info });
      } catch {
        // A file that cannot be looked at (a permission change mid-run) is not followed until the next full listing.
        next.delete(file.path);
      }
    }
    if (signal.aborted) return false;
    const hot = new Set(options.hotDirs([...next.values()], now, roots));
    const nextStamps = new Map(dirStamps);
    for (const dir of nextStamps.keys()) if (!hot.has(dir)) nextStamps.delete(dir);
    for (const dir of hot) {
      const root = rootOf(dir, roots);
      if (root === undefined) continue;
      const seen = await probe(dir, roots, scopes);
      if (signal.aborted) return false;
      const stamp = seen?.mtimeMs ?? null;
      if (nextStamps.has(dir) && nextStamps.get(dir) === stamp) continue;
      nextStamps.set(dir, stamp);
      const scope = scopes.get(root);
      if (seen === null || scope === undefined) continue;
      let entries;
      try {
        entries = await readDirectoryWithin(scope, dir, folders, options.hooks, signal);
      } catch {
        if (signal.aborted) return false;
        continue; // gone, refused or not allowed: the next full listing says which
      }
      for (const entry of entries) {
        if (signal.aborted) return false;
        if (entry.kind !== 'file') continue; // a link is not followed (an entry is an `lstat`, never what a link points to)
        const path = join(dir, entry.name);
        if (next.has(path)) continue;
        const rel = relative(root, path).split(sep).join('/');
        if (!options.accept(rel)) continue;
        try {
          const info = await statWithin(scope, path);
          if (info !== null && recent(info.mtimeMs, now))
            next.set(path, { path, ...info, root, rel });
        } catch {
          // Skipped until the next full listing.
        }
      }
    }
    if (signal.aborted) return false;
    followed = trimmed(next);
    dirStamps = nextStamps;
    return true;
  }

  return {
    async refresh(signal = new AbortController().signal) {
      const now = options.now();
      if (lastFull === null || now - lastFull >= fullEveryMs) await full(now, signal);
      else await light(now, signal);
      return { roots: rootsState, files: [...followed.values()].sort(byNewest) };
    },
    clear() {
      followed = new Map();
      roots = [];
      scopes = new Map();
      rootsState = 'notfound';
      lastFull = null;
      dirStamps = new Map();
    },
  };
}
