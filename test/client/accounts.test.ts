// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_PATH,
  CAPTURE_PREVIEW_KEY,
  CAPTURE_PREVIEW_PATH,
  CHATGPT_CONNECT_PATH,
  CHATGPT_DISCONNECT_PATH,
  CLAUDE_PLAN_LIMITS_CHECK_PATH,
  POLL_MS,
  captureErrorKind,
  chatgptPollPath,
  connectChatgpt,
  disconnectChatgpt,
  pollChatgpt,
  readCapturePreview,
  sendCapture,
  useCaptureChange,
  useCapturePreview,
  useChatgptConnect,
  useChatgptDisconnect,
  useChatgptPoll,
  useClaudePlanLimitsCheck,
} from '../../src/client/lib/accounts';
import { ApiRequestError } from '../../src/client/lib/api';
import { createQueryClient } from '../../src/client/lib/queryClient';

// Requests use the shared schemas and write guard. A check updates passive account views, and
// a refused removal refreshes the preview when the recorded settings have changed.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const reply = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const failure = (code: string, status: number, message = 'Plain words.') =>
  reply({ error: { code, message, retryable: false } }, status);

function stub(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...answers];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? reply({});
    }),
  );
  return calls;
}

const header = (call: { init: RequestInit } | undefined, name: string) =>
  (call?.init.headers as Record<string, string> | undefined)?.[name];

