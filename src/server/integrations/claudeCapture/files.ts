import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { FILE_MODE } from '../../lib/fsModes.ts';

// Small file helpers for the dashboard's OWN files, all owner-only.

/** Writes `data` to a temp file beside `path`, then renames it into place, so a reader never sees half a file. Mode 0600. */
export function writePrivateFile(path: string, data: string | Uint8Array): void {
  const temp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, data, { mode: FILE_MODE, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** The file's bytes, or null when there is no such file. Any other failure is thrown. */
export function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
