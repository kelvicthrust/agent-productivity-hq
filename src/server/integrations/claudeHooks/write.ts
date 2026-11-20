import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { FILE_MODE } from '../../lib/fsModes.ts';
import { settingsTarget } from '../claudeCapture/settings.ts';
import { ClaudeHooksError, type LeftBehind } from './errors.ts';
import {
  O_NOFOLLOW,
  O_NONBLOCK,
  codeOf,
  isInstalled,
  linkNew,
  readOpen,
  removeIfMade,
  renameOver,
  sealForRename,
  stageTemp,
  unlinkName,
  type Made,
} from './fsguard.ts';
import { MAX_SETTINGS_BYTES, parseSettings } from './settings.ts';
import { sweepStaleTemps } from './stale.ts';

// The guarded read-modify-write of the user's settings files, as ONE transaction over every file a change targets. The rules, in the
// order they act:
//   - A settings path is resolved once per attempt. A settings file that is a symlink (a dotfiles setup) is the one link followed: the
//     temp file is made beside the TARGET and renamed over the target, so the link stays a link. The target is resolved again at the
//     last moment before the rename and must be the same file it was staged for.
//   - What is read is what the change is computed from. A file that cannot be understood (not UTF-8, not JSON, not an object) is
//     refused with a fixed code, never treated as empty. The text written is always the file's own text with HQ's entries edited in
//     (splice.ts); nothing here prints a settings file from a parsed copy. (That the text read back through HQ's own reader, on every
//     limit it reads by, is checked where the text is made: edit.ts.)
//   - Distinct files. The settings target, its backup, every temp file and HQ's own files (and folder) are all different files: the
//     resolved paths AND device and inode are compared, so a link, a hard link, `..` or a case-insensitive name cannot make two of
//     them one. Two targeted settings paths that resolve to one file are one target (refused here when handed in twice), and a
//     backup that is the settings file, a link or hard link to it or to an HQ file, or inside HQ's folder, refuses the change
//     (`not_writable`) before anything is written.
//   - A file HQ may replace is one that belongs to the current user, that its owner can write (owner write bit and access), in a
//     folder that can be written. At every observation (the read, the staging, the last compare, a rollback) that is checked again;
//     a file that is not (the owner made it read-only, or took it away) is left alone with `not_writable`.
//   - Everything is staged before anything is replaced: for every file that changes, its new content AND its old content (for a
//     rollback) are written to temp files beside it (exclusive create, owner-only, each removed again on every path, but only while it
//     is still exactly what HQ wrote), and the one-time backup is PROVEN (see `backUp`). Only then are the files replaced, one after
//     the other.
//   - A staged file is never trusted because it was staged. Immediately before every rename (the update, the rollback copy) it is
//     sealed (fsguard.ts `sealForRename`): the same file HQ created (device, inode, one name, a regular file, still owner-only), its
//     bytes read back equal to the bytes HQ computed, and only then given the observed file's whole permission word (setuid, setgid
//     and sticky included; a bit the platform will not keep refuses the change). One that fails is not renamed: an update that fails
//     refuses the change; a rollback copy that fails is replaced by a fresh one written from the original bytes HQ holds in memory.
//     After the rename the file in place is looked at once more: it must be that file, those bytes, that mode.
//   - The compare-and-swap is the last thing before each replace: the file is observed again and must be the very file that was read:
//     its target, bytes, device, inode, size, modification time, mode, owner and group, and the folder it is in (device and inode).
//     If it is not, nothing is overwritten: what was replaced already is put back, and the attempt starts over from a fresh read, a
//     bounded number of times.
//   - If a replace fails after others succeeded, the files already replaced are put back (each only if it is still exactly what HQ
//     wrote, can still be written, and each read back to verify). A file that could not be put back is reported by name
//     (`rollback_failed`) and the backup is kept. The result is all files changed or none, or that report.
//   - Anything HQ made that could not be taken back, because the owner changed it meanwhile or it could not be removed, is left as it
//     is and named in the error (`left`), never silently.
//   A change made by someone else in the few microseconds between the last look at a staged file or the compare and the rename cannot
//   be detected without a lock the other program would have to take too; the window is that small and no other, and the look after
//   the rename names a file that is not what HQ meant (`rollback_failed`).

