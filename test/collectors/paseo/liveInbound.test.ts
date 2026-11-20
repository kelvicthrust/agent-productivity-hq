import { inspect } from 'node:util';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createWebSocketTransportFactory } from '@getpaseo/client/internal/daemon-client-websocket-transport';
import type { WebSocketLike } from '@getpaseo/client/internal/daemon-client-transport-types';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { createPaseoLiveFeed, LIVE_POLL_MS } from '../../../src/server/collectors/paseo/live.ts';
import { createPaseoLiveOpen } from '../../../src/server/collectors/paseo/open.ts';
import { allowlistTransport } from '../../../src/server/collectors/paseo/liveTransport.ts';
import { memoryLogger, NOW } from '../../server/helpers.ts';
import { entry } from './liveHelpers.ts';

// The inbound allowlist (liveTransport.ts), first alone on a fake transport, then under the pinned SDK over an in-memory socket: a
// daemon's unsolicited message of any kind must not reach the client, whichever way the daemon advertises its features.

// ---- the filter alone -----------------------------------------------------------------------------------------------------

function fakeTransport() {
  let deliver: (data: unknown, isBinary: boolean) => void = () => undefined;
  let closed: (event?: unknown) => void = () => undefined;
  let errored: (event?: unknown) => void = () => undefined;
  const sent: unknown[] = [];
  const transport = {
    supportsDrain: true as boolean,
    get maxFrameBytes() {
      return 1234;
    },
    send: (data: string | Uint8Array | ArrayBuffer) => {
      sent.push(data);
    },
    close: vi.fn(),
    onMessage: (handler: (data: unknown, isBinary: boolean) => void) => {
      deliver = handler;
      return () => undefined;
    },
    onClose: (handler: (event?: unknown) => void) => {
      closed = handler;
      return () => undefined;
    },
    onError: (handler: (event?: unknown) => void) => {
      errored = handler;
      return () => undefined;
    },
  };
  const wrapped = allowlistTransport(() => transport)({});
  const seen: unknown[] = [];
  const closes: unknown[] = [];
  const errors: unknown[] = [];
  wrapped.onMessage((data) => seen.push(data));
  wrapped.onClose((event) => closes.push(event));
  wrapped.onError((event) => errors.push(event));
  const inbound = (frame: unknown, isBinary = false) =>
    deliver(typeof frame === 'string' || isBinary ? frame : JSON.stringify(frame), isBinary);
  const ask = (requestId: string, type = 'fetch_agents_request') =>
    wrapped.send(JSON.stringify({ type: 'session', message: { type, requestId } }));
  const close = (event?: unknown) => closed(event);
  const error = (event?: unknown) => errored(event);
  return { wrapped, seen, inbound, ask, sent, transport, closes, errors, close, error };
}

const session = (message: object) => ({ type: 'session', message });
const answer = (requestId: string) =>
  session({ type: 'fetch_agents_response', payload: { requestId, entries: [] } });
const failure = (requestId: string) =>
  session({ type: 'rpc_error', payload: { requestId, error: 'x' } });

