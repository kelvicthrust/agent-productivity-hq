import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTranscript } from '../../../src/server/collectors/claude/files.ts';
import { createCodexFeed } from '../../../src/server/collectors/live/codexFeed.ts';
import { createRecent, type RecentFile } from '../../../src/server/collectors/live/recent.ts';
import { readLiveAgent } from '../../../src/server/collectors/paseo/liveAgent.ts';
import { EARLIEST_LIVE_MS, FUTURE_SKEW_MS, liveTime } from '../../../src/server/lib/liveTime.ts';
import { memoryLogger } from '../../server/helpers.ts';
import { entry, manualSleep, settle } from '../paseo/liveHelpers.ts';
import { R1, at } from './feedHelpers.ts';
import { line } from './lines.ts';

// A time is kept only when it is a date HQ believes: not a number a Date cannot hold, not before 2000, not a day or more ahead of the clock.

const NOW = Date.parse('2026-11-19T10:00:00Z');
const MAX_DATE = 8.64e15;

describe('liveTime', () => {
  it('keeps a time inside the window and nothing else', () => {
    expect(liveTime(NOW, NOW)).toBe(NOW);
    expect(liveTime(EARLIEST_LIVE_MS, NOW)).toBe(EARLIEST_LIVE_MS);
    expect(liveTime(NOW + FUTURE_SKEW_MS, NOW)).toBe(NOW + FUTURE_SKEW_MS);
    for (const bad of [
      EARLIEST_LIVE_MS - 1,
      0,
      -1,
      NOW + FUTURE_SKEW_MS + 1,
      1e16,
      MAX_DATE,
      MAX_DATE + 1,
      -MAX_DATE - 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      null,
      undefined,
    ])
      expect(liveTime(bad, NOW)).toBeNull();
  });

  it('every time it keeps can be serialised', () => {
    for (const value of [EARLIEST_LIVE_MS, NOW, NOW + FUTURE_SKEW_MS])
      expect(() => new Date(liveTime(value, NOW) ?? 0).toISOString()).not.toThrow();
  });
});

describe('Paseo times', () => {
  const when = (ms: number) => new Date(ms).toISOString();
  const spec = (over: Record<string, unknown>) => {
    const listed = entry({ id: 'a-1', status: 'running' });
    Object.assign(listed.agent, over);
    return readLiveAgent(listed, NOW);
  };

  it('drops a time outside the window: the update time falls back to the creation time, then to now', () => {
    const farFuture = '+275760-09-13T00:00:00.000Z';
    expect(spec({ updatedAt: farFuture, createdAt: when(NOW - 60_000) })).toMatchObject({
      updatedAt: NOW - 60_000,
      createdAt: NOW - 60_000,
    });
    expect(spec({ updatedAt: farFuture, createdAt: farFuture })).toMatchObject({
      updatedAt: NOW,
      createdAt: null,
    });
    expect(spec({ updatedAt: '1970-01-01T00:00:00.000Z', createdAt: null })).toMatchObject({
      updatedAt: NOW,
    });
  });

  it('drops the attention time and the turn start when they are outside the window', () => {
    const agent = spec({
      attentionTimestamp: '+275760-09-13T00:00:00.000Z',
      activeTurn: { turnId: 't', startedAt: '0001-01-01T00:00:00.000Z' },
    });
    expect(agent).toMatchObject({ attentionAt: null, turnStartedAt: null });
  });

  it('keeps a good time as it is', () => {
    expect(
      spec({ updatedAt: when(NOW - 5_000), attentionTimestamp: when(NOW - 9_000) }),
    ).toMatchObject({ updatedAt: NOW - 5_000, attentionAt: NOW - 9_000 });
  });
});

describe('a Codex rollout with times outside the window', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'live-time-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('shows the session with the time it was seen at, and no start time', async () => {
    const dir = join(home, 'sessions', '2026', '11', '19');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-11-19T09-59-00-${R1}.jsonl`);
    writeFileSync(
      path,
      [
        line({
          timestamp: 1e16,
          type: 'session_meta',
          payload: { id: R1, timestamp: 1e16, cwd: '/work/invented/project', source: 'cli' },
        }),
        line({
          timestamp: '+275760-09-13T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
      ].join('\n') + '\n',
    );
    utimesSync(path, new Date(at(29)), new Date(at(29)));
    const feed = createCodexFeed({
      homes: () => [home],
      now: () => at(30),
      logger: memoryLogger('debug').logger,
      sleep: manualSleep(),
    });
    feed.start();
    await feed.ready();
    await settle();
    const [agent] = feed.read().agents;
    expect(agent).toMatchObject({ sessionId: R1, state: 'working', startedAt: null });
    expect(agent?.lastActivityAt).toBe(at(30));
    expect(agent?.since).toBe(at(30));
    await feed.stop();
  });
});

describe('a file with a time outside the window', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'live-time-files-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const put = (rel: string, when: number) => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}\n');
    utimesSync(path, new Date(when), new Date(when));
  };

  it('is not followed (a file dated the year 3000 would stay at the top for ever), while one a little ahead of the clock is', async () => {
    put('p/good.jsonl', NOW - 1_000);
    put('p/ahead.jsonl', NOW + 60_000);
    put('p/far.jsonl', Date.UTC(3000, 0, 1));
    put('p/old.jsonl', 0);
    const feed = createRecent({
      roots: () => [root],
      accept: (rel) => classifyTranscript(rel) !== null,
      hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
      now: () => NOW,
    });
    const seen = await feed.refresh();
    expect(seen.files.map((file) => file.rel).sort()).toEqual(['p/ahead.jsonl', 'p/good.jsonl']);
  });
});