const DEFAULT_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 25;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A step of a change, for tests that act as the owner saving at exactly that moment. */
export type Step =
  | 'staged'
  | 'before_backup'
  | 'after_backup'
  | 'before_commit'
  /** The staged file is sealed (and has its final mode); the destination has not been looked at yet. */
  | 'sealed'
  /** The destination was observed and is what the change was computed from; the rename is the very next thing. */
  | 'observed'
  | 'after_commit'
  /** The same two moments for the copy a rollback renames back. */
  | 'restore_sealed'
  | 'restore_observed';

interface Identity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
  uid: number;
  gid: number;
}

interface Observed {
  target: string;
  bytes: Buffer | null;
  identity: Identity | null;
  /** The folder the file is in (or would be created in). */
  folder: { dev: number; ino: number };
  /** Whether HQ may replace (or create) this file now; see the rules above. */
  writable: boolean;
  /** How many names (hard links) the file has; 0 for a file that does not exist. */
  links: number;
  /** An open handle on the very file that was read, when the observation was asked to keep one (see `observe`); the caller closes it. */
  held: number | null;
}

const identityOf = (stat: Stats): Identity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  mode: stat.mode & 0o7777,
  uid: stat.uid,
  gid: stat.gid,
});
const sameIdentity = (a: Identity | null, b: Identity | null): boolean =>
  a === null || b === null
    ? a === b
    : a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.mode === b.mode &&
      a.uid === b.uid &&
      a.gid === b.gid;
const same = (a: Buffer | null, b: Buffer | null): boolean =>
  a === null || b === null ? a === b : a.equals(b);
export const digestOf = (bytes: Buffer | null): string =>
  bytes === null ? 'missing' : createHash('sha256').update(bytes).digest('hex');

const accessible = (path: string, mode: number): boolean => {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};

const statOrNull = (path: string): Stats | null => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};
const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/**
 * Whether `path` is the file `guard` names or is inside the folder it names: by path, and by device and inode (a hard link, a symlink,
 * `..` and a case-insensitive name all end in the same device and inode). A guard that does not exist guards nothing but its own path.
 */
export function coincides(path: string, guard: string): boolean {
  if (path === guard) return true;
  const other = statOrNull(guard);
  if (other === null) return false;
  if (!other.isDirectory()) {
    const mine = statOrNull(path);
    return mine !== null && mine.dev === other.dev && mine.ino === other.ino;
  }
  for (let at = path; ; at = dirname(at)) {
    const here = statOrNull(at);
    if (here !== null && here.dev === other.dev && here.ino === other.ino) return true;
    if (dirname(at) === at) return false;
  }
}

/**
 * A key that is the same for two paths that are one directory entry and different for any other: the folder the resolved file is in
 * (device and inode) and its name. A symlink chain ends in one resolved file, and a folder named twice (a link, `..`, another case on a
 * case-insensitive disk) is one folder, so those are one key. Two entries that merely share an inode (hard links, in folders of their
 * own) are two keys: a rename updates one entry, so each is a target and each is written. Null when the path cannot be resolved.
 */
