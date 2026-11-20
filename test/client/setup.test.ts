// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceStatus, type RefreshRun } from '../../src/shared/contracts/sources';
import { useBootstrap } from '../../src/client/lib/bootstrap';
import { createQueryClient } from '../../src/client/lib/queryClient';
import {
  SETUP_PATH_COMPLETE,
  SETUP_PATH_DISCOVER,
  completeSetup,
  discoverSetup,
  discoveryTag,
  useCompleteSetup,
  useSetupDiscovery,
} from '../../src/client/lib/setup';

// The client half of first-launch Setup (G10_1; TECH J1): discovery is a POST that only looks, Finish is a POST that starts one
// run, nothing is shown as found or finished before the server answers, a refusal changes nothing, and Finish settles only after
// the bootstrap has been read again (so the shell, which sends an unfinished setup to /setup, does not bounce the owner back).

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const failure = (code: string, status: number, message = 'Plain words.') =>
  reply({ error: { code, message, retryable: false } }, status);

type Call = { url: string; init: RequestInit };

/** Answers by path, in order for each path, and records every call. */
function server(routes: Record<string, Array<Response | Error>>): Call[] {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([path, list]) => [path, [...list]]));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = queues.get(url)?.shift();
      if (next instanceof Error) throw next;
      return next ?? reply({});
    }),
  );
  return calls;
}

const header = (call: Call | undefined, name: string) =>
  (call?.init.headers as Record<string, string> | undefined)?.[name];

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);

const DISCOVERY = {
  sources: [
    { id: 'codex', name: 'Codex', status: 'ok', location: '~/.codex', sessions: 12 },
    { id: 'claude', name: 'Claude Code', status: 'notfound' },
    { id: 'paseo', name: 'Paseo', status: 'notrunning' },
  ],
  accounts: [{ id: 'github', name: 'GitHub', status: 'notconnected' }],
};
const RUN = {
  id: 7,
  state: 'running',
  startedAt: '2026-11-04T17:42:00.000Z',
  linkRebuild: 'pending',
  sources: { codex: { state: 'running' } },
} satisfies RefreshRun;
const BOOTSTRAP = (setupComplete: boolean) => ({
  setupComplete,
  timezone: 'America/Los_Angeles',
  today: '2026-11-04',
  lookbackStart: '2025-11-05',
  issues: [],
});

