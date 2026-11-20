import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { PrsResponse } from '../../../shared/contracts/prs';
import { apiGet, type Query } from '../../lib/api';
import { filtersQuery, type Filters } from '../../lib/filters';
import { queryKeys } from '../../lib/queryClient';

// Server state for the Delivery screen (TanStack Query; TECH › State ownership). Keyed under `analytics`, so a finished refresh
// run refreshes the list with every other number. The endpoint takes the dates, repos and author (docs/tech/local-api.md), plus
// the link-basis tab and the search: the provider and grouping filters are left out, so changing them neither refetches nor
// re-keys this query.

export type Prs = z.infer<typeof PrsResponse>;
export type Pr = NonNullable<Prs['items']>[number];

/** The link-basis tabs, in order. `all` is the API's default. */
export const LINK_FILTERS = ['all', 'evidence', 'owner', 'suggested', 'unlinked'] as const;
export type LinkFilter = (typeof LINK_FILTERS)[number];

/** The tab a URL's `linkClass` means; anything unknown is All. */
export const linkFilterOf = (value: string | null): LinkFilter =>
  LINK_FILTERS.find((tab) => tab === value) ?? 'all';

/** How many PRs one page holds. The API's default is the same; it is spelled out so "Show N more" can say N. */
export const PAGE_SIZE = 50;

/** The query parameters of `GET /api/prs`, in the codec's own formatting. The defaults are left out. */
export function prsQuery(filters: Filters, link: LinkFilter, search: string): Query {
  const { start, end, repos, author } = filtersQuery(filters);
  return {
    start,
    end,
    repos,
    author,
    linkClass: link === 'all' ? undefined : link,
    q: search.trim() === '' ? undefined : search.trim(),
    limit: PAGE_SIZE,
  };
}

/**
 * The merged PRs of the filters, newest merge first, read a page at a time. The cursor is the server's and opaque. While a new
 * answer is on its way the previous one stays (`keepPreviousData`), so typing in the search box does not blank the table.
 */
export function usePrs(filters: Filters | null, link: LinkFilter, search: string) {
  const query = filters ? prsQuery(filters, link, search) : null;
  return useInfiniteQuery({
    queryKey: queryKeys.analytics('prs', query),
    queryFn: ({ pageParam, signal }) =>
      apiGet('/api/prs', PrsResponse, { signal, query: { ...(query ?? {}), cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}
