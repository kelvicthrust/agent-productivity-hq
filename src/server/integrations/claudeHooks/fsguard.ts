import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DIR_MODE, FILE_MODE } from '../../lib/fsModes.ts';
import { ClaudeHooksError } from './errors.ts';

// The ONLY place in the hook integration that changes the file system. Every create, write, truncate, chmod, chown, rename, link,
// unlink and mkdir of write.ts, ownFiles.ts and stale.ts is one of the functions below, so that
//   - the precondition of each kind of step is written once, here, next to the step (see the table at the end of each function),
//   - a test can record every step (`watchMutations`) and compare it with the plan the owner was shown, and can stop the process
//     "dead" after any step (the listener throws before every later step) to see what a crash would have left.
// A file HQ is about to rename into place is first sealed (`sealForRename`): it must still be the very file HQ created, byte for byte.

export type MutationOp =
  'create' | 'write' | 'truncate' | 'chmod' | 'chown' | 'rename' | 'link' | 'unlink' | 'mkdir';

export interface Mutation {
  op: MutationOp;
  /** The path acted on (for `rename` and `link`, the source). */
  path: string;
  /** The destination of a `rename` or `link`. */
  to?: string;
}

type Probe = (mutation: Mutation, phase: 'before' | 'after') => void;
let probe: Probe | null = null;

/** Tests only: told before and after every step this module makes. Throwing from `before` stops the step. Returns the way to stop watching. */
export function watchMutations(listener: Probe): () => void {
  probe = listener;
  return () => {
    if (probe === listener) probe = null;
  };
}

function around<T>(mutation: Mutation, run: () => T): T {
  probe?.(mutation, 'before');
  const result = run();
  probe?.(mutation, 'after');
  return result;
}

export const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
export const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

export const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** A file HQ made, as it was left: where, which file (device and inode) and its bytes. It is only ever removed or renamed while it still is exactly that. */
export interface Made {
  path: string;
  dev: number;
  ino: number;
  bytes: Buffer;
}

// ---- the steps ------------------------------------------------------------------------------------------------------------------

/** Creates a file that must not exist (exclusive, never through a link), owner-only whatever the umask. Precondition: none (the kernel refuses an existing path). */
export function createExclusive(path: string): number {
  const fd = around({ op: 'create', path }, () =>
    openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      FILE_MODE,
    ),
  );
  try {
    around({ op: 'chmod', path }, () => fchmodSync(fd, FILE_MODE));
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/** Writes all of `bytes` through the opened file (from the start when `fromStart`), and syncs it. Precondition: the caller opened the file and checked it. */
export function writeAll(fd: number, path: string, bytes: Buffer, fromStart = false): void {
  around({ op: 'write', path }, () => {
    let written = 0;
    while (written < bytes.length)
      written += fromStart
        ? writeSync(fd, bytes, written, bytes.length - written, written)
        : writeSync(fd, bytes, written);
    fsyncSync(fd);
  });
}

export function truncateOpen(fd: number, path: string): void {
  around({ op: 'truncate', path }, () => ftruncateSync(fd, 0));
}

export function setModeOpen(fd: number, path: string, mode: number): void {
  around({ op: 'chmod', path }, () => fchmodSync(fd, mode));
}

export function setGroupOpen(fd: number, path: string, gid: number): void {
  around({ op: 'chown', path }, () => fchownSync(fd, -1, gid));
}

/** chmod of a folder HQ made. Precondition: the caller checked the folder is the owner's and not a link. */
export function setModePath(path: string, mode: number): void {
  around({ op: 'chmod', path }, () => chmodSync(path, mode));
}

export function makeDir(path: string, mode: number): void {
  around({ op: 'mkdir', path }, () => mkdirSync(path, { mode }));
}

/** Creates a folder and its parents (owner-only, the last one tightened). Precondition: none beyond the caller's own guard of the HQ folder. */
export function makeOwnerDirs(path: string): void {
  const missing: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    try {
      if (lstatSync(at).isDirectory()) break;
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
      missing.push(at);
    }
    if (dirname(at) === at) break;
  }
  for (const folder of missing.reverse()) {
    try {
      makeDir(folder, DIR_MODE);
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
    }
  }
  setModePath(path, DIR_MODE);
}

/** Renames `from` over `to`. Precondition, in this order: the caller sealed `from` (sealForRename), THEN observed `to` (the compare-and-swap), and nothing but that comparison stands between the observation and this call. */
export function renameOver(from: string, to: string): void {
  around({ op: 'rename', path: from, to }, () => renameSync(from, to));
}

/** Gives `from` a second name `to`; refuses when `to` exists. Precondition: the caller sealed `from` (a new settings file) or proved it read back equal (the one-time backup copy, published whole under its final name). */
export function linkNew(from: string, to: string): void {
  around({ op: 'link', path: from, to }, () => linkSync(from, to));
}

/** Removes a name. Precondition: the caller verified, immediately before, that the name is the file it means to remove (`removeIfMade`, or the owner-file guard). */
export function unlinkName(path: string): void {
  around({ op: 'unlink', path }, () => unlinkSync(path));
}

