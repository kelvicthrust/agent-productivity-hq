import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunner, runStateOf, type Runner } from '../../../src/server/collectors/runner.ts';
import {
  REFRESH_SOURCE_IDS,
  type RefreshSourceId,
  type SourceAdapter,
} from '../../../src/server/collectors/types.ts';
import { readLinkHealth } from '../../../src/server/db/queries/link-health.ts';
import { markRunningRunsInterrupted } from '../../../src/server/db/queries/runs.ts';
import {
  getRun,
  getSourceState,
  recordAttempt,
  type RunSources,
} from '../../../src/server/db/queries/sources.ts';
import { RefreshRequest } from '../../../src/shared/contracts/sources.ts';
import { recomputeLinks } from '../../../src/server/services/links.ts';
import { memoryDb, memoryLogger } from '../../server/helpers.ts';
import { seedDatabase } from '../seed.ts';
import { fails, gate, holds, partial, scriptedAdapter, skips, succeeds } from './scripted.ts';

// The refresh runner, driven by scripted adapters over a real schema: the stages and their order, what each run row shows
// while it goes, how a run's state follows from its sources, and the consecutive_failures rule that "failed again" copy
// hangs on. Nothing here reads a log folder or the network.

const T0 = Date.parse('2026-11-04T17:42:00Z');

afterEach(() => {
  vi.useRealTimers();
});

function setup(
  adapters: readonly SourceAdapter[],
  options: {
    db?: DatabaseSync;
    afterSources?: Parameters<typeof createRunner>[0]['afterSources'];
  } = {},
) {
  const db = options.db ?? memoryDb();
  const logs = memoryLogger();
  let now = T0;
  const runner: Runner = createRunner({
    db,
    now: () => now,
    logger: logs.logger,
    adapters,
    ...(options.afterSources ? { afterSources: options.afterSources } : {}),
  });
  return {
    db,
    runner,
    entries: logs.entries,
    tick: (ms: number) => {
      now += ms;
    },
    clock: () => now,
  };
}

/** Runs to the end and returns the run row. */
async function runAll(t: ReturnType<typeof setup>, sources?: readonly RefreshSourceId[]) {
  const started = t.runner.start({ trigger: 'manual', ...(sources ? { sources } : {}) });
  if (!started.started) throw new Error('a run was already going');
  await t.runner.idle();
  return getRun(t.db, started.run.id)!;
}

const every = (steps: Parameters<typeof scriptedAdapter>[1]) =>
  REFRESH_SOURCE_IDS.map((id) => scriptedAdapter(id, steps));

