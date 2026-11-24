import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, type ListenFn, type RunningServer } from '../../src/server/boot.ts';
import { completeSetup } from '../../src/server/db/queries/setup.ts';
import { TAILSCALE_LOGIN_HEADER } from '../../src/server/http/guards.ts';
import { HqResponse } from '../../src/shared/contracts/hq.ts';
import { connectErrors } from '../collectors/paseo/helpers.ts';
import { entry, fakeLiveDaemon, type FakeLiveDaemon } from '../collectors/paseo/liveHelpers.ts';
import {
  HOST,
  NOW,
  TZ,
  call,
  memoryLogger,
  tempConfig,
  tempDir,
  unlockBrowser,
} from './helpers.ts';

// The live HQ roster through the real boot: the process is given a fake Paseo (the batch opener and the live one) and no socket is
// opened. What is checked is the demand: nothing connects until /api/hq is asked for, the connection closes when nobody asks for
// `idleMs`, and it closes for good on shutdown. Setup, the Paseo source being off, and the Tailscale listener are covered too.

const listen: ListenFn = async () => ({ close: (callback) => callback?.() });
const servers: RunningServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.shutdown();
});

const batchDaemon = () => ({
  open: () => ({
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    agents: {
      list: () => Promise.resolve({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
    },
  }),
});

interface Started {
  server: RunningServer;
  live: FakeLiveDaemon;
  logs: Record<string, unknown>[];
}

async function start(
  options: {
    live?: FakeLiveDaemon;
    paseo?: boolean;
    idleMs?: number;
    waitForSetup?: boolean;
    remote?: { host: string; ownerLogin: string };
    shutdownTimeoutMs?: number;
  } = {},
): Promise<Started> {
  const live =
    options.live ??
    fakeLiveDaemon([
      entry({ id: 'a-parent', title: 'Parent', status: 'running', provider: 'claude' }),
      entry({ id: 'a-child', title: 'Child', parent: 'a-parent', status: 'running' }),
      entry({ id: 'a-asks', title: 'Asks', permissions: ['plan'] }),
    ]);
  const { logger, entries: logs } = memoryLogger('debug');
  const server = await boot(tempConfig(), {
    logger,
    listen,
    now: () => NOW,
    timezone: TZ,
    scheduler: false,
    ...(options.waitForSetup ? { local: { env: {}, home: tempDir() } } : {}),
    ...(options.paseo === false ? {} : { paseo: { open: batchDaemon().open } }),
    hq: { open: live.open, idleMs: options.idleMs ?? 60_000, coldWaitMs: 2_000 },
    ...(options.remote ? { remote: options.remote } : {}),
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
  });
  servers.push(server);
  return { server, live, logs };
}

const hq = async (server: RunningServer): Promise<HqResponse> => {
  const response = await call(server.app as never, '/api/hq', { headers: HOST });
  expect(response.status).toBe(200);
  return HqResponse.parse(await response.json());
};

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 5_000; waited += 5) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('HQ through boot', () => {
  it('opens no connection until the first /api/hq, then answers with the roster', async () => {
    const { server, live } = await start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(live.opened).toEqual([]);

    const body = await hq(server);
    expect(live.opened).toEqual(['ws://127.0.0.1:6767/ws']);
    expect(body.feeds).toEqual([
      { id: 'paseo', status: 'live' },
      { id: 'claude', status: 'unavailable' },
      { id: 'codex', status: 'unavailable' },
    ]);
    // Waiting first; the two working agents were updated at the same moment, so they follow in id order.
    expect(body.agents.map((agent) => [agent.title, agent.state])).toEqual([
      ['Asks', 'waiting'],
      ['Child', 'working'],
      ['Parent', 'working'],
    ]);
    const byTitle = new Map(body.agents.map((agent) => [agent.title, agent]));
    expect(byTitle.get('Child')).toMatchObject({
      kind: 'child',
      parentId: byTitle.get('Parent')?.id,
      parentBasis: 'paseo',
    });
    expect(byTitle.get('Asks')).toMatchObject({ state: 'waiting', waitReason: 'plan_approval' });
    // Later polls reuse the connection.
    await hq(server);
    expect(live.opened).toHaveLength(1);
    expect(live.connected).toBe(1);
  });

  it('closes the connection after the idle time without a request, and opens it again on the next', async () => {
    const { server, live } = await start({ idleMs: 40 });
    await hq(server);
    expect(live.connected).toBe(1);

    await until(() => live.connected === 0, 'the connection to close when idle');
    expect(live.clients[0]?.closed).toBe(true);

    expect((await hq(server)).feeds[0]).toEqual({ id: 'paseo', status: 'live' });
    expect(live.opened).toHaveLength(2);
    expect(live.connected).toBe(1);
  });

  it('closes the connection on shutdown, and a request that was open does not reopen it', async () => {
    const { server, live } = await start();
    await hq(server);
    expect(live.connected).toBe(1);
    await server.shutdown();
    expect(live.connected).toBe(0);
    expect(live.clients.every((client) => client.closed)).toBe(true);
  });

  it('leaves no HQ timers after shutdown of a running feed', async () => {
    const drainMs = 100;
    const { server, live } = await start({ shutdownTimeoutMs: drainMs });
    vi.useFakeTimers();
    try {
      await hq(server);
      expect(live.connected).toBe(1);
      await server.shutdown();
      expect(live.connected).toBe(0);

      // The existing listener and refresh shutdown deadlines may run out after shutdown returns.
      await vi.advanceTimersByTimeAsync(drainMs);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says setup_incomplete and connects to nothing until Setup has been finished', async () => {
    const { server, live } = await start({ waitForSetup: true });
    const before = await hq(server);
    expect(before.feeds[0]).toEqual({ id: 'paseo', status: 'setup_incomplete' });
    expect(before.agents).toEqual([]);
    expect(live.opened).toEqual([]);

    completeSetup(server.db!, { at: NOW, timezone: TZ });
    const after = await hq(server);
    expect(after.feeds[0]).toEqual({ id: 'paseo', status: 'live' });
    expect(after.agents).toHaveLength(3);
    expect(live.opened).toHaveLength(1);
  });

  it('reports a daemon that is not running, and a daemon that wants a password', async () => {
    const down = fakeLiveDaemon();
    down.script(connectErrors.refused());
    const first = await start({ live: down });
    expect(await hq(first.server)).toMatchObject({
      feeds: [{ id: 'paseo', status: 'notrunning' }, expect.anything(), expect.anything()],
      agents: [],
    });

    const locked = fakeLiveDaemon();
    locked.script(connectErrors.password());
    const second = await start({ live: locked });
    expect((await hq(second.server)).feeds[0]).toEqual({ id: 'paseo', status: 'needspassword' });
  });

  it('a process with no Paseo source has no live feed: every feed is unavailable and nothing connects', async () => {
    const { server, live } = await start({ paseo: false });
    const body = await hq(server);
    expect(body.feeds.map((feed) => feed.status)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect(body.agents).toEqual([]);
    expect(live.opened).toEqual([]);
  });

  it('serves the Tailscale listener under its own guards from the same service, so one connection is shared', async () => {
    const remoteHost = 'machine.example.ts.net';
    const ownerLogin = 'owner@example.com';
    const listeners: { fetch: (request: Request) => Response | Promise<Response>; port: number }[] =
      [];
    const live = fakeLiveDaemon([entry({ id: 'a-1', title: 'Only', status: 'running' })]);
    const config = tempConfig();
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen: async (option) => {
        listeners.push(option);
        return { address: () => ({ port: option.port || 44_322 }), close: (done) => done?.() };
      },
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
      paseo: { open: batchDaemon().open },
      hq: { open: live.open, idleMs: 60_000 },
      remote: { host: remoteHost, ownerLogin },
    });
    servers.push(server);
    expect(listeners).toHaveLength(1);
    const [remote] = listeners;
    const get = (headers: Record<string, string>) =>
      new Request('http://localhost/api/hq', { headers });

    expect(
      (await remote!.fetch(get({ host: remoteHost, [TAILSCALE_LOGIN_HEADER]: ownerLogin }))).status,
    ).toBe(401);
    const owner = await unlockBrowser(remote!.fetch, config.dataDir, {
      host: remoteHost,
      ownerLogin,
    });
    const viaRemote = await remote!.fetch(get(owner));
    expect(viaRemote.status).toBe(200);
    expect(HqResponse.parse(await viaRemote.json()).agents).toHaveLength(1);
    // A request without the owner's login is refused, and a different Host too.
    expect((await remote!.fetch(get({ host: remoteHost }))).status).toBe(403);
    expect((await hq(server)).agents).toHaveLength(1);
    expect(live.opened).toHaveLength(1);
  });
});
