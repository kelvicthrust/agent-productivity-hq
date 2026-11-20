import { join, resolve } from 'node:path';

// Where things are. Claude Code's side is exactly one file (the user-level settings); everything else is under the dashboard's
// own data folder.

export const SCRIPT_FILE = 'claude-statusline.mjs';
export const CONFIG_FILE = 'claude-statusline.config.json';
export const SNAPSHOT_FILE = 'claude-limits.json';
export const CAPTURE_DIR = 'claude-capture';
export const STATE_FILE = 'state.json';

/**
 * The user-level settings file this module previews: `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set (Claude Code takes
 * a single folder), otherwise `~/.claude/settings.json`. A project's `.claude/settings.json` and `settings.local.json` are
 * never targets, and nothing else in the folder (credentials included) is ever opened.
 */
export function claudeSettingsPath(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  return configured !== undefined && configured !== ''
    ? join(resolve(configured), 'settings.json')
    : join(home, '.claude', 'settings.json');
}

export interface CapturePaths {
  dataDir: string;
  /** The hook, copied from assets/ at install. */
  script: string;
  /** `{ previousCommand }` and nothing else. */
  config: string;
  /** The old shared snapshot path, read only when migrating v1 captures. */
  snapshot: string;
  /** Capture state and any backups retained from the previous workflow. */
  captureDir: string;
  state: string;
}

export function capturePaths(dataDir: string): CapturePaths {
  const captureDir = join(dataDir, CAPTURE_DIR);
  return {
    dataDir,
    script: join(dataDir, SCRIPT_FILE),
    config: join(dataDir, CONFIG_FILE),
    snapshot: join(dataDir, SNAPSHOT_FILE),
    captureDir,
    state: join(captureDir, STATE_FILE),
  };
}

export function snapshotDirectory(paths: CapturePaths, snapshotId: string): string {
  return join(paths.captureDir, `snapshot.${snapshotId}`);
}

export function generationSnapshot(paths: CapturePaths, snapshotId: string): string {
  return join(snapshotDirectory(paths, snapshotId), SNAPSHOT_FILE);
}
