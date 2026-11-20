import { describe, expect, it } from 'vitest';
import {
  applyChange,
  canonicalSearch,
  clampRange,
  decodeFilters,
  defaultFilters,
  encodeFilters,
  latestEnd,
  searchAfter,
  type FilterContext,
} from '../../src/client/lib/filters.ts';

// G4_6, the codec's pure half: what a URL means and what a filter change writes back. Wed Nov 4, 2026 is "today", so the
// default week is Mon Nov 2 to Sun Nov 8 and the 12-month lookback starts a year before.

const ctx: FilterContext = { today: '2026-11-04', lookbackStart: '2025-11-04' };
const decode = (search: string) => decodeFilters(new URLSearchParams(search), ctx);

describe('the default view', () => {
  it('is This week, every repo, every provider, my PRs; no params at all', () => {
    expect(decode('')).toEqual({
      start: '2026-11-02',
      end: '2026-11-08',
      gran: 'day',
      repos: [],
      provider: 'all',
      author: 'mine',
    });
    expect(encodeFilters(defaultFilters(ctx), ctx)).toEqual({});
  });

  it('a URL that spells the defaults out is rewritten to the short one, and a short one is left alone', () => {
    expect(canonicalSearch('?provider=all&author=mine&start=2026-11-02&end=2026-11-08', ctx)).toBe(
      '',
    );
    expect(canonicalSearch('', ctx)).toBeNull();
    expect(canonicalSearch('?provider=codex', ctx)).toBeNull();
  });
});

describe('what a URL may say', () => {
  it('round-trips every non-default filter', () => {
    const filters = {
      start: '2026-10-05',
      end: '2026-11-03',
      gran: 'week' as const,
      repos: ['kelvin/atlas-api', 'kelvin/crew'],
      provider: 'claude' as const,
      author: 'all' as const,
    };
    const params = new URLSearchParams(encodeFilters(filters, ctx));
    expect(decodeFilters(params, ctx)).toEqual(filters);
  });

  it('clamps a custom range to the 12-month lookback and to the end of the current month', () => {
    const wide = decode('?start=2020-01-01&end=2031-01-01');
    expect(wide.start).toBe('2025-11-04');
    expect(wide.end).toBe('2026-11-30');
  });

  it('puts a reversed range the right way round, and ignores values it does not know', () => {
    expect(decode('?start=2026-11-03&end=2026-10-05')).toMatchObject({
      start: '2026-10-05',
      end: '2026-11-03',
    });
    expect(decode('?start=2026-02-30&provider=gemini&author=nobody&gran=hour')).toEqual(decode(''));
  });

  it('lists repos once each, sorted', () => {
    expect(decode('?repos=kelvin/b,kelvin/a,kelvin/b,,').repos).toEqual(['kelvin/a', 'kelvin/b']);
  });
});

describe('the range the API takes (latestEnd, clampRange)', () => {
  it('ends at the end of the current month when that is later than the end of the week', () => {
    expect(latestEnd(ctx)).toBe('2026-11-30');
  });

  it('ends at the end of the current week when that is later than the end of the month', () => {
    // Wed Dec 30: the month ends Dec 31, the week ends Sun Jan 3
    expect(latestEnd({ today: '2026-12-30', lookbackStart: '2025-12-30' })).toBe('2027-01-03');
  });

  it('moves only a date that is outside the lookback or later than the latest end', () => {
    const range = (start: string, end: string) => ({ start, end });
    expect(clampRange(range('2026-11-02', '2026-11-08'), ctx)).toEqual(
      range('2026-11-02', '2026-11-08'),
    );
    expect(clampRange(range('2026-11-06', '2026-11-06'), ctx)).toEqual(
      range('2026-11-06', '2026-11-06'),
    );
    expect(clampRange(range('2025-10-27', '2025-11-09'), ctx)).toEqual(
      range('2025-11-04', '2025-11-09'),
    );
    expect(clampRange(range('2026-11-23', '2026-12-06'), ctx)).toEqual(
      range('2026-11-23', '2026-11-30'),
    );
  });

  it('is the rule a URL is read with: decoding agrees with clampRange for any dates', () => {
    for (const start of ['2025-10-01', '2025-11-04', '2026-11-02', '2026-11-30', '2026-12-05']) {
      for (const end of ['2025-11-10', '2026-11-04', '2026-11-08', '2026-11-30', '2027-02-01']) {
        if (start > end) continue;
        const read = decode(`?start=${start}&end=${end}`);
        expect({ start: read.start, end: read.end }).toEqual(clampRange({ start, end }, ctx));
      }
    }
  });
});

describe('what a change writes', () => {
  it('a new range takes the default grouping for its length, and Reset goes back to the default view', () => {
    const year = applyChange(decode(''), { period: 'last-12m' }, ctx);
    expect(year.gran).toBe('month');
    expect(applyChange(year, { reset: true }, ctx)).toEqual(defaultFilters(ctx));
  });

  it('keeps params it does not own, and drops a selected bucket when the range moves', () => {
    expect(searchAfter('?sel=2026-11-02&q=atlas', { period: 'last-30' }, ctx)).toBe(
      '?start=2026-10-06&end=2026-11-04&q=atlas',
    );
    expect(searchAfter('?sel=2026-11-02&q=atlas', { provider: 'codex' }, ctx)).toBe(
      '?provider=codex&sel=2026-11-02&q=atlas',
    );
  });
});