describe('allowlistTransport', () => {
  it('lets the handshake, the keep-alive and a refused hello through', () => {
    const { seen, inbound } = fakeTransport();
    inbound({ type: 'pong' });
    inbound({ type: 'hello.rejected', reason: 'password_required' });
    inbound(session({ type: 'status', payload: { status: 'server_info', serverId: 's' } }));
    expect(seen).toHaveLength(3);
  });

  it('forwards the handshake as a rebuilt frame with only the named fields', () => {
    const { seen, inbound } = fakeTransport();
    inbound(
      session({
        type: 'status',
        payload: {
          status: 'server_info',
          serverId: 'daemon-1',
          hostname: 'private-host',
          version: '9.9.9',
          sourceId: 'src',
          permissions: ['workspace.read'],
          capabilities: { voice: { dictation: { enabled: true, reason: 'x' } } },
          protocolVersion: 1,
          features: {
            backgroundWorkspaces: true,
            ownedSubscriptions: false,
            binaryChunkingV1: true,
          },
        },
      }),
    );
    expect(seen.map((frame) => JSON.parse(frame as string))).toEqual([
      session({
        type: 'status',
        payload: {
          status: 'server_info',
          serverId: 'daemon-1',
          features: { backgroundWorkspaces: true },
        },
      }),
    ]);
  });

  it('drops a handshake with no usable server id', () => {
    const { seen, inbound } = fakeTransport();
    inbound(session({ type: 'status', payload: { status: 'server_info', serverId: '  ' } }));
    inbound(session({ type: 'status', payload: { status: 'server_info' } }));
    expect(seen).toEqual([]);
  });

  it('keeps the close code and replaces the close reason with a fixed one', () => {
    const { closes, close } = fakeTransport();
    close({ code: 1011, reason: 'SENTINEL free text from the peer' });
    close({ code: 1006 });
    close(new Error('SENTINEL error text'));
    close(undefined);
    expect(closes).toEqual([
      { code: 1011, reason: '' },
      { code: 1006, reason: '' },
      { reason: '' },
      { reason: '' },
    ]);
  });

  it.each(['Password required', 'Incorrect password'])(
    'keeps the close reason %s, which the SDK reads as a password failure',
    (reason) => {
      const { closes, close } = fakeTransport();
      close({ code: 1008, reason });
      expect(closes).toEqual([{ code: 1008, reason }]);
    },
  );

  it('replaces a transport error message with a fixed one and keeps only a machine code', () => {
    const { errors, error } = fakeTransport();
    error(Object.assign(new Error('connect ECONNREFUSED SENTINEL'), { code: 'ECONNREFUSED' }));
    error(Object.assign(new Error('SENTINEL'), { code: 'sentinel code text' }));
    error({ message: 'SENTINEL' });
    error('SENTINEL');
    expect(errors.map((e) => (e as Error).message)).toEqual(Array(4).fill('Transport error'));
    expect(errors.map((e) => (e as { code?: unknown }).code)).toEqual([
      'ECONNREFUSED',
      undefined,
      undefined,
      undefined,
    ]);
    expect(errors.every((e) => e instanceof Error)).toBe(true);
  });

  it('lets through the answer to HQ own listing request, once, and its RPC error', () => {
    const { seen, inbound, ask } = fakeTransport();
    ask('r1');
    ask('r2');
    inbound(answer('r1'));
    inbound(answer('r1')); // a second answer to the same request is not one HQ is waiting for
    inbound(failure('r2'));
    inbound(failure('r2'));
    expect(seen).toHaveLength(2);
  });

  it.each([
    ['an answer to a request HQ never sent', answer('other')],
    ['an RPC error for a request HQ never sent', failure('other')],
    [
      'an agent update',
      session({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }),
    ],
    ['an agent stream', session({ type: 'agent_stream', payload: { agentId: 'a' } })],
    [
      'a workspace update',
      session({ type: 'workspace_update', payload: { kind: 'remove', id: 'w' } }),
    ],
    [
      'a providers snapshot',
      session({ type: 'providers_snapshot_update', payload: { snapshotHash: 'h' } }),
    ],
    ['a permission request', session({ type: 'agent_permission_request', payload: {} })],
    ['another status', session({ type: 'status', payload: { status: 'agent_created' } })],
    ['a session message with no type', session({})],
    ['a message that is not a session one', { type: 'ping' }],
    ['an unknown envelope', { type: 'surprise', message: { type: 'status' } }],
    ['JSON that is not an object', '[1,2]'],
    ['text that is not JSON', 'not json'],
    ['a null', 'null'],
  ])('drops %s', (_name, frame) => {
    const { seen, inbound, ask } = fakeTransport();
    ask('r1');
    inbound(frame);
    expect(seen).toEqual([]);
    // The request still waits: dropping something else did not settle it.
    inbound(answer('r1'));
    expect(seen).toHaveLength(1);
  });

  it('drops every frame that is not text, including one whose bytes are JSON', () => {
    const { seen, inbound, ask } = fakeTransport();
    ask('r1');
    inbound(new Uint8Array([0x31, 1, 0, 3]), true); // a chunk frame
    inbound(new Uint8Array([0x01, 2, 3]), true); // a terminal or file frame
    inbound(new TextEncoder().encode(JSON.stringify({ type: 'pong' })), true);
    inbound(new TextEncoder().encode(JSON.stringify(answer('r1'))).buffer, true);
    expect(seen).toEqual([]);
  });

  it('does not count a request that is not a listing as one an answer is waited for', () => {
    const { seen, inbound, ask } = fakeTransport();
    ask('r1', 'fetch_agent_request');
    inbound(answer('r1'));
    inbound(failure('r1'));
    expect(seen).toEqual([]);
  });

  it('passes what HQ sends through untouched and keeps the transport members live', () => {
    const { wrapped, sent, transport } = fakeTransport();
    wrapped.send('{"type":"ping"}');
    expect(sent).toEqual(['{"type":"ping"}']);
    expect(wrapped.maxFrameBytes).toBe(1234);
    transport.supportsDrain = false;
    expect(wrapped.supportsDrain).toBe(false);
    wrapped.close(1000, 'bye');
    expect(transport.close).toHaveBeenCalledWith(1000, 'bye');
  });

  it('starts every transport with no open requests', () => {
    const first = fakeTransport();
    first.ask('r1');
    const second = fakeTransport();
    second.inbound(answer('r1'));
    expect(second.seen).toEqual([]);
  });
});

