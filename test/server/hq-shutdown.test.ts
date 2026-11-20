import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, type ListenFn, type RunningServer } from '../../src/server/boot.ts';
import { HqResponse } from '../../src/shared/contracts/hq.ts';
import { entry, fakeLiveDaemon, settle } from '../collectors/paseo/liveHelpers.ts';
import { HOST, NOW, TZ, call, memoryLogger, tempConfig } from './helpers.ts';

// Shutdown and a failed boot do not finish before HQ has finished closing (boot.ts › shutdown). The Paseo feed's client is a fake whose
// `close()` is held by the test, so the feed's stop cannot end until the test lets it; whatever the process does around that is then
// observable: the promise of `shutdown()` stays pending, the database is not closed and the lock is not released until the release.

const servers: RunningServer[] = [];
const FAKED: ('setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval')[] = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
];
afterEach(async () => {
  vi.useRealTimers();
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A fake Paseo daemon whose clients do not finish closing until `release()`. */
function heldDaemon() {
  const live = fakeLiveDaemon([entry({ id: 'a-1', title: 'One', status: 'running' })]);
  const gate = deferred();
  const closeCalls = { count: 0 };
  const open = (url: string) => {
    const client = live.open(url);
    return {
      ...client,
      close: async () => {
        closeCalls.count += 1;
        await gate.promise;
        await client.close();
      },
    };
  };
  return { live, open, release: gate.resolve, closeCalls };
}

const fetchHq = (fetchFn: (request: Request) => Response | Promise<Response>) =>
  fetchFn(new Request('http://127.0.0.1:4317/api/hq', { headers: HOST }));

interface Started {
  server: RunningServer;
  held: ReturnType<typeof heldDaemon>;
  fetch: (request: Request) => Response | Promise<Response>;
  events: string[];
  released: { count: number };
}

async function start(
  options: { shutdownTimeoutMs?: number; coldWaitMs?: number; connectHangs?: boolean } = {},
): Promise<Started> {
  const held = heldDaemon();
  if (options.connectHangs) held.live.script('hang');
  const events: string[] = [];
  const released = { count: 0 };
  let handler: ((request: Request) => Response | Promise<Response>) | null = null;
  const listen: ListenFn = async ({ fetch: serve }) => {
    handler ??= serve;
    return { close: (callback) => callback?.() };
  };
  const server = await boot(tempConfig(), {
    logger: memoryLogger('debug').logger,
    listen,
    now: () => NOW,
    timezone: TZ,
    scheduler: false,
    paseo: { open: batchDaemon().open },
    hq: { open: held.open, idleMs: 60_000, coldWaitMs: options.coldWaitMs ?? 2_000 },
    directoryLease: {
      ok: true,
      release: () => {
        released.count += 1;
        events.push('lock released');
      },
    },
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
  });
  servers.push(server);
  const db = server.db;
  if (db !== null) {
    const close = db.close.bind(db);
    db.close = () => {
      events.push('db closed');
      close();
    };
  }
  return { server, held, fetch: handler!, events, released };
}

describe('shutdown waits for HQ to finish closing', () => {
  it('stays pending while a feed is still stopping, and finishes only after it is released', async () => {
    const { server, held, fetch, events } = await start();
    expect(((await fetchHq(fetch)) as Response).status).toBe(200);
    expect(held.live.connected).toBe(1);

    let done = false;
    vi.useFakeTimers({ toFake: FAKED }); // before shutdown starts, so every timer it sets can be run out below
    const shutting = server.shutdown().then(() => {
      done = true;
      events.push('shutdown resolved');
    });
    for (let turn = 0; turn < 5; turn += 1) await settle();
    expect(held.closeCalls.count).toBe(1); // the feed's stop began at once, ahead of everything else
    // No timer-based deadline of any length ends the wait: a minute of the clock passes and it is still waiting.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(false);
    expect(events).toEqual([]); // the database is still open and the lock still held

    held.release();
    await vi.advanceTimersByTimeAsync(10);
    await shutting;
    vi.useRealTimers();
    expect(done).toBe(true);
    expect(events).toEqual(['db closed', 'lock released', 'shutdown resolved']);
    expect(held.live.connected).toBe(0);
  });

  it('is not cut short by its own deadline: HQ is awaited even when the drain deadline has long passed', async () => {
    const { server, held, fetch, events } = await start({ shutdownTimeoutMs: 20 });
    await fetchHq(fetch);
    let done = false;
    const shutting = server.shutdown().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150)); // far past the 20 ms deadline and the old 2 s race is gone
    expect(done).toBe(false);
    expect(events).toEqual([]);
    held.release();
    await shutting;
    expect(done).toBe(true);
    expect(events.at(-1)).toBe('lock released');
  });

  it('a boot that fails after HQ started does not finish before HQ has closed', async () => {
    const held = heldDaemon();
    const events: string[] = [];
    let release = 0;
    vi.useFakeTimers({ toFake: FAKED });
    const listen: ListenFn = async ({ fetch: serve }) => {
      // A request that starts HQ's feeds, and then the listener cannot be bound: boot must stop everything it started before it fails.
      await fetchHq(serve);
      throw new Error('listen failed');
    };
    let settled: 'resolved' | 'rejected' | null = null;
    const booting = boot(tempConfig(), {
      logger: memoryLogger('debug').logger,
      listen,
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
      paseo: { open: batchDaemon().open },
      hq: { open: held.open, idleMs: 60_000, coldWaitMs: 2_000 },
      directoryLease: {
        ok: true,
        release: () => {
          release += 1;
          events.push('lock released');
        },
      },
    }).then(
      () => {
        settled = 'resolved';
      },
      (error: Error) => {
        settled = 'rejected';
        expect(error.message).toBe('listen failed');
      },
    );
    for (let turn = 0; turn < 10; turn += 1) await settle();
    expect(held.closeCalls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBeNull();
    expect(release).toBe(0);
    held.release();
    await vi.advanceTimersByTimeAsync(10);
    await booting;
    vi.useRealTimers();
    expect(settled).toBe('rejected');
    expect(release).toBe(1);
    expect(held.live.connected).toBe(0);
  });

  it('leaves no timer behind once it has finished', async () => {
    const drainMs = 100;
    const { server, held, fetch } = await start({ shutdownTimeoutMs: drainMs });
    vi.useFakeTimers();
    await fetchHq(fetch);
    const shutting = server.shutdown();
    await vi.advanceTimersByTimeAsync(drainMs * 3);
    held.release();
    await shutting;
    await vi.advanceTimersByTimeAsync(drainMs);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a request while shutting down', () => {
  it('through the listener: a clean refusal, never a throw', async () => {
    const { server, held, fetch } = await start();
    await fetchHq(fetch);
    const shutting = server.shutdown();
    await settle();
    const response = await fetchHq(fetch);
    expect(response.status).toBe(503);
    held.release();
    await shutting;
  });

  it('straight to the app (the Tailscale route is the same app): a valid roster that builds nothing', async () => {
    const { server, held } = await start();
    await call(server.app as never, '/api/hq', { headers: HOST });
    const shutting = server.shutdown();
    await settle();
    const response = await call(server.app as never, '/api/hq', { headers: HOST });
    expect(response.status).toBe(200);
    const body = HqResponse.parse(await response.json());
    expect(body.agents).toEqual([]);
    held.release();
    await shutting;
    // After it has finished too: still a valid answer, and nothing started again.
    const later = await call(server.app as never, '/api/hq', { headers: HOST });
    expect(later.status).toBe(200);
    expect(held.live.connected).toBe(0);
  });

  it('a request already waiting for a cold feed gets a valid answer, and the database is not used after it is closed', async () => {
    const { server, held, fetch, events } = await start({ connectHangs: true, coldWaitMs: 10_000 });
    const db = server.db!;
    let usedAfterClose = 0;
    let closed = false;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (closed) usedAfterClose += 1;
      return prepare(sql);
    }) as typeof db.prepare;
    const inner = db.close;
    db.close = () => {
      closed = true;
      inner();
    };

    const waiting = fetchHq(fetch); // the connect hangs: the request is inside its cold wait
    await settle();
    const shutting = server.shutdown();
    for (let turn = 0; turn < 3; turn += 1) await settle();
    held.release();
    const response = await waiting;
    expect(response.status).toBe(200);
    const body = HqResponse.parse(await response.json());
    expect(body.agents).toEqual([]);
    await shutting;
    expect(closed).toBe(true);
    expect(usedAfterClose).toBe(0);
    expect(events.indexOf('db closed')).toBeGreaterThanOrEqual(0);
  });
});
