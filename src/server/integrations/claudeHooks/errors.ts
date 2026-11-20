import type { ClaudeHooksFileReason } from '../../../shared/contracts/hq.ts';

/**
 * Why a settings change did not happen. A fixed code: the file's own text and the path are never part of it.
 *   conflict          a settings file kept changing while HQ was updating it, so nothing was written
 *   no_folder         there is no Claude Code folder (or HQ has shut down)
 *   stale_preview     the preview the owner confirmed is not the plan for this action as the files are now (or none was sent)
 *   registry_failed   the running app could not publish where it listens, so nothing was left turned on
 *   rollback_failed   a change failed part-way and a file could not be put back: `files` names it
 *   unsupported_path  HQ's data folder or Node path has a character that cannot be put in a shell command and read back
 */
export type HooksFailure =
  | ClaudeHooksFileReason
  | 'conflict'
  | 'no_folder'
  | 'stale_preview'
  | 'registry_failed'
  | 'rollback_failed'
  | 'unsupported_path';

/**
 * Something HQ made while doing a change and, when the change failed, did not take back because it was no longer exactly what HQ
 * wrote (the owner saved over it) or could not be removed. It is left as it is and named, never silently.
 */
export type LeftBehind = 'script' | 'registry' | 'backup' | 'temp';

export class ClaudeHooksError extends Error {
  readonly failure: HooksFailure;
  /** For `rollback_failed`: the settings files that need attention, as the owner knows them (`~/…` under the home folder). */
  readonly files: readonly string[];
  /** What HQ made during the change and left in place (see `LeftBehind`). */
  readonly left: readonly LeftBehind[];
  constructor(
    failure: HooksFailure,
    files: readonly string[] = [],
    left: readonly LeftBehind[] = [],
  ) {
    super(failure);
    this.name = 'ClaudeHooksError';
    this.failure = failure;
    this.files = files;
    this.left = left;
  }

  /** The same failure, with more left behind. */
  with(more: readonly LeftBehind[]): ClaudeHooksError {
    return new ClaudeHooksError(this.failure, this.files, [...new Set([...this.left, ...more])]);
  }
}