export function fileKey(path: string): string | null {
  try {
    let target = settingsTarget(path);
    try {
      // The native resolver returns the spelling on disk on case-insensitive filesystems.
      target = realpathSync.native(target);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
    const folder = statSync(dirname(target));
    return `${folder.dev}:${folder.ino}/${basename(target)}`;
  } catch {
    return null;
  }
}

/** The file's own identity (device and inode), the same for every hard link of it. */
const inodeOf = (stat: { dev: number; ino: number }): string => `${stat.dev}:${stat.ino}`;

/**
 * Whether a file has names that none of the others in `group` (the targeted pathnames that are the same file) accounts for: a second
 * name HQ was not given and will not update, so that after a rename it would keep the old content. Such a file is refused.
 */
export const hasUnlistedName = (links: number, group: number): boolean => links > group;

/** How many of `all` are the same file (device and inode) as `one`: the names of it that were given. */
const namesOf = (all: readonly Observed[], one: Observed): number =>
  all.filter(
    (other) =>
      other.identity !== null &&
      one.identity !== null &&
      other.identity.dev === one.identity.dev &&
      other.identity.ino === one.identity.ino,
  ).length;

/**
 * Looks at a settings file: its bytes, its whole identity, its folder and whether HQ may replace it. With `hold` the file is opened
 * first and everything is read through that handle, which stays open (`held`): the very file that was seen, for the look after the
 * rename that tells whether it was written in place meanwhile.
 */
function observe(
  path: string,
  forbidden: readonly string[],
  uid: number | undefined,
  hold = false,
): Observed {
  let target: string;
  let folder: Stats;
  try {
    target = settingsTarget(path);
    folder = statSync(dirname(target));
  } catch {
    throw new ClaudeHooksError('unreadable');
  }
  if (forbidden.some((guard) => coincides(target, guard)))
    throw new ClaudeHooksError('unsupported_shape');
  const folderOk =
    folder.isDirectory() && accessible(dirname(target), constants.W_OK | constants.X_OK);
  const where = { dev: folder.dev, ino: folder.ino };
  let fd: number | null = null;
  try {
    if (hold) fd = openSync(target, constants.O_RDONLY | O_NONBLOCK);
    const stat = fd === null ? statSync(target) : fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new ClaudeHooksError('unreadable');
    const mine = uid === undefined || stat.uid === uid;
    const bytes = fd === null ? readFileSync(target) : readOpen(fd, stat.size);
    if (bytes.length > MAX_SETTINGS_BYTES) throw new ClaudeHooksError('unreadable');
    const seen: Observed = {
      target,
      bytes,
      identity: identityOf(stat),
      folder: where,
      writable: folderOk && mine && (stat.mode & 0o200) !== 0 && accessible(target, constants.W_OK),
      links: stat.nlink,
      held: fd,
    };
    fd = null;
    return seen;
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (error instanceof ClaudeHooksError) throw error;
    if (codeOf(error) === 'ENOENT')
      return {
        target,
        bytes: null,
        identity: null,
        folder: where,
        writable: folderOk,
        links: 0,
        held: null,
      };
    throw new ClaudeHooksError('unreadable');
  }
}

/** Whether `now` is not the file `seen` was: its target, bytes, whole identity or folder differ. */
const differs = (now: Observed, seen: Observed): boolean =>
  now.target !== seen.target ||
  !same(now.bytes, seen.bytes) ||
  !sameIdentity(now.identity, seen.identity) ||
  now.folder.dev !== seen.folder.dev ||
  now.folder.ino !== seen.folder.ino;

/** Lets go of the handle an observation kept. */
function release(seen: Observed): void {
  if (seen.held === null) return;
  try {
    closeSync(seen.held);
  } finally {
    seen.held = null;
  }
}

/**
 * After a rename over the file that was observed with a handle: what that very file (now unlinked, or only another name's) holds, when it
 * is not the bytes that were observed. It is what somebody wrote into it in place in the instant between the observation and the
 * rename, which the rename has just replaced. Null when it is still what was observed (or cannot be told).
 */
function writtenSince(seen: Observed): Buffer | null {
  if (seen.held === null || seen.bytes === null) return null;
  try {
    const bytes = readOpen(seen.held, fstatSync(seen.held).size);
    return bytes.equals(seen.bytes) ? null : bytes;
  } catch {
    return null;
  }
}

const currentUid = (): number | undefined => process.getuid?.();

/** The file's text with its byte-order mark kept, or null for a missing file. Anything that is not UTF-8 is refused as unreadable. */
function textOf(bytes: Buffer | null): string | null {
  if (bytes === null) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    throw new ClaudeHooksError('unreadable');
  }
}

/** The file as it is now, for a status or a preview: its text (null when missing) and whether HQ could change it. Nothing is written. */
export function readSettingsFile(
  path: string,
  forbidden: readonly string[] = [],
  uid: number | undefined = currentUid(),
): {
  text: string | null;
  exists: boolean;
  writable: boolean;
  target: string;
  digest: string;
  /** The file's device and inode (the same for every hard link of it); null for a file that does not exist. */
  inode: string | null;
  /** How many names the file has. */
  links: number;
} {
  const seen = observe(path, forbidden, uid);
  const text = textOf(seen.bytes);
  return {
    text,
    exists: seen.bytes !== null,
    writable: seen.writable,
    target: seen.target,
    digest: digestOf(seen.bytes),
    inode: seen.identity === null ? null : inodeOf(seen.identity),
    links: seen.links,
  };
}

