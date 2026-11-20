import { replaceRateLimits, type RateLimitInput } from '../../db/queries/accounts.ts';
import {
  readSnapshot,
  snapshotStamp,
  type ClaudeSnapshot,
} from '../../integrations/claudeCapture/snapshot.ts';
import type { AdapterContext, AdapterReport } from '../types.ts';

// The Claude account collector (id `claude_account`; data-and-sources › Claude account report, Collector).
//
// It reads ONE file, the snapshot the opt-in status-line hook writes (in Agent Productivity HQ's active capture directory), validates it and stores the two
// percent windows through `replaceRateLimits`. It never starts Claude Code, never reads Claude Code's own files or credentials,
// never writes outside the database and never makes a network call. Percentages stay percentages: there is no conversion to tokens
// and nothing here reaches usage events, sessions, repo rows or links (P-34 to P-38).
//
//   no snapshot file       skipped: capture is off, or Claude Code has not reported yet. Nothing is recorded.
//   file not valid         failed ("Couldn't read the Claude snapshot"); the stored windows stay as they were, and the next hook run
//                          rewrites the file
//   valid                  the windows it holds replace the stored ones (a window it no longer holds is removed: the newest report is
//                          the truth). A window already past its `resets_at` is stored as it is; the card says "Window reset".

/** The two windows Claude Code reports, with their length in minutes (5 hours, 7 days). */
const WINDOWS = [
  { key: 'five_hour', limitId: 'five_hour', windowMinutes: 300 },
  { key: 'seven_day', limitId: 'seven_day', windowMinutes: 10_080 },
] as const;

/** Sentences a run and Sources show. Fixed text: nothing read from the file is ever in one. */
export const CLAUDE_ACCOUNT_MESSAGE = {
  noSnapshot: 'Claude plan usage is off, or Claude Code hasn’t reported yet.',
  unreadable: 'Couldn’t read the Claude snapshot',
  unreadableKept: 'Couldn’t read the Claude snapshot. The last percentages are kept.',
  storeFailed: 'Couldn’t save the Claude plan usage. The last percentages are kept.',
} as const;

export interface ClaudeAccountCollectorOptions {
  /** The snapshot path for the current verified capture. */
  snapshotPath: () => string | null;
}

export interface ClaudeAccountCollector {
  /** The `source_state` id this collector reports under. */
  readonly id: 'claude_account';
  /** Same contract as `SourceAdapter.refresh`: one incremental attempt, a report and never a throw for a classified failure. */
  refresh(context: AdapterContext): Promise<AdapterReport>;
  /** Changes whenever the hook replaces the file (or it appears or goes); run `refresh` again when it does. */
  stamp(): string | null;
}

/** The windows a snapshot holds, as the account tables take them (reset times in epoch ms). */
export function limitsOf(snapshot: ClaudeSnapshot): RateLimitInput[] {
  const limits: RateLimitInput[] = [];
  for (const { key, limitId, windowMinutes } of WINDOWS) {
    const window = snapshot[key];
    if (window === null) continue;
    limits.push({
      limitId,
      usedPercent: window.used_percentage,
      windowMinutes,
      resetsAt: window.resets_at * 1000,
    });
  }
  return limits;
}

export function createClaudeAccountCollector(
  options: ClaudeAccountCollectorOptions,
): ClaudeAccountCollector {
  return {
    id: 'claude_account',
    stamp() {
      const path = options.snapshotPath();
      return path === null ? null : snapshotStamp(path);
    },
    async refresh({ db, now, logger }) {
      const path = options.snapshotPath();
      const read = path === null ? ({ kind: 'absent' } as const) : readSnapshot(path);
      if (read.kind === 'absent') {
        return { result: 'skipped', message: CLAUDE_ACCOUNT_MESSAGE.noSnapshot };
      }
      if (read.kind === 'invalid') {
        logger.warn('the Claude snapshot could not be read', {
          source: 'claude_account',
          code: 'snapshot_unreadable',
        });
        return {
          result: 'failed',
          errorCode: 'snapshot_unreadable',
          errorDetail: CLAUDE_ACCOUNT_MESSAGE.unreadable,
          message: CLAUDE_ACCOUNT_MESSAGE.unreadableKept,
        };
      }

      const { snapshot } = read;
      const limits = limitsOf(snapshot);
      // The report's own time: when a window was last updated. With no window to date, the hook's last run, then now.
      const fetchedAt =
        (snapshot.captured_at ?? snapshot.invoked_at ?? Math.floor(now() / 1000)) * 1000;
      try {
        replaceRateLimits(db, 'claude', limits, fetchedAt);
      } catch (error) {
        logger.warn('the Claude plan usage could not be stored', {
          source: 'claude_account',
          code: 'store_failed',
          reason: error instanceof Error ? error.name : 'error',
        });
        return {
          result: 'failed',
          errorCode: 'store_failed',
          errorDetail: CLAUDE_ACCOUNT_MESSAGE.storeFailed,
          message: CLAUDE_ACCOUNT_MESSAGE.storeFailed,
        };
      }
      logger.debug('claude plan usage stored', {
        source: 'claude_account',
        windows: limits.length,
      });
      return { result: 'succeeded' };
    },
  };
}