describe('the requests', () => {
  it('Discover POSTs to the setup route with the app header and an empty JSON body, and reads the sources and accounts', async () => {
    const calls = server({ [SETUP_PATH_DISCOVER]: [reply(DISCOVERY)] });
    const answer = await discoverSetup();
    expect(answer.sources?.map((s) => s.status)).toEqual(['ok', 'notfound', 'notrunning']);
    expect(answer.accounts?.[0]?.id).toBe('github');
    expect(calls[0]?.url).toBe('/api/setup/discover');
    expect(calls[0]?.init.method).toBe('POST');
    expect(header(calls[0], 'X-Agent-Productivity-Request')).toBe('1');
    expect(header(calls[0], 'Content-Type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  it('Finish POSTs the same way and reads back the run it started', async () => {
    const calls = server({ [SETUP_PATH_COMPLETE]: [reply(RUN, 202)] });
    const run = await completeSetup();
    expect(run).toMatchObject({ id: 7, state: 'running' });
    expect(calls[0]?.url).toBe('/api/setup/complete');
    expect(calls[0]?.init.method).toBe('POST');
    expect(header(calls[0], 'X-Agent-Productivity-Request')).toBe('1');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  it('sends no path, folder, key or token: the only things Setup posts are empty bodies', async () => {
    const calls = server({
      [SETUP_PATH_DISCOVER]: [reply(DISCOVERY)],
      [SETUP_PATH_COMPLETE]: [reply(RUN, 202)],
    });
    await discoverSetup();
    await completeSetup();
    expect(calls.map((c) => String(c.init.body))).toEqual(['{}', '{}']);
  });

  it('reads an answer that is not the contract as unreadable instead of rendering undefined', async () => {
    server({ [SETUP_PATH_DISCOVER]: [reply({ sources: [{ id: 'codex', status: 'ok' }] })] });
    await expect(discoverSetup()).rejects.toMatchObject({ code: 'unreadable' });
    server({ [SETUP_PATH_COMPLETE]: [reply({ id: 'seven' }, 202)] });
    await expect(completeSetup()).rejects.toMatchObject({ code: 'unreadable' });
  });
});

describe('useSetupDiscovery', () => {
  it('is pending (Looking…) until the server answers, and shows nothing as found before that', async () => {
    let release: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const { result } = renderHook(() => useSetupDiscovery(), {
      wrapper: wrapper(createQueryClient()),
    });
    expect(result.current.data).toBeUndefined();
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(result.current.data).toBeUndefined();
    await act(async () => release(reply(DISCOVERY)));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.sources).toHaveLength(3);
  });

  it('reads the sources and the issue count again after an answer (discovery records the rows it found)', async () => {
    server({ [SETUP_PATH_DISCOVER]: [reply(DISCOVERY)] });
    const client = createQueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSetupDiscovery(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sources'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['bootstrap'] });
  });

  it('a refusal changes nothing: no data, and no queries read again', async () => {
    server({ [SETUP_PATH_DISCOVER]: [failure('internal', 500, 'Could not look.')] });
    const client = createQueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSetupDiscovery(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useCompleteSetup', () => {
  /** The shell's own question (setup complete?) rendered beside the mutation, so the test sees what the shell would see. */
  function both(client: QueryClient) {
    return renderHook(() => ({ finish: useCompleteSetup(), bootstrap: useBootstrap() }), {
      wrapper: wrapper(client),
    });
  }

  it('settles only after the bootstrap says setup is complete, so Overview does not bounce back to Setup', async () => {
    const calls = server({
      '/api/bootstrap': [reply(BOOTSTRAP(false)), reply(BOOTSTRAP(true))],
      [SETUP_PATH_COMPLETE]: [reply(RUN, 202)],
    });
    const client = createQueryClient();
    const { result } = both(client);
    await waitFor(() => expect(result.current.bootstrap.data?.setupComplete).toBe(false));
    let run: unknown;
    let cached: unknown;
    await act(async () => {
      run = await result.current.finish.mutateAsync();
      // At the moment the mutation settled, the shell's own copy (the cache) already says complete.
      cached = client.getQueryData(['bootstrap']);
    });
    expect(run).toMatchObject({ id: 7 });
    expect(cached).toMatchObject({ setupComplete: true });
    const order = calls.map((c) => c.url);
    expect(order.indexOf(SETUP_PATH_COMPLETE)).toBeLessThan(order.lastIndexOf('/api/bootstrap'));
  });

  it('reads the bootstrap again even when nothing on the page watches it (Setup draws no app-bar chip), so the shell mounts with the new answer', async () => {
    server({
      '/api/bootstrap': [reply(BOOTSTRAP(false)), reply(BOOTSTRAP(true))],
      [SETUP_PATH_COMPLETE]: [reply(RUN, 202)],
    });
    const client = createQueryClient();
    // The shell asked once on the first load and went away when the owner was sent to Setup: the answer is cached, nothing watches it.
    const shell = renderHook(() => useBootstrap(), { wrapper: wrapper(client) });
    await waitFor(() => expect(shell.result.current.data?.setupComplete).toBe(false));
    shell.unmount();
    const { result } = renderHook(() => useCompleteSetup(), { wrapper: wrapper(client) });
    let cached: unknown;
    await act(async () => {
      await result.current.mutateAsync();
      cached = client.getQueryData(['bootstrap']);
    });
    expect(cached).toMatchObject({ setupComplete: true });
  });

  it('starts the one run the server answers with and asks for nothing else of the server', async () => {
    const calls = server({
      '/api/bootstrap': [reply(BOOTSTRAP(false)), reply(BOOTSTRAP(true))],
      [SETUP_PATH_COMPLETE]: [reply(RUN, 202)],
    });
    const { result } = both(createQueryClient());
    await waitFor(() => expect(result.current.bootstrap.isSuccess).toBe(true));
    await act(async () => {
      await result.current.finish.mutateAsync();
    });
    expect(calls.filter((c) => c.url === SETUP_PATH_COMPLETE)).toHaveLength(1);
    expect(calls.some((c) => c.url === '/api/refresh')).toBe(false);
  });

  it('a refusal leaves setup open: the bootstrap is not read again and the mutation fails', async () => {
    const calls = server({
      '/api/bootstrap': [reply(BOOTSTRAP(false)), reply(BOOTSTRAP(true))],
      [SETUP_PATH_COMPLETE]: [failure('internal', 500, 'Could not save.')],
    });
    const { result } = both(createQueryClient());
    await waitFor(() => expect(result.current.bootstrap.isSuccess).toBe(true));
    await act(async () => {
      await result.current.finish.mutateAsync().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.finish.isError).toBe(true));
    expect(result.current.bootstrap.data?.setupComplete).toBe(false);
    expect(calls.filter((c) => c.url === '/api/bootstrap')).toHaveLength(1);
  });
});

describe('discovery tags', () => {
  it('says Looking until the server has answered, then Found, Not found, Access denied or Not running', () => {
    expect(discoveryTag(undefined).text).toBe('Looking…');
    expect(discoveryTag('checking').text).toBe('Looking…');
    expect(discoveryTag('ok').text).toBe('Found');
    expect(discoveryTag('notfound').text).toBe('Not found');
    expect(discoveryTag('denied').text).toBe('Access denied');
    expect(discoveryTag('notrunning').text).toBe('Not running');
  });

  it('reads a partly readable source as Found, and keeps the words Sources already uses for the other two', () => {
    expect(discoveryTag('partial').text).toBe('Found');
    expect(discoveryTag('needspassword').text).toBe('Needs a password');
    expect(discoveryTag('failed').text).toBe('Unavailable');
    expect(discoveryTag('failed', true).text).toBe('Refresh failed');
  });

  it('has a word for every status the contract can send', () => {
    for (const status of SourceStatus.shape.status.options) {
      expect(discoveryTag(status).text.length).toBeGreaterThan(0);
    }
  });
});
