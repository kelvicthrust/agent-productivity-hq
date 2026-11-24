import { inspect } from 'node:util';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createWebSocketTransportFactory } from '@getpaseo/client/internal/daemon-client-websocket-transport';
import type { WebSocketLike } from '@getpaseo/client/internal/daemon-client-transport-types';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LIVE_LIST_TIMEOUT_MS,
  LIVE_POLL_MS,
  createPaseoLiveFeed,
} from '../../../src/server/collectors/paseo/live.ts';
import { createPaseoLiveOpen } from '../../../src/server/collectors/paseo/open.ts';
import { memoryLogger, NOW } from '../../server/helpers.ts';
import { entry } from './liveHelpers.ts';

// Exercise the pinned SDK over an in-memory WebSocket. The seam is below the SDK so its own logs and cleanup are observable: the
// SDK's own socket-to-transport adapter is given the in-memory socket, in place of the Node (`ws`) socket the real opener uses.
// What the real socket does on close is checked in liveSocket.test.ts.
function startFeed(
  reply: (requestId: string) => object | undefined,
  features = { ownedSubscriptions: true, backgroundWorkspaces: true },
) {
  const sockets: DaemonSocket[] = [];
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
        message?: { type: string; requestId: string };
      };
      if (frame.type === 'hello') {
        this.receive({
          type: 'status',
          payload: {
            status: 'server_info',
            serverId: 'test-daemon',
            features,
          },
        });
      } else if (frame.message?.type === 'fetch_agents_request') {
        listed(frame.message);
        const response = reply(frame.message.requestId);
        if (response) this.receive(response);
      }
    }

    receive(message: object) {
      queueMicrotask(() => {
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify({ type: 'session', message }) }),
        );
      });
    }

    close() {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
    }
  }

  const { logger, entries } = memoryLogger('debug');
  const feed = createPaseoLiveFeed({
    url: 'ws://127.0.0.1:6767/ws',
    open: createPaseoLiveOpen(() =>
      createWebSocketTransportFactory(() => new DaemonSocket() as unknown as WebSocketLike),
    ),
    now: () => NOW,
    logger,
  });
  feed.start();
  return { feed, listed, entries, socket: () => sockets[0], sockets };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const emptyListing = (requestId: string) => ({
  type: 'fetch_agents_response',
  payload: {
    requestId,
    subscriptionId: 'sub-1',
    entries: [],
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
  },
});

it('sends the attention-first sort through the pinned SDK', async () => {
  const { feed, listed } = startFeed(emptyListing);
  try {
    await feed.ready();
    expect(feed.status()).toBe('live');
    expect(listed).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [
          { key: 'status_priority', direction: 'asc' },
          { key: 'updated_at', direction: 'desc' },
        ],
      }),
    );
  } finally {
    await feed.stop();
  }
});

