import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { unlinkName } from './fsguard.ts';

// A temp file is removed on every error path, but a process that is killed between creating one and renaming it leaves it behind (it
// may hold the registry's token or a copy of the owner's settings). Temp files are named `.<name>.<pid>-<8 hex>.tmp`, so a leftover is
// recognisable by name AND by the process that made it being gone. Only a regular file with exactly that name is ever removed.

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Removes the leftover temp files of `names` in `dir`: those whose maker is no longer running. Never throws. */
export function sweepStaleTemps(dir: string, names: readonly string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = entry.match(/^\.(.+)\.(\d+)-[0-9a-f]{8}\.tmp$/);
    if (match === null || !names.includes(match[1]!)) continue;
    const pid = Number(match[2]);
    if (pid === process.pid || alive(pid)) continue;
    try {
      const path = join(dir, entry);
      if (lstatSync(path).isFile()) unlinkName(path);
    } catch {
      // best effort
    }
  }
}
