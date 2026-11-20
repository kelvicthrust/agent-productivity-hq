import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach } from 'vitest';
import {
  createClaudeHooks,
  type ClaudeHooks,
  type ClaudeHooksOptions,
} from '../../src/server/integrations/claudeHooks/index.ts';
import { memoryLogger } from '../server/helpers.ts';

// Every test here runs in a throwaway folder whose name has a space, with CLAUDE_CONFIG_DIR, the home and the data folder passed in
// explicitly: nothing reads or writes the real ~/.claude and process.env is never changed.

export const ASSET = resolve(
  import.meta.dirname,
  '../../src/server/integrations/claudeHooks/assets/claude-hook.mjs',
);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }))
        if (!entry.isSymbolicLink()) chmodSync(join(entry.parentPath, entry.name), 0o700);
    } catch {
      // best effort
    }
    rmSync(root, { recursive: true, force: true });
  }
});

export interface Rig {
  root: string;
  home: string;
  /** `CLAUDE_CONFIG_DIR`. */
  config: string;
  data: string;
  settings: string;
  hooks: ClaudeHooks;
  logs: Record<string, unknown>[];
  /** A second instance over the same folders (a restart, or a copy of the app in another data folder). */
  another(options?: Partial<ClaudeHooksOptions>): ClaudeHooks;
}

export function rig(
  options: { settings?: string | null; config?: boolean; extra?: Partial<ClaudeHooksOptions> } = {},
): Rig {
  const root = mkdtempSync(join(tmpdir(), 'hooks test-'));
  roots.push(root);
  const home = join(root, 'home');
  const config = join(home, '.claude');
  const data = join(root, 'data dir');
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  if (options.config !== false) mkdirSync(config, { recursive: true });
  const settings = join(config, 'settings.json');
  if (typeof options.settings === 'string') writeFileSync(settings, options.settings);
  const { logger, entries } = memoryLogger();
  const make = (extra: Partial<ClaudeHooksOptions> = {}) =>
    createClaudeHooks({
      dataDir: data,
      env: { CLAUDE_CONFIG_DIR: config },
      home,
      nodePath: '/usr/local/bin/node',
      // The Node named above is a name, not a file on this machine: "on" needs a Node that can run, so tests that are not about that say yes.
      nodeUsable: () => true,
      logger,
      pause: async () => undefined,
      ...options.extra,
      ...extra,
    });
  return { root, home, config, data, settings, hooks: make(), logs: entries, another: make };
}

export const read = (path: string): string => readFileSync(path, 'utf8');
export const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;

/** Every file name under `dir` (for "no temp file is left behind"). */
export const names = (dir: string): string[] => readdirSync(dir).sort();

/** A typical settings file: permissions, an env block and the user's own hooks on events HQ also uses. */
export const USER_SETTINGS = {
  permissions: { allow: ['Bash(git status)'], deny: [] },
  env: { FOO: 'bar' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/check.sh' }] }],
  },
  model: 'opus',
};
export const asText = (value: unknown, indent: string | number = 2): string =>
  `${JSON.stringify(value, null, indent)}\n`;
