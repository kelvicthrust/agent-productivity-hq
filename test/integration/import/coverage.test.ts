import { describe, expect, it } from 'vitest';
import {
  RETENTION_DAYS,
  coveredFrom,
  providerCoverage,
  retentionHorizon,
} from '../../../src/shared/domain/coverage.ts';
import { addDays } from '../../../src/shared/domain/periods.ts';

// Coverage where real history meets retention (P-29, P-04). A source's stored "oldest imported date" is written by the attempt,
// BEFORE the run's retention step prunes what is older than today minus 366 days, so after the first import of a long history
// it can name a day whose events are already gone (see retention.test.ts). Coverage must not claim those days.

const today = '2027-10-02';
const horizon = '2026-10-01'; // today minus 366 days
const bucket = (start: string, end = start) => ({ start, end });

describe('the retention horizon', () => {
  it('is today minus 366 days', () => {
    expect(RETENTION_DAYS).toBe(366);
    expect(retentionHorizon(today)).toBe(horizon);
    expect(addDays(today, -RETENTION_DAYS)).toBe(horizon);
  });

  it('is where coverage starts when the stored oldest date is older, and not before the stored date otherwise', () => {
    expect(coveredFrom('2025-01-01', today)).toBe(horizon);
    expect(coveredFrom(horizon, today)).toBe(horizon);
    expect(coveredFrom('2026-10-12', today)).toBe('2026-10-12');
  });
});

describe('providerCoverage over history older than the horizon', () => {
  const longHistory = { found: true, oldestDate: '2025-09-28' }; // imported on a first run, before the prune

  it('treats days before the horizon as unavailable, the straddling bucket as partial, and the rest as ok', () => {
    expect(providerCoverage(bucket('2026-09-20', '2026-09-30'), longHistory, today)).toBe(
      'unavailable',
    );
    expect(providerCoverage(bucket('2026-09-26', '2026-10-02'), longHistory, today)).toBe(
      'partial',
    );
    expect(providerCoverage(bucket('2026-10-01', '2026-10-07'), longHistory, today)).toBe('ok');
    expect(providerCoverage(bucket('2027-09-27', '2027-10-03'), longHistory, today)).toBe('ok');
  });

  it('agrees, right after the first import, with what the next refresh will say once the stored date is corrected', () => {
    const afterNextRefresh = { found: true, oldestDate: '2026-10-01' }; // the oldest event that was kept
    for (const [start, end] of [
      ['2026-09-20', '2026-09-30'],
      ['2026-09-26', '2026-10-02'],
      ['2026-10-01', '2026-10-07'],
      ['2027-09-27', '2027-10-02'],
    ] as const)
      expect(providerCoverage(bucket(start, end), longHistory, today), `${start}..${end}`).toBe(
        providerCoverage(bucket(start, end), afterNextRefresh, today),
      );
  });

  it('leaves recent history exactly as it was: only the retention horizon is new', () => {
    const recent = { found: true, oldestDate: '2026-11-02' };
    expect(providerCoverage(bucket('2026-10-26', '2026-11-01'), recent, today)).toBe('unavailable');
    expect(providerCoverage(bucket('2026-10-31', '2026-11-02'), recent, today)).toBe('partial');
    expect(providerCoverage(bucket('2026-11-02'), recent, today)).toBe('ok');
    expect(providerCoverage(bucket('2027-10-03'), recent, today)).toBe('future');
    expect(providerCoverage(bucket('2027-09-20'), { found: false }, today)).toBe('none');
  });

  it('still says stale after the last collected day, inside the retained window', () => {
    const failed = { found: true, oldestDate: '2025-09-28', staleAfter: '2027-09-30' };
    expect(providerCoverage(bucket('2027-09-30'), failed, today)).toBe('ok');
    expect(providerCoverage(bucket('2027-10-01', '2027-10-02'), failed, today)).toBe('stale');
  });
});
