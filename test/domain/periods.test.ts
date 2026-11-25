import { describe, expect, it } from 'vitest';
import {
  addDays,
  bucketIndexOf,
  bucketsFor,
  checkRange,
  dateInZone,
  defaultGranularity,
  diffDays,
  isDateString,
  isTimeZone,
  lookbackStart,
  monthEnd,
  presetRange,
  previousRange,
  rangeBounds,
  utcBounds,
  weekStart,
  type PeriodBucket,
} from '../../src/shared/domain/periods';

const LA = 'America/Los_Angeles';
const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

describe('Temporal', () => {
  it('is a global on this runtime (Node 26), so no date library is needed', () => {
    expect(typeof Temporal.ZonedDateTime).toBe('function');
  });
});

describe('calendar helpers', () => {
  it('uses Monday-start weeks, including from a Sunday', () => {
    expect(weekStart('2026-11-04')).toBe('2026-11-02'); // Wednesday
    expect(weekStart('2026-11-02')).toBe('2026-11-02'); // Monday
    expect(weekStart('2026-11-08')).toBe('2026-11-02'); // Sunday belongs to the week before
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
  });

  it('adds and counts days across month, year and leap boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-11-01', '2026-11-08')).toBe(7);
    expect(diffDays('2026-11-08', '2026-11-01')).toBe(-7);
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    expect(monthEnd('2028-02-10')).toBe('2028-02-29');
  });

  it('accepts only real calendar dates', () => {
    expect(isDateString('2026-02-28')).toBe(true);
    expect(isDateString('2026-02-30')).toBe(false);
    expect(isDateString('2026-2-3')).toBe(false);
    expect(isDateString('2026-11-04T00:00:00Z')).toBe(false);
    expect(isTimeZone(LA)).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });

  it('puts the lookback 365 days before today', () => {
    expect(lookbackStart('2026-11-04')).toBe('2025-11-04');
  });
});

