import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveFeedStatus, PaseoLiveFeed } from '../../../src/server/collectors/paseo/live.ts';
import { createDemandGate } from '../../../src/server/services/hq/gate.ts';
import { createHqService } from '../../../src/server/services/hq/service.ts';
import { entry, fakeLiveDaemon, manualSleep, settle } from '../../collectors/paseo/liveHelpers.ts';
import { createPaseoLiveFeed } from '../../../src/server/collectors/paseo/live.ts';
import { NOW, memoryLogger } from '../helpers.ts';

// The demand gate on its own (a start and a stop that only count), then the service over a feed that is scripted, then the
// service over the real feed and a fake daemon. Idle time is the gate's own timer, so it runs under fake timers.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

function counting(stopTakes: () => Promise<void> = () => Promise.resolve()) {
  const calls: string[] = [];
  const gate = createDemandGate({
    start: () => calls.push('start'),
    stop: async () => {
      calls.push('stop-begin');
      await stopTakes();
      calls.push('stop-end');
    },
    idleMs: 30_000,
  });
  return { gate, calls };
}

describe('the demand gate', () => {
  it('starts on the first touch and not before', () => {
    const { gate, calls } = counting();
    expect(calls).toEqual([]);
    expect(gate.active()).toBe(false);
    gate.touch();
    gate.touch();
    expect(calls).toEqual(['start']);
    expect(gate.active()).toBe(true);
  });

  it('stops after the idle time without a touch, and every touch restarts the countdown', async () => {
    const { gate, calls } = counting();
    gate.touch();
    await vi.advanceTimersByTimeAsync(29_000);
    gate.touch();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toEqual(['start']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(['start', 'stop-begin', 'stop-end']);
    expect(gate.active()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts again on a touch after it has stopped', async () => {
    const { gate, calls } = counting();
    gate.touch();
    await vi.advanceTimersByTimeAsync(30_000);
    gate.touch();
    expect(calls).toEqual(['start', 'stop-begin', 'stop-end', 'start']);
  });

  it('a touch while stopping queues one restart for when it has stopped', async () => {
    let finish: () => void = () => undefined;
    const { gate, calls } = counting(() => new Promise<void>((resolve) => (finish = resolve)));
    gate.touch();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toEqual(['start', 'stop-begin']);

    gate.touch();
    gate.touch();
    expect(calls).toEqual(['start', 'stop-begin']); // not started on top of the stop
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['start', 'stop-begin', 'stop-end', 'start']);
    expect(gate.active()).toBe(true);
    // And the countdown runs for the restarted feeds.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.at(-1)).toBe('stop-begin');
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.active()).toBe(false);
  });

  it('close stops what is running, clears the timer, and later touches do nothing', async () => {
    const { gate, calls } = counting();
    gate.touch();
    await gate.close();
    await gate.close();
    expect(calls).toEqual(['start', 'stop-begin', 'stop-end']);
    gate.touch();
    expect(calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close while stopping waits for the stop and does not restart', async () => {
    let finish: () => void = () => undefined;
    const { gate, calls } = counting(() => new Promise<void>((resolve) => (finish = resolve)));
    gate.touch();
    await vi.advanceTimersByTimeAsync(30_000);
    gate.touch(); // queues a restart
    const closing = gate.close();
    finish();
    await closing;
    expect(calls).toEqual(['start', 'stop-begin', 'stop-end']);
  });

  it('a stop that fails still ends the gate in the stopped state', async () => {
    const gate = createDemandGate({
      start: () => undefined,
      stop: () => Promise.reject(new Error('boom')),
      idleMs: 10,
    });
    gate.touch();
    await vi.advanceTimersByTimeAsync(10);
    expect(gate.active()).toBe(false);
  });
});

/** A feed that only records what it is told and says what the test says. */
function scriptedFeed(initial: LiveFeedStatus = 'stopped') {
  const calls: string[] = [];
  let status = initial;
  let release: () => void = () => undefined;
  let ready = Promise.resolve();
  const feed: PaseoLiveFeed = {
    start: () => {
      calls.push('start');
      if (status === 'stopped') {
        status = 'starting';
        ready = new Promise<void>((resolve) => (release = resolve));
      }
    },
    stop: () => {
      calls.push('stop');
      status = 'stopped';
      return Promise.resolve();
    },
    ready: () => ready,
    status: () => status,
    read: () => ({ agents: [], truncated: false }),
  };
  return {
    feed,
    calls,
    become(next: LiveFeedStatus) {
      status = next;
      release();
    },
  };
}

describe('the roster service', () => {
  function serviceOver(
    feed: PaseoLiveFeed,
    over: { waits?: () => boolean; coldWaitMs?: number } = {},
  ) {
    const sleep = manualSleep();
    const service = createHqService({
      feeds: { paseo: feed },
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      waitsForSetup: over.waits ?? (() => false),
      sleep,
      ...(over.coldWaitMs === undefined ? {} : { coldWaitMs: over.coldWaitMs }),
    });
    return { service, sleep };
  }

  it('starts the feed on the first snapshot and not at construction', async () => {
    const { feed, calls, become } = scriptedFeed();
    const { service } = serviceOver(feed);
    expect(calls).toEqual([]);
    const pending = service.snapshot();
    become('live');
    await pending;
    expect(calls).toEqual(['start']);
    await service.snapshot();
    expect(calls).toEqual(['start']);
    await service.close();
  });

  it('stops the feed after 30 s without a request, and starts it again on the next one', async () => {
    const { feed, calls, become } = scriptedFeed();
    const { service } = serviceOver(feed);
    const first = service.snapshot();
    become('live');
    await first;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toEqual(['start', 'stop']);

    const next = service.snapshot();
    become('live');
    await next;
    expect(calls).toEqual(['start', 'stop', 'start']);
    await service.close();
  });

  it('does not start anything while setup is unfinished, and says so', async () => {
    const { feed, calls, become } = scriptedFeed();
    let waiting = true;
    const { service } = serviceOver(feed, { waits: () => waiting });
    const during = await service.snapshot();
    expect(calls).toEqual([]);
    expect(during.feeds).toEqual([
      { id: 'paseo', status: 'setup_incomplete' },
      { id: 'claude', status: 'unavailable' },
      { id: 'codex', status: 'unavailable' },
    ]);
    expect(during.agents).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    waiting = false;
    const after = service.snapshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['start']);
    become('live');
    expect((await after).feeds[0]).toEqual({ id: 'paseo', status: 'live' });
    await service.close();
  });

  it('on a cold start waits for the feed, and answers it once it is live', async () => {
    const { feed, become } = scriptedFeed();
    const { service } = serviceOver(feed);
    const pending = service.snapshot();
    become('notrunning');
    const body = await pending;
    expect(body.feeds[0]).toEqual({ id: 'paseo', status: 'notrunning' });
    await service.close();
  });

  it('on a cold start that takes longer than the cold wait reports the feed as starting', async () => {
    const { feed, become } = scriptedFeed();
    const { service, sleep } = serviceOver(feed, { coldWaitMs: 1_000 });
    const pending = service.snapshot();
    await settle();
    expect(sleep.asked).toEqual([1_000]);
    sleep.release();
    const body = await pending;
    expect(body.feeds[0]).toEqual({ id: 'paseo', status: 'starting' });
    expect(body.agents).toEqual([]);
    expect(sleep.pending).toBe(0);

    become('live');
    expect((await service.snapshot()).feeds[0]).toEqual({ id: 'paseo', status: 'live' });
    expect(sleep.asked).toEqual([1_000]); // a warm feed is never waited for
    await service.close();
  });

  it('reports the claude and codex feeds as unavailable', async () => {
    const { feed, become } = scriptedFeed();
    const { service } = serviceOver(feed);
    const pending = service.snapshot();
    become('live');
    const body = await pending;
    expect(body.feeds).toEqual([
      { id: 'paseo', status: 'live' },
      { id: 'claude', status: 'unavailable' },
      { id: 'codex', status: 'unavailable' },
    ]);
    await service.close();
  });

  it('close stops the feed, and is safe to call twice', async () => {
    const { feed, calls, become } = scriptedFeed();
    const { service } = serviceOver(feed);
    const pending = service.snapshot();
    become('live');
    await pending;
    await service.close();
    await service.close();
    expect(calls).toEqual(['start', 'stop']);
  });

  it('over the real feed: the roster appears on the first request, and the connection closes when idle', async () => {
    const daemon = fakeLiveDaemon([entry({ id: 'a-1', status: 'running', title: 'busy' })]);
    const feed = createPaseoLiveFeed({
      url: 'ws://x',
      open: daemon.open,
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      sleep: manualSleep(),
    });
    const { service } = serviceOver(feed);
    // Real timers for the feed's awaits: only the gate's timer is faked.
    const pending = service.snapshot();
    await settle();
    const body = await pending;
    expect(body.feeds[0]).toEqual({ id: 'paseo', status: 'live' });
    expect(body.agents.map((agent) => agent.title)).toEqual(['busy']);
    expect(daemon.connected).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(daemon.connected).toBe(0);
    expect(daemon.clients[0]?.closed).toBe(true);
    await service.close();
  });
});
