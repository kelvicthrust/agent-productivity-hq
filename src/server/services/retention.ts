import { RETENTION_DAYS } from '../../shared/domain/coverage.ts';
import { addDays, todayIn, utcBounds } from '../../shared/domain/periods.ts';
import type { Db } from '../db/open.ts';
import { type PruneCounts, pruneBefore } from '../db/queries/retention.ts';

// Rows older than today minus 366 days are pruned (P-29), at boot, daily at 03:00 report time and after every refresh run. The
// number lives in shared/domain/coverage.ts so coverage and retention cannot disagree about where history ends. Calendar math
// happens in the report timezone. Repos (stopped ones too), owner decisions on PRs that are still held, and settings are never touched.
export { RETENTION_DAYS };

export interface RetentionResult extends PruneCounts {
  today: string;
  cutoff: string;
}

export function runRetention(
  db: Db,
  options: { nowMs: number; timezone: string },
): RetentionResult {
  const today = todayIn(options.nowMs, options.timezone);
  const cutoff = addDays(today, -RETENTION_DAYS);
  const counts = pruneBefore(db, utcBounds(cutoff, options.timezone).start);
  return { ...counts, today, cutoff };
}