describe('local midnight', () => {
  it('maps 23:59:59.999 and 00:00:00.000 local to different days, whatever the process zone', () => {
    // Nov 6 23:59:59.999 PST = Nov 7 07:59:59.999 UTC; one millisecond later is Nov 7 local.
    expect(dateInZone(at('2026-11-07T07:59:59.999Z'), LA)).toBe('2026-11-06');
    expect(dateInZone(at('2026-11-07T08:00:00.000Z'), LA)).toBe('2026-11-07');
  });

  it('gives half-open day bounds that tile the timeline with no gap or overlap', () => {
    for (const day of [
      '2026-11-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]) {
      expect(utcBounds(day, LA).end).toBe(utcBounds(addDays(day, 1), LA).start);
    }
    const nov7 = utcBounds('2026-11-07', LA);
    expect(nov7.end - nov7.start).toBe(24 * HOUR);
    expect(dateInZone(nov7.start, LA)).toBe('2026-11-07');
    expect(dateInZone(nov7.start - 1, LA)).toBe('2026-11-06');
    expect(dateInZone(nov7.end - 1, LA)).toBe('2026-11-07');
    expect(dateInZone(nov7.end, LA)).toBe('2026-11-08');
  });

  it('bounds a range from its first local midnight to the midnight after its last day', () => {
    expect(rangeBounds('2026-11-02', '2026-11-08', LA)).toEqual({
      start: utcBounds('2026-11-02', LA).start,
      end: utcBounds('2026-11-09', LA).start,
    });
  });
});

describe('daylight-saving transitions in America/Los_Angeles (2026)', () => {
  it('spring forward: Sunday 8 March 2026 is 23 hours long', () => {
    const day = utcBounds('2026-03-08', LA);
    expect((day.end - day.start) / HOUR).toBe(23);
    expect(day.start).toBe(at('2026-03-08T08:00:00Z')); // midnight PST
    expect(day.end).toBe(at('2026-03-09T07:00:00Z')); // midnight PDT
    // 01:59:59 PST is still the 8th; the next instant is 03:00 PDT, also the 8th.
    expect(dateInZone(at('2026-03-08T09:59:59Z'), LA)).toBe('2026-03-08');
    expect(dateInZone(at('2026-03-08T10:00:00Z'), LA)).toBe('2026-03-08');
    expect(dateInZone(at('2026-03-09T06:59:59.999Z'), LA)).toBe('2026-03-08');
    expect(dateInZone(at('2026-03-09T07:00:00Z'), LA)).toBe('2026-03-09');
  });

  it('fall back: Sunday 1 November 2026 is 25 hours long', () => {
    const day = utcBounds('2026-11-01', LA);
    expect((day.end - day.start) / HOUR).toBe(25);
    expect(day.start).toBe(at('2026-11-01T07:00:00Z')); // midnight PDT
    expect(day.end).toBe(at('2026-11-02T08:00:00Z')); // midnight PST
    // The 01:00–02:00 hour happens twice; both belong to the 1st.
    expect(dateInZone(at('2026-11-01T08:30:00Z'), LA)).toBe('2026-11-01');
    expect(dateInZone(at('2026-11-01T09:30:00Z'), LA)).toBe('2026-11-01');
    expect(dateInZone(at('2026-11-02T07:59:59.999Z'), LA)).toBe('2026-11-01');
  });

  it('a week that holds a transition is 167 or 169 hours, not 168', () => {
    const spring = rangeBounds('2026-03-02', '2026-03-08', LA);
    const fall = rangeBounds('2026-10-26', '2026-11-01', LA);
    expect((spring.end - spring.start) / HOUR).toBe(167);
    expect((fall.end - fall.start) / HOUR).toBe(169);
  });
});

describe('buckets', () => {
  it('builds day buckets with labels the prototype uses', () => {
    const buckets = bucketsFor('2026-11-02', '2026-11-08', 'day');
    expect(buckets).toHaveLength(7);
    expect(buckets[0]).toMatchObject({
      start: '2026-11-02',
      end: '2026-11-02',
      label: 'Mon, Nov 2, 2026',
      short: 'Mon 2',
      partOfRange: false,
    });
    expect(bucketsFor('2026-10-01', '2026-11-30', 'day')[1]!.short).toBe('Oct 2');
  });

  it('clips weeks and months to the range and flags them', () => {
    const weeks = bucketsFor('2026-11-04', '2026-11-20', 'week');
    expect(weeks.map((b) => [b.start, b.end, b.partOfRange])).toEqual([
      ['2026-11-04', '2026-11-08', true],
      ['2026-11-09', '2026-11-15', false],
      ['2026-11-16', '2026-11-20', true],
    ]);
    expect(weeks[0]!.label).toBe('Week of Nov 2, 2026 (part in range)');
    expect(weeks[1]!.label).toBe('Week of Nov 9, 2026');

    const months = bucketsFor('2025-12-15', '2026-02-10', 'month');
    expect(months.map((b) => [b.start, b.end, b.partOfRange, b.short])).toEqual([
      ['2025-12-15', '2025-12-31', true, 'Dec'],
      ['2026-01-01', '2026-01-31', false, 'Jan ’26'],
      ['2026-02-01', '2026-02-10', true, 'Feb'],
    ]);
    expect(months[0]!.label).toBe('Dec 2025 (part in range)');
  });

  it.each(['day', 'week', 'month'] as const)(
    '%s buckets cover the range exactly once, in order',
    (gran) => {
      for (const [start, end] of [
        ['2026-03-01', '2026-03-31'],
        ['2026-02-27', '2026-03-10'],
        ['2025-11-04', '2026-11-04'],
        ['2026-11-01', '2026-11-01'],
      ] as const) {
        const buckets = bucketsFor(start, end, gran);
        expect(buckets[0]!.start).toBe(start);
        expect(buckets.at(-1)!.end).toBe(end);
        buckets.forEach((bucket, i) => {
          expect(bucket.index).toBe(i);
          expect(bucket.start <= bucket.end).toBe(true);
          if (i > 0) expect(bucket.start).toBe(addDays(buckets[i - 1]!.end, 1));
        });
      }
    },
  );

  it('finds the bucket a date falls in, or -1 outside the range', () => {
    const buckets = bucketsFor('2026-11-04', '2026-11-20', 'week');
    expect(bucketIndexOf(buckets, '2026-11-04')).toBe(0);
    expect(bucketIndexOf(buckets, '2026-11-08')).toBe(0);
    expect(bucketIndexOf(buckets, '2026-11-09')).toBe(1);
    expect(bucketIndexOf(buckets, '2026-11-20')).toBe(2);
    expect(bucketIndexOf(buckets, '2026-11-03')).toBe(-1);
    expect(bucketIndexOf(buckets, '2026-11-21')).toBe(-1);
  });
});

describe('totals reconcile across granularities (P-11)', () => {
  // A deterministic set of events, including the exact instants on both sides of local midnight and inside both DST days.
  const events: { at: number; tokens: number }[] = [];
  let seed = 7;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed;
  };
  for (const [from, to] of [
    ['2026-02-20T00:00:00Z', '2026-04-10T00:00:00Z'],
    ['2026-10-15T00:00:00Z', '2026-11-20T00:00:00Z'],
  ] as const) {
    for (let i = 0; i < 4000; i++) {
      events.push({ at: at(from) + (next() % (at(to) - at(from))), tokens: 1 + (next() % 5000) });
    }
  }
  for (const day of ['2026-03-08', '2026-11-01', '2026-11-06']) {
    const { start, end } = utcBounds(day, LA);
    for (const instant of [start - 1, start, start + 1, end - 1, end])
      events.push({ at: instant, tokens: 977 });
  }

  const sumsBy = (start: string, end: string, gran: 'day' | 'week' | 'month') => {
    const buckets = bucketsFor(start, end, gran);
    const sums = buckets.map(() => 0);
    for (const event of events) {
      const i = bucketIndexOf(buckets, dateInZone(event.at, LA));
      if (i >= 0) sums[i]! += event.tokens;
    }
    return { buckets, sums };
  };
  const total = (sums: number[]) => sums.reduce((a, b) => a + b, 0);

  it.each([
    ['2026-02-23', '2026-04-05'],
    ['2026-10-26', '2026-11-15'],
    ['2026-03-01', '2026-03-31'],
  ])('day sum = week sum = month sum = events in the range (%s to %s)', (start, end) => {
    const bounds = rangeBounds(start, end, LA);
    const expected = events
      .filter((e) => e.at >= bounds.start && e.at < bounds.end)
      .reduce((a, e) => a + e.tokens, 0);
    expect(expected).toBeGreaterThan(0);
    const day = total(sumsBy(start, end, 'day').sums);
    const week = total(sumsBy(start, end, 'week').sums);
    const month = total(sumsBy(start, end, 'month').sums);
    expect(day).toBe(expected);
    expect(week).toBe(expected);
    expect(month).toBe(expected);
  });

  it('assigns each event the same bucket by date and by UTC bounds, on every day including both DST days', () => {
    const { buckets, sums } = sumsBy('2026-02-23', '2026-11-20', 'day');
    const bySql = (bucket: PeriodBucket) => {
      const bounds = rangeBounds(bucket.start, bucket.end, LA);
      return events
        .filter((e) => e.at >= bounds.start && e.at < bounds.end)
        .reduce((a, e) => a + e.tokens, 0);
    };
    for (const bucket of buckets) expect(sums[bucket.index]).toBe(bySql(bucket));
  });
});

