import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TranscriptAgent,
  TranscriptFeed,
  TranscriptFeedStatus,
} from '../../../src/server/collectors/live/feed.ts';
import type { LiveFeedStatus, PaseoLiveFeed } from '../../../src/server/collectors/paseo/live.ts';
import { liveSessionKey } from '../../../src/server/db/queries/hq.ts';
import { createHqService } from '../../../src/server/services/hq/service.ts';
import { keyId } from '../../../src/server/services/hq/roster.ts';
import { liveAgent, manualSleep, settle } from '../../collectors/paseo/liveHelpers.ts';
import { NOW, memoryLogger } from '../helpers.ts';

// The roster service with the transcript feeds: which feeds it starts and stops, the statuses it reports for feeds that are absent,
// not live or waiting for Setup, what it merges, and what it forgets when the feeds stop. The feeds are fakes.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const agent = (over: Partial<TranscriptAgent> & { sessionId: string }): TranscriptAgent => ({
  provider: 'claude',
  parentSessionId: null,
  cwd: '/work/invented/project',
  startedAt: null,
  state: 'working',
  activity: 'reading',
  waitReason: null,
  since: NOW - 60_000,
  lastActivityAt: NOW - 1_000,
  ...over,
});

interface FakeTranscript extends TranscriptFeed {
  starts: number;
  stops: number;
  agents: TranscriptAgent[];
  set(status: TranscriptFeedStatus): void;
}

function transcriptFeed(
  initial: TranscriptAgent[] = [],
  upStatus: TranscriptFeedStatus = 'live',
): FakeTranscript {
  let status: TranscriptFeedStatus = 'stopped';
  const feed: FakeTranscript = {
    starts: 0,
    stops: 0,
    agents: initial,
    start: () => {
      feed.starts += 1;
      status = upStatus;
    },
    stop: () => {
      feed.stops += 1;
      status = 'stopped';
      return Promise.resolve();
    },
    ready: () => Promise.resolve(),
    status: () => status,
    read: () => ({ agents: feed.agents, files: feed.agents.length }),
    set: (next) => {
      status = next;
    },
  };
  return feed;
}

function paseoFeed(
  entries: ReturnType<typeof liveAgent>[] = [],
  upStatus: LiveFeedStatus = 'live',
) {
  let status: LiveFeedStatus = 'stopped';
  const feed: PaseoLiveFeed & { starts: number; stops: number; entries: typeof entries } = {
    starts: 0,
    stops: 0,
    entries,
    start: () => {
      feed.starts += 1;
      status = upStatus;
    },
    stop: () => {
      feed.stops += 1;
      status = 'stopped';
      return Promise.resolve();
    },
    ready: () => Promise.resolve(),
    status: () => status,
    read: () => ({ agents: feed.entries, truncated: false }),
  };
  return feed;
}

const service = (
  feeds: Parameters<typeof createHqService>[0]['feeds'],
  over: Partial<Parameters<typeof createHqService>[0]> = {},
) =>
  createHqService({
    feeds,
    now: () => NOW,
    logger: memoryLogger('debug').logger,
    waitsForSetup: () => false,
    sleep: manualSleep(),
    ...over,
  });