// ---- under the SDK --------------------------------------------------------------------------------------------------------

const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};
const MARKER = 'SENTINEL_PRIVATE_INBOUND';
const CWD = '/work/invented/project';

function agentSnapshot(id: string) {
  return { ...entry({ id, cwd: CWD }).agent, lastError: MARKER, capabilities: CAPABILITIES };
}
const project = {
  projectKey: 'legacy-project',
  projectName: 'Legacy project',
  checkout: {
    cwd: CWD,
    isGit: false,
    currentBranch: null,
    remoteUrl: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  },
};
const timelineItem = { type: 'assistant_message', text: MARKER };

/** Unsolicited messages a daemon can push, each carrying the marker. */
const UNSOLICITED: Record<string, object> = {
  'an agent update (upsert, with project)': {
    type: 'agent_update',
    payload: { kind: 'upsert', agent: agentSnapshot('legacy-agent'), project },
  },
  'an agent update (upsert, no project)': {
    type: 'agent_update',
    payload: { kind: 'upsert', agent: agentSnapshot('legacy-agent') },
  },
  'an agent stream': {
    type: 'agent_stream',
    payload: {
      agentId: 'legacy-agent',
      timestamp: new Date(NOW).toISOString(),
      event: { type: 'timeline', provider: 'codex', item: timelineItem },
    },
  },
  'an attention event': {
    type: 'agent_stream',
    payload: {
      agentId: 'legacy-agent',
      timestamp: new Date(NOW).toISOString(),
      event: {
        type: 'attention_required',
        provider: 'codex',
        reason: 'error',
        timestamp: new Date(NOW).toISOString(),
        shouldNotify: true,
        notification: { title: MARKER, body: MARKER, data: {} },
      },
    },
  },
  'a created-agent status': {
    type: 'status',
    payload: { status: 'agent_created', agentId: 'legacy-agent', agent: agentSnapshot('x') },
  },
  'a permission request': {
    type: 'agent_permission_request',
    payload: {
      agentId: 'legacy-agent',
      request: {
        id: 'p-1',
        provider: 'codex',
        name: MARKER,
        kind: 'tool',
        title: MARKER,
        description: MARKER,
        input: { command: MARKER },
      },
    },
  },
  'a workspace update': {
    type: 'workspace_update',
    payload: { kind: 'remove', id: MARKER },
  },
  'an answer to a request HQ never sent': {
    type: 'fetch_agents_response',
    payload: {
      requestId: 'never-sent',
      subscriptionId: 'sub-x',
      entries: [{ agent: agentSnapshot('legacy-agent'), project }],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    },
  },
  'an RPC error for a request HQ never sent': {
    type: 'rpc_error',
    payload: { requestId: 'never-sent', error: MARKER, code: MARKER },
  },
};

const FEATURES: Record<string, Record<string, boolean>> = {
  'legacy (no owned subscriptions, no multiplicity)': {
    ownedSubscriptions: false,
    backgroundWorkspaces: true,
  },
  'owned subscriptions': { ownedSubscriptions: true, backgroundWorkspaces: true },
  'owned subscriptions with workspace multiplicity': {
    ownedSubscriptions: true,
    workspaceMultiplicity: true,
    backgroundWorkspaces: true,
  },
};

