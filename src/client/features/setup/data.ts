import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { ConnectPollResponse, ConnectResponse } from '../../../shared/contracts/accounts';
import { AccountStatus } from '../../../shared/contracts/sources';
import { ApiRequestError, apiGet, apiSend } from '../../lib/api';
import { invalidateServerState } from '../../lib/queryClient';

// What Setup's second and third steps read and write beyond the lib's hooks (lib/setup.ts for discovery and Finish, lib/accounts.ts
// for ChatGPT, lib/repos.ts for repositories): the GitHub sign-in and the App's client ID.
// Every write reads the sources, the issue count and every number again, because a connection or a repo changes what they say.
// Nothing is optimistic: a card or a row changes only after the server has answered.

export type Connected = z.infer<typeof ConnectResponse>;
export type Poll = z.infer<typeof ConnectPollResponse>;

const refresh = (client: ReturnType<typeof useQueryClient>): Promise<void> =>
  invalidateServerState(client).catch(() => undefined);

/** What a failed call says, in words; a call that never reached the app gets the fallback. */
export function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError && error.message !== '' ? error.message : fallback;
}

/** The message the server attached to one field of a 400 (`details.fields.clientId`), else its own sentence. */
export function fieldMessageOf(error: unknown, field: string, fallback: string): string {
  if (error instanceof ApiRequestError) {
    const fields = error.details?.['fields'];
    const named =
      typeof fields === 'object' && fields !== null
        ? (fields as Record<string, unknown>)[field]
        : undefined;
    if (typeof named === 'string' && named !== '') return named;
  }
  return messageOf(error, fallback);
}

// ---- GitHub ----

/** Starts the sign-in: the existing `gh` one answers at once, otherwise a device code to enter on github.com. */
export function useGithubConnect() {
  const client = useQueryClient();
  return useMutation<Connected, unknown, void>({
    mutationFn: () => apiSend('POST', '/api/accounts/github/connect', ConnectResponse, {}),
    // Not awaited: the page reads the answer (a code to show) the moment it arrives. A refusal changes nothing on the card, but a
    // sign-in that was cancelled to start this one might have, so it is read again either way.
    onSuccess: () => void refresh(client),
    onError: () => void refresh(client),
  });
}

/** Cancels a device sign-in that is waiting (the poll then says `cancelled`). Setup offers no other disconnect. */
export function useGithubCancel() {
  const client = useQueryClient();
  return useMutation<z.infer<typeof AccountStatus>, unknown, void>({
    mutationFn: () => apiSend('POST', '/api/accounts/github/disconnect', AccountStatus, {}),
    onSuccess: () => refresh(client),
  });
}

/** Saves the App's client ID. It is a setting, not a secret: the route refuses every other field. */
export function useSaveClientId() {
  const client = useQueryClient();
  return useMutation<z.infer<typeof AccountStatus>, unknown, string>({
    mutationFn: (clientId) =>
      apiSend('PUT', '/api/accounts/github/app', AccountStatus, { clientId }),
    onSuccess: () => refresh(client),
  });
}

const POLL_MS = 2000;

/**
 * The state of the sign-in this page started. The server polls GitHub at GitHub's own interval; this only asks the server how it is
 * going, every two seconds, until it is no longer pending or the server no longer knows the login id (an error, shown as its sentence).
 */
export function useGithubPoll(loginId: string | null) {
  return useQuery({
    queryKey: ['github-signin', loginId] as const,
    queryFn: ({ signal }) =>
      apiGet(
        `/api/accounts/github/connect/${encodeURIComponent(loginId ?? '')}`,
        ConnectPollResponse,
        { signal },
      ),
    enabled: loginId !== null,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data !== undefined && (query.state.data.state ?? 'pending') === 'pending'
        ? POLL_MS
        : false,
  });
}
