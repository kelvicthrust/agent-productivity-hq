import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { ensureDir } from '../../lib/fsModes.ts';
import { conflict } from './errors.ts';
import { writePrivateFile } from './files.ts';
import { hookRunnable } from './health.ts';
import { generationSnapshot, snapshotDirectory, type CapturePaths } from './paths.ts';
import { buildPlan, type CapturePlan } from './plan.ts';
import {
  assertSeparateSettings,
  commandOf,
  readSettings,
  settingsTarget,
  statusLineOf,
} from './settings.ts';
import { readSnapshot } from './snapshot.ts';
import { type CaptureState, type ManualCaptureState, writeState } from './state.ts';

export interface InstallContext {
  settingsPath: string;
  paths: CapturePaths;
  node: string;
  assetPath: string;
  now: () => number;
}

export function installPlan(ctx: InstallContext, state: CaptureState | null): CapturePlan {
  const { settingsPath, paths, node } = ctx;
  if (state !== null && state.settingsPath !== settingsPath) {
    throw conflict(
      state.settingsPath,
      'Finish removing capture from the recorded profile before setting it up in this one.',
    );
  }
  if (state?.v === 2 && state.phase === 'awaiting_removal') {
    throw conflict(settingsPath, 'Finish removing the current capture before preparing a new one.');
  }
  const read = readSettings(settingsPath);
  assertSeparateSettings(
    paths,
    settingsPath,
    read.realPath,
    state?.v === 2 ? state.snapshotId : null,
  );
  if (state?.v === 2 && read.realPath !== state.settingsRealPath) {
    throw conflict(
      settingsPath,
      'This settings file points to a different target. Finish removing capture from the recorded profile first.',
    );
  }
  return buildPlan({
    read,
    state,
    paths,
    node,
    keepPrepared: state !== null && hookRunnable(state),
  });
}

function createSnapshotGeneration(paths: CapturePaths): string {
  const id = randomBytes(12).toString('hex');
  ensureDir(snapshotDirectory(paths, id));
  return id;
}

export function retireSnapshotGeneration(paths: CapturePaths, id: string | null): void {
  if (id !== null) rmSync(snapshotDirectory(paths, id), { recursive: true, force: true });
}

export function prepareInstall(
  ctx: InstallContext,
  state: CaptureState | null,
  digest: string,
): void {
  const plan = installPlan(ctx, state);
  if (digest !== plan.previewDigest) throw conflict(plan.settingsPath);
  if (state?.v === 2 && state.phase === 'awaiting_edit' && hookRunnable(state)) return;
  if (
    state?.v === 2 &&
    state.phase === 'active' &&
    plan.current?.['command'] === state.wrapper &&
    plan.wrapperCommand === state.wrapper &&
    hookRunnable(state)
  )
    return;

  ensureDir(ctx.paths.dataDir);
  ensureDir(ctx.paths.captureDir);
  const script = readFileSync(ctx.assetPath);
  writePrivateFile(
    ctx.paths.config,
    `${JSON.stringify({ previousCommand: plan.previousCommand })}\n`,
  );
  writePrivateFile(ctx.paths.script, script);
  rmSync(ctx.paths.snapshot, { force: true });

  const snapshotId = createSnapshotGeneration(ctx.paths);
  try {
    writeState(ctx.paths, {
      v: 2,
      snapshotId,
      phase: 'awaiting_edit',
      settingsPath: plan.settingsPath,
      settingsRealPath: plan.resolvedSettingsPath,
      node: ctx.node,
      script: ctx.paths.script,
      wrapper: plan.wrapperCommand,
      previousStatusLine: plan.previousStatusLine,
      expectedStatusLine: plan.next,
      backupPath: state?.backupPath ?? null,
      installedAt: state?.installedAt ?? ctx.now(),
    });
  } catch (error) {
    retireSnapshotGeneration(ctx.paths, snapshotId);
    throw error;
  }
  if (state?.v === 2) retireSnapshotGeneration(ctx.paths, state.snapshotId);
}

export function verifyInstall(ctx: InstallContext, state: CaptureState | null): void {
  if (state === null || state.v !== 2 || state.phase === 'awaiting_removal') {
    throw conflict(ctx.settingsPath, 'Prepare a Claude Code settings edit before verifying it.');
  }
  if (state.settingsPath !== ctx.settingsPath) {
    throw conflict(
      state.settingsPath,
      'Verify the edit using the Claude Code profile where capture was prepared.',
    );
  }
  const read = readSettings(state.settingsPath);
  if (read.realPath !== state.settingsRealPath) throw conflict(state.settingsPath);
  if (
    state.phase === 'awaiting_edit'
      ? !isDeepStrictEqual(statusLineOf(read), state.expectedStatusLine)
      : commandOf(read) !== state.wrapper
  ) {
    throw conflict(
      state.settingsPath,
      'Save the status line shown in the preview, then verify the edit again.',
    );
  }
  if (!hookRunnable(state)) {
    throw conflict(
      state.settingsPath,
      'The capture hook can’t run. Review setup again to prepare the hook.',
    );
  }
  if (state.phase === 'awaiting_edit') {
    if (state.snapshotId === null)
      throw conflict(state.settingsPath, 'Prepare the capture hook again before verifying it.');
    assertSeparateSettings(ctx.paths, read.path, read.realPath, state.snapshotId);
    writeState(ctx.paths, { ...state, phase: 'active' });
  }
}

export function upgradeLegacyHook(ctx: InstallContext, state: CaptureState): void {
  if (state.v === 1 && state.script === ctx.paths.script && existsSync(ctx.paths.script)) {
    writePrivateFile(ctx.paths.script, readFileSync(ctx.assetPath));
  }
}

/** Adopt only a verified v1 command. Its existing backup and original status line stay intact. */
export function adoptLegacy(ctx: InstallContext, state: CaptureState): void {
  if (state.v !== 1) return;
  for (const path of new Set([state.settingsPath, ctx.settingsPath])) {
    assertSeparateSettings(ctx.paths, path, settingsTarget(path));
  }
  upgradeLegacyHook(ctx, state);
  if (state.settingsPath !== ctx.settingsPath || state.script !== ctx.paths.script) return;
  const read = readSettings(state.settingsPath);
  if (commandOf(read) !== state.wrapper || !hookRunnable(state)) return;

  const snapshotId = createSnapshotGeneration(ctx.paths);
  const migrated: ManualCaptureState = {
    ...state,
    v: 2,
    snapshotId,
    phase: 'active',
    settingsRealPath: read.realPath,
    expectedStatusLine: statusLineOf(read),
  };
  try {
    const prior = readSnapshot(ctx.paths.snapshot);
    if (prior.kind === 'ok') {
      writePrivateFile(
        generationSnapshot(ctx.paths, snapshotId),
        `${JSON.stringify(prior.snapshot)}
`,
      );
    }
    writeState(ctx.paths, migrated);
  } catch (error) {
    retireSnapshotGeneration(ctx.paths, snapshotId);
    throw error;
  }
  rmSync(ctx.paths.snapshot, { force: true });
}
