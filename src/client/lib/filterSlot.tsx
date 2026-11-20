import { createContext, useContext, type ReactNode } from 'react';

// The filter bar belongs to the shell (it mounts it once, for the route it is showing) but is drawn by the screen, under the
// title and subtitle in PageHeader. The shell cannot put it there itself: the heading is the route's, so the shell hands the
// bar over through this slot, and PageHeader draws it. A screen without a header, or a route with no filters, gets nothing.

/** The filter groups a screen can carry. `period` is the bar's own control; the rest sit behind its Filters button. */
export type FilterGroupId = 'period' | 'gran' | 'repos' | 'provider' | 'author';

const FilterSlotContext = createContext<ReactNode>(null);

export const FilterSlotProvider = FilterSlotContext.Provider;

/** The filter bar the shell provided for the current route, or null when the route has no filters. */
export function useFilterSlot(): ReactNode {
  return useContext(FilterSlotContext);
}
