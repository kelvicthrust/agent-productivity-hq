import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CaptureRequest } from '../../../shared/contracts/accounts.ts';
import { adoptLegacy, installPlan, prepareInstall, verifyInstall } from './apply.ts';
import { CaptureError, CAPTURE_ERROR_CODES, conflict, type CaptureErrorCode } from './errors.ts';
import {
  computeHealth,
  countProjectOverrides,
  hookRunnable,
  type CaptureHealth,
} from './health.ts';
import { capturePaths, claudeSettingsPath, type CapturePaths } from './paths.ts';
import type { CapturePlan } from './plan.ts';
import {
  beginRemove,
  previewRemoval,
  retireCapture,
  verifyRemove,
  type RemovalPreview,
} from './revert.ts';
import { commandOf, readSettings, type SettingsRead } from './settings.ts';
import { readSnapshot, snapshotStamp, type ClaudeSnapshot, type SnapshotRead } from './snapshot.ts';
import { activeSnapshotPath, InvalidCaptureState, readState, type CaptureState } from './state.ts';

export { CaptureError, CAPTURE_ERROR_CODES, type CaptureErrorCode };
export type { CaptureHealth, CapturePaths, CapturePlan };
export type { CaptureHealthState } from './health.ts';
export { readSnapshot, snapshotStamp, type ClaudeSnapshot, type SnapshotRead } from './snapshot.ts';
export { capturePaths, claudeSettingsPath } from './paths.ts';

export interface ClaudeCaptureOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  nodePath?: string;
  now?: () => number;
  /** Local project folders, for a presence-only count of known project status lines. */
  projectDirs?: () => readonly string[] | Promise<readonly string[]>;
}

type InstallPreview = Omit<CapturePlan, 'previousCommand' | 'previousStatusLine'> & {
  projectOverrides: number;
};
export type CapturePreview = InstallPreview | RemovalPreview;
type CapturePreviewAction = 'install' | 'remove';
type HistoricalCaptureRequest =
  { action: 'prepare_install'; confirm: string } | { action: 'verify_install' } | CaptureRequest;

export interface ClaudeCapture {
  readonly settingsPath: string;
  readonly paths: CapturePaths;
  initialize(): void;
  retire(retainSnapshot?: (snapshot: ClaudeSnapshot) => void): void;
  removalHealth(): Pick<
    CaptureHealth,
    'phase' | 'state' | 'recorded' | 'settingsPath' | 'backupPath'
  >;
  plan(): CapturePlan;
  preview(action: 'install'): Promise<InstallPreview>;
  preview(action: 'remove'): Promise<RemovalPreview>;
  preview(action: CapturePreviewAction): Promise<CapturePreview>;
  change(request: HistoricalCaptureRequest): void;
  canCollect(): boolean;
  activeSnapshotPath(): string | null;
  snapshot(): SnapshotRead;
  snapshotStamp(): string | null;
  health(): Promise<CaptureHealth>;
}

const ASSET = join(import.meta.dirname, 'assets', 'claude-statusline.mjs');

export function createClaudeCapture(options: ClaudeCaptureOptions): ClaudeCapture {
  const paths = capturePaths(options.dataDir);
  const settingsPath = claudeSettingsPath(options.env ?? process.env, options.home ?? homedir());
  const node = options.nodePath ?? process.execPath;
  const now = options.now ?? Date.now;
  const ctx = { settingsPath, paths, node, now, assetPath: ASSET };
  const dirs = async (): Promise<readonly string[]> => (await options.projectDirs?.()) ?? [];

  function stateForChange(): CaptureState | null {
    try {
      return readState(paths);
    } catch (error) {
      if (!(error instanceof InvalidCaptureState)) throw error;
      throw conflict(settingsPath, error.message);
    }
  }

  const plan = (): CapturePlan => installPlan(ctx, stateForChange());
  const snapshotPath = (): string | null => activeSnapshotPath(paths);
  const snapshot = (): SnapshotRead => {
    const path = snapshotPath();
    return path === null ? { kind: 'absent' } : readSnapshot(path);
  };

  async function preview(action: 'install'): Promise<InstallPreview>;
  async function preview(action: 'remove'): Promise<RemovalPreview>;
  async function preview(action: CapturePreviewAction): Promise<CapturePreview>;
  async function preview(action: CapturePreviewAction): Promise<CapturePreview> {
    if (action === 'remove') {
      const state = stateForChange();
      if (state === null) return { action, settingsPath, files: [], backupPath: null };
      return previewRemoval(state);
    }
    const made = plan();
    return {
      action,
      settingsPath: made.settingsPath,
      resolvedSettingsPath: made.resolvedSettingsPath,
      settingsFileExists: made.settingsFileExists,
      current: made.current,
      next: made.next,
      wrapperCommand: made.wrapperCommand,
      notes: made.notes,
      sampleStatusRow: made.sampleStatusRow,
      previewDigest: made.previewDigest,
      projectOverrides: await countProjectOverrides(await dirs(), settingsPath),
    };
  }

  return {
    settingsPath,
    paths,
    initialize() {
      const state = readState(paths);
      if (state !== null) adoptLegacy(ctx, state);
    },
    retire(retainSnapshot) {
      retireCapture(ctx, stateForChange(), retainSnapshot);
    },
    removalHealth() {
      try {
        const state = readState(paths);
        return {
          phase: state === null ? 'off' : 'awaiting_removal',
          state: state === null ? 'off' : 'awaiting_removal',
          recorded: state !== null,
          settingsPath: state?.settingsPath ?? null,
          backupPath: state?.backupPath ?? null,
        };
      } catch {
        return {
          phase: 'needs_attention',
          state: 'state_unreadable',
          recorded: false,
          settingsPath: null,
          backupPath: null,
        };
      }
    },
    plan,
    preview,
    change(request) {
      const state = stateForChange();
      switch (request.action) {
        case 'prepare_install':
          prepareInstall(ctx, state, request.confirm);
          break;
        case 'verify_install':
          verifyInstall(ctx, state);
          break;
        case 'begin_remove':
          beginRemove(ctx, state);
          break;
        case 'verify_remove':
          verifyRemove(ctx, state);
          break;
      }
    },
    canCollect() {
      try {
        const state = readState(paths);
        if (
          state?.v !== 2 ||
          state.phase !== 'active' ||
          state.snapshotId === null ||
          state.settingsPath !== settingsPath
        )
          return false;
        const read = readSettings(settingsPath);
        return (
          read.realPath === state.settingsRealPath &&
          commandOf(read) === state.wrapper &&
          hookRunnable(state)
        );
      } catch {
        return false;
      }
    },
    activeSnapshotPath: snapshotPath,
    snapshot,
    snapshotStamp() {
      const path = snapshotPath();
      return path === null ? null : snapshotStamp(path);
    },
    async health() {
      let state: CaptureState | null = null;
      let invalid = false;
      let settings: SettingsRead | null = null;
      try {
        state = readState(paths);
      } catch {
        invalid = true;
      }
      try {
        settings = readSettings(state?.settingsPath ?? settingsPath);
      } catch {
        // An unreadable profile is reported as such.
      }
      return computeHealth({
        state,
        invalid,
        settings,
        selectedPath: settingsPath,
        snapshot: snapshot(),
        hookRunnable: state === null || hookRunnable(state),
        now: now(),
        projectOverrides: await countProjectOverrides(
          await dirs(),
          state?.settingsPath ?? settingsPath,
        ),
      });
    },
  };
}