it('does not log the raw error from a failed Paseo listing', async () => {
  const detail = 'SENTINEL_DAEMON_ERROR_DETAIL';
  const consoleLogs = (['debug', 'log', 'info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
  const { feed, listed, entries } = startFeed((requestId) => ({
    type: 'rpc_error',
    payload: { requestId, error: detail },
  }));
  try {
    await feed.ready();
    expect(listed).toHaveBeenCalledOnce();
    expect(feed.status()).toBe('failed');
    expect(
      inspect(
        consoleLogs.flatMap((log) => log.mock.calls),
        { depth: null },
      ),
    ).not.toContain(detail);
    expect(JSON.stringify(entries)).not.toContain(detail);
  } finally {
    await feed.stop();
  }
});

it('does not log free-form text in the daemon RPC error code', async () => {
  const code = 'SENTINEL_PRIVATE_PERMISSION_DETAIL';
  const { feed, entries } = startFeed((requestId) => ({
    type: 'rpc_error',
    payload: { requestId, error: 'Listing failed', code },
  }));
  try {
    await feed.ready();
    expect(feed.status()).toBe('failed');
    expect(JSON.stringify(entries).toLowerCase()).not.toContain(code.toLowerCase());
  } finally {
    await feed.stop();
  }
});

it('does not retain private fields from an unsolicited update during a legacy daemon connection', async () => {
  vi.useFakeTimers();
  const state = vi.spyOn(DaemonClient.prototype, 'getConnectionState');
  const { feed, listed, socket } = startFeed(emptyListing, {
    ownedSubscriptions: false,
    backgroundWorkspaces: true,
  });
  try {
    await vi.waitFor(() => expect(feed.status()).toBe('live'));
    const marker = 'SENTINEL_PRIVATE_LEGACY_UPDATE';
    const cwd = '/work/invented/project';
    const sample = entry({ id: 'legacy-agent', cwd });
    socket()?.receive({
      type: 'agent_update',
      payload: {
        kind: 'upsert',
        agent: {
          ...sample.agent,
          lastError: marker,
          capabilities: {
            supportsStreaming: true,
            supportsSessionPersistence: true,
            supportsDynamicModes: false,
            supportsMcpServers: false,
            supportsReasoningStream: false,
            supportsToolInvocations: true,
          },
        },
        project: {
          projectKey: 'legacy-project',
          projectName: 'Legacy project',
          checkout: {
            cwd,
            isGit: false,
            currentBranch: null,
            remoteUrl: null,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: null,
          },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(listed).toHaveBeenCalledTimes(2);
    expect(feed.status()).toBe('live');
    const client = state.mock.contexts[0];
    expect(client).toBeInstanceOf(DaemonClient);
    const retainedPrivateField = inspect(client, { depth: null, customInspect: false }).includes(
      marker,
    );
    expect(retainedPrivateField).toBe(false);
  } finally {
    await feed.stop();
  }
});

it('reconnects when the daemon disconnects before answering the initial listing', async () => {
  vi.useFakeTimers();
  const reply = vi.fn<(requestId: string) => object | undefined>(emptyListing);
  reply.mockImplementationOnce(() => undefined);
  const { feed, listed, socket, sockets } = startFeed(reply);
  try {
    await vi.waitFor(() => expect(listed).toHaveBeenCalledOnce());
    socket()?.close();
    await vi.advanceTimersByTimeAsync(10_000);
    // Adapted for polling: the reviewer's `toHaveBeenCalledTimes(2)` counted one listing per connection, which holds only when the
    // listing is asked for once. The feed now lists every 2 s, so "reconnected and asked again" is `>= 2` listings over a second
    // socket.
    expect(listed.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sockets).toHaveLength(2);
    expect(feed.status()).toBe('live');
  } finally {
    await feed.stop();
  }
});

it('closes the socket promptly when stopped while Paseo is silent on the initial listing', async () => {
  vi.useFakeTimers();
  const { feed, listed, socket } = startFeed(() => undefined);
  let stopped = false;
  let stopping: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(listed).toHaveBeenCalledOnce());
    stopping = feed.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket()?.readyState).toBe(3);
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    // Release the SDK's pending request even if the assertion fails.
    if (!stopped) socket()?.close();
    await (stopping ?? feed.stop());
  }
});

it('closes the socket promptly when stopped while the daemon never answers the subscription release', async () => {
  vi.useFakeTimers();
  const { feed, socket } = startFeed(emptyListing);
  let stopped = false;
  let stopping: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(feed.status()).toBe('live'));
    stopping = feed.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket()?.readyState).toBe(3);
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (!stopped) socket()?.close();
    await (stopping ?? feed.stop());
  }
});

it('gives up on a listing the daemon never answers while the socket stays open, and reconnects', async () => {
  vi.useFakeTimers();
  const reply = vi.fn<(requestId: string) => object | undefined>(emptyListing);
  reply.mockImplementationOnce(() => undefined);
  const { feed, listed, entries, sockets } = startFeed(reply);
  try {
    await vi.waitFor(() => expect(listed).toHaveBeenCalledOnce());
    expect(feed.status()).toBe('starting');
    await vi.advanceTimersByTimeAsync(LIVE_LIST_TIMEOUT_MS);
    expect(feed.status()).toBe('failed');
    expect(sockets[0]?.readyState).toBe(3); // the client was closed, not left open
    expect(entries.find((line) => line.msg === 'paseo live feed failed')).toMatchObject({
      code: 'list_timeout',
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets).toHaveLength(2);
    expect(feed.status()).toBe('live');
  } finally {
    await feed.stop();
  }
});
