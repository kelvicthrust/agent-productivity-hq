import { ApiError } from '../../shared/contracts/errors.ts';
import type { GithubAccounts } from '../collectors/github/ports.ts';
import type { Runner } from '../collectors/runner.ts';
import type { Db } from '../db/open.ts';
import { checkpointResetData, clearAppData } from '../db/queries/reset.ts';
import { isResetSetupPending, readSetupState } from '../db/queries/setup.ts';
import type { ClaudeHooks } from '../integrations/claudeHooks/index.ts';
import type { ChatgptAccounts } from './accounts.ts';

export interface ResetOptions {
  db: Db;
  runner: Runner;
  timezone: string;
  github?: GithubAccounts | undefined;
  chatgpt?: ChatgptAccounts | undefined;
  claudeHooks?: ClaudeHooks | undefined;
  clearLegacyCapture?: () => void;
  clearRuntime?: () => void | Promise<void>;
}

export const RESET_PATH = '/api/setup/reset';

/** A confirmed reset (or its retry) finishes only after old WAL frames have been removed. */
export function finishResetStorage(db: Db): void {
  if (!checkpointResetData(db)) {
    throw new ApiError(
      'internal',
      'Another local process is reading HQ’s database. Close that reader and try again.',
    );
  }
}

export function createResetService(deps: ResetOptions) {
  const active = new Set<Promise<void>>();
  let resetting = false;

  const busy = () =>
    new ApiError('reset_in_progress', 'The app is resetting. Try again in a moment.');

  return {
    running: () => resetting,
    enter() {
      if (resetting) throw busy();
      let release!: () => void;
      const request = new Promise<void>((resolve) => {
        release = resolve;
      });
      active.add(request);
      return () => {
        active.delete(request);
        release();
      };
    },
    async reset() {
      if (resetting) throw busy();
      resetting = true;
      let cleanupStarted = false;
      try {
        // A request already in progress can start a refresh, finish a sign-in, or write SQLite.
        // Drain the requests first, then the refresh and any remaining background sign-ins.
        await Promise.all(active);
        if (!readSetupState(deps.db).complete) {
          if (isResetSetupPending(deps.db)) finishResetStorage(deps.db);
          return;
        }
        await deps.runner.idle();
        const clearGithub = deps.github?.prepareReset?.();
        cleanupStarted = true;
        deps.clearLegacyCapture?.();
        clearGithub?.();
        deps.chatgpt?.clearFlows?.();
        if (deps.claudeHooks) {
          try {
            // This uses the same ownership and conflict checks as the switch.
            const hooks = await deps.claudeHooks.set(false, { currentInstallationOnly: true });
            if (hooks.leftover !== null) throw new Error('Claude Code hook files remain');
          } catch {
            throw new ApiError(
              'claude_hooks_blocked',
              'HQ couldn’t remove its Claude Code hooks. Check the hooks section on this page, then try again.',
            );
          }
        }
        await deps.clearRuntime?.();
        clearAppData(deps.db, deps.timezone);
        finishResetStorage(deps.db);
      } catch (error) {
        if (!cleanupStarted) throw error;
        const failure =
          error instanceof ApiError
            ? error
            : new ApiError('internal', 'Try resetting the app again.');
        throw new ApiError(
          failure.code,
          `The reset didn’t finish. Some connections or hooks may already be off. ${failure.message}`,
          { status: failure.status, retryable: failure.retryable },
        );
      } finally {
        resetting = false;
      }
    },
  };
}

export type ResetService = ReturnType<typeof createResetService>;
