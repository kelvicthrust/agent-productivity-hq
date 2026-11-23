import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  decodeFilters,
  periodOf,
  searchAfter,
  type FilterChange,
  type FilterContext,
  type Filters,
  type Period,
} from '../../shared/domain/dashboard-filters';
import { useBootstrap } from './bootstrap';

export * from '../../shared/domain/dashboard-filters';

// ---- the hook ----------------------------------------------------------------------------------------------------

export interface FilterState {
  /** Null until /api/bootstrap has said what today is. */
  filters: Filters | null;
  ctx: FilterContext | null;
  /** Null until `filters` is known. */
  period: Period | null;
  /** Writes the change to the URL (a new history entry, so Back restores the previous filters). */
  apply: (change: FilterChange) => void;
}

/** The current filters, parsed from the URL. The URL is the only owner: nothing is kept in React state. */
export function useFilters(): FilterState {
  const { data } = useBootstrap();
  const { search } = useLocation();
  const navigate = useNavigate();
  const today = data?.today;
  const lookbackStart = data?.lookbackStart;
  const ctx = useMemo<FilterContext | null>(
    () => (today !== undefined && lookbackStart !== undefined ? { today, lookbackStart } : null),
    [today, lookbackStart],
  );
  const filters = useMemo(
    () => (ctx ? decodeFilters(new URLSearchParams(search), ctx) : null),
    [ctx, search],
  );
  const period = useMemo(() => (ctx && filters ? periodOf(filters, ctx) : null), [ctx, filters]);
  const apply = useCallback(
    (change: FilterChange) => {
      if (!ctx) return;
      const next = searchAfter(search, change, ctx);
      // A change that leaves the URL as it is (Reset on the default view) would only stack a duplicate history entry.
      if (next !== search) void navigate({ search: next });
    },
    [ctx, navigate, search],
  );
  return { filters, ctx, period, apply };
}
