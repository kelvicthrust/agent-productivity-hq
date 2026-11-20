import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptAgent, TranscriptFeed } from '../../../src/server/collectors/live/feed.ts';
import type { LiveAgent } from '../../../src/server/collectors/paseo/liveAgent.ts';
import type { PaseoLiveFeed } from '../../../src/server/collectors/paseo/live.ts';
import type { LiveSessionLabel } from '../../../src/server/db/queries/hq.ts';
import { buildRoster } from '../../../src/server/services/hq/roster.ts';
import { createHqService } from '../../../src/server/services/hq/service.ts';
import { HqRoster } from '../../../src/shared/contracts/hq.ts';
import { liveAgent, manualSleep, settle } from '../../collectors/paseo/liveHelpers.ts';
import { NOW, memoryLogger } from '../helpers.ts';

// One bad agent, time or lookup never fails the answer: the roster is built from whatever the feeds hold, and what cannot be built is
// repaired or left out, with one fixed log code. And a look that began before a stop does not build anything after it.

const MIN = 60_000;
const BAD_TIMES = [1e16, 8.64e15, -8.64e15, Number.NaN, Number.POSITIVE_INFINITY, 0, 1];

const transcript = (over: Partial<TranscriptAgent> & { sessionId: string }): TranscriptAgent => ({
  provider: 'claude',
  parentSessionId: null,
  cwd: '/work/invented/project',
  startedAt: null,
  state: 'working',
  activity: 'editing',
  waitReason: null,
  since: NOW - 2 * MIN,
  lastActivityAt: NOW - 5_000,
  ...over,
});

describe('the roster is total', () => {
  it.each(BAD_TIMES)(
    'a Paseo agent with the time %s everywhere is shown, with times that serialise',
    (bad) => {
      const roster = buildRoster({
        now: NOW,
        agents: [
          liveAgent({
            id: 'p1',
            status: 'running',
            updatedAt: bad,
            createdAt: bad,
            attentionAt: bad,
            turnStartedAt: bad,
          }),
        ],
      });
      expect(roster.agents).toHaveLength(1);
      expect(roster.repaired).toBeGreaterThan(0);
      const [agent] = roster.agents;
      for (const value of [agent?.since, agent?.lastActivityAt])
        expect(new Date(value ?? '').toISOString()).toBe(value);
      expect(agent?.startedAt).toBeNull();
    },
  );

  it.each(BAD_TIMES)(
    'a transcript with the time %s everywhere is shown, with times that serialise',
    (bad) => {
      const roster = buildRoster({
        now: NOW,
        agents: [],
        transcripts: [
          transcript({ sessionId: 's', since: bad, lastActivityAt: bad, startedAt: bad }),
        ],
      });
      expect(roster.agents).toHaveLength(1);
      expect(roster.repaired).toBeGreaterThan(0);
      expect(new Date(roster.agents[0]?.lastActivityAt ?? '').getTime()).toBe(NOW);
    },
  );

  it('one bad agent does not take the good ones with it, and the roster is valid as a whole', () => {
    const roster = buildRoster({
      now: NOW,
      agents: [
        liveAgent({ id: 'bad', status: 'running', updatedAt: 1e16 }),
        liveAgent({ id: 'good', status: 'running' }),
      ],
      transcripts: [transcript({ sessionId: 'x', lastActivityAt: Number.NaN })],
    });
    expect(roster.agents).toHaveLength(3);
    expect(roster.repaired).toBe(2);
  });

  it('a clock that is not a time does not fail the answer either', () => {
    const roster = buildRoster({
      now: Number.NaN,
      agents: [liveAgent({ id: 'p1', status: 'running', updatedAt: Date.now() - 1_000 })],
    });
    expect(roster.agents).toHaveLength(1);
  });

  it('an agent that cannot be built is left out and its children say the parent is away', () => {
    const labelsOf = (): ReadonlyMap<string, LiveSessionLabel> =>
      new (class extends Map<string, LiveSessionLabel> {
        override get(key: string): LiveSessionLabel | undefined {
          if (key === 'claude:boss') throw new Error('broken');
          return undefined;
        }
      })();
    const roster = buildRoster({
      now: NOW,
      agents: [],
      transcripts: [
        transcript({ sessionId: 'boss' }),
        transcript({ sessionId: 'worker', parentSessionId: 'boss' }),
      ],
      labelsOf,
    });
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]).toMatchObject({ kind: 'child', parentId: null, parentAway: true });
    expect(roster.repaired).toBe(1);
    expect(() =>
      HqRoster.parse({
        generatedAt: new Date(NOW).toISOString(),
        feeds: [],
        agents: roster.agents,
        truncated: false,
      }),
    ).not.toThrow();
  });

  it('a repo lookup that throws is no repo, and a label lookup that throws is no label', () => {
    const roster = buildRoster({
      now: NOW,
      agents: [liveAgent({ id: 'p1', status: 'running' })],
      repoOf: () => {
        throw new Error('broken');
      },
      labelsOf: () => {
        throw new Error('broken');
      },
    });
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]?.repo).toBeNull();
  });
});

