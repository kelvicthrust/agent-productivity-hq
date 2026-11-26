import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import {
  MAX_REGISTRY_BYTES,
  isTrustedRegistry,
  parseRegistryBytes,
} from './assets/claude-hook.mjs';
import { O_NOFOLLOW, O_NONBLOCK } from './fsguard.ts';
import { REGISTRY_FILE } from './paths.ts';

// "Deliverable": what has to be true for Claude Code's hook to reach this app. ONE place decides it, from the very rules the installed
// script applies, so that the status never says "on" for something the script would refuse:
//   - the registry: the script's own trust rule (`isTrustedRegistry`: a regular file, at most 4 KiB, the current user's, closed to
//     group and others) and its own reading (`parseRegistryBytes`: strict UTF-8, version 1, a live pid, a port, a token of the shape
//     the app makes) are IMPORTED from the script, not copied, and applied in the order the script applies them (lstat, open
//     without following a link, look at the opened file, bounded read). A test feeds the same fixtures to the script and to this.
//   - the script itself: exactly the bytes this app ships, a regular file the current user owns and nobody else can write, which its
//     owner can read (the command runs `node <script>`, which only reads it).
//   - the Node the command names: a regular file that can be executed (`[ -x ]` in the command, plus what it must be to run).

export interface RegistryRead {
  pid: number;
  port: number;
  token: string;
  backgroundWork?: true;
}

/** The registry in `dir`, read the way the installed script reads it; null where the script would give up. */
export function registryAsScriptReadsIt(dir: string): RegistryRead | null {
  const path = join(dir, REGISTRY_FILE);
  let fd: number | null = null;
  try {
    if (!isTrustedRegistry(lstatSync(path))) return null;
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!isTrustedRegistry(fstatSync(fd))) return null;
    const buffer = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const got = readSync(fd, buffer, size, buffer.length - size, size);
      if (got === 0) break;
      size += got;
    }
    return size > MAX_REGISTRY_BYTES ? null : parseRegistryBytes(buffer.subarray(0, size));
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const accessible = (path: string, mode: number): boolean => {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};

/** Whether the hook script's file is one the command can run and nobody else can change: the current user's, readable, not writable by group or others. */
export function scriptFileIsUsable(stat: Stats, path: string): boolean {
  const uid = process.getuid?.();
  if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return false;
  if ((stat.mode & 0o400) === 0 || (stat.mode & 0o022) !== 0) return false;
  return accessible(path, constants.R_OK);
}

/** Whether `node` (as the command names it) is a regular file that can be executed. */
export function nodeIsUsable(node: string): boolean {
  try {
    return statSync(node).isFile() && accessible(node, constants.X_OK);
  } catch {
    return false;
  }
}
