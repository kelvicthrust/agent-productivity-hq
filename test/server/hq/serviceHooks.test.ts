import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptAgent, TranscriptFeed } from '../../../src/server/collectors/live/feed.ts';
import {
  CAPABLE_KEEP_MS,
  HOOK_KEEP_MS,
  createHookStore,
} from '../../../src/server/services/hq/hookStore.ts';
import { createHqService } from '../../../src/server/services/hq/service.ts';
import { manualSleep } from '../../collectors/paseo/liveHelpers.ts';
import { NOW, memoryLogger } from '../helpers.ts';

// The service wires the hook store to the Claude transcript feed: the feed asks `guessesPermission(sessionId)` for every session it
// follows at every read, and the store answers from "has this session ever delivered" (hookStore.ts), not from "is its latest
// event still kept". Timers are faked only so the demand gate's idle timer cannot outlive a test.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const MIN = 60_000;

function claudeFeed(followed: () => string[]) {
  const asked: Record<string, boolean>[] = [];
  const feed: TranscriptFeed = {
    start: () => undefined,
    stop: () => Promise.resolve(),
    ready: () => Promise.resolve(),
    status: () => 'live',
    read: (options) => {
      const answers: Record<string, boolean> = {};
      const agents: TranscriptAgent[] = [];
      for (const sessionId of followed()) {
        answers[sessionId] = options?.guessesPermission?.(sessionId) ?? true;
        agents.push({
          provider: 'claude',
          sessionId,
          parentSessionId: null,
          cwd: '/work/invented/project',
          startedAt: null,
          state: 'working',
          activity: 'editing',
          waitReason: null,
          since: NOW - 60_000,
          lastActivityAt: NOW - 30_000,
        });
      }
      asked.push(answers);
      return { agents, files: agents.length };
    },
  };
  return { feed, asked };
}

function rig(followed: () => string[]) {
  const clock = { now: NOW };
  const store = createHookStore({ now: () => clock.now });
  const { feed, asked } = claudeFeed(followed);
  const service = createHqService({
    feeds: { claude: feed },
    now: () => clock.now,
    logger: memoryLogger('debug').logger,
    hooks: store,
    waitsForSetup: () => false,
    sleep: manualSleep(),
  });
  return { clock, store, service, asked };
}

describe('the roster service and a session that delivers hook events', () => {
  it('does not guess for a session whose hooks have spoken, even after the event is forgotten, while it is followed', async () => {
    let followed = ['s1'];
    const { clock, store, service, asked } = rig(() => followed);
    store.record({ hook_event_name: 'PermissionRequest', session_id: 's1' });
    await service.snapshot();
    expect(asked.at(-1)).toEqual({ s1: false });

    // The event expires; the transcript is still followed (a long tool call, a long session).
    for (let step = 0; step < 6; step += 1) {
      clock.now += 5 * MIN;
      await service.snapshot();
      expect(asked.at(-1)).toEqual({ s1: false });
    }
    expect(clock.now - NOW).toBeGreaterThan(HOOK_KEEP_MS);
    expect(store.read().size).toBe(0);

    // A session that never delivered still guesses, in the same read.
    followed = ['s1', 'other'];
    await service.snapshot();
    expect(asked.at(-1)).toEqual({ s1: false, other: true });
    await service.close();
  });

  it('guesses again once the session has not been followed for a long time', async () => {
    let followed = ['s1'];
    const { clock, store, service, asked } = rig(() => followed);
    store.record({ hook_event_name: 'Stop', session_id: 's1' });
    await service.snapshot();
    expect(asked.at(-1)).toEqual({ s1: false });

    followed = []; // the transcript is gone (a silent file is dropped after 15 minutes)
    clock.now += CAPABLE_KEEP_MS;
    await service.snapshot();
    followed = ['s1'];
    clock.now += 1;
    await service.snapshot();
    expect(asked.at(-1)).toEqual({ s1: true });
    await service.close();
  });

  it('guesses again for a session that ended, and the ended record keeps it off the roster meanwhile', async () => {
    const { clock, store, service, asked } = rig(() => ['s1']);
    store.record({ hook_event_name: 'Stop', session_id: 's1' });
    clock.now += 1_000;
    store.record({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'clear' });
    clock.now += 1_000;
    const roster = await service.snapshot();
    expect(asked.at(-1)).toEqual({ s1: true });
    expect(roster.agents).toEqual([]);
    await service.close();
  });

  it('closing the service leaves nothing scheduled, and the store is emptied by its owner', async () => {
    const { store, service } = rig(() => ['s1']);
    store.record({ hook_event_name: 'Stop', session_id: 's1' });
    await service.snapshot();
    await service.close();
    expect(vi.getTimerCount()).toBe(0);
    store.clear();
    expect(store.delivered('s1')).toBe(false);
    expect(store.read().size).toBe(0);
  });
});
