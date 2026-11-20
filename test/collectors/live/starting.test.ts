import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTranscriptFeed,
  type Tracker,
  type TranscriptAgent,
} from '../../../src/server/collectors/live/feed.ts';
import {
  FIRST_READ_DEADLINE_MS,
  FULL_LISTING_EVERY_MS,
} from '../../../src/server/collectors/live/heuristics.ts';
import type { RecentFile } from '../../../src/server/collectors/live/recent.ts';
import { memoryLogger } from '../../server/helpers.ts';
import { manualSleep, settle } from '../paseo/liveHelpers.ts';

// A feed is `starting` until its first complete tick is over: the files found AND each of them read once. `ready()` resolves at the
// moment the status changes. A feed that finds its roots again after `notfound` is live only after its reads too.

const NOW = Date.parse('2026-11-19T10:00:00Z');
let dir: string;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-starting-'));
  clock = NOW;
});
afterEach(() => {
  chmodSafe(dir);
  rmSync(dir, { recursive: true, force: true });
});
function chmodSafe(path: string) {
  try {
    chmodSync(path, 0o700);
  } catch {
    // already gone
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function write(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '{"n":1}\n');
  utimesSync(path, new Date(clock - 1_000), new Date(clock - 1_000));
  return path;
}

const agentOf = (sessionId: string): TranscriptAgent => ({
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

/** A feed whose tracker start for each file name waits for the test. */
function feedOver(
  gate: (name: string) => Promise<void> | undefined = () => undefined,
  roots: () => readonly string[] = () => [dir],
) {
  const sleep = manualSleep();
  const started: string[] = [];
  const feed = createTranscriptFeed({
    now: () => clock,
    logger: memoryLogger('debug').logger,
    sleep,
    source: {
      provider: 'claude',
      roots,
      accept: (rel) => rel.endsWith('.jsonl'),
      hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
      start: async (file) => {
        const name = file.rel;
        started.push(name);
        await gate(name);
        const tracker: Tracker = {
          line: () => undefined,
          overlong: () => undefined,
          agent: () => agentOf(name),
        };
        return tracker;
      },
    },
  });
  return { feed, sleep, started };
}

describe('a feed is starting until its first look has read each file', () => {
  it('is starting and shows nothing while the first transcript is still being read, and live the moment it has been', async () => {
    write('a.jsonl');
    const slow = deferred();
    const { feed, started } = feedOver(() => slow.promise);
    feed.start();
    let readyAt: string | null = null;
    void feed.ready().then(() => {
      readyAt = feed.status();
    });
    for (let turn = 0; turn < 100 && started.length === 0; turn += 1) await settle();
    expect(started).toEqual(['a.jsonl']);
    expect(feed.status()).toBe('starting'); // the listing found the file; its first read has not ended
    expect(feed.read()).toEqual({ agents: [], files: 0 });
    expect(readyAt).toBeNull();

    slow.resolve();
    await feed.ready();
    expect(feed.status()).toBe('live');
    expect(readyAt).toBe('live'); // ready() answered when the status was already live, never before
    expect(feed.read().agents.map((agent) => agent.sessionId)).toEqual(['a.jsonl']);
    await feed.stop();
  });

  it('stays starting until every followed file has been read once, not just the first', async () => {
    write('a.jsonl');
    write('b.jsonl');
    write('c.jsonl');
    const second = deferred();
    const { feed, started } = feedOver((name) => (name === 'b.jsonl' ? second.promise : undefined));
    feed.start();
    for (let turn = 0; turn < 100 && !started.includes('b.jsonl'); turn += 1) await settle();
    expect(started).toEqual(['a.jsonl', 'b.jsonl']); // c is deferred behind b
    expect(feed.status()).toBe('starting');
    second.resolve();
    await feed.ready();
    expect(started).toEqual(['a.jsonl', 'b.jsonl', 'c.jsonl']);
    expect(feed.status()).toBe('live');
    expect(feed.read().agents).toHaveLength(3);
    await feed.stop();
  });

  it('counts a file that could not be read as attempted, so one unreadable file does not hold it back', async () => {
    write('a.jsonl');
    const locked = write('b.jsonl');
    chmodSync(locked, 0o000);
    const { feed } = feedOver();
    feed.start();
    await feed.ready();
    expect(feed.status()).toBe('live');
    expect(feed.read().agents.map((agent) => agent.sessionId)).toEqual(['a.jsonl']);
    await feed.stop();
  });

  it(`gives up waiting ${FIRST_READ_DEADLINE_MS} ms after it started (by its clock) and shows what it has read`, async () => {
    write('a.jsonl');
    write('b.jsonl');
    const never = deferred();
    const { feed, started } = feedOver((name) => {
      if (name === 'a.jsonl') {
        clock += FIRST_READ_DEADLINE_MS; // the first read was slow
        return undefined;
      }
      return never.promise; // b: still unread
    });
    feed.start();
    for (let turn = 0; turn < 100 && !started.includes('b.jsonl'); turn += 1) await settle();
    // `ready()` has answered although b has not been read: the deadline passed after a's read.
    await feed.ready();
    expect(feed.status()).toBe('live');
    expect(feed.read().agents.map((agent) => agent.sessionId)).toEqual(['a.jsonl']);
    never.resolve();
    await feed.stop();
  });

  it('is not live before the deadline either: under it, an unread file keeps the feed starting', async () => {
    write('a.jsonl');
    write('b.jsonl');
    const never = deferred();
    const { feed, started } = feedOver((name) => {
      if (name === 'a.jsonl') {
        clock += FIRST_READ_DEADLINE_MS - 1;
        return undefined;
      }
      return never.promise;
    });
    feed.start();
    for (let turn = 0; turn < 100 && !started.includes('b.jsonl'); turn += 1) await settle();
    expect(feed.status()).toBe('starting');
    never.resolve();
    await feed.stop();
  });

  it('a first look that fails ends the wait with the failure, and one with no roots with notfound', async () => {
    const failing = feedOver(undefined, () => {
      throw new Error('boom');
    });
    failing.feed.start();
    await failing.feed.ready();
    expect(failing.feed.status()).toBe('failed');
    await failing.feed.stop();

    const missing = feedOver(undefined, () => [join(dir, 'nothing-here')]);
    missing.feed.start();
    await missing.feed.ready();
    expect(missing.feed.status()).toBe('notfound');
    await missing.feed.stop();
  });

  it('a feed that finds its roots again after notfound is live only after the files there have been read', async () => {
    const roots = join(dir, 'later');
    const slow = deferred();
    const { feed, sleep, started } = feedOver(
      () => slow.promise,
      () => [roots],
    );
    feed.start();
    await feed.ready();
    expect(feed.status()).toBe('notfound');
    await settle(); // the loop is now waiting between ticks

    // The folder appears; the next full listing (a minute on) finds it. The file's first read is slow: still not live.
    mkdirSync(roots);
    const path = join(roots, 'a.jsonl');
    writeFileSync(path, '{"n":1}\n');
    clock += FULL_LISTING_EVERY_MS;
    utimesSync(path, new Date(clock - 1_000), new Date(clock - 1_000));
    sleep.release();
    for (let turn = 0; turn < 100 && started.length === 0; turn += 1) await settle();
    expect(started).toEqual(['a.jsonl']);
    expect(feed.status()).toBe('notfound');
    expect(feed.read()).toEqual({ agents: [], files: 0 });

    slow.resolve();
    for (let turn = 0; turn < 100 && feed.status() !== 'live'; turn += 1) await settle();
    expect(feed.status()).toBe('live');
    expect(feed.read().agents).toHaveLength(1);
    await feed.stop();
  });
});
