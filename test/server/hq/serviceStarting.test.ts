import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTranscriptFeed,
  type Tracker,
  type TranscriptAgent,
} from '../../../src/server/collectors/live/feed.ts';
import type { RecentFile } from '../../../src/server/collectors/live/recent.ts';
import { HqRoster } from '../../../src/shared/contracts/hq.ts';
import { createHqService } from '../../../src/server/services/hq/service.ts';
import { manualSleep, settle } from '../../collectors/paseo/liveHelpers.ts';
import { memoryLogger } from '../helpers.ts';

// The service over a REAL transcript feed whose first read is slow: a snapshot taken while that first transcript is unread says the feed
// is `starting`, has no agents and does not say the list was cut; the next one, once it is read, says `live` with the agent. The cold wait
// ends when the status changes, not before.

const NOW = Date.parse('2026-11-19T10:00:00Z');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hq-starting-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const agent = (sessionId: string): TranscriptAgent => ({
  provider: 'claude',
  sessionId,
  parentSessionId: null,
  cwd: null,
  startedAt: null,
  state: 'working',
  activity: 'thinking',
  waitReason: null,
  since: NOW - 1_000,
  lastActivityAt: NOW - 1_000,
});

function setup(
  firstRead: Promise<void>,
  labelsOf?: Parameters<typeof createHqService>[0]['labelsOf'],
) {
  const path = join(dir, 'session-one.jsonl');
  writeFileSync(path, '{"n":1}\n');
  utimesSync(path, new Date(NOW - 1_000), new Date(NOW - 1_000));
  const feedSleep = manualSleep();
  let started = 0;
  const claude = createTranscriptFeed({
    now: () => NOW,
    logger: memoryLogger('debug').logger,
    sleep: feedSleep,
    source: {
      provider: 'claude',
      roots: () => [dir],
      accept: (rel) => rel.endsWith('.jsonl'),
      hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
      start: async (file) => {
        started += 1;
        await firstRead;
        const tracker: Tracker = {
          line: () => undefined,
          overlong: () => undefined,
          agent: () => agent(file.rel),
        };
        return tracker;
      },
    },
  });
  const sleep = manualSleep(); // the service's cold wait
  const hq = createHqService({
    feeds: { claude },
    now: () => NOW,
    logger: memoryLogger('debug').logger,
    waitsForSetup: () => false,
    sleep,
    labelsOf,
  });
  return { hq, claude, sleep, started: () => started };
}

/**
 * Waits until the feed has begun its first read. The look before it does real file system work (listing the temp folder), which
 * takes as long as the machine makes it take, so this waits on the clock (up to 5 s) and not on a fixed number of turns.
 */
async function untilStarted(started: () => number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (started() === 0 && Date.now() < deadline) {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('a snapshot during the first transcript read', () => {
  it('reports starting with no agents, and live with the agent once the read has ended', async () => {
    const firstRead = deferred();
    const { hq, sleep, started } = setup(firstRead.promise);

    const cold = hq.snapshot(); // starts the feeds, waits for them up to the cold wait
    await untilStarted(started);
    expect(started()).toBe(1); // the first transcript is being read
    sleep.release(); // the cold wait runs out before the read ends
    const during = await cold;
    expect(during.feeds).toEqual([
      { id: 'paseo', status: 'unavailable' },
      { id: 'claude', status: 'starting' },
      { id: 'codex', status: 'unavailable' },
    ]);
    expect(during.agents).toEqual([]);
    expect(during.truncated).toBe(false);

    firstRead.resolve();
    const after = await hq.snapshot(); // the cold wait is not needed any more: the feed answers by itself
    expect(after.feeds[1]).toEqual({ id: 'claude', status: 'live' });
    expect(after.agents).toHaveLength(1);
    await hq.close();
  });

  it('the cold wait ends when the first read does, so the first request can already show the agent', async () => {
    const firstRead = deferred();
    const { hq, started } = setup(firstRead.promise);
    const cold = hq.snapshot();
    await untilStarted(started);
    firstRead.resolve();
    const body = await cold;
    expect(body.feeds[1]).toEqual({ id: 'claude', status: 'live' });
    expect(body.agents).toHaveLength(1);
    await hq.close();
  });
});

describe('a stop in the middle of building the answer', () => {
  it('during the label lookup: the answer is still valid, the feeds end stopped and nothing is held', async () => {
    const holder: { close: () => Promise<void> } = { close: () => Promise.resolve() };
    let closing: Promise<void> | null = null;
    const { hq, claude } = setup(Promise.resolve(), () => {
      closing = holder.close(); // the service is closed while the roster is being built
      return new Map();
    });
    holder.close = () => hq.close();
    const body = await hq.snapshot();
    expect(HqRoster.safeParse(body).success).toBe(true);
    expect(closing).not.toBeNull();
    await closing;
    expect(claude.status()).toBe('stopped');
    expect(claude.read()).toEqual({ agents: [], files: 0 });
    // And nothing comes back: a later snapshot of a closed service starts nothing.
    await hq.snapshot();
    expect(claude.status()).toBe('stopped');
  });
});
