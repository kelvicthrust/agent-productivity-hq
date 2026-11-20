import { join } from 'node:path';

// Where things are (data-and-sources › Claude Code hooks). Claude Code's side is the user-level `settings.json` of each Claude Code
// folder; everything else is under the dashboard's own data folder, in one owner-only folder of its own.

export const HOOKS_DIR = 'claude-hooks';
export const HOOK_SCRIPT = 'agent-productivity-hook.mjs';
export const REGISTRY_FILE = 'registry.json';
/** The one-time copy of a settings file as it was before HQ first changed it, beside that file. */
export const BACKUP_SUFFIX = '.agent-productivity-backup';

export interface HookPaths {
  dataDir: string;
  /** `<data>/claude-hooks`, mode 0700. */
  dir: string;
  /** The hook script, copied from assets/ when the switch is turned on. */
  script: string;
  /** `{ v, pid, port, token }`, written while the server listens and the switch is on. */
  registry: string;
}

export function hookPaths(dataDir: string): HookPaths {
  const dir = join(dataDir, HOOKS_DIR);
  return { dataDir, dir, script: join(dir, HOOK_SCRIPT), registry: join(dir, REGISTRY_FILE) };
}
