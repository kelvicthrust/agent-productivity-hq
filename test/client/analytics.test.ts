// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RECORDS_LIMIT,
  modelsQuery,
  overviewQuery,
  recordsQuery,
  seriesQuery,
  useModels,
  useOverview,
  useRecords,
  useSeries,
  useYear,
  yearQuery,
} from '../../src/client/lib/analytics';
import type { Filters } from '../../src/client/lib/filters';
import { createQueryClient, queryKeys } from '../../src/client/lib/queryClient';

// The review surfaces' server state (src/client/lib/analytics.ts): every endpoint gets exactly the parameters its contract
// names (docs/tech/local-api.md › Filters), keyed under `analytics` so a finished refresh run refreshes it.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const filters: Filters = {
  start: '2026-10-05',
  end: '2026-11-04',
  gran: 'week',
  repos: ['kelvin/atlas-api', 'kelvin/dotfiles'],
  provider: 'codex',
  author: 'all',
};
const BUCKET = { start: '2026-11-02', end: '2026-11-08' };

describe('the parameters each endpoint takes', () => {
  it('overview: the period, repos, provider and author, never the grouping', () => {
    expect(overviewQuery(filters)).toEqual({
      start: '2026-10-05',
      end: '2026-11-04',
      repos: 'kelvin/atlas-api,kelvin/dotfiles',
      provider: 'codex',
      author: 'all',
    });
  });

  it('series: the same plus the grouping', () => {
    expect(seriesQuery(filters)).toEqual({ ...overviewQuery(filters), gran: 'week' });
  });

  it('models: usage only, so no author and no grouping', () => {
    expect(modelsQuery(filters)).toEqual({
      start: '2026-10-05',
      end: '2026-11-04',
      repos: 'kelvin/atlas-api,kelvin/dotfiles',
      provider: 'codex',
    });
  });

  it('year: delivery only, so repos and author, no period and no provider', () => {
    expect(yearQuery(filters)).toEqual({
      repos: 'kelvin/atlas-api,kelvin/dotfiles',
      author: 'all',
    });
  });

  it("records: one bucket's own dates replace the period; the scope stays; the limit has a default", () => {
    expect(recordsQuery(filters, BUCKET)).toEqual({
      start: '2026-11-02',
      end: '2026-11-08',
      repos: 'kelvin/atlas-api,kelvin/dotfiles',
      provider: 'codex',
      author: 'all',
      limit: DEFAULT_RECORDS_LIMIT,
    });
    expect(recordsQuery(filters, BUCKET, 100)['limit']).toBe(100);
  });

  it('leaves out "all repos" instead of sending an empty list', () => {
    const all: Filters = { ...filters, repos: [] };
    expect(overviewQuery(all)['repos']).toBeUndefined();
    expect(yearQuery(all)['repos']).toBeUndefined();
    expect(recordsQuery(all, BUCKET)['repos']).toBeUndefined();
  });
});

describe('what changes a query key', () => {
  it('a filter an endpoint ignores neither changes its key nor refetches it', () => {
    const otherAuthor: Filters = { ...filters, author: 'mine' };
    const otherProvider: Filters = { ...filters, provider: 'claude' };
    const otherPeriod: Filters = { ...filters, start: '2026-09-01' };
    const key = (route: string, query: unknown) => queryKeys.analytics(route, query);
    expect(key('models', modelsQuery(otherAuthor))).toEqual(key('models', modelsQuery(filters)));
    expect(key('year', yearQuery(otherProvider))).toEqual(key('year', yearQuery(filters)));
    expect(key('year', yearQuery(otherPeriod))).toEqual(key('year', yearQuery(filters)));
    // ...while one it takes does
    expect(key('series', seriesQuery(otherAuthor))).not.toEqual(
      key('series', seriesQuery(filters)),
    );
    expect(key('overview', overviewQuery(otherProvider))).not.toEqual(
      key('overview', overviewQuery(filters)),
    );
  });

  it('every key starts with analytics, so invalidateServerState refreshes them with the rest', () => {
    for (const [route, query] of [
      ['overview', overviewQuery(filters)],
      ['series', seriesQuery(filters)],
      ['models', modelsQuery(filters)],
      ['year', yearQuery(filters)],
      ['records', recordsQuery(filters, BUCKET)],
    ] as const) {
      expect(queryKeys.analytics(route, query).slice(0, 2)).toEqual(['analytics', route]);
    }
  });
});