/**
 * Whether the one-time copy of `file` could not be proven independent of everything else HQ touches: it must be a different file from
 * the settings file (not the same path, not a link, not a hard link), from every other targeted settings file (`others`, resolved
 * paths) and from HQ's own files and folder (`forbidden`). Checked by resolved path and by device and inode.
 */
export function backupConflicts(
  backup: string,
  target: string,
  forbidden: readonly string[],
  others: readonly string[] = [],
): boolean {
  let real: string;
  try {
    real = join(realpathSync(dirname(backup)), basename(backup));
  } catch {
    return true;
  }
  if (real === target || forbidden.some((guard) => coincides(real, guard))) return true;
  if (others.some((other) => other === real || coincides(real, other))) return true;
  const found = lstatOrNull(real);
  if (found === null) return false;
  // (A link, folder or pipe standing there is refused when the copy is proven: it is not a usable copy, whatever it points at.)
  // Not a second name of any file HQ writes or may write.
  return [target, ...others, ...forbidden].some((path) => {
    const there = statOrNull(path);
    return (
      there !== null && !there.isDirectory() && there.dev === found.dev && there.ino === found.ino
    );
  });
}

/** What the one-time copy step made in this attempt: the published backup (null when one was already there) and whether its temp stayed. */
export interface BackupResult {
  made: Made | null;
  /** The temp the copy was written to could not be removed after the copy was published: it is a complete copy, named by the error's `left`. */
  strayTemp: boolean;
}

/**
 * Proves the one-time copy of a settings file before the file is replaced. The final name only ever appears complete:
 *   - the copy is written to an exclusive, owner-only temp in the same folder (`.<name>.<pid>-<hex>.tmp`, swept like any other temp when
 *     its maker is gone), fsynced and read back equal to `bytes`; only then is it published under the final name with `link`, which
 *     refuses a name that exists, and the temp name is removed: 'created' (and removed again if the attempt does not end in a change).
 *     A process that dies at any step leaves no file under the final name, or a complete one.
 *   - a file already at the final name is accepted as "already saved" only when it is a regular, non-link file that is not empty and
 *     reads as a settings file (a JSON object): 'existed'. It is never overwritten, and never trusted when it is empty or unreadable as
 *     settings (`backup_unusable`, naming the file).
 * Anything else at the path (a folder, a link, a pipe, a file HQ cannot read) throws `not_writable`, and nothing is replaced.
 */
function backUp(backup: string, bytes: Buffer, named: string): BackupResult {
  if (lstatOrNull(backup) !== null) {
    existingBackupIsUsable(backup, named);
    return { made: null, strayTemp: false };
  }
  let temp: Made | null = null;
  let published: Made | null = null;
  try {
    temp = stageTemp(backup, bytes);
    if (!isInstalled(temp.path, temp)) throw new Error('not read back');
    try {
      linkNew(temp.path, backup);
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
      // Somebody made the name since it was looked at: never replaced, judged like any backup that was there.
      existingBackupIsUsable(backup, named);
      return { made: null, strayTemp: removeIfMade(temp) === 'left' };
    }
    published = { path: backup, dev: temp.dev, ino: temp.ino, bytes };
    if (!isInstalled(backup, published)) throw new Error('not read back');
    return { made: published, strayTemp: removeIfMade(temp) === 'left' };
  } catch (error) {
    if (published !== null) removeIfMade(published);
    if (temp !== null) removeIfMade(temp);
    throw error;
  }
}

/**
 * A backup that is already there counts only when it is a regular file (not a link, folder or pipe) that can be read, is not empty and
 * reads as a settings file. `named` is how the owner knows the file, for the refusal that tells them which file to look at.
 */