describe('the stages', () => {
  it('knows exactly the sources POST /api/refresh accepts', () => {
    const accepted = RefreshRequest.shape.sources.unwrap().element.options;
    expect([...REFRESH_SOURCE_IDS].sort()).toEqual([...accepted].sort());
  });

  it('queues every source, then runs codex and claude together, and each later stage only after the one before', async () => {
    const codexGate = gate();
    const claudeGate = gate();
    const codex = scriptedAdapter('codex', [holds(codexGate, succeeds({ imported: 2 }))]);
    const claude = scriptedAdapter('claude', [holds(claudeGate, succeeds({ imported: 3 }))]);
    const paseo = scriptedAdapter('paseo', [succeeds()]);
    const github = scriptedAdapter('github', [succeeds()]);
    const chatgpt = scriptedAdapter('chatgpt_account', [succeeds()]);
    const t = setup([codex, claude, paseo, github, chatgpt]);

    const started = t.runner.start({ trigger: 'manual' });
    expect(started.started).toBe(true);
    if (!started.started) return;
    // The run exists the moment start() returns, with every source waiting.
    expect(started.run.state).toBe('running');
    expect(
      Object.fromEntries(Object.entries(started.run.sources).map(([k, v]) => [k, v.state])),
    ).toEqual({
      codex: 'queued',
      claude: 'queued',
      paseo: 'queued',
      github: 'queued',
      chatgpt_account: 'queued',
    });

    // Stage 1 is parallel: both are running before either has finished, and nothing later has started.
    await Promise.all([codex.called(), claude.called()]);
    const during = getRun(t.db, started.run.id)!;
    expect(during.sources['codex']?.state).toBe('running');
    expect(during.sources['claude']?.state).toBe('running');
    expect(during.sources['paseo']?.state).toBe('queued');
    expect(paseo.calls).toBe(0);

    // Stage 2 waits for BOTH of stage 1, not just the first to finish.
    codexGate.release();
    await vi.waitFor(() =>
      expect(getRun(t.db, started.run.id)!.sources['codex']?.state).toBe('succeeded'),
    );
    expect(getRun(t.db, started.run.id)!.sources['claude']?.state).toBe('running');
    expect(paseo.calls).toBe(0);

    claudeGate.release();
    await t.runner.idle();
    const done = getRun(t.db, started.run.id)!;
    expect(done.state).toBe('succeeded');
    expect(done.finishedAt).toBe(T0);
    expect(done.sources['codex']).toMatchObject({ state: 'succeeded', imported: 2 });
    expect(done.sources['claude']).toMatchObject({ state: 'succeeded', imported: 3 });
    expect([paseo.calls, github.calls, chatgpt.calls]).toEqual([1, 1, 1]);
  });

  it('runs the stages in the order codex+claude, paseo, github, chatgpt_account', async () => {
    const order: string[] = [];
    const logging = (id: RefreshSourceId) =>
      scriptedAdapter(id, [
        async () => {
          order.push(`start ${id}`);
          await Promise.resolve();
          order.push(`end ${id}`);
          return succeeds();
        },
      ]);
    const t = setup(REFRESH_SOURCE_IDS.map(logging));
    await runAll(t);
    const at = (entry: string) => order.indexOf(entry);
    // Both stage-1 sources started before either ended, then the rest one at a time, in order.
    expect(Math.max(at('start codex'), at('start claude'))).toBeLessThan(
      Math.min(at('end codex'), at('end claude')),
    );
    expect(Math.max(at('end codex'), at('end claude'))).toBeLessThan(at('start paseo'));
    expect(at('end paseo')).toBeLessThan(at('start github'));
    expect(at('end github')).toBeLessThan(at('start chatgpt_account'));
  });

  it('runs only the sources it was asked for', async () => {
    const codex = scriptedAdapter('codex', [succeeds({ imported: 1 })]);
    const claude = scriptedAdapter('claude', [succeeds()]);
    const t = setup([codex, claude]);
    const run = await runAll(t, ['codex']);
    expect(Object.keys(run.sources)).toEqual(['codex']);
    expect(claude.calls).toBe(0);
    expect(getSourceState(t.db, 'claude')).toBeNull();
  });

  it('skips a source this process has no adapter for, and records nothing about it', async () => {
    const t = setup([scriptedAdapter('codex', [succeeds()])]);
    const run = await runAll(t);
    expect(run.sources['claude']).toMatchObject({ state: 'skipped' });
    expect(run.sources['claude']?.message).toBeTruthy();
    expect(getSourceState(t.db, 'claude')).toBeNull();
    expect(getSourceState(t.db, 'codex')?.lastAttemptResult).toBe('succeeded');
    // Skipped sources count for nothing: the one that ran succeeded, so the run did.
    expect(run.state).toBe('succeeded');
  });
});