// ---- the hooks, over a stubbed fetch ---------------------------------------------------------------------------------------

const SCOPE = {
  start: '2026-10-05',
  end: '2026-11-04',
  gran: 'week',
  repos: [],
  provider: 'codex',
  author: 'all',
  timezone: 'America/Los_Angeles',
};
const answers: Record<string, unknown> = {
  '/api/overview': {
    scope: SCOPE,
    linkHealth: { state: 'fresh', lastSuccessfulAt: '2026-11-04T20:00:00.000Z' },
    kpis: {},
    coverage: {},
    accounts: [],
    repoRows: [],
    recentPrs: [],
  },
  '/api/series': { scope: SCOPE, buckets: [] },
  '/api/models': {},
  '/api/year': { start: '2025-11-04', today: '2026-11-04', counts: {}, total: 0, daysWithMerge: 0 },
  '/api/records': {},
};

function stubFetch() {
  const calls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = new URL(input, 'http://crew.test');
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify(answers[url.pathname]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

const wrapperFor = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };

describe('the hooks', () => {
  it('ask each endpoint for exactly its parameters and cache the answer under analytics', async () => {
    const calls = stubFetch();
    const client = createQueryClient();
    const wrapper = wrapperFor(client);
    const hooks = [
      renderHook(() => useOverview(filters), { wrapper }),
      renderHook(() => useSeries(filters), { wrapper }),
      renderHook(() => useModels(filters), { wrapper }),
      renderHook(() => useYear(filters), { wrapper }),
      renderHook(() => useRecords(filters, BUCKET), { wrapper }),
    ];
    await waitFor(() => expect(hooks.every((hook) => hook.result.current.isSuccess)).toBe(true));

    const paramsOf = (path: string) =>
      Object.fromEntries(calls.find((url) => url.pathname === path)?.searchParams ?? []);
    expect(Object.keys(paramsOf('/api/overview')).sort()).toEqual([
      'author',
      'end',
      'provider',
      'repos',
      'start',
    ]);
    expect(Object.keys(paramsOf('/api/series')).sort()).toEqual([
      'author',
      'end',
      'gran',
      'provider',
      'repos',
      'start',
    ]);
    expect(Object.keys(paramsOf('/api/models')).sort()).toEqual([
      'end',
      'provider',
      'repos',
      'start',
    ]);
    expect(Object.keys(paramsOf('/api/year')).sort()).toEqual(['author', 'repos']);
    expect(paramsOf('/api/records')).toMatchObject({
      start: '2026-11-02',
      end: '2026-11-08',
      limit: String(DEFAULT_RECORDS_LIMIT),
    });
    expect(paramsOf('/api/overview')['repos']).toBe('kelvin/atlas-api,kelvin/dotfiles');
    const routes = client
      .getQueryCache()
      .findAll({ queryKey: ['analytics'] })
      .map((query) => query.queryKey[1])
      .sort();
    expect(routes).toEqual(['models', 'overview', 'records', 'series', 'year']);
  });

  it('asks nothing until the filters are known, and nothing for a records list until a bucket is chosen', async () => {
    const calls = stubFetch();
    const wrapper = wrapperFor(createQueryClient());
    renderHook(() => useSeries(null), { wrapper });
    renderHook(() => useOverview(null), { wrapper });
    renderHook(() => useRecords(filters, null), { wrapper });
    renderHook(() => useRecords(null, BUCKET), { wrapper });
    await new Promise((done) => setTimeout(done, 20));
    expect(calls).toEqual([]);
  });

  it('keeps the last series on screen while a changed filter loads', async () => {
    stubFetch();
    const wrapper = wrapperFor(createQueryClient());
    const { result, rerender } = renderHook(({ f }) => useSeries(f), {
      wrapper,
      initialProps: { f: filters },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ f: { ...filters, provider: 'claude' } });
    expect(result.current.data).toBeDefined();
    expect(result.current.isPlaceholderData).toBe(true);
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
  });

  it("shows no records under another bucket's title, but keeps them when only the limit is raised", async () => {
    stubFetch();
    const wrapper = wrapperFor(createQueryClient());
    const { result, rerender } = renderHook(
      ({ bucket, limit }) => useRecords(filters, bucket, limit),
      { wrapper, initialProps: { bucket: BUCKET, limit: 30 } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ bucket: BUCKET, limit: 60 });
    expect(result.current.data).toBeDefined();

    rerender({ bucket: { start: '2026-10-26', end: '2026-11-01' }, limit: 60 });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
