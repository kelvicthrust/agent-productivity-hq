import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClaudeHooksStatus, HqResponse } from '../../shared/contracts/hq';
import { apiGet, apiSend } from './api';
import { queryKeys } from './queryClient';

// The live roster, and Claude Code's hooks switch that HQ's first-time prompt and the Sources screen share (a feature may not import
// another feature, so both read them from here).
//
// The live roster (TECH › State ownership: TanStack Query, its own key, not under `analytics`). It is always stale and polled
// every 2 s; the interval pauses while the tab is hidden (TanStack's default: no refetch in the background), and slows to 10 s
// after a failed request so an app that is down is not asked twice a second. The last answer stays in `data` through a failure,
// so the page keeps showing it.

export const HQ_POLL_MS = 2_000;
export const HQ_ERROR_POLL_MS = 10_000;

const readHq = ({ signal }: { signal: AbortSignal }) => apiGet('/api/hq', HqResponse, { signal });

export function useHq() {
  return useQuery({
    queryKey: queryKeys.hq,
    queryFn: readHq,
    staleTime: 0,
    // The poll is the retry: a failure shows at once and the next poll tries again.
    retry: false,
    refetchInterval: (query) => (query.state.status === 'error' ? HQ_ERROR_POLL_MS : HQ_POLL_MS),
  });
}

// Claude Code's hooks, the owner's opt-in switch (docs/tech/local-api.md, GET and PUT /api/hq/claude-hooks). The preview is read only
// when the owner opens the disclosure or presses an action. The switch is a PUT that carries the action’s
// fingerprint, so the server can reject changes to settings that occurred after the preview was read.

const HOOKS_PATH = '/api/hq/claude-hooks';

/**
 * Whether the hooks switch is on, off, needs repair or is unavailable, for a screen that does not show the roster (Sources): the same
 * query as `useHq` (so a change made there is seen here at once), read once and not polled. HQ itself reads it from `useHq`.
 */
export function useExactPrompts() {
  return useQuery({
    queryKey: queryKeys.hq,
    queryFn: readHq,
    staleTime: 0,
    retry: false,
    select: (response) => response.exactPrompts,
  });
}

export function useClaudeHooksPreview(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.hqHooks,
    queryFn: ({ signal }) => apiGet(HOOKS_PATH, ClaudeHooksStatus, { signal }),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

export interface HooksChange {
  enabled: boolean;
  /** The `preview` of the status the owner was shown. */
  preview: string;
}

export function useClaudeHooksSwitch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ enabled, preview }: HooksChange) =>
      apiSend('PUT', HOOKS_PATH, ClaudeHooksStatus, { enabled, preview }),
    onSuccess: (status) => {
      client.setQueryData(queryKeys.hqHooks, status);
    },
    onSettled: () => {
      // The roster's wording follows the switch, and a refusal may mean the files are not what was shown: read both again at once.
      void client.invalidateQueries({ queryKey: queryKeys.hq });
      void client.invalidateQueries({ queryKey: queryKeys.hqHooks });
    },
  });
}
