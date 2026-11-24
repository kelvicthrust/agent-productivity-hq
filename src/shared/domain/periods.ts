import type { Granularity } from '../contracts/common.ts';
import type { PeriodPreset as DashboardPeriodPreset } from './dashboard-filters.ts';

// Calendar and bucket math for the report timezone (P-09, P-10, P-11). Pure: no I/O. `Temporal` is a global on Node 26
// (checked by test/domain/periods.test.ts, which also fails loudly if a runtime ever lacks it). Dates are `YYYY-MM-DD`
// strings in the report timezone; instants are epoch milliseconds in UTC.

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** The days a report may look back from today (`today − 365 days`, PRODUCT lookback). */
export const LOOKBACK_DAYS = 365;

export function isDateString(value: string): boolean {
  if (!DATE_SHAPE.test(value)) return false;
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString() === value;
  } catch {
    return false;
  }
}

const plain = (date: string) => Temporal.PlainDate.from(date, { overflow: 'reject' });

export const addDays = (date: string, days: number): string => plain(date).add({ days }).toString();
/** Whole calendar days from `a` to `b` (negative when b is earlier). */
export const diffDays = (a: string, b: string): number =>
  plain(a).until(plain(b), { largestUnit: 'day' }).days;
/** 1 = Monday … 7 = Sunday. */
export const isoWeekday = (date: string): number => plain(date).dayOfWeek;
export const weekStart = (date: string): string => addDays(date, 1 - isoWeekday(date));
export const weekEnd = (date: string): string => addDays(weekStart(date), 6);
export const monthStart = (date: string): string => `${date.slice(0, 8)}01`;
export const monthEnd = (date: string): string =>
  plain(monthStart(date)).add({ months: 1 }).subtract({ days: 1 }).toString();
export const minDate = (a: string, b: string): string => (a < b ? a : b);
export const maxDate = (a: string, b: string): string => (a > b ? a : b);

