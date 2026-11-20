import { defaultGranularity, type Filters } from '../../lib/filters';
import type { FilterGroupId } from '../../lib/filterSlot';

/** The groups behind the Filters button: everything the screen has except the period, which has its own control on the bar. */
export function secondaryGroups(groups: readonly FilterGroupId[]): FilterGroupId[] {
  return groups.filter((group) => group !== 'period');
}

/**
 * The number on the Filters button: how many of the screen's secondary groups are off their default. The default grouping is
 * the one that fits the range (defaultGranularity), so a long range grouped by week is not a change.
 */
export function activeFilterCount(groups: readonly FilterGroupId[], filters: Filters): number {
  return secondaryGroups(groups).filter((group) => {
    switch (group) {
      case 'gran':
        return filters.gran !== defaultGranularity(filters.start, filters.end);
      case 'repos':
        return filters.repos.length > 0;
      case 'provider':
        return filters.provider !== 'all';
      case 'author':
        return filters.author !== 'mine';
      default:
        return false;
    }
  }).length;
}
