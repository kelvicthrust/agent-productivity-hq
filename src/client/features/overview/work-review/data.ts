import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  WorkReviewAccount,
  WorkReviewAutomation,
  WorkReviewConnect,
  WorkReviewState,
} from '../../../../shared/contracts/work-review';
import { overviewQuery } from '../../../lib/analytics';
import { apiGet, apiSend, queryString } from '../../../lib/api';
import { useBootstrap } from '../../../lib/bootstrap';
import { weekEnd, weekStart, type Filters } from '../../../lib/filters';
import { isPaseoBrowser } from '../../../lib/paseoBrowser';
import { queryKeys } from '../../../lib/queryClient';

const PATH = '/api/work-review';
const ACCOUNT_PATH = `${PATH}/account`;
const ACCOUNT_KEY = ['work-review-account'] as const;
const AUTOMATION_PATH = `${PATH}/automation`;
const AUTOMATION_KEY = ['work-review-automation'] as const;
// An open view can discover background updates without repeatedly collecting a week's evidence.
const AUTOMATION_READ_INTERVAL_MS = 5 * 60_000;

export const reviewScopeKey = (filters: Filters): string => queryString(overviewQuery(filters));

function reviewKey(filters: Filters, version?: number) {
  return queryKeys.analytics('work-review', { ...overviewQuery(filters), version });
}

export function useWorkReview(filters: Filters, version?: number) {
  const client = useQueryClient();
  const today = useBootstrap().data?.today;
  const automationScope =
    today !== undefined &&
    version === undefined &&
    filters.start === weekStart(today) &&
    filters.end === weekEnd(today) &&
    filters.author === 'mine' &&
    filters.provider === 'all' &&
    filters.repos.length === 0;
  const paseo = isPaseoBrowser();
  const automation = useReviewAutomation(automationScope && !paseo);
  const followAutomaticUpdates =
    automationScope && (paseo || (!automation.isError && automation.data?.enabled));
  return useQuery({
    queryKey: reviewKey(filters, version),
    queryFn: async ({ signal }) => {
      const state = await apiGet(PATH, WorkReviewState, {
        signal,
        query: { ...overviewQuery(filters), version },
      });
      if (!paseo && state.status === 'failed')
        void client.invalidateQueries({ queryKey: ACCOUNT_KEY, exact: true });
      return state;
    },
    refetchInterval: ({ state }) => {
      if (state.data?.status === 'running') return 1_500;
      return followAutomaticUpdates && state.data?.locked === false
        ? AUTOMATION_READ_INTERVAL_MS
        : false;
    },
  });
}

export function useGenerateWorkReview(filters: Filters) {
  const client = useQueryClient();
  const key = reviewKey(filters);
  return useMutation({
    mutationFn: (revision: boolean) =>
      apiSend(
        'POST',
        `${PATH}/generate`,
        WorkReviewState,
        revision ? { consent: true, revision: true } : { consent: true },
        { query: overviewQuery(filters) },
      ),
    onSuccess: async (state) => {
      await client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData(key, state);
    },
    // A lost response can still have started the review. Read the status without resending the POST.
    onError: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: key, exact: true }),
        client.invalidateQueries({ queryKey: ACCOUNT_KEY, exact: true }),
      ]);
    },
  });
}

export function useReviewAccount(pollPending = false, enabled = true) {
  return useQuery({
    queryKey: ACCOUNT_KEY,
    enabled,
    queryFn: ({ signal }) => apiGet(ACCOUNT_PATH, WorkReviewAccount, { signal }),
    refetchInterval: (query) =>
      pollPending && query.state.data?.status === 'pending' ? 2_000 : false,
  });
}

export function useReviewAutomation(enabled = true) {
  return useQuery({
    queryKey: AUTOMATION_KEY,
    queryFn: ({ signal }) => apiGet(AUTOMATION_PATH, WorkReviewAutomation, { signal }),
    enabled,
    refetchInterval: ({ state }) => (state.data?.enabled ? AUTOMATION_READ_INTERVAL_MS : false),
  });
}

export function useChangeReviewAutomation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      apiSend('POST', AUTOMATION_PATH, WorkReviewAutomation, { enabled }),
    onError: () => client.invalidateQueries({ queryKey: ACCOUNT_KEY }),
    // A disconnect or lost response may have changed the setting while this request was in flight.
    onSettled: () => client.invalidateQueries({ queryKey: AUTOMATION_KEY }),
  });
}

export function useConnectReviewAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (newProfile: boolean) =>
      apiSend(
        'POST',
        `${ACCOUNT_PATH}/connect`,
        WorkReviewConnect,
        newProfile ? { newProfile } : {},
      ),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ACCOUNT_KEY }),
        client.invalidateQueries({ queryKey: AUTOMATION_KEY }),
      ]);
    },
  });
}

export function useDisconnectReviewAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', `${ACCOUNT_PATH}/disconnect`, WorkReviewAccount, {}),
    onSuccess: async (account) => {
      await client.cancelQueries({ queryKey: ACCOUNT_KEY });
      client.setQueryData(ACCOUNT_KEY, account);
    },
    onError: () => client.invalidateQueries({ queryKey: ACCOUNT_KEY }),
    onSettled: () => client.invalidateQueries({ queryKey: AUTOMATION_KEY }),
  });
}