describe('feeds', () => {
  it('a process with only the transcript feeds says Paseo is unavailable and shows what they see', async () => {
    const claude = transcriptFeed([agent({ sessionId: 'c1' })]);
    const codex = transcriptFeed([
      agent({ sessionId: 'x1', provider: 'codex', activity: 'command' }),
    ]);
    const hq = service({ claude, codex });
    const body = await hq.snapshot();
    expect(body.feeds).toEqual([
      { id: 'paseo', status: 'unavailable' },
      { id: 'claude', status: 'live' },
      { id: 'codex', status: 'live' },
    ]);
    expect(
      body.agents.map((a) => [a.provider, a.activity, a.confidence, a.seenBy.transcript]),
    ).toEqual([
      ['claude', 'reading', 'inferred', true],
      ['codex', 'command', 'inferred', true],
    ]);
    await hq.close();
  });

  it('a feed that is not live shows its status and no agents, and the others carry on', async () => {
    const claude = transcriptFeed([agent({ sessionId: 'c1' })], 'notfound');
    const codex = transcriptFeed([agent({ sessionId: 'x1', provider: 'codex' })]);
    const hq = service({ claude, codex });
    const body = await hq.snapshot();
    expect(body.feeds.map((feed) => feed.status)).toEqual(['unavailable', 'notfound', 'live']);
    expect(body.agents).toHaveLength(1);
    await hq.close();
  });

  it.each(['denied', 'failed', 'starting'] as const)(
    'reports a %s transcript feed as it is',
    async (status) => {
      const hq = service({ claude: transcriptFeed([], status), codex: transcriptFeed() });
      expect((await hq.snapshot()).feeds[1]).toEqual({ id: 'claude', status });
      await hq.close();
    },
  );

  it('with nothing live there are no agents, whatever a stopped feed still holds', async () => {
    const claude = transcriptFeed([agent({ sessionId: 'c1' })], 'failed');
    const hq = service({ claude });
    expect((await hq.snapshot()).agents).toEqual([]);
    await hq.close();
  });

  it('merges Paseo and the transcripts into one roster, one entry for an agent both see', async () => {
    const paseo = paseoFeed([
      liveAgent({
        id: 'p1',
        provider: 'claude',
        sessionId: 'c1',
        status: 'running',
        title: 'Both',
      }),
      liveAgent({ id: 'p2', provider: 'codex', sessionId: null, status: 'idle' }),
    ]);
    const claude = transcriptFeed([
      agent({ sessionId: 'c1', activity: 'editing' }),
      agent({ sessionId: 'c2' }),
    ]);
    const hq = service({ paseo, claude });
    const body = await hq.snapshot();
    expect(body.feeds.map((feed) => feed.status)).toEqual(['live', 'live', 'unavailable']);
    expect(body.agents).toHaveLength(3);
    const both = body.agents.find((a) => a.title === 'Both');
    expect(both).toMatchObject({
      state: 'working',
      activity: 'editing',
      confidence: 'reported',
      seenBy: { paseo: true, transcript: true },
    });
    await hq.close();
  });

  it('uses the stored label for a session the database knows, asking by session keys', async () => {
    const claude = transcriptFeed([agent({ sessionId: 'known' }), agent({ sessionId: 'unknown' })]);
    const asked: unknown[] = [];
    const hq = service(
      { claude },
      {
        labelsOf: (keys) => {
          asked.push(keys);
          return new Map([
            [
              liveSessionKey('claude', 'known'),
              { title: 'Stored name', repo: 'acme/widgets', workspace: null },
            ],
          ]);
        },
      },
    );
    const body = await hq.snapshot();
    expect(body.agents.find((a) => a.title === 'Stored name')?.repo).toBe('acme/widgets');
    expect(body.agents.filter((a) => a.title === null)).toHaveLength(1);
    expect(asked).toHaveLength(1);
    await hq.close();
  });
});

describe('stored labels', () => {
  it('a label read that throws does not take the roster down', async () => {
    const claude = transcriptFeed([agent({ sessionId: 'c1' })]);
    const hq = service(
      { claude },
      {
        labelsOf: () => {
          throw new Error('database is locked');
        },
      },
    );
    const body = await hq.snapshot();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]?.title).toBeNull();
    await hq.close();
  });
});

describe('Setup', () => {
  it('starts nothing and says setup_incomplete for each feed that exists, until Setup is finished', async () => {
    let waits = true;
    const claude = transcriptFeed([agent({ sessionId: 'c1' })]);
    const codex = transcriptFeed();
    const hq = service({ claude, codex }, { waitsForSetup: () => waits });
    expect(await hq.snapshot()).toMatchObject({
      feeds: [
        { id: 'paseo', status: 'unavailable' },
        { id: 'claude', status: 'setup_incomplete' },
        { id: 'codex', status: 'setup_incomplete' },
      ],
      agents: [],
    });
    expect([claude.starts, codex.starts]).toEqual([0, 0]);
    waits = false;
    expect((await hq.snapshot()).agents).toHaveLength(1);
    expect([claude.starts, codex.starts]).toEqual([1, 1]);
    await hq.close();
  });
});

