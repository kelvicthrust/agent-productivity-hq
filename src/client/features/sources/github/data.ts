import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { ConnectPollResponse, ConnectResponse } from '../../../../shared/contracts/accounts';
import { AccountStatus } from '../../../../shared/contracts/sources';
import { useSources } from '../../../components/RefreshBanner';
import { ApiRequestError, apiGet, apiSend } from '../../../lib/api';
import { invalidateServerState } from '../../../lib/queryClient';

// Where the GitHub connection reads and writes. The card is server state: `GET /api/sources` `accounts[0]` (the server caches
// it for 10 seconds and recomputes it at once after any change made through these routes, so each write below invalidates the
// sources query and the page shows the new state straight away). A device sign-in is watched by polling its login id.

export type Connected = z.infer<typeof ConnectResponse>;
export type Poll = z.infer<typeof ConnectPollResponse>;

/** The GitHub card and the sync's own source entry, from the query the whole Sources page shares. */
export function useGithub() {
  const sources = useSources();
  return {
    sources,
    card: sources.data?.accounts?.find((account) => account.id === 'github'),
    sync: sources.data?.sources?.find((source) => source.id === 'github'),
  };
}

/** What a failed call says, in words; a call that never reached the app gets a plain fallback. */
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

/** Reads the card (and every number) again; the caller waits for it only when what follows needs the new state. */
const refresh = (client: ReturnType<typeof useQueryClient>): Promise<void> =>
  invalidateServerState(client).catch(() => undefined);

/** Starts the sign-in: the existing `gh` one answers at once, otherwise a device code to enter on github.com. */
export function useConnect() {
  const client = useQueryClient();
  return useMutation<Connected, unknown, void>({
    mutationFn: () => apiSend('POST', '/api/accounts/github/connect', ConnectResponse, {}),
    // Not awaited: the page reads the answer (a code to show) the moment it arrives, and the card follows when it is read. A
    // refusal (no App yet, a wrong client ID, GitHub unreachable) changes nothing on the card, but a sign-in that was cancelled
    // to start this one might have, so it is read again either way.
    onSuccess: () => void refresh(client),
    onError: () => void refresh(client),
  });
}

/** Stops using the sign-in; while a device sign-in runs it is also what cancels it (the poll then says `cancelled`). */
export function useDisconnect() {
  const client = useQueryClient();
  return useMutation<z.infer<typeof AccountStatus>, unknown, void>({
    mutationFn: () => apiSend('POST', '/api/accounts/github/disconnect', AccountStatus, {}),
    onSuccess: () => refresh(client),
  });
}

/** Saves the App's client ID. It is a setting, not a secret; the answer is the card as it reads now. */
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
 * The state of the sign-in this page started. The server polls GitHub at GitHub's own interval; this only asks the server how
 * it is going, every two seconds, until it is no longer pending (connected, failed, expired or cancelled), or the server no longer
 * knows the login id (an error, shown as its sentence).
 */
export function useSignInPoll(loginId: string | null) {
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
