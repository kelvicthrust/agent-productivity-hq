import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

// The data directory is private to its owner: 0700 for folders, 0600 for files (data-and-sources › Storage).
// Modes are set explicitly, so a permissive umask cannot loosen them.

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Creates `dir` (and parents) and makes it, but not its parents, owner-only. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}

/** Creates an empty owner-only file if it is missing, so a library that opens it later inherits the mode. */
export function ensureFile(path: string): void {
  if (!existsSync(path)) closeSync(openSync(path, 'a', FILE_MODE));
  chmodSync(path, FILE_MODE);
}

/** Tightens every file directly inside `dir` whose name starts with `prefix` (the database and its -wal and -shm files). */
export function hardenFiles(dir: string, prefix: string): void {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const path = join(dir, name);
    if (statSync(path).isFile()) chmodSync(path, FILE_MODE);
  }
}

/** The permission bits of a path, e.g. 0o600. */
export const modeOf = (path: string): number => statSync(path).mode & 0o777;
