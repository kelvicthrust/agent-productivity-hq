import { describe, expect, it } from 'vitest';
import { filterGroupsFor, showsFilters } from '../../src/client/app/routes';
import { activeFilterCount, secondaryGroups } from '../../src/client/features/filters/groups';
import { defaultFilters, type FilterContext, type Filters } from '../../src/client/lib/filters';

// Which filter groups each screen carries, and the number on its "Filters" button: how many of the groups behind that button
// differ from the default view. Wed Nov 4, 2026 is "today" (the default week is Nov 2 to Nov 8, grouped by day).

const ctx: FilterContext = { today: '2026-11-04', lookbackStart: '2025-11-04' };
const base = defaultFilters(ctx);
const changed = (patch: Partial<Filters>): Filters => ({ ...base, ...patch });

describe('the groups a screen uses', () => {
  it.each([
    ['/', ['period', 'gran', 'repos', 'provider', 'author']],
    ['/trends', ['period', 'gran', 'repos', 'provider', 'author']],
    ['/delivery', ['period', 'repos', 'author']],
    ['/usage', ['period', 'repos', 'provider']],
    ['/sources', []],
    ['/setup', []],
    ['/no/such/page', []],
  ])('%s uses %j', (path, groups) => {
    expect(filterGroupsFor(path)).toEqual(groups);
  });

  it('shows the filter bar exactly where there is a group to filter by', () => {
    expect(['/', '/trends', '/delivery', '/usage'].map(showsFilters)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['/sources', '/setup', '/no/such/page'].map(showsFilters)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('keeps the period out of the Filters popover: it has its own control on the bar', () => {
    expect(secondaryGroups(filterGroupsFor('/delivery'))).toEqual(['repos', 'author']);
    expect(secondaryGroups(filterGroupsFor('/usage'))).toEqual(['repos', 'provider']);
  });
});

describe('the Filters count', () => {
  it('is zero on the default view', () => {
    for (const path of ['/', '/trends', '/delivery', '/usage']) {
      expect(activeFilterCount(filterGroupsFor(path), base)).toBe(0);
    }
  });

  it('counts each secondary group that is off its default, once', () => {
    const all = changed({
      gran: 'week',
      repos: ['kelvin/a', 'kelvin/b'],
      provider: 'codex',
      author: 'all',
    });
    expect(activeFilterCount(filterGroupsFor('/'), all)).toBe(4);
    expect(activeFilterCount(filterGroupsFor('/trends'), all)).toBe(4);
  });

  it('counts only the groups the screen has', () => {
    const all = changed({ gran: 'week', repos: ['kelvin/a'], provider: 'claude', author: 'all' });
    expect(activeFilterCount(filterGroupsFor('/delivery'), all)).toBe(2);
    expect(activeFilterCount(filterGroupsFor('/usage'), all)).toBe(2);
  });

  it('does not count the period, and takes the grouping that fits the range as the default', () => {
    // A month is grouped by day to 45 days and by week after that: week is the default for 90 days, not a change.
    expect(
      activeFilterCount(
        filterGroupsFor('/'),
        changed({ start: '2026-08-07', end: '2026-11-04', gran: 'week' }),
      ),
    ).toBe(0);
    expect(
      activeFilterCount(
        filterGroupsFor('/'),
        changed({ start: '2026-08-07', end: '2026-11-04', gran: 'day' }),
      ),
    ).toBe(1);
  });
});
