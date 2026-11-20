import { mkdirSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, type ListenFn } from '../../src/server/boot.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { openDatabase } from '../../src/server/db/open.ts';
import { completeSetup } from '../../src/server/db/queries/setup.ts';
import { HqResponse } from '../../src/shared/contracts/hq.ts';
import { at, makeHomes } from '../collectors/live/feedHelpers.ts';
import { HOST, TZ, call, memoryLogger, tempConfig, tempDir } from './helpers.ts';

// After `shutdown()` has resolved, HQ holds nothing: no handle, no timer, no state in the feeds, the service, the id memo, the repo lookup
// or the label query. Everything goes through the real boot, over temp provider homes that hold invented transcripts. What cannot be read
// from outside (a feed's followed files, the service's memo) is checked where it is made or replaced: the finder's `clear()` is called for
// each feed, the memo and the repo lookup are replaced by new, empty ones, and a request after the close builds nothing.

const seen = vi.hoisted(() => ({
  cleared: 0,
  recents: 0,
  memos: [] as { ids: Map<unknown, unknown>; owners: Map<unknown, unknown>; polls: number }[],
  resolvers: 0,
  resolved: 0,
  labelReads: 0,
}));

vi.mock('../../src/server/collectors/live/recent.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/server/collectors/live/recent.ts')>();
  return {
    ...actual,
    createRecent: (options: Parameters<typeof actual.createRecent>[0]) => {
      seen.recents += 1;
      const inner = actual.createRecent(options);
      return {
        refresh: (signal?: AbortSignal) => inner.refresh(signal),
        clear: () => {
          seen.cleared += 1;
          inner.clear();
        },
      };
    },
  };
});
vi.mock('../../src/server/services/hq/roster.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/services/hq/roster.ts')>();
  return {
    ...actual,
    createKeyMemo: () => {
      const memo = actual.createKeyMemo();
      seen.memos.push(memo);
      return memo;
    },
  };
});
vi.mock('../../src/server/collectors/ingest/repo.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/server/collectors/ingest/repo.ts')>();
  return {
    ...actual,
    createRepoResolver: () => {
      seen.resolvers += 1;
      const inner = actual.createRepoResolver();
      return ((...args: Parameters<typeof inner>) => {
        seen.resolved += 1;
        return inner(...args);
      }) as typeof inner;
    },
  };
});
vi.mock('../../src/server/db/queries/hq.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/db/queries/hq.ts')>();
  return {
    ...actual,
    readLiveSessionLabels: (...args: Parameters<typeof actual.readLiveSessionLabels>) => {
      seen.labelReads += 1;
      return actual.readLiveSessionLabels(...args);
    },
  };
});

const listen: ListenFn = async () => ({ close: (callback) => callback?.() });
const CLOCK = at(34);
afterEach(() => {
  seen.cleared = 0;
  seen.recents = 0;
  seen.memos.length = 0;
  seen.resolvers = 0;
  seen.resolved = 0;
  seen.labelReads = 0;
});

/** The descriptors this process has open (the listing itself holds one, the same one every time). */
const openDescriptors = (): number =>
  readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length;
const timers = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

describe('after HQ has closed', () => {
  it('holds no handle, no timer and no state, and a request then builds nothing', async () => {
    const homes = makeHomes(CLOCK);
    const config = tempConfig();
    mkdirSync(config.dataDir, { recursive: true });
    const db = openDatabase(config.dbPath);
    migrate(db);
    completeSetup(db, { at: CLOCK, timezone: TZ });
    db.close();
    const server = await boot(config, {
      logger: memoryLogger('debug').logger,
      listen,
      now: () => CLOCK,
      timezone: TZ,
      scheduler: false,
      adapters: [],
      local: {
        env: { CLAUDE_CONFIG_DIR: homes.claudeDir, CODEX_HOME: homes.codexHome },
        home: tempDir(),
      },
      shutdownTimeoutMs: 50,
      hq: { idleMs: 60_000, coldWaitMs: 5_000, transcriptPollMs: 5 },
    });
    // Measured with the database open and nothing of HQ started: the baseline the close must return to.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const descriptorsBefore = openDescriptors();
    const timersBefore = timers();

    const response = await call(server.app as never, '/api/hq', { headers: HOST });
    const body = HqResponse.parse(await response.json());
    expect(body.agents).toHaveLength(5); // the feeds were running and had read the transcripts
    expect(seen.labelReads).toBeGreaterThan(0);
    expect(seen.resolved).toBeGreaterThan(0);
    const memosBefore = seen.memos.length;
    const resolversBefore = seen.resolvers;
    expect(seen.cleared).toBe(0);
    expect(openDescriptors()).toBeGreaterThan(0);

    await server.shutdown();

    // No handle: every descriptor HQ opened (folders, transcripts) is closed, the database's too.
    expect(openDescriptors()).toBeLessThanOrEqual(descriptorsBefore);
    // No timer: the feeds' waits and the service's idle countdown are gone; the shutdown's own deadline timers have run out.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(timers()).toBeLessThanOrEqual(timersBefore);
    // No state: each feed's finder was cleared (both of them), the id memo is a new empty one and the repo lookup was dropped.
    expect(seen.recents).toBe(2);
    expect(seen.cleared).toBe(2);
    expect(seen.memos.length).toBe(memosBefore + 1);
    const latest = seen.memos.at(-1);
    expect(latest?.ids.size).toBe(0);
    expect(latest?.owners.size).toBe(0);
    expect(latest?.polls).toBe(0);

    // And nothing is built again by a later request: no label query, no repo lookup, no memo, no new finder, and the answer is valid.
    const labelReads = seen.labelReads;
    const resolved = seen.resolved;
    const later = await call(server.app as never, '/api/hq', { headers: HOST });
    expect(later.status).toBe(200);
    const empty = HqResponse.parse(await later.json());
    expect(empty.agents).toEqual([]);
    expect(seen.labelReads).toBe(labelReads);
    expect(seen.resolved).toBe(resolved);
    expect(seen.resolvers).toBe(resolversBefore);
    expect(seen.memos.length).toBe(memosBefore + 1);
    expect(seen.recents).toBe(2);
    expect(openDescriptors()).toBeLessThanOrEqual(descriptorsBefore);
  });
});