describe('how a run ends', () => {
  const entry = (state: 'succeeded' | 'partial' | 'failed' | 'skipped') => ({ state });
  it.each<[string, RunSources, string]>([
    ['everything succeeded', { a: entry('succeeded'), b: entry('succeeded') }, 'succeeded'],
    ['everything was skipped', { a: entry('skipped') }, 'succeeded'],
    ['succeeded and skipped', { a: entry('succeeded'), b: entry('skipped') }, 'succeeded'],
    ['everything attempted failed', { a: entry('failed'), b: entry('failed') }, 'failed'],
    ['a failure and a skip', { a: entry('failed'), b: entry('skipped') }, 'failed'],
    ['one failed, one succeeded', { a: entry('failed'), b: entry('succeeded') }, 'partial'],
    ['one source, partial', { a: entry('partial') }, 'partial'],
    ['partial and failed', { a: entry('partial'), b: entry('failed') }, 'partial'],
  ])('is %s -> %s', (_name, sources, expected) => {
    expect(runStateOf(sources)).toBe(expected);
  });

  it('reports a mixed run as partial, with each source as it ended', async () => {
    const t = setup([
      scriptedAdapter('codex', [fails()]),
      scriptedAdapter('claude', [succeeds({ imported: 5, duplicatesSkipped: 2 })]),
      scriptedAdapter('paseo', [partial({ unreadable: 3 })]),
      scriptedAdapter('github', [skips('GitHub isn’t connected.')]),
    ]);
    const run = await runAll(t);
    expect(run.state).toBe('partial');
    expect(run.sources['codex']).toMatchObject({ state: 'failed' });
    expect(run.sources['claude']).toMatchObject({
      state: 'succeeded',
      imported: 5,
      duplicatesSkipped: 2,
    });
    expect(run.sources['paseo']).toMatchObject({ state: 'partial', unreadable: 3 });
    expect(run.sources['github']).toMatchObject({
      state: 'skipped',
      message: 'GitHub isn’t connected.',
    });
    expect(run.finishedAt).not.toBeNull();
  });

  it('reports a retry that fails again as a failed run with that source failed', async () => {
    const t = setup([scriptedAdapter('codex', [fails()])]);
    const run = await runAll(t, ['codex']);
    expect(run.state).toBe('failed');
    expect(run.sources['codex']?.state).toBe('failed');
  });
});

describe('consecutive_failures', () => {
  it('is 0 after succeeded or partial and one more after each failed attempt, with last_attempt_* written alongside', async () => {
    const t = setup([
      scriptedAdapter('codex', [fails(), fails(), partial(), fails(), succeeds(), fails()]),
    ]);
    const seen: Array<[number, string | null, number | null, number | null]> = [];
    for (let i = 0; i < 6; i++) {
      t.tick(60_000);
      await runAll(t, ['codex']);
      const row = getSourceState(t.db, 'codex')!;
      seen.push([
        row.consecutiveFailures,
        row.lastAttemptResult,
        row.lastAttemptAt,
        row.lastSuccessAt,
      ]);
    }
    const at = (n: number) => T0 + n * 60_000;
    expect(seen).toEqual([
      [1, 'failed', at(1), null], // first failure: never a success yet
      [2, 'failed', at(2), null], // "failed again" starts here
      [0, 'partial', at(3), at(3)], // partial resets it and counts as data coming in
      [1, 'failed', at(4), at(3)], // the last success stays the last time data came in
      [0, 'succeeded', at(5), at(5)],
      [1, 'failed', at(6), at(5)],
    ]);
  });

  it('carries on from the stored count: the seeded failed source goes 1, 2, then 0 when Retry works', async () => {
    const db = memoryDb();
    seedDatabase(db, { scenario: 'refresh-failed' });
    expect(getSourceState(db, 'codex')).toMatchObject({ consecutiveFailures: 1, status: 'failed' });
    const codex = scriptedAdapter('codex', [fails(), succeeds({ imported: 4 })]);
    const t = setup([codex], { db });

    await runAll(t, ['codex']);
    expect(getSourceState(db, 'codex')).toMatchObject({
      consecutiveFailures: 2,
      status: 'failed',
      lastAttemptResult: 'failed',
      lastAttemptAt: T0,
    });

    await runAll(t, ['codex']);
    expect(getSourceState(db, 'codex')).toMatchObject({
      consecutiveFailures: 0,
      status: 'ok',
      lastAttemptResult: 'succeeded',
      errorCode: null,
      errorDetail: null,
    });
  });

  it('is not changed by a skipped source, whatever it was before', async () => {
    const t = setup([scriptedAdapter('codex', [skips('Nothing in its usual locations.')])]);
    recordAttempt(t.db, { sourceId: 'codex', result: 'failed', at: T0 - 5_000, status: 'failed' });
    recordAttempt(t.db, { sourceId: 'codex', result: 'failed', at: T0 - 1_000, status: 'failed' });
    const before = getSourceState(t.db, 'codex');
    expect(before?.consecutiveFailures).toBe(2);

    const run = await runAll(t, ['codex']);
    expect(run.sources['codex']?.state).toBe('skipped');
    expect(getSourceState(t.db, 'codex')).toEqual(before);

    // And a skipped source that was never recorded still has no row to show.
    const none = setup([scriptedAdapter('claude', [skips()])]);
    await runAll(none, ['claude']);
    expect(getSourceState(none.db, 'claude')).toBeNull();
  });

  it('leaves earlier rows alone when a source fails', async () => {
    const db = memoryDb();
    seedDatabase(db, { scenario: 'typical' });
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = ['session', 'usage_event', 'pull_request'].map(count);
    const t = setup([scriptedAdapter('codex', [fails()])], { db });
    await runAll(t, ['codex']);
    expect(['session', 'usage_event', 'pull_request'].map(count)).toEqual(before);
    expect(getSourceState(db, 'codex')).toMatchObject({ status: 'failed', consecutiveFailures: 1 });
  });
});

