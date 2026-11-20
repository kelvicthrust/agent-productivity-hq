import { formatDay } from '../../shared/domain/periods';
import { compactCount } from '../../shared/domain/tokens';

// Number, count and time formats shared by the screens. Ported from the D7 prototype's ui.js (`compact`, `int`, `plural`)
// with `Intl` doing the locale work, per docs/tech/design-to-code.md "Prototype reuse audit". The prototype's UTC-date
// helpers are not ported: periods and buckets come from src/shared/domain/periods (report timezone, DST-safe).

/** "38.1M", "850K", "42", or "—" when there is no number. The same output as the prototype's `compact`. */
export const compact: (n: number | null | undefined) => string = compactCount;

const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** A whole number with thousands separators ("1,234,567"); "—" when there is no number. */
export function int(n: number | null | undefined): string {
  return n == null || Number.isNaN(n) ? '—' : INTEGER.format(n);
}

const PLURAL = new Intl.PluralRules('en-US');

/** The singular for exactly one, else `many` (default: `one` + "s"): plural(2, 'child', 'children') is "children". */
export function plural(n: number, one: string, many?: string): string {
  return PLURAL.select(n) === 'one' ? one : (many ?? `${one}s`);
}

/** The number and its noun together, so a label always agrees with its number: "1 session", "2 children". */
export function count(n: number, one: string, many?: string): string {
  return `${int(n)} ${plural(n, one, many)}`;
}

/** The parts that are present, joined with the product's " · " separator. */
export function dotJoin(parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' · ');
}

// ---- times ----
// The wall-clock parts come from Intl (it knows the zone rules), but the words are assembled here: month names from the
// same fixed table as the rest of the app and "AM"/"PM" spelled out, so the text is identical whatever ICU a machine has
// (newer ICU puts a narrow no-break space before AM/PM).

interface WallClock {
  /** `YYYY-MM-DD` in the zone. */
  date: string;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(epochMs: number, timeZone?: string): WallClock {
  const key = timeZone ?? '';
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      ...(timeZone ? { timeZone } : {}),
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(key, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(epochMs)) parts[part.type] = part.value;
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
  };
}

/** "9:52 AM", "12:05 PM": a 24-hour clock reading as the 12-hour time the design uses. */
export function formatTimeOfDay(hour24: number, minute: number): string {
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
}

/** "Nov 2, 10:52 AM": the one session time the UI shows (after the word "Started"). `timeZone` defaults to this machine's. */
export function formatStarted(instant: string, timeZone?: string): string {
  const epochMs = Date.parse(instant);
  if (Number.isNaN(epochMs)) return '—';
  const { date, hour, minute } = wallClock(epochMs, timeZone);
  return `${formatDay(date)}, ${formatTimeOfDay(hour, minute)}`;
}

/** The calendar day (`YYYY-MM-DD`) of an instant in `timeZone` (default: this machine's), or null when it is not an instant. */
export function dayOf(instant: string, timeZone?: string): string | null {
  const epochMs = Date.parse(instant);
  return Number.isNaN(epochMs) ? null : wallClock(epochMs, timeZone).date;
}

export interface WhenOptions {
  timeZone?: string;
  /** Today's `YYYY-MM-DD` in the report timezone (from bootstrap). Defaults to the current date in `timeZone`. */
  today?: string;
}

/** "today, 9:42 AM" for a time on today's date, else "Nov 3, 6:12 PM": for refresh and attempt times in sentences. */
export function formatWhen(instant: string, options: WhenOptions = {}): string {
  const epochMs = Date.parse(instant);
  if (Number.isNaN(epochMs)) return '—';
  const { date, hour, minute } = wallClock(epochMs, options.timeZone);
  const today = options.today ?? wallClock(Date.now(), options.timeZone).date;
  const time = formatTimeOfDay(hour, minute);
  return date === today ? `today, ${time}` : `${formatDay(date)}, ${time}`;
}

/** The first letter capitalised, for a phrase that starts a line instead of continuing a sentence ("today, 9:42 AM"). */
export function upperFirst(text: string): string {
  return text === '' ? text : text[0]!.toUpperCase() + text.slice(1);
}