// ---- checks ---------------------------------------------------------------------------------------------------------------------

/** All of an opened file's bytes (the size is the file's own, fstat'ed). */
export function readOpen(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const got = readSync(fd, bytes, read, size - read, read);
    if (got === 0) break;
    read += got;
  }
  return read === size ? bytes : bytes.subarray(0, read);
}

const sameFile = (stat: Stats, made: Made): boolean =>
  stat.isFile() && stat.dev === made.dev && stat.ino === made.ino;

/**
 * Removes a file HQ made, only while it is still exactly what HQ wrote (a regular file, the same device and inode, the same bytes), and
 * checks the name again immediately before the unlink. 'left' when it is something else now or could not be removed; 'absent' when gone.
 */
export function removeIfMade(made: Made): 'removed' | 'absent' | 'left' {
  let stat: Stats;
  try {
    stat = lstatSync(made.path);
  } catch (error) {
    return codeOf(error) === 'ENOENT' ? 'absent' : 'left';
  }
  if (!sameFile(stat, made) || stat.size !== made.bytes.length) return 'left';
  try {
    if (!readFileSync(made.path, { flag: constants.O_RDONLY | O_NOFOLLOW }).equals(made.bytes))
      return 'left';
    if (!sameFile(lstatSync(made.path), made)) return 'left';
    unlinkName(made.path);
    return 'removed';
  } catch {
    return 'left';
  }
}

/** A new owner-only file beside `near`, holding `bytes`, made by exclusive create. Throws when it cannot be made (nothing is left). */
export function stageTemp(near: string, bytes: Buffer): Made {
  const path = join(
    dirname(near),
    `.${basename(near)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
  );
  let fd: number | null = null;
  let made: Made | null = null;
  try {
    fd = createExclusive(path);
    const stat = fstatSync(fd);
    made = { path, dev: stat.dev, ino: stat.ino, bytes };
    writeAll(fd, path, bytes);
    closeSync(fd);
    fd = null;
    return made;
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (made !== null) removeIfMade(made);
    throw error;
  }
}

const refused = (): never => {
  throw new ClaudeHooksError('not_writable');
};

/**
 * Makes a staged file ready to be renamed into place, and proves it is still HQ's, in one go on the OPENED file. Every file HQ renames
 * (a staged update, a rollback copy, a staged script or registry) passes through here immediately before the rename:
 *   - it is a regular file (not a link: opened with O_NOFOLLOW, and the name is looked at again), the very device and inode HQ created,
 *     with one name only (a second hard link means somebody else holds it), still owner-only (0600) and the current user's;
 *   - its bytes are exactly the bytes HQ computed (read back through the opened file);
 *   - then the mode step: the group is given back where HQ may, the whole permission word (`mode`, setuid, setgid and sticky included)
 *     is set, and the file is looked at once more: a bit the platform did not keep refuses the change instead of dropping it.
 * Anything else throws `not_writable`, and nothing has been renamed.
 */
export function sealForRename(made: Made, mode: number, gid: number | undefined): void {
  let fd: number | null = null;
  try {
    fd = openSync(made.path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (
      !sameFile(stat, made) ||
      stat.nlink !== 1 ||
      stat.size !== made.bytes.length ||
      (stat.mode & 0o7777) !== FILE_MODE ||
      (uid !== undefined && stat.uid !== uid)
    )
      return refused();
    if (!readOpen(fd, stat.size).equals(made.bytes)) return refused();
    if (!sameFile(lstatSync(made.path), made)) return refused();
    if (gid !== undefined && gid !== stat.gid) {
      try {
        setGroupOpen(fd, made.path, gid);
      } catch {
        // the group is the owner's to keep; where HQ may not give it back, the file keeps the folder's (refused below when setgid is asked for)
      }
    }
    setModeOpen(fd, made.path, mode);
    const after = fstatSync(fd);
    if ((after.mode & 0o7777) !== mode) return refused();
    if ((mode & 0o2000) !== 0 && gid !== undefined && after.gid !== gid) return refused();
  } catch (error) {
    throw error instanceof ClaudeHooksError ? error : new ClaudeHooksError('not_writable');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Whether `path` is now the regular file `made` describes (the same file, the same bytes) and, when `mode` is given, has exactly that
 * permission word. For the look after a rename or link: what ended up in place is what HQ meant.
 */
export function isInstalled(path: string, made: Made, mode?: number): boolean {
  try {
    const stat = lstatSync(path);
    if (!sameFile(stat, made) || stat.size !== made.bytes.length) return false;
    if (mode !== undefined && (stat.mode & 0o7777) !== mode) return false;
    return readFileSync(path, { flag: constants.O_RDONLY | O_NOFOLLOW }).equals(made.bytes);
  } catch {
    return false;
  }
}

export const identityOfStat = (stat: Stats): { dev: number; ino: number } => ({
  dev: stat.dev,
  ino: stat.ino,
});
