import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { OverviewResponse } from '../../shared/contracts/overview';
import { RecordsResponse } from '../../shared/contracts/prs';
import { SeriesResponse, YearResponse } from '../../shared/contracts/series';
import { ModelsResponse } from '../../shared/contracts/usage';
import { apiGet, type Query } from './api';
import { useBootstrap } from './bootstrap';
import { addDays, filtersQuery, weekEnd, weekStart, type Filters } from './filters';
import { queryKeys } from './queryClient';

// Server state for the review surfaces (Overview, Trends and the records drawer; TECH › State ownership, journey J2). The
// five endpoints live here because more than one feature needs them and features may not import one another (ESLint
// boundaries): Overview and Trends both read the series, Overview and the drawer both read records.
//
// Every query is keyed `['analytics', route, scope]`, so a finished refresh run (invalidateServerState) refreshes every
// number, and `scope` is exactly the parameters the endpoint takes, in the codec's own formatting: a filter an endpoint
// ignores can neither change its answer nor re-key it (docs/tech/local-api.md › Filters):
//
//   /api/overview   start end repos provider author
//   /api/series     start end gran repos provider author   (also the KPI trend: the last 12 weeks, whatever the period)
//   /api/records    start end repos provider author limit   (start and end are ONE bucket's dates, not the period)
//   /api/models     start end repos provider                (usage only: no author)
//   /api/year       repos author                            (delivery only: no period, no provider; always the last 12 months)

export type Overview = z.infer<typeof OverviewResponse>;
export type Series = z.infer<typeof SeriesResponse>;
export type SeriesBucket = Series['buckets'][number];
export type Records = z.infer<typeof RecordsResponse>;
export type Models = z.infer<typeof ModelsResponse>;
export type Year = z.infer<typeof YearResponse>;

/** One bucket's dates, as the series gives them. The records drawer asks for exactly this range. */
export interface BucketDates {
  start: string;
  end: string;
}

/** The records a drawer lists at first; its "Show more" raises this (the API allows up to 100). */
export const DEFAULT_RECORDS_LIMIT = 30;

export function overviewQuery(filters: Filters): Query {
  const { start, end, repos, provider, author } = filtersQuery(filters);
  return { start, end, repos, provider, author };
}

export function seriesQuery(filters: Filters): Query {
  const { start, end, gran, repos, provider, author } = filtersQuery(filters);
  return { start, end, gran, repos, provider, author };
}

export function modelsQuery(filters: Filters): Query {
  const { start, end, repos, provider } = filtersQuery(filters);
  return { start, end, repos, provider };
}

export function yearQuery(filters: Filters): Query {
  const { repos, author } = filtersQuery(filters);
  return { repos, author };
}

/** The bucket's own dates replace the period; the repo, provider and author scope stays as the filters say. */
export function recordsQuery(
  filters: Filters,
  bucket: BucketDates,
  limit: number = DEFAULT_RECORDS_LIMIT,
): Query {
  const { repos, provider, author } = filtersQuery(filters);
  return { start: bucket.start, end: bucket.end, repos, provider, author, limit };
}

// `keepPreviousData` keeps the last answer on screen while a changed filter loads, so the charts never flash empty;
// `isPlaceholderData` tells a screen it is still the old scope.

export function useOverview(filters: Filters | null) {
  const query = filters ? overviewQuery(filters) : null;
  return useQuery({
    queryKey: queryKeys.analytics('overview', query),
    queryFn: ({ signal }) =>
      apiGet('/api/overview', OverviewResponse, { signal, query: query ?? {} }),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

export function useSeries(filters: Filters | null) {
  const query = filters ? seriesQuery(filters) : null;
  return useQuery({
    queryKey: queryKeys.analytics('series', query),
    queryFn: ({ signal }) => apiGet('/api/series', SeriesResponse, { signal, query: query ?? {} }),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

/** The weeks the KPI sparklines draw: this many, the last of them the current week. */
export const KPI_TREND_WEEKS = 12;

/** The twelve Monday-to-Sunday weeks that end with the current week, with the repo, provider and author scope of `filters`. */
export function kpiTrendQuery(filters: Filters, today: string): Query {
  const { repos, provider, author } = filtersQuery(filters);
  return {
    start: addDays(weekStart(today), -7 * (KPI_TREND_WEEKS - 1)),
    end: weekEnd(today),
    gran: 'week',
    repos,
    provider,
    author,
  };
}

/**
 * The series behind the Overview's KPI sparklines. The period filter does not apply (a trend is always the last twelve weeks), so
 * it has a key of its own and the period chart's answer is never reused for it. Nothing is asked until bootstrap has said what
 * today is.
 */
export function useKpiTrend(filters: Filters | null) {
  const today = useBootstrap().data?.today;
  const query = filters && today ? kpiTrendQuery(filters, today) : null;
  return useQuery({
    queryKey: queryKeys.analytics('kpi-trend', query),
    queryFn: ({ signal }) => apiGet('/api/series', SeriesResponse, { signal, query: query ?? {} }),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

export function useModels(filters: Filters | null) {
  const query = filters ? modelsQuery(filters) : null;
  return useQuery({
    queryKey: queryKeys.analytics('models', query),
    queryFn: ({ signal }) => apiGet('/api/models', ModelsResponse, { signal, query: query ?? {} }),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

export function useYear(filters: Filters | null) {
  const query = filters ? yearQuery(filters) : null;
  return useQuery({
    queryKey: queryKeys.analytics('year', query),
    queryFn: ({ signal }) => apiGet('/api/year', YearResponse, { signal, query: query ?? {} }),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

/** The records inside one bucket. Nothing is asked until both the filters and a bucket are known. */
export function useRecords(
  filters: Filters | null,
  bucket: BucketDates | null,
  limit: number = DEFAULT_RECORDS_LIMIT,
) {
  const query = filters && bucket ? recordsQuery(filters, bucket, limit) : null;
  return useQuery({
    queryKey: queryKeys.analytics('records', query),
    queryFn: ({ signal }) =>
      apiGet('/api/records', RecordsResponse, { signal, query: query ?? {} }),
    enabled: query !== null,
    // A bucket is a different list, not a changed filter: showing the previous bucket's records under a new title would lie.
    // Raising the limit of the same bucket is the one change that keeps them.
    placeholderData: (previous, previousQuery) =>
      previousQuery !== undefined && sameBucket(previousQuery.queryKey[2], query)
        ? previous
        : undefined,
  });
}

function sameBucket(previous: unknown, next: Query | null): boolean {
  if (next === null || typeof previous !== 'object' || previous === null) return false;
  const was = previous as Query;
  return was['start'] === next['start'] && was['end'] === next['end'];
}
