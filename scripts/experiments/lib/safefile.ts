import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';

// The one place an experiment opens a file it writes (and the workspace reads). The folder checks in workspace.ts and
// findings.ts look at the parent; this looks at the file itself, so a symbolic link or hard link planted at the final
// name cannot send a write somewhere else. The file is opened without following a link in the last path component and
// without truncating, checked, and only then truncated, so a refused file is never changed. The window between the
// check on the parent and this open still needs someone who can already write inside the folder.

export class UnsafeFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeFileError';
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// A named pipe planted at the name would make a write-only open wait for a reader; non-blocking turns that into an error
// (and a read-only open into a file the checks below refuse). It changes nothing for a regular file.
const NONBLOCK = constants.O_NONBLOCK ?? 0;

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;

function refuseSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new UnsafeFileError('Refusing to use a file that is a symbolic link.');
  } catch (error) {
    if (error instanceof UnsafeFileError) throw error;
    if (codeOf(error) === 'ENOENT') return; // nothing there yet: the open below creates it
    throw error;
  }
}

/** Opens `path` without following a link at its end, and returns the descriptor of a regular file with one link. */
function openPlain(path: string, flags: number, mode?: number): number {
  refuseSymlink(path);
  let fd: number;
  try {
    fd = openSync(path, flags | NOFOLLOW | NONBLOCK, mode);
  } catch (error) {
    if (codeOf(error) === 'ELOOP')
      throw new UnsafeFileError('Refusing to use a file that is a symbolic link.');
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile())
      throw new UnsafeFileError('Refusing to use something that is not a regular file.');
    if (info.nlink > 1)
      throw new UnsafeFileError('Refusing to use a file that has more than one hard link.');
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

function writeAll(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  let done = 0;
  while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
}

/** Creates or replaces a plain file. A link at the target is refused before anything is changed. */
export function writeFileNoFollow(path: string, data: string | Uint8Array, mode = 0o600): void {
  const fd = openPlain(path, constants.O_WRONLY | constants.O_CREAT, mode);
  try {
    ftruncateSync(fd, 0);
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Adds to a plain file, creating it if it is not there. */
export function appendFileNoFollow(path: string, data: string | Uint8Array, mode = 0o600): void {
  const fd = openPlain(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, mode);
  try {
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Reads a plain file as UTF-8 text. */
export function readFileNoFollow(path: string): string {
  const fd = openPlain(path, constants.O_RDONLY);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