describe('the demand', () => {
  it('starts every feed on the first request, once, and stops them all after the idle time', async () => {
    const paseo = paseoFeed();
    const claude = transcriptFeed();
    const codex = transcriptFeed();
    const hq = service({ paseo, claude, codex }, { idleMs: 30_000 });
    await hq.snapshot();
    await hq.snapshot();
    expect([paseo.starts, claude.starts, codex.starts]).toEqual([1, 1, 1]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect([paseo.stops, claude.stops, codex.stops]).toEqual([0, 0, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect([paseo.stops, claude.stops, codex.stops]).toEqual([1, 1, 1]);
    // The next request starts them again.
    await hq.snapshot();
    expect([paseo.starts, claude.starts, codex.starts]).toEqual([2, 2, 2]);
    await hq.close();
    expect([paseo.stops, claude.stops, codex.stops]).toEqual([2, 2, 2]);
  });

  it('close stops every feed even when one refuses, and is safe twice', async () => {
    const claude = transcriptFeed();
    const codex = transcriptFeed();
    claude.stop = () => Promise.reject(new Error('boom'));
    const hq = service({ claude, codex });
    await hq.snapshot();
    await expect(hq.close()).resolves.toBeUndefined();
    expect(codex.stops).toBe(1);
    await expect(hq.close()).resolves.toBeUndefined();
  });

  it('waits for feeds that have only just started, then answers with what they saw', async () => {
    let release: () => void = () => undefined;
    const claude = transcriptFeed([agent({ sessionId: 'c1' })], 'starting');
    claude.ready = () => new Promise<void>((resolve) => (release = resolve));
    const sleep = manualSleep();
    const hq = service({ claude }, { sleep, coldWaitMs: 1_000 });
    const pending = hq.snapshot();
    await settle();
    expect(sleep.pending).toBe(1); // the cold wait's deadline
    claude.set('live');
    release();
    const body = await pending;
    expect(body.feeds[1]).toEqual({ id: 'claude', status: 'live' });
    expect(body.agents).toHaveLength(1);
    expect(sleep.pending).toBe(0); // the deadline's timer is released
    await hq.close();
  });

  it('reports a feed that is still starting after the cold wait as starting', async () => {
    const claude = transcriptFeed([], 'starting');
    claude.ready = () => new Promise<void>(() => undefined);
    const sleep = manualSleep();
    const hq = service({ claude }, { sleep, coldWaitMs: 1_000 });
    const pending = hq.snapshot();
    await settle();
    sleep.release();
    expect((await pending).feeds[1]).toEqual({ id: 'claude', status: 'starting' });
    await hq.close();
  });
});

describe('what it forgets when the feeds stop', () => {
  it('drops the ids it remembered: a transcript-only id does not survive a stop', async () => {
    const paseo = paseoFeed([]);
    const claude = transcriptFeed([agent({ sessionId: 'S' })]);
    const hq = service({ paseo, claude }, { idleMs: 30_000 });
    const first = (await hq.snapshot()).agents[0]?.id;
    expect(first).toBe(keyId('claude:S'));
    // Paseo then sees the same agent: the id already shown is kept (the memory).
    paseo.entries = [
      liveAgent({ id: 'p1', provider: 'claude', sessionId: 'S', status: 'running' }),
    ];
    expect((await hq.snapshot()).agents[0]?.id).toBe(first);
    await vi.advanceTimersByTimeAsync(30_000);
    // After the stop nothing is remembered, and only Paseo sees it now. The id is the same all the same: it comes from the provider
    // session, which Paseo names, not from the memory.
    claude.agents = [];
    expect((await hq.snapshot()).agents[0]?.id).toBe(first);
    await hq.close();
  });
});
