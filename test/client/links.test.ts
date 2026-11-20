// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LINK_SAVE_FAILED,
  STATE_AFTER,
  linkPath,
  priorStateOf,
  requestFor,
  saveLinkState,
  useEvidence,
  useLinkChange,
  type LinkAction,
  type LinkState,
} from '../../src/client/lib/links';
import { createQueryClient, queryKeys } from '../../src/client/lib/queryClient';

// The client half of owner link decisions (TECH › Owner link decision transitions): every action is one request that puts the pair
// in a state, every Undo is the request that puts it back where it was, nothing is cached before the server says yes, and a
// success refreshes every number that reads links.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reply = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

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

const SESSION = {
  id: 7,
  provider: 'claude',
  kind: 'root',
  nameLead: 'Root session',
  named: false,
  providerSessionRef: 'claude:abc',
  tokens: 1200,
  startedAt: '2026-11-03T17:00:00.000Z',
  startedBasis: 'source_start',
  firstEventAt: '2026-11-03T17:00:00.000Z',
  lastEventAt: '2026-11-03T17:50:00.000Z',
  linkStatus: 'linked',
  linkedPrs: [],
};
const ITEM = {
  session: SESSION,
  effectiveClass: 'owner',
  sourceClass: 'suggested',
  basis: 'owner',
  basisText: 'Confirmed by you',
  actions: ['remove'],
};

const PR = 'PR_kwDOAbC+/=1';

describe('every action is one request that puts the pair in a state', () => {
  const table: Array<[LinkAction, LinkState, 'PUT' | 'DELETE']> = [
    ['confirm', 'confirmed', 'PUT'],
    ['add', 'confirmed', 'PUT'],
    ['dismiss', 'dismissed', 'PUT'],
    ['reject', 'rejected', 'PUT'],
    ['restore', null, 'DELETE'],
    ['remove', null, 'DELETE'],
  ];
  it.each(table)('%s puts the pair in %s with %s', (action, state, method) => {
    expect(STATE_AFTER[action]).toBe(state);
    const request = requestFor(PR, 7, STATE_AFTER[action]);
    expect(request.method).toBe(method);
    expect(request.body).toEqual(state === null ? undefined : { decision: state });
  });

  it('encodes the opaque PR id in the path and leaves the session id a number', () => {
    expect(linkPath(PR, 7)).toBe('/api/prs/PR_kwDOAbC%2B%2F%3D1/links/7');
  });

  it('sends the app header and a JSON body on a PUT, and a DELETE that answers 204 gives no item', async () => {
    const calls = stub(reply(ITEM), new Response(null, { status: 204 }));
    const saved = await saveLinkState(PR, 7, 'confirmed');
    expect(saved?.effectiveClass).toBe('owner');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ decision: 'confirmed' });
    expect((calls[0]?.init.headers as Record<string, string>)['X-Agent-Productivity-Request']).toBe(
      '1',
    );
    expect(await saveLinkState(PR, 7, null)).toBeNull();
    expect(calls[1]?.init.method).toBe('DELETE');
  });
});

describe('Undo goes back to what the pair was', () => {
  const item = (effectiveClass: 'evidence' | 'owner' | 'suggested' | 'rejected') => ({
    effectiveClass,
  });
  it('reads the owner’s decision off the item the owner acted on', () => {
    expect(priorStateOf(item('owner'))).toBe('confirmed');
    expect(priorStateOf(item('rejected'))).toBe('rejected');
    expect(priorStateOf(item('suggested'))).toBeNull();
    expect(priorStateOf(item('evidence'))).toBeNull();
    expect(priorStateOf(undefined)).toBeNull();
  });

  it('each action’s Undo request restores the state before it', () => {
    // [action, item acted on, request that Undo sends]
    const cases: Array<
      [LinkAction, ReturnType<typeof item> | undefined, 'PUT' | 'DELETE', string?]
    > = [
      ['confirm', item('suggested'), 'DELETE'], // suggested -> owner; back to suggested
      ['dismiss', item('suggested'), 'DELETE'],
      ['reject', item('evidence'), 'DELETE'],
      ['restore', item('rejected'), 'PUT', 'rejected'], // rejected -> evidence; back to struck through
      ['remove', item('owner'), 'PUT', 'confirmed'], // owner -> computed; back to the owner link
      ['add', undefined, 'DELETE'], // none -> owner; back to none
    ];
    for (const [action, acted, method, decision] of cases) {
      const undo = requestFor(PR, 7, priorStateOf(acted));
      expect(undo.method, action).toBe(method);
      expect(undo.body, action).toEqual(decision === undefined ? undefined : { decision });
    }
  });
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

describe('useLinkChange', () => {
  it('refreshes every analytics query after a change that saved, and no other', async () => {
    stub(reply(ITEM));
    const client = createQueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useLinkChange(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({ prId: PR, sessionId: 7, state: 'confirmed' });
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['analytics'] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('changes nothing in the cache when the change fails, and says why', async () => {
    stub(reply({ error: { code: 'internal', message: 'nope', retryable: false } }, 500));
    const client = createQueryClient();
    client.setQueryData(queryKeys.analytics('prs', { a: 1 }), { items: [] });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useLinkChange(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current
        .mutateAsync({ prId: PR, sessionId: 7, state: 'rejected' })
        .catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(spy).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.analytics('prs', { a: 1 }))).toEqual({ items: [] });
    expect(LINK_SAVE_FAILED).toBe('Couldn’t save your change');
  });
});

describe('useEvidence', () => {
  const DETAIL = { pr: undefined, evidence: [ITEM], candidates: [SESSION] };

  it('asks nothing until a PR is named, then reads that PR’s detail under the analytics key', async () => {
    const calls = stub(reply(DETAIL));
    const client = createQueryClient();
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useEvidence(id), {
      wrapper: wrapper(client),
      initialProps: { id: null as string | null },
    });
    expect(calls).toHaveLength(0);
    expect(result.current.fetchStatus).toBe('idle');
    rerender({ id: PR });
    await waitFor(() => expect(result.current.data?.evidence).toHaveLength(1));
    expect(calls[0]?.url).toBe('/api/prs/PR_kwDOAbC%2B%2F%3D1');
    expect(client.getQueryData(['analytics', 'pr-detail', { prId: PR }])).toEqual(DETAIL);
  });
});