function startFeed(
  features: Record<string, boolean>,
  entries: unknown[] = [],
  { chunking = false, permissions }: { chunking?: boolean; permissions?: string[] } = {},
) {
  const sockets: DaemonSocket[] = [];
  const hellos: { capabilities?: Record<string, unknown> }[] = [];
  const listed = vi.fn();

  class DaemonSocket extends EventTarget {
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(payload: string) {
      const frame = JSON.parse(payload) as {
        type: string;
        capabilities?: Record<string, unknown>;
        message?: { type: string; requestId: string };
      };
      if (frame.type === 'hello') {
        hellos.push(frame);
        this.receive({
          type: 'status',
          payload: {
            status: 'server_info',
            serverId: 'test-daemon',
            hostname: 'test-host',
            features: { ...features, binaryChunkingV1: chunking },
            permissions,
          },
        });
      } else if (frame.message?.type === 'fetch_agents_request') {
        listed();
        this.receive({
          type: 'fetch_agents_response',
          payload: {
            requestId: frame.message.requestId,
            subscriptionId: 'sub-1',
            entries,
            pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
          },
        });
      }
    }
    receive(message: object) {
      queueMicrotask(() => {
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify({ type: 'session', message }) }),
        );
      });
    }
    receiveRaw(data: unknown) {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }
    disconnect(reason: string) {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent('close', { code: 1011, reason }));
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
    }
  }

  const { logger } = memoryLogger('debug');
  const feed = createPaseoLiveFeed({
    url: 'ws://127.0.0.1:6767/ws',
    open: createPaseoLiveOpen(() =>
      createWebSocketTransportFactory(() => new DaemonSocket() as unknown as WebSocketLike),
    ),
    now: () => NOW,
    logger,
  });
  feed.start();
  return { feed, listed, hellos, socket: () => sockets[0] };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Runs two polls with `push` between them, and returns whether the marker is anywhere in the SDK client afterwards. */
async function retainsMarker(
  features: Record<string, boolean>,
  push: (socket: ReturnType<ReturnType<typeof startFeed>['socket']>) => void,
  entries: unknown[] = [],
): Promise<{ retained: boolean; listed: number; status: string }> {
  vi.useFakeTimers();
  const state = vi.spyOn(DaemonClient.prototype, 'getConnectionState');
  const { feed, listed, socket } = startFeed(features, entries);
  try {
    await vi.waitFor(() => expect(feed.status()).toBe('live'));
    push(socket());
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    const client = state.mock.contexts[0];
    expect(client).toBeInstanceOf(DaemonClient);
    return {
      retained: inspect(client, { depth: null, customInspect: false }).includes(MARKER),
      listed: listed.mock.calls.length,
      status: feed.status(),
    };
  } finally {
    await feed.stop();
  }
}