// ---- the service ----------------------------------------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

function paseoFeed(read: () => { agents: LiveAgent[]; truncated: boolean }) {
  let status: ReturnType<PaseoLiveFeed['status']> = 'stopped';
  const feed: PaseoLiveFeed = {
    start: () => {
      status = 'live';
    },
    stop: () => {
      status = 'stopped';
      return Promise.resolve();
    },
    ready: () => Promise.resolve(),
    status: () => status,
    read,
  };
  return feed;
}

const service = (
  feeds: Parameters<typeof createHqService>[0]['feeds'],
  over: Partial<Parameters<typeof createHqService>[0]> = {},
) => {
  const logs = memoryLogger('debug');
  const hq = createHqService({
    feeds,
    now: () => NOW,
    logger: logs.logger,
    waitsForSetup: () => false,
    sleep: manualSleep(),
    ...over,
  });
  return { hq, logs: logs.entries };
};

describe('the service answers whatever the feeds hold', () => {
  it('serves a roster whose agents carry times no Date can hold, and says so once with a fixed code', async () => {
    const feed = paseoFeed(() => ({
      agents: [
        liveAgent({ id: 'p1', status: 'running', updatedAt: 1e16, turnStartedAt: Number.NaN }),
      ],
      truncated: false,
    }));
    const { hq, logs } = service({ paseo: feed });
    const first = await hq.snapshot();
    expect(HqRoster.parse(first).agents).toHaveLength(1);
    await hq.snapshot();
    const repaired = logs.filter((entry) => entry['msg'] === 'hq roster repaired');
    expect(repaired).toEqual([
      expect.objectContaining({ source: 'hq', code: 'roster_repaired', level: 'warn' }),
    ]);
    await hq.close();
  });

  it('a feed that throws when read does not fail the answer: the statuses stay, the agents are none', async () => {
    const feed = paseoFeed(() => {
      throw new Error('SENTINEL_FEED_FAILURE');
    });
    const { hq, logs } = service({ paseo: feed });
    const body = await hq.snapshot();
    expect(HqRoster.parse(body).agents).toEqual([]);
    expect(body.feeds[0]).toEqual({ id: 'paseo', status: 'live' });
    expect(JSON.stringify(logs)).not.toContain('SENTINEL_FEED_FAILURE');
    expect(logs.filter((entry) => entry['code'] === 'roster_failed')).toHaveLength(1);
    await hq.close();
  });

  it('an agent that cannot be built is left out of the answer; the rest are shown', async () => {
    const feed = paseoFeed(() => ({
      agents: [
        liveAgent({ id: 'p1', provider: 'claude', sessionId: 'boss', status: 'running' }),
        liveAgent({ id: 'p2', provider: 'claude', sessionId: 'ok', status: 'running' }),
      ],
      truncated: false,
    }));
    const { hq } = service(
      { paseo: feed },
      {
        labelsOf: () =>
          new (class extends Map<string, LiveSessionLabel> {
            override get(key: string): LiveSessionLabel | undefined {
              if (key === 'claude:boss') throw new Error('broken');
              return undefined;
            }
          })(),
      },
    );
    const body = await hq.snapshot();
    expect(body.agents).toHaveLength(1);
    await hq.close();
  });
});

describe('a look that began before the stop', () => {
  it('builds nothing after the service closed: no label query, and no agents', async () => {
    let status: ReturnType<TranscriptFeed['status']> = 'starting';
    const labels = vi.fn(() => new Map<string, LiveSessionLabel>());
    const claude: TranscriptFeed = {
      start: () => undefined,
      stop: () => {
        status = 'stopped';
        return Promise.resolve();
      },
      ready: () => new Promise<void>(() => undefined),
      status: () => status,
      read: () => ({ agents: [transcript({ sessionId: 's' })], files: 1 }),
    };
    const sleep = manualSleep();
    const { hq } = service({ claude }, { sleep, labelsOf: labels });
    const pending = hq.snapshot();
    await settle();
    // The feed comes up, then the service is closed while the first look is still waiting for its cold start.
    status = 'live';
    await hq.close();
    sleep.release();
    const body = await pending;
    expect(body.agents).toEqual([]);
    expect(labels).not.toHaveBeenCalled();
  });
});

describe('shutdown', () => {
  it('reaches every feed’s stop before it awaits anything, so a deadline that wins cannot leave a feed running', async () => {
    const stops: string[] = [];
    const feedWithStop = (name: string) => {
      let status: ReturnType<PaseoLiveFeed['status']> = 'stopped';
      const feed: PaseoLiveFeed = {
        start: () => {
          status = 'live';
        },
        // A stop that never finishes: the shutdown deadline is what ends the wait.
        stop: () => {
          stops.push(name);
          return new Promise<void>(() => undefined);
        },
        ready: () => Promise.resolve(),
        status: () => status,
        read: () => ({ agents: [], truncated: false }),
      };
      return feed;
    };
    const { hq } = service({
      paseo: feedWithStop('paseo'),
    });
    await hq.snapshot();
    void hq.close(); // not awaited: it never finishes
    expect(stops).toEqual(['paseo']);
  });
});