describe('an adapter that breaks', () => {
  it('is a failed attempt with a generic message: nothing the error said reaches the run or the stored row', async () => {
    const sentinel = 'SENTINEL_PROMPT the text of a transcript line';
    const t = setup([
      scriptedAdapter('codex', [new Error(sentinel)]),
      scriptedAdapter('claude', [succeeds()]),
    ]);
    const run = await runAll(t);
    expect(run.sources['codex']).toMatchObject({ state: 'failed' });
    // The other source in the same stage is not taken down with it.
    expect(run.sources['claude']?.state).toBe('succeeded');
    expect(run.state).toBe('partial');
    const row = getSourceState(t.db, 'codex')!;
    expect(row).toMatchObject({
      status: 'failed',
      consecutiveFailures: 1,
      errorCode: 'unexpected_error',
    });
    expect(JSON.stringify([run, row])).not.toContain('SENTINEL');
    expect(t.entries.some((e) => e['level'] === 'error' && e['source'] === 'codex')).toBe(true);
  });

  it('a result that cannot be saved is a failed entry, and the stored source stays exactly as it was', async () => {
    const t = setup([scriptedAdapter('codex', [succeeds({ imported: 9 })])]);
    recordAttempt(t.db, { sourceId: 'codex', result: 'failed', at: T0 - 1_000, status: 'failed' });
    const before = getSourceState(t.db, 'codex');
    t.db.exec(
      "CREATE TRIGGER no_write BEFORE UPDATE ON source_state BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const run = await runAll(t, ['codex']);
    expect(run.sources['codex']).toMatchObject({ state: 'failed' });
    expect(run.state).toBe('failed');
    // last_attempt_* and consecutive_failures move together or not at all.
    expect(getSourceState(t.db, 'codex')).toEqual(before);
    expect(t.entries.some((e) => e['code'] === 'record')).toBe(true);
  });
});

describe('one run at a time', () => {
  it('answers with the running id while a run is going, and starts a new one when it has ended', async () => {
    const held = gate();
    const t = setup([scriptedAdapter('codex', [holds(held, succeeds())])]);
    const first = t.runner.start({ trigger: 'manual', sources: ['codex'] });
    if (!first.started) throw new Error('expected the first start to run');

    const second = t.runner.start({ trigger: 'scheduler' });
    expect(second).toEqual({ started: false, runId: first.run.id });
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM refresh_run').get() as { n: number }).n).toBe(
      1,
    );

    held.release();
    await t.runner.idle();
    const third = t.runner.start({ trigger: 'manual', sources: ['codex'] });
    expect(third.started).toBe(true);
    if (third.started) expect(third.run.id).toBeGreaterThan(first.run.id);
    await t.runner.idle();
  });

  it('treats a run row left "running" by a process that is gone as running until boot marks it interrupted', async () => {
    const t = setup([scriptedAdapter('codex', [succeeds()])]);
    t.db
      .prepare(
        'INSERT INTO refresh_run (id, trigger, started_at, state, per_source_json) VALUES (9, \'manual\', 1, \'running\', \'{"codex":{"state":"running"}}\')',
      )
      .run();
    expect(t.runner.start({ trigger: 'manual' })).toEqual({ started: false, runId: 9 });
    markRunningRunsInterrupted(t.db, T0);
    expect(t.runner.start({ trigger: 'manual', sources: ['codex'] }).started).toBe(true);
    await t.runner.idle();
  });
});

