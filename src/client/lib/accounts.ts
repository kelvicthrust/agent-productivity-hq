import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  ClaudePlanLimitsCheckResponse,
  type CaptureRequest,
  type ClaudePlanLimitsCheckRequest,
  ConnectPollResponse,
  ConnectResponse,
  UsageCapturePreview,
  UsageCaptureResponse,
} from '../../shared/contracts/accounts';
import { AccountStatus, type SourcesResponse } from '../../shared/contracts/sources';
import { ApiRequestError, apiGet, apiSend } from './api';
import { invalidateServerState, queryKeys } from './queryClient';

// Server state for ChatGPT connect, Claude plan checks and legacy Claude capture removal.
// The Sources page and the Overview account cards both read accounts, and features may not import one another, so the requests
// and hooks live here.
//
// What the screens may rely on:
//   - ChatGPT: Connect starts Codex's own sign-in (it also signs Codex in on this computer, which the Connect button says) and
//     answers with a browser address and a login id; the page polls the login id until it is no longer pending. Disconnect only
//     stops the dashboard reading; it does not sign Codex out and deletes nothing that was imported.
//   - Claude: checks limits on demand. Owners with a recorded hook can preview and verify manual removal.
//   - Every write reads the sources again afterwards (the account cards, the issue count and every number), because a connection
//     or a capture changes what the Overview and Sources say.

export type Connected = z.infer<typeof ConnectResponse>;
export type Poll = z.infer<typeof ConnectPollResponse>;
export type CapturePreview = z.infer<typeof UsageCapturePreview>;
export type CaptureResult = z.infer<typeof UsageCaptureResponse>;
export type Account = z.infer<typeof AccountStatus>;

export type { CaptureRequest };

export const CHATGPT_CONNECT_PATH = '/api/accounts/chatgpt/connect';
export const CHATGPT_DISCONNECT_PATH = '/api/accounts/chatgpt/disconnect';
export const CLAUDE_PLAN_LIMITS_CHECK_PATH = '/api/accounts/claude/plan-limits/check';
export const CAPTURE_PREVIEW_PATH = '/api/accounts/claude/usage-capture/preview';
export const CAPTURE_PATH = '/api/accounts/claude/usage-capture';

/** `/api/accounts/chatgpt/connect/{loginId}`. The id is the server's own, so it is encoded. */
export const chatgptPollPath = (loginId: string): string =>
  `${CHATGPT_CONNECT_PATH}/${encodeURIComponent(loginId)}`;

export const connectChatgpt = (): Promise<Connected> =>
  apiSend('POST', CHATGPT_CONNECT_PATH, ConnectResponse, {});

export const disconnectChatgpt = (): Promise<Account> =>
  apiSend('POST', CHATGPT_DISCONNECT_PATH, AccountStatus, {});

export const pollChatgpt = (loginId: string, signal?: AbortSignal): Promise<Poll> =>
  apiGet(chatgptPollPath(loginId), ConnectPollResponse, signal ? { signal } : {});

export const readCapturePreview = (signal?: AbortSignal): Promise<CapturePreview> =>
  apiGet(`${CAPTURE_PREVIEW_PATH}?action=remove`, UsageCapturePreview, signal ? { signal } : {});

export const sendCapture = (request: CaptureRequest): Promise<CaptureResult> =>
  apiSend('PUT', CAPTURE_PATH, UsageCaptureResponse, request);

/** Reads the sources (and every number) again. The caller waits for it only when what follows needs the new state. */
const refresh = (client: ReturnType<typeof useQueryClient>): Promise<void> =>
  invalidateServerState(client).catch(() => undefined);

export function useClaudePlanLimitsCheck(mode?: ClaudePlanLimitsCheckRequest['mode']) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiSend(
        'POST',
        CLAUDE_PLAN_LIMITS_CHECK_PATH,
        ClaudePlanLimitsCheckResponse,
        mode && { mode },
      ),
    onSuccess: async ({ account }) => {
      if (mode === 'refresh' && account.planLimits?.report?.provenance !== 'claude_code_oauth')
        return;
      await client.cancelQueries({ queryKey: queryKeys.sources });
      client.setQueryData<z.infer<typeof SourcesResponse>>(
        queryKeys.sources,
        (previous) =>
          previous && {
            ...previous,
            ...(previous.accounts && {
              accounts: previous.accounts.map((current) =>
                current.id === account.id ? account : current,
              ),
            }),
          },
      );
      void refresh(client);
    },
  });
}

/**
 * Starts ChatGPT's sign-in. Not awaited before the answer is shown: the page needs the address and login id at once, and the
 * card follows when the sources are read. A refusal (no `codex` on this computer, the app-server not answering) changes nothing
 * on the card, but a sign-in that was cancelled to start this one might have, so it is read again either way.
 */
export function useChatgptConnect() {
  const client = useQueryClient();
  return useMutation<Connected, unknown, void>({
    mutationFn: connectChatgpt,
    onSuccess: () => void refresh(client),
    onError: () => void refresh(client),
  });
}

/** Stops the dashboard reading ChatGPT. It does not sign Codex out; what was imported stays. */
export function useChatgptDisconnect() {
  const client = useQueryClient();
  return useMutation<Account, unknown, void>({
    mutationFn: disconnectChatgpt,
    onSuccess: () => refresh(client),
  });
}

export const POLL_MS = 2000;

/**
 * The state of the sign-in this page started: asked every two seconds until it is no longer pending (connected, failed, expired
 * or cancelled), or until the server no longer knows the login id (an error, shown as its sentence). Nothing is asked without a
 * login id.
 */
export function useChatgptPoll(loginId: string | null) {
  return useQuery({
    queryKey: ['chatgpt-signin', loginId] as const,
    queryFn: ({ signal }) => pollChatgpt(loginId ?? '', signal),
    enabled: loginId !== null,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data !== undefined && (query.state.data.state ?? 'pending') === 'pending'
        ? POLL_MS
        : false,
  });
}

export const CAPTURE_PREVIEW_KEY = ['claude-capture-preview'] as const;

export function useCapturePreview() {
  return useQuery({
    queryKey: CAPTURE_PREVIEW_KEY,
    queryFn: ({ signal }) => readCapturePreview(signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

export function useCaptureChange() {
  const client = useQueryClient();
  const refreshPreview = () => client.invalidateQueries({ queryKey: CAPTURE_PREVIEW_KEY });
  return useMutation<CaptureResult, unknown, CaptureRequest>({
    mutationFn: sendCapture,
    onSuccess: async () => {
      await Promise.all([refresh(client), refreshPreview()]);
    },
    onError: (error) => {
      if (captureErrorKind(error) === 'conflict') void refreshPreview();
    },
  });
}

export type CaptureErrorKind = 'conflict' | 'unreadable' | 'other';

/** The recovery hint to show after a refused legacy removal request. */
export function captureErrorKind(error: unknown): CaptureErrorKind {
  if (!(error instanceof ApiRequestError)) return 'other';
  switch (error.code) {
    case 'claude_settings_conflict':
      return 'conflict';
    case 'claude_settings_unreadable':
      return 'unreadable';
    default:
      return 'other';
  }
}