describe('presets and validation', () => {
  const today = '2026-11-04'; // a Wednesday

  it('resolves the period presets', () => {
    expect(presetRange('this-week', today)).toEqual({ start: '2026-11-02', end: '2026-11-08' });
    expect(presetRange('this-month', today)).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(presetRange('last-week', '2024-01-04')).toEqual({
      start: '2023-12-25',
      end: '2023-12-31',
    });
    expect(presetRange('last-month', '2024-03-01')).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
    });
    expect(presetRange('last-30', today)).toEqual({ start: '2026-10-06', end: today });
    expect(presetRange('last-90', today)).toEqual({ start: '2026-08-07', end: today });
    expect(presetRange('last-12m', today)).toEqual({ start: '2025-11-04', end: today });
  });

  it('picks the default granularity at the 45 and 200 day edges', () => {
    const span = (days: number) =>
      defaultGranularity('2026-01-01', addDays('2026-01-01', days - 1));
    expect(span(1)).toBe('day');
    expect(span(45)).toBe('day');
    expect(span(46)).toBe('week');
    expect(span(200)).toBe('week');
    expect(span(201)).toBe('month');
  });

  it('accepts every preset and rejects dates outside the lookback or the current period', () => {
    for (const preset of [
      'this-week',
      'last-week',
      'this-month',
      'last-month',
      'last-30',
      'last-90',
      'last-12m',
    ] as const) {
      const range = presetRange(preset, today);
      expect(checkRange(range.start, range.end, today)).toEqual({ ok: true });
    }
    expect(checkRange('2025-11-03', today, today)).toMatchObject({
      ok: false,
      message: expect.stringContaining('Nov 4, 2025'),
    });
    expect(checkRange('2026-11-05', '2026-11-04', today)).toMatchObject({ ok: false });
    expect(checkRange('2026-11-01', '2026-12-01', today)).toMatchObject({
      ok: false,
      message: expect.stringContaining('Nov 30, 2026'),
    });
  });

  it('lets a week that straddles a month end run to the week end', () => {
    // Wed 2026-07-29: the week ends Sun Aug 2, past the month end; the month ends Jul 31.
    expect(checkRange('2026-07-27', '2026-08-02', '2026-07-29')).toEqual({ ok: true });
    expect(checkRange('2026-07-27', '2026-08-03', '2026-07-29')).toMatchObject({ ok: false });
  });

  it('gives the previous range of equal length', () => {
    expect(previousRange('2026-11-02', '2026-11-08')).toEqual({
      start: '2026-10-26',
      end: '2026-11-01',
    });
    expect(previousRange('2026-11-04', '2026-11-04')).toEqual({
      start: '2026-11-03',
      end: '2026-11-03',
    });
  });
});
