import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { retireSnapshotGeneration, upgradeLegacyHook, type InstallContext } from './apply.ts';
import { conflict } from './errors.ts';
import { writePrivateFile } from './files.ts';
import { generationSnapshot, type CapturePaths } from './paths.ts';
import {
  assertSeparateSettings,
  readSettings,
  settingsTarget,
  type Json,
  type SettingsRead,
} from './settings.ts';
import { readSnapshot, type ClaudeSnapshot } from './snapshot.ts';
import { readState, removeState, writeState, type CaptureState } from './state.ts';
import { shellQuote } from './wrapper.ts';

function referencesHook(read: SettingsRead, state: CaptureState): boolean {
  const line = JSON.stringify(read.value['statusLine']) ?? '';
  const asJson = (value: string): string => JSON.stringify(value).slice(1, -1);
  const escaped = state.script.replace(/([^\w/.-])/g, '\\$1');
  return [state.wrapper, state.script, shellQuote(state.script), escaped].some((value) =>
    line.includes(asJson(value)),
  );
}

/** Always check the recorded profile and, if a symlink moved, the original resolved target as well. */
function readRemovalPaths(state: CaptureState): SettingsRead[] {
  const profile = readSettings(state.settingsPath);
  if (
    state.v === 2 &&
    state.settingsRealPath !== null &&
    state.settingsRealPath !== profile.realPath
  ) {
    return [readSettings(state.settingsRealPath), profile];
  }
  return [profile];
}

export interface RemovalPreview {
  action: 'remove';
  settingsPath: string;
  files: {
    path: string;
    exists: boolean;
    current: unknown;
    next: Json | null;
    hookReferenced: boolean;
  }[];
  backupPath: string | null;
}

export function previewRemoval(state: CaptureState): RemovalPreview {
  return {
    action: 'remove',
    settingsPath: state.settingsPath,
    files: readRemovalPaths(state).map((read) => ({
      path: read.realPath,
      exists: read.exists,
      current: read.value['statusLine'] ?? null,
      next: state.previousStatusLine,
      hookReferenced: referencesHook(read, state),
    })),
    backupPath: state.backupPath,
  };
}

export function beginRemove(ctx: InstallContext, state: CaptureState | null): void {
  if (state === null || (state.v === 2 && state.phase === 'awaiting_removal')) return;
  let currentTarget: string | null = null;
  const snapshotId = state.v === 2 ? state.snapshotId : null;
  for (const path of new Set([state.settingsPath, ctx.settingsPath])) {
    let target: string;
    try {
      target = settingsTarget(path);
    } catch {
      // Pausing still works when the settings path cannot be resolved. Verification requires it.
      continue;
    }
    assertSeparateSettings(ctx.paths, path, target, snapshotId);
    if (path === state.settingsPath) currentTarget = target;
  }
  const realPath = state.v === 2 ? state.settingsRealPath : currentTarget;
  upgradeLegacyHook(ctx, state);
  writeState(ctx.paths, {
    ...state,
    v: 2,
    snapshotId,
    phase: 'awaiting_removal',
    settingsRealPath: realPath,
    expectedStatusLine: null,
  });
}

/** The migration accepts only the old, private Agent Productivity HQ file in its recorded generation. */
function retainedSnapshot(paths: CapturePaths, snapshotId: string | null): ClaudeSnapshot | null {
  const path = snapshotId === null ? paths.snapshot : generationSnapshot(paths, snapshotId);
  try {
    const expected = join(realpathSync(paths.dataDir), relative(paths.dataDir, path));
    if (realpathSync(path) !== expected) return null;
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 64 * 1024 ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    ) {
      return null;
    }
    const read = readSnapshot(path);
    return read.kind === 'ok' ? read.snapshot : null;
  } catch {
    return null;
  }
}

/** Pause an existing installation while keeping the owner's status line and manual recovery record. */
export function retireCapture(
  ctx: InstallContext,
  state: CaptureState | null,
  retainSnapshot?: (snapshot: ClaudeSnapshot) => void,
): void {
  if (state === null || (state.v === 2 && state.retired)) return;
  beginRemove(ctx, state);
  const paused = readState(ctx.paths);
  if (paused?.v !== 2) return;

  // Earlier script versions could still render their own limits while paused.
  // Update only the recorded Agent Productivity HQ artifact. Avoid overwriting any provider settings link.
  if (paused.script === ctx.paths.script) {
    if (existsSync(paused.script)) {
      for (const path of new Set([
        paused.settingsPath,
        ctx.settingsPath,
        paused.settingsRealPath,
      ])) {
        if (path !== null) {
          assertSeparateSettings(ctx.paths, path, settingsTarget(path), paused.snapshotId);
        }
      }
      writePrivateFile(paused.script, readFileSync(ctx.assetPath));
    }
    if (retainSnapshot && (state.v === 1 || state.phase !== 'awaiting_edit')) {
      const snapshot = retainedSnapshot(ctx.paths, paused.snapshotId);
      if (snapshot !== null) retainSnapshot(snapshot);
    }
  }
  writeState(ctx.paths, { ...paused, retired: true });
}

export function verifyRemove(ctx: InstallContext, state: CaptureState | null): void {
  if (state === null) return;
  if (state.v !== 2 || state.phase !== 'awaiting_removal') {
    throw conflict(state.settingsPath, 'Begin removal before verifying the settings edit.');
  }
  const settings = readRemovalPaths(state);
  for (const read of settings)
    assertSeparateSettings(ctx.paths, read.path, read.realPath, state.snapshotId);
  if (ctx.settingsPath !== state.settingsPath) {
    assertSeparateSettings(
      ctx.paths,
      ctx.settingsPath,
      settingsTarget(ctx.settingsPath),
      state.snapshotId,
    );
  }
  const referenced = settings.find((read) => referencesHook(read, state));
  if (referenced) {
    throw conflict(
      referenced.realPath,
      'This Claude Code settings file still references the capture hook. Edit the recorded settings file and verify again.',
    );
  }
  for (const path of [ctx.paths.script, ctx.paths.config, ctx.paths.snapshot])
    rmSync(path, { force: true });
  retireSnapshotGeneration(ctx.paths, state.snapshotId);
  removeState(ctx.paths);
}
