import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  WorkReviewAccount,
  WorkReviewConnect,
  WorkReviewState,
} from '../../../../shared/contracts/work-review';
import { overviewQuery } from '../../../lib/analytics';
import { apiGet, apiSend, queryString } from '../../../lib/api';
import type { Filters } from '../../../lib/filters';
import { queryKeys } from '../../../lib/queryClient';

const PATH = '/api/work-review';
const ACCOUNT_PATH = `${PATH}/account`;
const ACCOUNT_KEY = ['work-review-account'] as const;

export const reviewScopeKey = (filters: Filters): string => queryString(overviewQuery(filters));

function reviewKey(filters: Filters, version?: number) {
  return queryKeys.analytics('work-review', { ...overviewQuery(filters), version });
}

export function useWorkReview(filters: Filters, version?: number) {
  const client = useQueryClient();
  return useQuery({
    queryKey: reviewKey(filters, version),
    queryFn: async ({ signal }) => {
      const state = await apiGet(PATH, WorkReviewState, {
        signal,
        query: { ...overviewQuery(filters), version },
      });
      if (state.status === 'failed')
        void client.invalidateQueries({ queryKey: ACCOUNT_KEY, exact: true });
      return state;
    },
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1_500 : false),
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

export function useReviewAccount(pollPending = false) {
  return useQuery({
    queryKey: ACCOUNT_KEY,
    queryFn: ({ signal }) => apiGet(ACCOUNT_PATH, WorkReviewAccount, { signal }),
    refetchInterval: (query) =>
      pollPending && query.state.data?.status === 'pending' ? 2_000 : false,
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
    onSettled: () => client.invalidateQueries({ queryKey: ACCOUNT_KEY }),
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
  });
}