/** The calendar date in `timeZone` at the instant `epochMs`. */
export function dateInZone(epochMs: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

export const todayIn = dateInZone;
export const lookbackStart = (today: string): string => addDays(today, -LOOKBACK_DAYS);

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    Temporal.Now.zonedDateTimeISO(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The UTC instants that bound one local calendar day: `[start, end)`. A day that has a DST transition is 23 or 25 hours
 * long here, never 24 by assumption.
 */
export function utcBounds(date: string, timeZone: string): { start: number; end: number } {
  const first = plain(date);
  return {
    start: first.toZonedDateTime(timeZone).epochMilliseconds,
    end: first.add({ days: 1 }).toZonedDateTime(timeZone).epochMilliseconds,
  };
}

/** The UTC instants that bound `start..end` inclusive (local dates). */
export function rangeBounds(
  start: string,
  end: string,
  timeZone: string,
): { start: number; end: number } {
  return { start: utcBounds(start, timeZone).start, end: utcBounds(end, timeZone).end };
}

export type PeriodPreset = Exclude<DashboardPeriodPreset, 'today'>;

/** The date range of a period preset. `this-week` and `this-month` may end after today. */
export function presetRange(preset: PeriodPreset, today: string): { start: string; end: string } {
  switch (preset) {
    case 'this-week':
      return { start: weekStart(today), end: weekEnd(today) };
    case 'last-week': {
      const start = weekStart(today);
      return { start: addDays(start, -7), end: addDays(start, -1) };
    }
    case 'this-month':
      return { start: monthStart(today), end: monthEnd(today) };
    case 'last-month': {
      const end = addDays(monthStart(today), -1);
      return { start: monthStart(end), end };
    }
    case 'last-30':
      return { start: addDays(today, -29), end: today };
    case 'last-90':
      return { start: addDays(today, -89), end: today };
    case 'last-12m':
      return { start: lookbackStart(today), end: today };
  }
}

/** `day` for ≤ 45 days, `week` for ≤ 200, else `month` (local-api › Filters). */
export function defaultGranularity(start: string, end: string): Granularity {
  const days = diffDays(start, end) + 1;
  return days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
}

export type RangeCheck = { ok: true } | { ok: false; message: string };

/**
 * `lookbackStart ≤ start ≤ end`, and `end` may pass today only to the end of the current week or month (the presets).
 * The messages are plain English for the invalid_range error.
 */
export function checkRange(start: string, end: string, today: string): RangeCheck {
  if (start > end) return { ok: false, message: 'The start date is after the end date.' };
  const first = lookbackStart(today);
  if (start < first) {
    return {
      ok: false,
      message: `Dates before ${formatDayLong(first)} are outside the 12-month history.`,
    };
  }
  const last = maxDate(weekEnd(today), monthEnd(today));
  if (end > last) {
    return { ok: false, message: `Dates after ${formatDayLong(last)} are in the future.` };
  }
  return { ok: true };
}

/** The range just before `start..end`, of equal length (for the "previous period" comparison). */
export function previousRange(start: string, end: string): { start: string; end: string } {
  const days = diffDays(start, end) + 1;
  return { start: addDays(start, -days), end: addDays(start, -1) };
}

export interface PeriodBucket {
  /** Position in the series, from 0. */
  index: number;
  start: string;
  end: string;
  /** True when the bucket is clipped by the requested range. */
  partOfRange: boolean;
  label: string;
  short: string;
}

/**
 * Buckets for `start..end`: one per calendar day; Monday-start weeks and calendar months clipped to the range.
 * Every bucket lies inside `start..end`, and together they cover it exactly once, so day, week and month totals over the
 * same events are equal (P-11).
 */
export function bucketsFor(start: string, end: string, gran: Granularity): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  const add = (a: string, b: string, partOfRange: boolean, label: string, short: string) =>
    out.push({ index: out.length, start: a, end: b, partOfRange, label, short });

  if (gran === 'day') {
    const few = diffDays(start, end) + 1 <= 7;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      add(
        d,
        d,
        false,
        `${formatWeekday(d)}, ${formatDayLong(d)}`,
        few ? `${formatWeekday(d)} ${Number(d.slice(8))}` : formatDay(d),
      );
    }
  } else if (gran === 'week') {
    for (let ws = weekStart(start); ws <= end; ws = addDays(ws, 7)) {
      const a = maxDate(ws, start);
      const b = minDate(addDays(ws, 6), end);
      const part = a !== ws || b !== addDays(ws, 6);
      add(
        a,
        b,
        part,
        `Week of ${formatDayLong(ws)}${part ? ' (part in range)' : ''}`,
        formatDay(ws),
      );
    }
  } else {
    for (let ms = monthStart(start); ms <= end; ms = addDays(monthEnd(ms), 1)) {
      const a = maxDate(ms, start);
      const b = minDate(monthEnd(ms), end);
      const part = a !== ms || b !== monthEnd(ms);
      add(a, b, part, `${formatMonth(ms)}${part ? ' (part in range)' : ''}`, formatMonthShort(ms));
    }
  }
  return out;
}

/** The bucket a date falls in. Bucket lists are contiguous and ordered, so this is a plain scan or binary search. */
export function bucketIndexOf(buckets: readonly PeriodBucket[], date: string): number {
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const bucket = buckets[mid]!;
    if (date < bucket.start) high = mid - 1;
    else if (date > bucket.end) low = mid + 1;
    else return mid;
  }
  return -1;
}

// ---- English labels (fixed tables: the same text on every machine, whatever ICU is installed) ----
export const formatWeekday = (date: string): string => DOW[isoWeekday(date) - 1]!;
export const formatDay = (date: string): string =>
  `${MONTHS[Number(date.slice(5, 7)) - 1]!} ${Number(date.slice(8))}`;
export const formatDayLong = (date: string): string => `${formatDay(date)}, ${date.slice(0, 4)}`;
export const formatMonth = (date: string): string =>
  `${MONTHS[Number(date.slice(5, 7)) - 1]!} ${date.slice(0, 4)}`;
export const formatMonthShort = (date: string): string => {
  const month = MONTHS[Number(date.slice(5, 7)) - 1]!;
  return date.slice(5, 7) === '01' ? `${month} ’${date.slice(2, 4)}` : month;
};
export function formatRange(a: string, b: string): string {
  if (a === b) return formatDayLong(a);
  if (a.slice(0, 4) === b.slice(0, 4)) return `${formatDay(a)} – ${formatDayLong(b)}`;
  return `${formatDayLong(a)} – ${formatDayLong(b)}`;
}