function existingBackupIsUsable(backup: string, named: string): void {
  if (!lstatSync(backup).isFile()) throw new ClaudeHooksError('not_writable');
  // A pipe swapped in after the check must not block: open without waiting, and read what is there through the opened file.
  const fd = openSync(backup, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ClaudeHooksError('not_writable');
    if (stat.size === 0 || stat.size > MAX_SETTINGS_BYTES)
      throw new ClaudeHooksError('backup_unusable', [named]);
    try {
      parseSettings(utf8.decode(readOpen(fd, stat.size)));
    } catch {
      throw new ClaudeHooksError('backup_unusable', [named]);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the one-time copy that is at `backup` (when there is one) is one HQ would refuse as "already saved" because it is empty or
 * is not a settings file. For the status and the preview, so the page says so before anything is pressed. False for no file at all and
 * for anything that is not this problem (those are `not_writable`, found when the copy is proven).
 */
export function backupIsUnusable(backup: string): boolean {
  try {
    existingBackupIsUsable(backup, '');
    return false;
  } catch (error) {
    return error instanceof ClaudeHooksError && error.failure === 'backup_unusable';
  }
}

export interface SeenFile {
  path: string;
  /** The text as read (byte-order mark kept), null for a file that does not exist. */
  text: string | null;
  /** The resolved file the text came from. */
  target: string;
  /** sha256 of its bytes, or 'missing'. */
  digest: string;
}

export interface TransactionOptions {
  /**
   * Resolved files and folders a settings file must not be, or be inside (HQ's own script, registry and folder): a link onto one is
   * refused, and so is a backup that is one.
   */
  forbidden?: readonly string[];
  attempts?: number;
  pause?: (ms: number) => Promise<void>;
  /** The path as the owner knows it, for the files a failed rollback names. */
  label?: (path: string) => string;
  /** Called at each step with the settings path: tests change the file here, as the owner saving would. */
  onStep?: (step: Step, path: string) => void;
  /** The user a settings file must belong to (default: the user running HQ). Tests only. */
  uid?: number;
  /** Told what a change that succeeded still left in place (a temp file that is no longer HQ's to remove), never silently. */
  report?: (left: readonly LeftBehind[]) => void;
}

export interface TransactionFile {
  path: string;
  /** Where the one-time copy goes: beside the settings path the owner knows (a link's own folder, not its target's). */
  backup: string;
}

interface Staged {
  file: TransactionFile;
  seen: Observed;
  next: Buffer;
  /** The new content, until it is the file. */
  temp: Made | null;
  /** The old content, for a rollback, until the change is done. */
  undo: Made | null;
  /** The one-time copy, when THIS attempt made it. */
  backup: Made | null;
}

/**
 * Changes every file for which `plan` returns text, or none. `plan` is given what was read (it may throw a `ClaudeHooksError` for a
 * file it cannot use or a preview that is no longer current) and returns, for each file in order, the text to write or null for
 * "nothing to change". Resolves the paths that were changed. A failure carries `left`: what HQ made and could not take back.
 */
export async function editSettingsFiles(
  files: readonly TransactionFile[],
  plan: (seen: readonly SeenFile[]) => (string | null)[],
  options: TransactionOptions = {},
): Promise<string[]> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const pause = options.pause ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const forbidden = options.forbidden ?? [];
  const step = options.onStep ?? (() => undefined);
  const label = options.label ?? ((path: string) => path);
  const uid = options.uid ?? currentUid();
  const left = new Set<LeftBehind>();

  try {
    const changed = await run();
    if (left.size > 0) options.report?.([...left]);
    return changed;
  } catch (error) {
    throw error instanceof ClaudeHooksError ? error.with([...left]) : error;
  }

  async function run(): Promise<string[]> {
    for (let attempt = 1; ; attempt += 1) {
      const observed = files.map((file) => observe(file.path, forbidden, uid));
      // Two paths that are one file are one target: never written twice.
      const keys = new Set(observed.map((seen) => fileKey(seen.target)));
      if (keys.size !== files.length || keys.has(null)) throw new ClaudeHooksError('not_writable');
      // A file that has a name HQ was not given would keep the old content under it after a rename: refused, nothing is written.
      if (observed.some((seen) => hasUnlistedName(seen.links, namesOf(observed, seen))))
        throw new ClaudeHooksError('not_writable');
      const texts = plan(
        files.map((file, i) => ({
          path: file.path,
          text: textOf(observed[i]!.bytes),
          target: observed[i]!.target,
          digest: digestOf(observed[i]!.bytes),
        })),
      );

      const staged: Staged[] = [];
      const committed: { staged: Staged; ino: number; dev: number; installed: Identity | null }[] =
        [];
      /** Settings files that could not be put back: their one-time copies stay. */
      const attention: string[] = [];
      let done = false;
      const discard = (): void => {
        for (const item of staged) {
          for (const made of [item.temp, item.undo])
            if (made !== null && removeIfMade(made) === 'left') left.add('temp');
          if (item.backup !== null && !attention.includes(label(item.file.path)))
            if (removeIfMade(item.backup) === 'left') left.add('backup');
        }
      };
      try {
        for (const [i, file] of files.entries()) {
          const text = texts[i];
          if (text === null || text === undefined) continue;
          const seen = observed[i]!;
          const item: Staged = {
            file,
            seen,
            next: Buffer.from(text, 'utf8'),
            temp: null,
            undo: null,
            backup: null,
          };
          staged.push(item);
          try {
            if (!seen.writable) throw new ClaudeHooksError('not_writable');
            if (
              backupConflicts(
                file.backup,
                seen.target,
                forbidden,
                observed.filter((_, j) => j !== i).map((other) => other.target),
              )
            )
              throw new ClaudeHooksError('not_writable');
            sweepStaleTemps(dirname(seen.target), [basename(seen.target)]);
            sweepStaleTemps(dirname(file.backup), [basename(file.backup)]);
            item.temp = stageTemp(seen.target, item.next);
            if (seen.bytes !== null) item.undo = stageTemp(seen.target, seen.bytes);
          } catch (error) {
            if (error instanceof ClaudeHooksError) throw error;
            throw new ClaudeHooksError('not_writable');
          }
          step('staged', file.path);
        }
        if (staged.length === 0) return [];

        // The one-time copies, each proven. Any that this attempt made are removed again if the attempt does not end in a change.
        try {
          for (const item of staged) {
            if (item.seen.bytes === null) continue;
            step('before_backup', item.file.path);
            const copy = backUp(item.file.backup, item.seen.bytes, label(item.file.backup));
            item.backup = copy.made;
            if (copy.strayTemp) left.add('temp');
            step('after_backup', item.file.path);
          }
        } catch (error) {
          throw error instanceof ClaudeHooksError ? error : new ClaudeHooksError('not_writable');
        }

        // The commit. For each file, in this order and no other: (1) the staged file is sealed completely (identity, bytes, final mode
        // and group, read back); (2) the destination is observed (bytes, identity, folder, writability) and compared with what the
        // change was computed from; (3) the rename. Nothing but the comparison is between (2) and (3): no await, no read, no write.
        let retry = false;
        let failure: ClaudeHooksError | null = null;
        for (const item of staged) {
          step('before_commit', item.file.path);
          const temp = item.temp!;
          // The staged file takes the whole mode (and group) the file has; if that is not what the observation below finds, the
          // observation is not the file this change was computed from and the attempt starts over.
          const mode = item.seen.identity?.mode ?? FILE_MODE;
          try {
            sealForRename(temp, mode, item.seen.identity?.gid);
          } catch {
            // Nothing is renamed. A staged file that is gone because the folder it was staged in is not the file's folder any more is
            // the file having changed, not a tampered file: the attempt starts over.
            let moved = false;
            try {
              moved = differs(observe(item.file.path, forbidden, uid), item.seen);
            } catch {
              // unreadable now: refused below
            }
            if (moved) retry = true;
            else failure = new ClaudeHooksError('not_writable');
            break;
          }
          step('sealed', item.file.path);
          // Earlier replacements may have split the original hard-link group. Count only the other targets
          // that still name this inode before the final observation of the destination.
          const original = item.seen.identity;
          const listedNames =
            1 +
            observed.filter((other) => {
              if (other === item.seen || original === null || other.identity === null) return false;
              if (inodeOf(other.identity) !== inodeOf(original)) return false;
              const linked = lstatOrNull(other.target);
              return linked !== null && linked.isFile() && inodeOf(linked) === inodeOf(original);
            }).length;
          let now: Observed;
          try {
            now = observe(item.file.path, forbidden, uid, true);
          } catch (error) {
            failure = error as ClaudeHooksError;
            break;
          }
          // Read-only now (or not the owner's, or in a folder that cannot be written): not HQ's to replace, whatever else changed.
          if (!now.writable) {
            release(now);
            failure = new ClaudeHooksError('not_writable');
            break;
          }
          if (differs(now, item.seen)) {
            release(now);
            retry = true;
            break;
          }
          // The very file that was read, and a name HQ was not given would keep the old content after the rename: refused.
          if (hasUnlistedName(now.links, listedNames)) {
            release(now);
            failure = new ClaudeHooksError('not_writable');
            break;
          }
          step('observed', item.file.path);
          try {
            if (item.seen.bytes === null) {
              // A new file: link fails if one appeared since the compare, where a rename would replace it.
              linkNew(temp.path, item.seen.target);
            } else {
              renameOver(temp.path, item.seen.target);
            }
          } catch (error) {
            release(now);
            if (codeOf(error) === 'EEXIST') retry = true;
            else failure = new ClaudeHooksError('not_writable');
            break;
          }
          // The rename is done: what follows only looks. If the owner saved into the file in place in the instant between the
          // observation and the rename, the file the observation held now holds that save: it is put back, and the attempt starts over.
          const late = writtenSince(now);
          release(now);
          item.temp = null;
          if (item.seen.bytes === null) removeIfMade(temp);
          const placed = lstatOrNull(item.seen.target);
          committed.push({
            staged: item,
            ino: temp.ino,
            dev: temp.dev,
            installed: placed === null ? null : identityOf(placed),
          });
          // What is in place must be that file, those bytes, that mode; else it is named by the roll-back below.
          if (!isInstalled(item.seen.target, temp, mode)) {
            failure = new ClaudeHooksError('not_writable');
            break;
          }
          if (late !== null) {
            committed.pop();
            retry = true;
            try {
              reinstate(item, late, temp, mode);
            } catch {
              attention.push(label(item.file.path));
            }
            break;
          }
          step('after_commit', item.file.path);
        }

        if (!retry && failure === null) {
          done = true;
          return committed.map((entry) => entry.staged.file.path);
        }

        // Put back what was replaced, newest first. A file is only put back if it is still exactly what HQ wrote and can still be
        // written (the same rule as the replace), from a copy that is sealed like any other file HQ renames: seal, then observe, then
        // rename, in that order and nothing else between the last two.
        for (const { staged: item, ino, dev, installed } of committed.reverse()) {
          try {
            const still = (current: Observed): boolean =>
              current.target === item.seen.target &&
              same(current.bytes, item.next) &&
              current.identity?.ino === ino &&
              current.identity.dev === dev &&
              sameIdentity(current.identity, installed) &&
              current.folder.dev === item.seen.folder.dev &&
              current.folder.ino === item.seen.folder.ino &&
              current.writable &&
              // (the file HQ put in place is a new file with one name)
              !hasUnlistedName(current.links, 1);
            if (item.seen.bytes === null) {
              const current = observe(item.file.path, forbidden, uid);
              if (!still(current)) throw new Error('changed since');
              const named = lstatSync(item.seen.target);
              if (!named.isFile() || named.ino !== ino || named.dev !== dev)
                throw new Error('changed since');
              unlinkName(item.seen.target);
              if (observe(item.file.path, forbidden, uid).bytes !== null)
                throw new Error('not restored');
            } else {
              restore(item, still);
            }
          } catch {
            attention.push(label(item.file.path));
          }
        }
        if (attention.length > 0) {
          // The copy of the original is the owner's way back for each file that was not put back: it stays.
          throw new ClaudeHooksError('rollback_failed', attention.reverse());
        }
        if (failure !== null) throw failure;
        if (attempt >= attempts) throw new ClaudeHooksError('conflict');
      } finally {
        if (!done) {
          // Nothing of this attempt stays: temp files, and the copies it made (the next attempt makes them again from a fresh read).
          discard();
        } else {
          for (const item of staged)
            if (item.undo !== null && removeIfMade(item.undo) === 'left') left.add('temp');
        }
      }
      await pause(RETRY_PAUSE_MS * attempt);
    }
  }

  /**
   * Puts an existing file's original bytes back over what HQ wrote. The copy staged for it is used only if it still passes
   * the seal (the same file, the same bytes); otherwise a new one is written from the original bytes HQ holds, and sealed the same way.
   * The mode is the original's whole permission word. Order: the copy is sealed, THEN the file is observed (`still` must hold), THEN
   * the rename; if the owner saved into HQ's file in place in the instant between, that save is put back and the file is named.
   */
  function restore(item: Staged, still: (current: Observed) => boolean): void {
    const original = item.seen.bytes!;
    const mode = item.seen.identity!.mode;
    const gid = item.seen.identity!.gid;
    let source: Made | null = null;
    if (item.undo !== null) {
      try {
        sealForRename(item.undo, mode, gid);
        source = item.undo;
      } catch {
        // edited, replaced or gone since it was staged: it is left where it is (and named), and the remembered bytes are used instead
      }
    }
    if (source === null) {
      const fresh = stageTemp(item.seen.target, original);
      try {
        sealForRename(fresh, mode, gid);
      } catch (error) {
        removeIfMade(fresh);
        throw error;
      }
      source = fresh;
    }
    step('restore_sealed', item.file.path);
    let current: Observed | null = null;
    try {
      current = observe(item.file.path, forbidden, uid, true);
      if (!still(current)) throw new Error('changed since');
      step('restore_observed', item.file.path);
      renameOver(source.path, item.seen.target);
    } catch (error) {
      if (current !== null) release(current);
      if (source !== item.undo) removeIfMade(source);
      throw error;
    }
    const late = writtenSince(current);
    release(current);
    if (source === item.undo) item.undo = null;
    if (!isInstalled(item.seen.target, source, mode)) throw new Error('not restored');
    if (late !== null) {
      reinstate(item, late, source, mode);
      throw new Error('saved meanwhile');
    }
  }

  /**
   * Puts the bytes the owner saved into a file in the instant before HQ replaced it (`late`) back over what HQ put in its place
   * (`placed`), only while that is still exactly HQ's file; the copy is sealed first and the file looked at right before the rename.
   */
  function reinstate(item: Staged, late: Buffer, placed: Made, mode: number): void {
    const fresh = stageTemp(item.seen.target, late);
    try {
      sealForRename(fresh, mode, item.seen.identity?.gid);
      if (!isInstalled(item.seen.target, placed, mode)) throw new Error('changed since');
      renameOver(fresh.path, item.seen.target);
    } catch (error) {
      removeIfMade(fresh);
      throw error;
    }
    if (!isInstalled(item.seen.target, fresh, mode)) throw new Error('not restored');
  }
}

export interface EditOptions {
  /** Resolved files and folders the settings must not be, or be inside (HQ's own script, registry and folder): a link onto one is refused. */
  forbidden?: readonly string[];
  /** Where the one-time copy goes: beside the settings path the owner knows (a link's own folder, not its target's). */
  backup: string;
  attempts?: number;
  pause?: (ms: number) => Promise<void>;
  onStep?: (step: Step, path: string) => void;
  uid?: number;
  report?: (left: readonly LeftBehind[]) => void;
}

/**
 * Changes one settings file. `edit` is given the text (null for a missing file) and returns the text to write, or null for "nothing
 * to change"; it throws a `ClaudeHooksError` for a file it cannot use. Resolves 'changed' or 'unchanged'.
 */
export async function editSettings(
  path: string,
  edit: (text: string | null) => string | null,
  options: EditOptions,
): Promise<'changed' | 'unchanged'> {
  const { backup, ...rest } = options;
  const changed = await editSettingsFiles([{ path, backup }], ([seen]) => [edit(seen!.text)], rest);
  return changed.length === 0 ? 'unchanged' : 'changed';
}
