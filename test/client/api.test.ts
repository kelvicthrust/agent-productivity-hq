import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiRequestError, apiGet, apiSend, queryString } from '../../src/client/lib/api';
import {
  STALE_TIME_MS,
  createQueryClient,
  invalidateServerState,
  queryKeys,
  shouldRetry,
} from '../../src/client/lib/queryClient';

// The one fetch in the client: what it sends, how it reads answers, and how every failure reaches a screen.
afterEach(() => vi.unstubAllGlobals());

const Thing = z.object({ n: z.number() });
const reply = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const stub = (...answers: Array<Response | Error>) => {
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
};
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
const failureOf = async (run: () => Promise<unknown>): Promise<ApiRequestError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiRequestError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
};

describe('queryString', () => {
  it('sorts keys, drops undefined and null, and is empty when nothing is left', () => {
    expect(
      queryString({ provider: 'codex', start: '2026-11-02', end: undefined, repos: null }),
    ).toBe('?provider=codex&start=2026-11-02');
    expect(queryString({ a: undefined })).toBe('');
    expect(queryString(undefined)).toBe('');
    expect(queryString({ limit: 15, flag: false })).toBe('?flag=false&limit=15');
  });
});

describe('reading', () => {
  it('sends a GET with Accept and no app header, and returns the parsed body', async () => {
    const calls = stub(reply({ n: 3 }));
    const result = await apiGet('/api/x', Thing, { query: { b: 2, a: 1 } });
    expect(result).toEqual({ n: 3 });
    expect(calls[0]!.url).toBe('/api/x?a=1&b=2');
    expect(calls[0]!.init.method).toBe('GET');
    expect(headersOf(calls[0]!.init)['Accept']).toBe('application/json');
    expect(headersOf(calls[0]!.init)['X-Agent-Productivity-Request']).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('fails as unreadable, with only a count, when the body breaks the contract or is not JSON', async () => {
    stub(reply({ n: 'three' }), reply('<html>nope</html>'));
    const drift = await failureOf(() => apiGet('/api/x', Thing));
    expect(drift).toMatchObject({ code: 'unreadable', status: 200, details: { issues: 1 } });
    expect(drift.message).not.toContain('three');
    const html = await failureOf(() => apiGet('/api/x', Thing));
    expect(html.code).toBe('unreadable');
  });
});

describe('writing', () => {
  it('sends the app header, a JSON content type and a JSON body', async () => {
    const calls = stub(reply({ n: 1 }, 202));
    await apiSend('POST', '/api/refresh', Thing, { sources: ['codex'] });
    const { init } = calls[0]!;
    expect(init.method).toBe('POST');
    expect(headersOf(init)['X-Agent-Productivity-Request']).toBe('1');
    expect(headersOf(init)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"sources":["codex"]}');
  });

  it('sends an empty object when there is no body, and returns nothing for a 204', async () => {
    const calls = stub(new Response(null, { status: 204 }));
    expect(await apiSend('DELETE', '/api/prs/1/links/2', null)).toBeUndefined();
    expect(calls[0]!.init.body).toBe('{}');
  });
});

describe('failing', () => {
  it("turns the server's error envelope into code, status, retryable and details", async () => {
    stub(
      reply(
        {
          error: {
            code: 'refresh_running',
            message: 'A refresh is running.',
            retryable: true,
            details: { runId: 7 },
          },
        },
        409,
      ),
    );
    const error = await failureOf(() => apiSend('POST', '/api/refresh', Thing));
    expect(error).toMatchObject({
      code: 'refresh_running',
      status: 409,
      retryable: true,
      details: { runId: 7 },
      message: 'A refresh is running.',
    });
  });

  it('does not echo a body that is not the app’s own envelope', async () => {
    stub(reply('<html>proxy error SECRET</html>', 502), reply({ nothing: true }, 404));
    const proxy = await failureOf(() => apiGet('/api/x', Thing));
    expect(proxy).toMatchObject({ code: 'internal', status: 502, retryable: true });
    expect(proxy.message).not.toContain('SECRET');
    const other = await failureOf(() => apiGet('/api/x', Thing));
    expect(other).toMatchObject({ code: 'internal', status: 404, retryable: false });
  });

  it('reports a network failure as retryable, and lets an abort through untouched', async () => {
    stub(new TypeError('failed to fetch'));
    const network = await failureOf(() => apiGet('/api/x', Thing));
    expect(network).toMatchObject({ code: 'network', retryable: true });
    stub(new DOMException('aborted', 'AbortError'));
    await expect(apiGet('/api/x', Thing)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('the query client', () => {
  it('keeps data fresh for 30 seconds, refetches on focus, and retries only what is retryable, twice', () => {
    const defaults = createQueryClient().getDefaultOptions().queries;
    expect(defaults?.staleTime).toBe(STALE_TIME_MS);
    expect(STALE_TIME_MS).toBe(30_000);
    expect(defaults?.refetchOnWindowFocus).toBe(true);
    const retryable = new ApiRequestError('upstream_unavailable', 'x', { retryable: true });
    const final = new ApiRequestError('invalid_input', 'x', { retryable: false });
    expect(shouldRetry(0, retryable)).toBe(true);
    expect(shouldRetry(1, retryable)).toBe(true);
    expect(shouldRetry(2, retryable)).toBe(false);
    expect(shouldRetry(0, final)).toBe(false);
    expect(shouldRetry(0, new Error('boom'))).toBe(false);
  });

  it('names its keys so one invalidation covers every number', () => {
    expect(queryKeys.bootstrap).toEqual(['bootstrap']);
    expect(queryKeys.sources).toEqual(['sources']);
    expect(queryKeys.analytics('usage')).toEqual(['analytics', 'usage']);
    expect(queryKeys.analytics('usage', { provider: 'all' })).toEqual([
      'analytics',
      'usage',
      { provider: 'all' },
    ]);
  });

  it('invalidates analytics, sources and bootstrap after a refresh finishes', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.analytics('usage', { a: 1 }), 1);
    client.setQueryData(queryKeys.analytics('overview'), 2);
    client.setQueryData(queryKeys.sources, 3);
    client.setQueryData(queryKeys.bootstrap, 4);
    client.setQueryData(['unrelated'], 5);
    await invalidateServerState(client);
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    expect(stale(queryKeys.analytics('usage', { a: 1 }))).toBe(true);
    expect(stale(queryKeys.analytics('overview'))).toBe(true);
    expect(stale(queryKeys.sources)).toBe(true);
    expect(stale(queryKeys.bootstrap)).toBe(true);
    expect(stale(['unrelated'])).toBe(false);
  });
});
