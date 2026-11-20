import { describe, expect, it } from 'vitest';
import {
  compact,
  count,
  dotJoin,
  formatStarted,
  formatTimeOfDay,
  formatWhen,
  int,
  plural,
  upperFirst,
} from '../../src/client/lib/format';

describe('plural and count', () => {
  it('makes the D7 count labels agree with their numbers', () => {
    const tree = (roots: number, sessions: number) =>
      [count(roots, 'root'), count(sessions, 'session')].join(' · ');
    expect(tree(1, 1)).toBe('1 root · 1 session');
    expect(tree(2, 8)).toBe('2 roots · 8 sessions');
    expect(count(1, 'child', 'children')).toBe('1 child');
    expect(count(2, 'child', 'children')).toBe('2 children');
    expect(count(1, 'source issue')).toBe('1 source issue');
    expect(count(3, 'source issue')).toBe('3 source issues');
  });

  it('plural returns just the word, and zero and fractions are not "one"', () => {
    expect(plural(1, 'session')).toBe('session');
    expect(plural(0, 'session')).toBe('sessions');
    expect(plural(1.5, 'session')).toBe('sessions');
    expect(plural(1, 'child', 'children')).toBe('child');
    expect(plural(0, 'child', 'children')).toBe('children');
  });

  it('puts thousands separators in a large count', () => {
    expect(count(1234, 'session')).toBe('1,234 sessions');
  });
});

describe('number formats', () => {
  it('compact matches the prototype', () => {
    expect(compact(38_100_000)).toBe('38.1M');
    expect(compact(850_000)).toBe('850K');
    expect(compact(1_200_000_000)).toBe('1.2B');
    expect(compact(42)).toBe('42');
    expect(compact(0)).toBe('0');
    expect(compact(null)).toBe('—');
    expect(compact(undefined)).toBe('—');
  });

  it('int groups digits and shows a dash for no number', () => {
    expect(int(1_234_567)).toBe('1,234,567');
    expect(int(0)).toBe('0');
    expect(int(12.6)).toBe('13');
    expect(int(null)).toBe('—');
  });
});

describe('dotJoin and upperFirst', () => {
  it('joins the parts that are present with the product separator', () => {
    expect(dotJoin(['a', undefined, '', false, null, 'b'])).toBe('a · b');
    expect(dotJoin([])).toBe('');
  });
  it('capitalises the first letter only', () => {
    expect(upperFirst('today, 9:42 AM')).toBe('Today, 9:42 AM');
    expect(upperFirst('')).toBe('');
  });
});

describe('times', () => {
  it('reads a 24-hour clock as the design’s 12-hour time', () => {
    expect(formatTimeOfDay(0, 5)).toBe('12:05 AM');
    expect(formatTimeOfDay(9, 52)).toBe('9:52 AM');
    expect(formatTimeOfDay(12, 0)).toBe('12:00 PM');
    expect(formatTimeOfDay(13, 7)).toBe('1:07 PM');
    expect(formatTimeOfDay(23, 59)).toBe('11:59 PM');
  });

  it('formats Started in the report timezone, with ordinary spaces', () => {
    // 18:52 UTC is 10:52 in Los Angeles in November (UTC-8).
    expect(formatStarted('2026-11-02T18:52:00Z', 'America/Los_Angeles')).toBe('Nov 2, 10:52 AM');
    expect(formatStarted('2026-11-02T00:05:00Z', 'UTC')).toBe('Nov 2, 12:05 AM');
    // The same instant is already the next day in Tokyo.
    expect(formatStarted('2026-11-02T18:52:00Z', 'Asia/Tokyo')).toBe('Nov 3, 3:52 AM');
    // Newer ICU puts a narrow no-break space (U+202F) before AM/PM; the text here must use an ordinary space.
    expect(formatStarted('2026-11-02T18:52:00Z', 'UTC')).not.toMatch(/[\u202f\u00a0]/);
  });

  it('follows a daylight-saving change', () => {
    // 2026-03-08 10:30 UTC is 3:30 AM PDT, after the 2:00 AM jump in Los Angeles.
    expect(formatStarted('2026-03-08T10:30:00Z', 'America/Los_Angeles')).toBe('Mar 8, 3:30 AM');
  });

  it('shows a dash for something that is not a time', () => {
    expect(formatStarted('not a date')).toBe('—');
    expect(formatWhen('not a date')).toBe('—');
  });

  it('says "today" only for today’s date in the report timezone', () => {
    const options = { timeZone: 'America/Los_Angeles', today: '2026-11-04' };
    expect(formatWhen('2026-11-04T17:42:00Z', options)).toBe('today, 9:42 AM');
    expect(formatWhen('2026-11-04T02:12:00Z', options)).toBe('Nov 3, 6:12 PM');
    expect(formatWhen('2026-11-04T17:42:00Z', { ...options, today: '2026-11-05' })).toBe(
      'Nov 4, 9:42 AM',
    );
  });
});
