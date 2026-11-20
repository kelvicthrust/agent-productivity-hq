import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { conflict, unreadable, unsupported } from './errors.ts';
import { isRecord } from './files.ts';
import { snapshotDirectory, type CapturePaths } from './paths.ts';

export type Json = Record<string, unknown>;

export interface SettingsRead {
  path: string;
  realPath: string;
  exists: boolean;
  value: Json;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Resolve existing parents of a missing file as well, so creation through a directory link keeps the same binding. */
function resolveTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!missing(error)) throw error;
    try {
      lstatSync(path);
    } catch (lookup) {
      if (!missing(lookup)) throw lookup;
      const parent = dirname(path);
      if (parent === path) throw error;
      return join(resolveTarget(parent), basename(path));
    }
    throw error; // a dangling link is ambiguous
  }
}

export function settingsTarget(path: string): string {
  try {
    return resolveTarget(path);
  } catch {
    throw unreadable(path);
  }
}

/** A settings symlink must never turn an Agent Productivity HQ artifact write into a provider settings edit. */
export function assertSeparateSettings(
  paths: CapturePaths,
  path: string,
  target: string,
  snapshotId: string | null = null,
): void {
  const directory =
    snapshotId === null ? null : settingsTarget(snapshotDirectory(paths, snapshotId));
  if (
    (directory !== null && (target === directory || target.startsWith(directory + sep))) ||
    [paths.script, paths.config, paths.snapshot, paths.state].some(
      (file) => target === settingsTarget(file),
    )
  ) {
    throw conflict(
      path,
      'This Claude Code settings file points to an Agent Productivity HQ capture file. Correct the link before continuing.',
    );
  }
}

/** Read user settings as JSON. The only value carried into a capture record or preview is statusLine. */
export function readSettings(path: string): SettingsRead {
  const realPath = settingsTarget(path);
  try {
    if (!statSync(realPath).isFile()) throw unreadable(path);
    const text = readFileSync(realPath, 'utf8');
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw unreadable(path);
    return { path, realPath, exists: true, value };
  } catch (error) {
    if (missing(error)) return { path, realPath, exists: false, value: {} };
    throw unreadable(path);
  }
}

export const commandOf = (read: SettingsRead): string | null => {
  const line = read.value['statusLine'];
  return isRecord(line) && line['type'] === 'command' && typeof line['command'] === 'string'
    ? line['command']
    : null;
};

/** A missing key is allowed. An existing value must be a command to preserve it alongside the hook. */
export function statusLineOf(read: SettingsRead): Json | null {
  const line = read.value['statusLine'];
  if (line === undefined) return null;
  if (!isRecord(line) || line['type'] !== 'command' || typeof line['command'] !== 'string') {
    throw unsupported(read.path);
  }
  return line;
}