describe('the live client under the SDK', () => {
  for (const [featureName, features] of Object.entries(FEATURES)) {
    describe(featureName, () => {
      it.each(Object.entries(UNSOLICITED))('does not retain %s', async (_name, message) => {
        const outcome = await retainsMarker(features, (socket) => socket?.receive(message));
        expect(outcome).toEqual({ retained: false, listed: 2, status: 'live' });
      });
    });
  }

  it('does not retain the daemon connection grants from the live handshake', async () => {
    vi.useFakeTimers();
    const state = vi.spyOn(DaemonClient.prototype, 'getConnectionState');
    const { feed } = startFeed(FEATURES['owned subscriptions']!, [], {
      permissions: ['workspace.read'],
    });
    try {
      await vi.waitFor(() => expect(feed.status()).toBe('live'));
      const client = state.mock.contexts[0];
      assert(client instanceof DaemonClient);
      expect(client.getLastServerInfoMessage()?.permissions ?? []).toEqual([]);
    } finally {
      await feed.stop();
    }
  });

  it('does not retain the daemon error text from a socket close reason', async () => {
    vi.useFakeTimers();
    const state = vi.spyOn(DaemonClient.prototype, 'getConnectionState');
    const { feed, socket } = startFeed(FEATURES['owned subscriptions']!);
    try {
      await vi.waitFor(() => expect(feed.status()).toBe('live'));
      const client = state.mock.contexts[0];
      assert(client instanceof DaemonClient);
      socket()!.disconnect(MARKER);
      expect(client.getConnectionState().status).toBe('disconnected');
      const retained = inspect(client, { depth: null, customInspect: false }).includes(MARKER);
      expect(retained).toBe(false);
    } finally {
      await feed.stop();
    }
  });

  it.each([
    ['Password required', 'password_required'],
    ['Incorrect password', 'incorrect_password'],
  ])('still reads a legacy %s close as an authentication failure', async (reason, expected) => {
    vi.useFakeTimers();
    const state = vi.spyOn(DaemonClient.prototype, 'getConnectionState');
    const { feed, socket } = startFeed(FEATURES['owned subscriptions']!);
    try {
      await vi.waitFor(() => expect(feed.status()).toBe('live'));
      const client = state.mock.contexts[0];
      assert(client instanceof DaemonClient);
      socket()!.disconnect(reason);
      expect(client.authFailureReason).toBe(expected);
    } finally {
      await feed.stop();
    }
  });

  it('describes a close by its code alone, not by the daemon text', async () => {
    vi.useFakeTimers();
    const state = vi.spyOn(DaemonClient.prototype, 'getConnectionState');
    const { feed, socket } = startFeed(FEATURES['owned subscriptions']!);
    try {
      await vi.waitFor(() => expect(feed.status()).toBe('live'));
      const client = state.mock.contexts[0];
      assert(client instanceof DaemonClient);
      socket()!.disconnect(MARKER);
      expect(client.lastError).toBe('Transport closed (code 1011)');
      expect(client.authFailureReason).toBeNull();
    } finally {
      await feed.stop();
    }
  });

  it('does not retain a frame that is not text', async () => {
    const outcome = await retainsMarker(
      FEATURES['legacy (no owned subscriptions, no multiplicity)']!,
      (socket) => {
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            type: 'session',
            message: {
              type: 'agent_update',
              payload: { kind: 'upsert', agent: agentSnapshot('a'), project },
            },
          }),
        );
        socket?.receiveRaw(bytes.buffer);
      },
    );
    expect(outcome).toEqual({ retained: false, listed: 2, status: 'live' });
  });

  it('keeps the feed live and its connection healthy while it drops what it was not asked for', async () => {
    vi.useFakeTimers();
    const { feed, listed, socket } = startFeed(
      FEATURES['legacy (no owned subscriptions, no multiplicity)']!,
    );
    try {
      await vi.waitFor(() => expect(feed.status()).toBe('live'));
      for (let poll = 0; poll < 3; poll += 1) {
        for (const message of Object.values(UNSOLICITED)) socket()?.receive(message);
        await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
      }
      expect(feed.status()).toBe('live');
      expect(listed).toHaveBeenCalledTimes(4);
    } finally {
      await feed.stop();
    }
  });

  it('offers no binary chunking in its hello', async () => {
    vi.useFakeTimers();
    const { feed, hellos } = startFeed(FEATURES['owned subscriptions']!, [], { chunking: true });
    try {
      await vi.waitFor(() => expect(feed.status()).toBe('live'));
      expect(hellos[0]?.capabilities?.binary_chunking_v1).toBe(false);
    } finally {
      await feed.stop();
    }
  });

  it('reads the roster from the answer to its own listing, and the client keeps none of that answer', async () => {
    const listing = [{ agent: agentSnapshot('listed-agent'), project }];
    vi.useFakeTimers();
    const state = vi.spyOn(DaemonClient.prototype, 'getConnectionState');
    const { feed } = startFeed(
      FEATURES['legacy (no owned subscriptions, no multiplicity)']!,
      listing,
    );
    try {
      await vi.waitFor(() => expect(feed.status()).toBe('live'));
      await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
      expect(feed.read().agents.map((agent) => agent.id)).toEqual(['listed-agent']);
      const client = state.mock.contexts[0];
      const retained = inspect(client, { depth: null, customInspect: false });
      expect(retained).not.toContain(MARKER);
      expect(retained).not.toContain('listed-agent');
      expect(retained).not.toContain(CWD);
    } finally {
      await feed.stop();
    }
  });
});
