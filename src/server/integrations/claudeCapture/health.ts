import { accessSync, constants, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isRecord } from './files.ts';
import { CONFIG_FILE } from './paths.ts';
import type { SnapshotRead } from './snapshot.ts';
import { commandOf, type SettingsRead } from './settings.ts';
import type { CaptureState } from './state.ts';
import { isWrapper } from './wrapper.ts';

export type CapturePhase =
  'off' | 'awaiting_edit' | 'active' | 'awaiting_removal' | 'needs_attention';

export type CaptureHealthState =
  | 'off'
  | 'awaiting_edit'
  | 'awaiting_removal'
  | 'waiting'
  | 'ok'
  | 'no_limits'
  | 'idle'
  | 'replaced'
  | 'node_missing'
  | 'settings_unreadable'
  | 'profile_changed'
  | 'state_unreadable'
  | 'legacy_unverified';

export interface CaptureHealth {
  phase: CapturePhase;
  state: CaptureHealthState;
  leftover: boolean;
  recorded: boolean;
  lastInvokedAt: number | null;
  capturedAt: number | null;
  settingsPath: string | null;
  projectOverrides: number;
  backupPath: string | null;
}

export const IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface HealthInput {
  state: CaptureState | null;
  invalid: boolean;
  settings: SettingsRead | null;
  selectedPath: string;
  snapshot: SnapshotRead;
  hookRunnable: boolean;
  now: number;
  projectOverrides: number;
}

export function computeHealth(input: HealthInput): CaptureHealth {
  const { state, settings, snapshot, now, projectOverrides } = input;
  const seen = snapshot.kind === 'ok' ? snapshot.snapshot : null;
  const lastInvokedAt = seen?.invoked_at == null ? null : seen.invoked_at * 1000;
  const capturedAt = seen?.captured_at == null ? null : seen.captured_at * 1000;
  const make = (
    phase: CapturePhase,
    health: CaptureHealthState,
    leftover = false,
  ): CaptureHealth => ({
    phase,
    state: health,
    leftover,
    recorded: state !== null,
    lastInvokedAt: phase === 'active' ? lastInvokedAt : null,
    capturedAt: phase === 'active' ? capturedAt : null,
    settingsPath: state?.settingsPath ?? (leftover ? (settings?.path ?? null) : null),
    projectOverrides,
    backupPath: state?.backupPath ?? null,
  });

  if (input.invalid) return make('needs_attention', 'state_unreadable');
  if (state === null) {
    const command = settings === null ? null : commandOf(settings);
    return command !== null && isWrapper(command)
      ? make('needs_attention', 'node_missing', true)
      : make('off', 'off');
  }
  if (state.v === 2 && state.phase === 'awaiting_removal') {
    return make('awaiting_removal', 'awaiting_removal');
  }
  if (
    state.settingsPath !== input.selectedPath ||
    (settings !== null && state.v === 2 && settings.realPath !== state.settingsRealPath)
  ) {
    return make('needs_attention', 'profile_changed');
  }
  if (settings === null) return make('needs_attention', 'settings_unreadable');
  if (state.v === 1) return make('needs_attention', 'legacy_unverified');
  if (!input.hookRunnable) return make('needs_attention', 'node_missing');
  if (state.phase === 'awaiting_edit') return make('awaiting_edit', 'awaiting_edit');
  if (commandOf(settings) !== state.wrapper) return make('needs_attention', 'replaced');
  if (lastInvokedAt === null) return make('active', 'waiting');
  if (capturedAt === null) return make('active', 'no_limits');
  if (now - lastInvokedAt > IDLE_AFTER_MS) return make('active', 'idle');
  return make('active', 'ok');
}

/** The recorded Node is an executable file and the script is there: the two things the wrapper tests before it runs the hook. */
export function hookRunnable(state: CaptureState): boolean {
  try {
    accessSync(state.node, constants.X_OK);
    accessSync(join(dirname(state.script), CONFIG_FILE), constants.R_OK);
    return statSync(state.node).isFile() && statSync(state.script).isFile();
  } catch {
    return false;
  }
}

// ---- project status lines ----------------------------------------------------------------------------------------------------

const MAX_PROJECT_SETTINGS_BYTES = 1024 * 1024;
const MAX_WALK = 24;

/**
 * The folders whose project settings Claude Code reads for a session started in `cwd`: the folder itself and its repository root
 * (the nearest folder at or above it holding `.git`, a folder or, in a worktree, a file).
 */
async function projectRoots(cwd: string): Promise<string[]> {
  let dir = cwd;
  for (let step = 0; step < MAX_WALK; step += 1) {
    try {
      await stat(join(dir, '.git'));
      return dir === cwd ? [cwd] : [cwd, dir];
    } catch {
      // no repository here: look one level up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [cwd];
}

/** True when the file holds a top-level `statusLine` key. Only the key's presence is read out; its value is dropped at once. */
async function definesStatusLine(file: string, userSettings: string): Promise<boolean> {
  try {
    // A session started in the home folder finds the USER settings here, which are the dashboard's own target and not a project's.
    if ((await realpath(file)) === userSettings) return false;
    if ((await stat(file)).size > MAX_PROJECT_SETTINGS_BYTES) return false;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isRecord(parsed) && Object.hasOwn(parsed, 'statusLine');
  } catch {
    return false; // no such file, not readable or not JSON: it does not override anything we can see
  }
}

/**
 * How many of the folders Claude Code ran in define their own `statusLine` (in `.claude/settings.local.json` or
 * `.claude/settings.json`, in the folder or its repository root), which hides the dashboard's from those sessions. Presence only:
 * no value is kept. Managed-settings overrides can't be seen from here and are not claimed.
 */
export async function countProjectOverrides(
  cwds: readonly string[],
  userSettingsPath: string,
): Promise<number> {
  let user = userSettingsPath;
  try {
    user = await realpath(userSettingsPath);
  } catch {
    // the user settings file does not exist yet: compare by the path as written
  }
  let count = 0;
  for (const cwd of new Set(cwds)) {
    let defined = false;
    for (const root of await projectRoots(cwd)) {
      for (const name of ['settings.local.json', 'settings.json']) {
        if (!defined) defined = await definesStatusLine(join(root, '.claude', name), user);
      }
    }
    if (defined) count += 1;
  }
  return count;
}
