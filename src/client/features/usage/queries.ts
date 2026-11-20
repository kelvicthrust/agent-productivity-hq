import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  UsageCategoriesResponse,
  UsageGroupsResponse,
  UsageRootsResponse,
  type Session,
} from '../../../shared/contracts/usage';
import { apiGet, type Query } from '../../lib/api';
import { filtersQuery, type Filters } from '../../lib/filters';
import { queryKeys } from '../../lib/queryClient';

// Server state for the Usage screen (TanStack Query; TECH › State ownership). Everything is keyed under `analytics`, so a
// finished refresh run refreshes every number here with the rest of the app. The three endpoints take only the filters
// that apply to usage (docs/tech/local-api.md: start, end, repos, provider): the author and grouping filters are left
// out, so changing them neither refetches nor re-keys these queries.

export type UsageCategories = z.infer<typeof UsageCategoriesResponse>;
export type UsageGroups = z.infer<typeof UsageGroupsResponse>;
export type UsageGroup = NonNullable<UsageGroups['groups']>[number];
export type UsageRoots = z.infer<typeof UsageRootsResponse>;
export type Root = NonNullable<UsageRoots['roots']>[number];

/** The query parameters of the Usage endpoints for `filters`, in the codec's own formatting. */
export function usageQuery(filters: Filters): Query {
  const { start, end, repos, provider } = filtersQuery(filters);
  return { start, end, repos, provider };
}

export function useUsageCategories(filters: Filters | null) {
  const query = filters ? usageQuery(filters) : null;
  return useQuery({
    queryKey: queryKeys.analytics('usage-categories', query),
    queryFn: ({ signal }) =>
      apiGet('/api/usage/categories', UsageCategoriesResponse, { signal, query: query ?? {} }),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

export function useUsageGroups(filters: Filters | null) {
  const query = filters ? usageQuery(filters) : null;
  return useQuery({
    queryKey: queryKeys.analytics('usage-groups', query),
    queryFn: ({ signal }) =>
      apiGet('/api/usage/groups', UsageGroupsResponse, { signal, query: query ?? {} }),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

/** The sessions of one group, loaded when it is first expanded and paged by root (docs/tech/local-api.md). */
export interface GroupSessions {
  status: 'idle' | 'loading' | 'error' | 'ready';
  roots: Root[];
  /** Children whose root is not in the list (outside the filters). Come with the first page only. */
  orphans: Session[];
  /** Sessions whose parent was never recorded. Come with the first page only. */
  unknown: Session[];
  /** Roots after the pages loaded so far. */
  remaining: number;
  /** A further page is being read. */
  isFetchingMore: boolean;
  /** Reads the next page. Resolves to whether more roots remain after it. */
  loadMore: () => Promise<boolean>;
  retry: () => void;
}

const NONE: never[] = [];

/** `enabled` is whether the group is open: a collapsed group costs no request. */
export function useGroupSessions(
  groupKey: string,
  filters: Filters,
  enabled: boolean,
): GroupSessions {
  const query = usageQuery(filters);
  const result = useInfiniteQuery({
    queryKey: queryKeys.analytics('usage-roots', { groupKey, ...query }),
    queryFn: ({ pageParam, signal }) =>
      apiGet(
        // A repo key has a slash in it (`kelvin/atlas-api`), so it travels URL-encoded.
        `/api/usage/groups/${encodeURIComponent(groupKey)}/roots`,
        UsageRootsResponse,
        { signal, query: { ...query, cursor: pageParam } },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    placeholderData: keepPreviousData,
  });

  const pages = result.data?.pages ?? NONE;
  const last = pages.at(-1);
  const { fetchNextPage, refetch } = result;
  return {
    status: !enabled
      ? 'idle'
      : result.isError && !result.data
        ? 'error'
        : result.data
          ? 'ready'
          : 'loading',
    roots: pages.flatMap((page) => page.roots ?? NONE),
    orphans: pages.flatMap((page) => page.orphans ?? NONE),
    unknown: pages.flatMap((page) => page.unknownRelationship ?? NONE),
    remaining: last?.remaining ?? 0,
    isFetchingMore: result.isFetchingNextPage,
    loadMore: async () => {
      const next = await fetchNextPage();
      return next.hasNextPage;
    },
    retry: () => void refetch(),
  };
}