const ACCOUNT = { id: 'chatgpt', name: 'ChatGPT', status: 'notconnected' };
const CONNECT = {
  loginId: 'login 1/a',
  mode: 'browser',
  authUrl: 'https://auth.example.test/start',
};
const CLAUDE = {
  id: 'claude',
  name: 'Claude',
  status: 'notconnected',
  planLimits: { state: 'unchecked', lastCheckedAt: null, retryAt: null, report: null },
};
const PREVIEW = {
  action: 'remove',
  settingsPath: '/tmp/crew test/settings.json',
  files: [],
  backupPath: null,
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

describe('the requests', () => {
  it('Connect POSTs to the ChatGPT connect route with the app header and an empty JSON body', async () => {
    const calls = stub(reply(CONNECT));
    const answer = await connectChatgpt();
    expect(answer).toMatchObject({ mode: 'browser', authUrl: 'https://auth.example.test/start' });
    expect(calls[0]?.url).toBe(CHATGPT_CONNECT_PATH);
    expect(calls[0]?.init.method).toBe('POST');
    expect(header(calls[0], 'X-Agent-Productivity-Request')).toBe('1');
    expect(header(calls[0], 'Content-Type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  it('Disconnect POSTs and reads the card back', async () => {
    const calls = stub(reply({ ...ACCOUNT, status: 'notconnected' }));
    expect((await disconnectChatgpt()).id).toBe('chatgpt');
    expect(calls[0]?.url).toBe(CHATGPT_DISCONNECT_PATH);
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('the poll path encodes the server’s login id', async () => {
    expect(chatgptPollPath('login 1/a')).toBe('/api/accounts/chatgpt/connect/login%201%2Fa');
    const calls = stub(reply({ state: 'pending' }));
    expect((await pollChatgpt('login 1/a')).state).toBe('pending');
    expect(calls[0]?.url).toBe('/api/accounts/chatgpt/connect/login%201%2Fa');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('sends a read-only GET for the removal preview', async () => {
    const calls = stub(reply(PREVIEW));
    expect(await readCapturePreview()).toEqual(PREVIEW);
    expect(calls[0]?.url).toBe(`${CAPTURE_PREVIEW_PATH}?action=remove`);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(header(calls[0], 'X-Agent-Productivity-Request')).toBeUndefined();
  });

  it('sends only the legacy removal action', async () => {
    const calls = stub(reply({ account: CLAUDE }), reply({ account: CLAUDE }));
    const requests = [{ action: 'begin_remove' }, { action: 'verify_remove' }] as const;
    for (const request of requests) await sendCapture(request);
    for (const [index, call] of calls.entries()) {
      expect(call.url).toBe(CAPTURE_PATH);
      expect(call.init.method).toBe('PUT');
      expect(header(call, 'X-Agent-Productivity-Request')).toBe('1');
      expect(JSON.parse(String(call.init.body))).toEqual(requests[index]);
    }
  });

  it('treats an answer that is outside the contract as unreadable', async () => {
    stub(reply({ action: 'install' }));
    await expect(readCapturePreview()).rejects.toMatchObject({ code: 'unreadable' });
  });
});

describe('captureErrorKind', () => {
  const error = (code: string) =>
    new ApiRequestError(code as ApiRequestError['code'], 'x', { status: 409 });
  it('names removal refusals that have specific recovery steps', () => {
    expect(captureErrorKind(error('claude_settings_conflict'))).toBe('conflict');
    expect(captureErrorKind(error('claude_settings_unreadable'))).toBe('unreadable');
    expect(captureErrorKind(error('internal'))).toBe('other');
    expect(captureErrorKind(new Error('x'))).toBe('other');
    expect(captureErrorKind(undefined)).toBe('other');
  });
});

describe('useChatgptConnect and useChatgptDisconnect', () => {
  it('a Connect that answers reads the sources again, and so does one that is refused', async () => {
    stub(reply(CONNECT), failure('invalid_input', 422, 'Codex is not on this computer.'));
    const client = createQueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useChatgptConnect(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sources'] });
    spy.mockClear();
    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sources'] });
  });

  it('a Disconnect reads the sources again once the server has answered', async () => {
    stub(reply(ACCOUNT));
    const client = createQueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useChatgptDisconnect(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sources'] });
  });
});

describe('useChatgptPoll', () => {
  it('asks nothing without a login id', () => {
    const calls = stub(reply({ state: 'pending' }));
    const { result } = renderHook(() => useChatgptPoll(null), {
      wrapper: wrapper(createQueryClient()),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(calls).toHaveLength(0);
  });

  it('asks again every two seconds while pending, and stops the moment it is not', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stub(
      reply({ state: 'pending' }),
      reply({ state: 'pending' }),
      reply({ state: 'connected' }),
    );
    const { result } = renderHook(() => useChatgptPoll('login-1'), {
      wrapper: wrapper(createQueryClient()),
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    });
    await waitFor(() => expect(result.current.data?.state).toBe('connected'));
    const settled = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(calls).toHaveLength(settled);
    expect(POLL_MS).toBe(2000);
  });
});

describe('useCapturePreview', () => {
  it('reads the recorded settings fresh each time the removal panel opens', async () => {
    const updated = { ...PREVIEW, backupPath: '/tmp/crew test/backup.json' };
    const calls = stub(reply(PREVIEW), reply(updated));
    const client = createQueryClient();
    const first = renderHook(() => useCapturePreview(), { wrapper: wrapper(client) });
    await waitFor(() => expect(first.result.current.data).toEqual(PREVIEW));
    first.unmount();
    await waitFor(() => expect(client.getQueryData(CAPTURE_PREVIEW_KEY)).toBeUndefined());
    const second = renderHook(() => useCapturePreview(), { wrapper: wrapper(client) });
    await waitFor(() => expect(second.result.current.data).toEqual(updated));
    expect(calls).toHaveLength(2);
  });
});

describe('useClaudePlanLimitsCheck', () => {
  it('waits for the owner, posts no credential, and publishes the returned status', async () => {
    const account = {
      ...CLAUDE,
      planLimits: {
        ...CLAUDE.planLimits,
        state: 'signed_out',
        lastCheckedAt: '2026-11-04T17:42:00Z',
      },
    };
    const calls = stub(reply({ account }));
    const client = createQueryClient();
    client.setQueryData(['sources'], { accounts: [ACCOUNT, CLAUDE] });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useClaudePlanLimitsCheck(), {
      wrapper: wrapper(client),
    });
    expect(calls).toHaveLength(0);
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CLAUDE_PLAN_LIMITS_CHECK_PATH);
    expect(calls[0]?.init.method).toBe('POST');
    expect(header(calls[0], 'X-Agent-Productivity-Request')).toBe('1');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
    expect(client.getQueryData(['sources'])).toEqual({ accounts: [ACCOUNT, account] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['analytics'] });
  });
});

describe('useCaptureChange', () => {
  const VERIFY = { action: 'verify_remove' } as const;

  it('a change that saved reads the sources again', async () => {
    stub(reply({ account: { ...ACCOUNT, id: 'claude', status: 'connected' } }));
    const client = createQueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCaptureChange(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync(VERIFY);
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sources'] });
  });

  it('a refusal changes nothing: no source is read again and nothing in the cache moves', async () => {
    stub(failure('claude_settings_unreadable', 422, 'The settings could not be read.'));
    const client = createQueryClient();
    client.setQueryData(['sources'], { sources: [] });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCaptureChange(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync(VERIFY).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(captureErrorKind(result.current.error)).toBe('unreadable');
    expect(spy).not.toHaveBeenCalled();
    expect(client.getQueryData(['sources'])).toEqual({ sources: [] });
  });

  it('a conflict drops the preview so the owner must read the change as it is now', async () => {
    stub(failure('claude_settings_conflict', 409, 'That is not what would be written now.'));
    const client = createQueryClient();
    client.setQueryData(CAPTURE_PREVIEW_KEY, PREVIEW);
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCaptureChange(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync(VERIFY).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(captureErrorKind(result.current.error)).toBe('conflict');
    expect(spy).toHaveBeenCalledWith({ queryKey: CAPTURE_PREVIEW_KEY });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['sources'] });
  });
});
