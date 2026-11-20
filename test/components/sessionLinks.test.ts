import { describe, expect, it } from 'vitest';
import { deliveryLink } from '../../src/client/components/SessionLinks';
import { dayOf } from '../../src/client/lib/format';

// Where a Usage session's `#number` goes (G8_6): Delivery, on the day the PR merged in the report timezone, for every author, with
// the search for that PR, so the PR is on the page the link lands on whatever week it merged in.

describe('dayOf', () => {
  it('is the calendar day in the zone it is asked in, not the day in UTC', () => {
    // 2026-11-05T02:30Z is still Nov 4 in Los Angeles and already Nov 5 in Berlin.
    expect(dayOf('2026-11-05T02:30:00.000Z', 'America/Los_Angeles')).toBe('2026-11-04');
    expect(dayOf('2026-11-05T02:30:00.000Z', 'Europe/Berlin')).toBe('2026-11-05');
  });

  it('is null for something that is not an instant', () => {
    expect(dayOf('soon', 'America/Los_Angeles')).toBeNull();
  });
});

describe('deliveryLink', () => {
  const pr = { repo: 'kelvin/atlas-api', number: 310, mergedAt: '2026-10-29T18:05:00.000Z' };

  it('opens the merge day, every author, and the search for that PR', () => {
    expect(deliveryLink(pr, 'America/Los_Angeles')).toEqual({
      pathname: '/delivery',
      search: `?start=2026-10-29&end=2026-10-29&author=all&q=${encodeURIComponent('kelvin/atlas-api#310')}`,
    });
  });

  it('takes the day from the report timezone', () => {
    const late = { ...pr, mergedAt: '2026-10-30T02:30:00.000Z' };
    expect(deliveryLink(late, 'America/Los_Angeles').search).toContain(
      'start=2026-10-29&end=2026-10-29',
    );
    expect(deliveryLink(late, 'Europe/Berlin').search).toContain('start=2026-10-30&end=2026-10-30');
  });

  it('falls back to the search alone when there is no merge time to name a day', () => {
    expect(deliveryLink({ repo: 'a/b', number: 1 })).toEqual({
      pathname: '/delivery',
      search: `?q=${encodeURIComponent('a/b#1')}`,
    });
  });
});
