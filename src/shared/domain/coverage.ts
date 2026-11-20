import type { DeliveryCoverage, Provider, UsageCoverage } from '../contracts/common.ts';
import { addDays, formatDayLong, minDate } from './periods.ts';

// Coverage classification (P-04, P-05, P-07). Pure. A bucket is `future` before it starts, and otherwise each provider
// is classified against what this machine actually has: never found (none), entirely before the oldest imported date
// (unavailable), straddling it (partial), after a failed refresh's last good day (stale), or ok.
// Coverage decides what a total means: a covered bucket with no events is a real zero; an uncovered one is null.

/** How long imported history is kept (P-29): retention deletes what is older than today minus this many days. */
export const RETENTION_DAYS = 366;

/**
 * The oldest date retention keeps on `today`. Real history reaches further back than that (a first import of a year-old Codex
 * folder), and the stored "oldest imported date" is written before retention prunes it, so it can name a day whose events are
 * already gone. Coverage never reaches back beyond this date: a day before it is history this app no longer holds, not a zero.
 */
export const retentionHorizon = (today: string): string => addDays(today, -RETENTION_DAYS);

/** The date a source's coverage really starts: its oldest imported date, or the retention horizon if that is later. */
export function coveredFrom(oldestDate: string, today: string): string {
  const horizon = retentionHorizon(today);
  return oldestDate > horizon ? oldestDate : horizon;
}

export interface DateSpan {
  start: string;
  end: string;
}

export interface SourceCoverageInput {
  /** The source was found on this machine and has imported records. */
  found: boolean;
  /** The oldest date with imported data. */
  oldestDate?: string | null | undefined;
  /** The last date fully collected before a failed refresh. */
  staleAfter?: string | null | undefined;
}

export function providerCoverage(
  bucket: DateSpan,
  source: SourceCoverageInput | undefined,
  today: string,
): UsageCoverage {
  if (bucket.start > today) return 'future';
  if (!source || !source.found || !source.oldestDate) return 'none';
  const oldest = coveredFrom(source.oldestDate, today);
  if (bucket.end < oldest) return 'unavailable';
  if (bucket.start < oldest) return 'partial';
  if (source.staleAfter && bucket.end > source.staleAfter) return 'stale';
  return 'ok';
}

/** The one rail value for a bucket, combining the in-scope providers (same rules as the prototype's coverage strip). */
export function railCoverage(coverages: readonly UsageCoverage[]): UsageCoverage {
  if (coverages.length === 0) return 'none';
  if (coverages.every((c) => c === 'future')) return 'future';
  if (coverages.every((c) => c === 'unavailable' || c === 'none')) return 'unavailable';
  if (coverages.some((c) => c !== 'ok')) return 'partial';
  return 'ok';
}

export interface DeliveryCoverageInput {
  /** Active tracked repos in scope. */
  activeRepos: number;
  /** Any in-scope repo whose first backfill has not finished. */
  backfillIncomplete: boolean;
}

export function deliveryCoverage(
  bucket: Pick<DateSpan, 'start'>,
  input: DeliveryCoverageInput,
  today: string,
): DeliveryCoverage {
  if (bucket.start > today) return 'future';
  if (input.activeRepos === 0) return 'none';
  if (input.backfillIncomplete) return 'syncing';
  return 'ok';
}

/** A total is shown only where the data exists: `null` for unavailable, none and future; `0` is a covered zero. */
export function tokenValue(coverage: UsageCoverage, total: number): number | null {
  return coverage === 'unavailable' || coverage === 'none' || coverage === 'future' ? null : total;
}

/** Merged PR counts are shown only where delivery is tracked and not in the future. */
export function prValue(coverage: DeliveryCoverage, count: number): number | null {
  return coverage === 'none' || coverage === 'future' ? null : count;
}

/** "History unavailable before <date>" for the chart; the plain no-records sentence when nothing was found. */
export function unavailableText(oldestDates: readonly (string | null | undefined)[]): string {
  const dates = oldestDates.filter((d): d is string => Boolean(d)).sort();
  return dates.length > 0
    ? `History unavailable before ${formatDayLong(dates[0]!)}`
    : 'No local records on this machine';
}

export interface TrueZeroInput {
  range: DateSpan;
  today: string;
  /** The providers in scope. */
  providers: readonly Provider[];
  sources: Partial<Record<Provider, SourceCoverageInput>>;
  delivery: DeliveryCoverage;
  events: number;
  merges: number;
}

/**
 * The quiet panel: every in-scope provider is ok across the elapsed part of the range, delivery is ok (so at least one
 * active tracked repo), and there are no events and no merges. Anything uncovered is "unavailable", never zero.
 */
export function isTrueZero(input: TrueZeroInput): boolean {
  if (input.range.start > input.today) return false;
  if (input.providers.length === 0 || input.delivery !== 'ok') return false;
  const elapsed = { start: input.range.start, end: minDate(input.range.end, input.today) };
  const covered = input.providers.every(
    (provider) => providerCoverage(elapsed, input.sources[provider], input.today) === 'ok',
  );
  return covered && input.events === 0 && input.merges === 0;
}