describe('after the sources', () => {
  it('keeps a previous empty result fresh until an input changes during refresh', async () => {
    const hold = gate();
    const adapter = scriptedAdapter('codex', [holds(hold, succeeds())]);
    const t = setup([adapter], {
      afterSources: [{ name: 'links', rebuild: (id) => void recomputeLinks(t.db, t.clock(), id) }],
    });
    recomputeLinks(t.db, T0);
    expect(readLinkHealth(t.db).state).toBe('fresh');

    t.tick(1000);
    const started = t.runner.start({ trigger: 'manual', sources: ['codex'] });
    expect(started).toMatchObject({ started: true, run: { linkRebuild: 'pending' } });
    await adapter.called();
    expect(readLinkHealth(t.db).state).toBe('fresh');
    t.db.exec(`INSERT INTO session (provider, provider_session_id, kind, started_at, started_basis)
      VALUES ('codex', 'new', 'root', ${T0}, 'source_start')`);
    expect(readLinkHealth(t.db)).toEqual({
      state: 'stale',
      lastSuccessfulAt: new Date(T0).toISOString(),
    });
    hold.release();
    await t.runner.idle();
    expect(readLinkHealth(t.db)).toEqual({
      state: 'fresh',
      lastSuccessfulAt: new Date(t.clock()).toISOString(),
    });
  });

  it('runs the link and retention steps once the sources are done, even when every source failed, before the run finishes', async () => {
    const seen: Array<{ run: string; codex: string | undefined }> = [];
    const t = setup([scriptedAdapter('codex', [fails()])], {
      afterSources: [
        {
          name: 'links',
          rebuild: (runId) => {
            const run = getRun(t.db, 1)!;
            seen.push({ run: run.state, codex: run.sources['codex']?.state });
            recomputeLinks(t.db, T0, runId);
          },
        },
      ],
    });
    const run = await runAll(t, ['codex']);
    expect(seen).toEqual([{ run: 'running', codex: 'failed' }]);
    expect(run.state).toBe('failed');
    expect(run.linkRebuild).toBe('succeeded');
  });

  it('finishes as partial when a source succeeds but links could not be rebuilt', async () => {
    const afterSources = [
      {
        name: 'links' as const,
        rebuild: () => {
          throw new Error('recompute broke');
        },
      },
      { name: 'retention', run: vi.fn() },
    ];
    const t = setup([scriptedAdapter('codex', [succeeds()])], { afterSources });
    const run = await runAll(t, ['codex']);
    expect(run.state).toBe('partial');
    expect(run.linkRebuild).toBe('failed');
    expect(afterSources[1]!.run).toHaveBeenCalledOnce();
    expect(t.entries.some((e) => e['level'] === 'error' && e['step'] === 'links')).toBe(true);
  });
});

describe('no artificial delay', () => {
  it('finishes a run with no timer involved: fake timers never advance and the run still ends', async () => {
    vi.useFakeTimers();
    const t = setup(every([succeeds({ imported: 1 })]));
    const started = t.runner.start({ trigger: 'manual' });
    expect(vi.getTimerCount()).toBe(0);
    await t.runner.idle();
    expect(vi.getTimerCount()).toBe(0);
    if (started.started) expect(getRun(t.db, started.run.id)?.state).toBe('succeeded');
  });
});
