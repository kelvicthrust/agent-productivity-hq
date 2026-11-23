import { QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from './api';

// Server state lives in one place: the TanStack Query cache (TECH › State ownership). Fresh for 30 s, refetched when the
// window regains focus, and invalidated when a refresh run finishes or any mutation succeeds. No other copy of server data
// is kept in React state.

export const STALE_TIME_MS = 30_000;

/** The cache keys. `analytics` groups every dated query so one invalidation refreshes all numbers. */
export const queryKeys = {
  bootstrap: ['bootstrap'] as const,
  sources: ['sources'] as const,
  paseoQuota: ['paseo-quota'] as const,
  /** The live roster is its own key, not under `analytics`: it is polled, and a finished refresh run does not touch it. */
  hq: ['hq'] as const,
  /** The Claude Code hooks switch's preview and status: read when the owner opens "What will change", and after a change. */
  hqHooks: ['hq-hooks'] as const,
  analytics: (route: string, scope?: unknown) =>
    scope === undefined ? (['analytics', route] as const) : (['analytics', route, scope] as const),
};

/** Retry only what the server marked retryable, and only twice; a 4xx or an unreadable answer will not change. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return error instanceof ApiRequestError && error.retryable && failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: STALE_TIME_MS, refetchOnWindowFocus: true, retry: shouldRetry },
    },
  });
}

/** After a refresh run finishes or a mutation succeeds: every number, source row and the issue count are stale. */
export function invalidateServerState(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: ['analytics'] }),
    client.invalidateQueries({ queryKey: queryKeys.sources }),
    client.invalidateQueries({ queryKey: queryKeys.paseoQuota }),
    client.invalidateQueries({ queryKey: queryKeys.bootstrap }),
  ]).then(() => undefined);
}
