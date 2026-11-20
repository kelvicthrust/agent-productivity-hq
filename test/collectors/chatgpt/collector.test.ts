import { describe, expect, it } from 'vitest';
import { CHATGPT_MESSAGE } from '../../../src/server/collectors/chatgpt/collector.ts';
import { readObserved } from '../../../src/server/collectors/chatgpt/observed.ts';
import { createRunner } from '../../../src/server/collectors/runner.ts';
import {
  markChatgptDisconnected,
  readAccountSnapshot,
  readChatgptConnection,
  readDailyTokenSpan,
  readDailyTokens,
} from '../../../src/server/db/queries/accounts.ts';
import { getRun, listSourceStates } from '../../../src/server/db/queries/sources.ts';
import { chatgptStatus } from '../../../src/server/services/accounts.ts';
import { TZ } from '../../server/helpers.ts';
import {
  SENTINEL,
  codexSession,
  count,
  everything,
  nameOf,
  world,
  localEvent,
  NOW,
  DAY,
} from './helpers.ts';
import { loadScenario, withMethods } from './scripted.ts';

// G9_3 (the ChatGPT account collector) and G9_4 (Codex session names), on a scripted app-server and an in-memory database: what a
// read stores, what it never stores, what a failed read leaves alone, and that the child never outlives the attempt.

const NAME_COLUMNS = new Set(['recorded_name', 'name_source']);
const status = (w: ReturnType<typeof world>) => chatgptStatus(w.db, { now: NOW, timezone: TZ });

describe('a signed-in read', () => {
  it('stores the lifetime figure, the daily buckets and the percent windows, each with its own unit', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    const report = await w.refresh();
    expect(report).toEqual({ result: 'succeeded' });

    const snapshot = readAccountSnapshot(w.db, 'chatgpt');
    expect(snapshot.lifetimeTokens).toEqual({ value: 123456, fetchedAt: NOW });
    expect(snapshot.rateLimits).toEqual([
      {
        limitId: 'primary',
        usedPercent: 23,
        windowMinutes: 300,
        resetsAt: 1762432800000,
        fetchedAt: NOW,
      },
      {
        limitId: 'secondary',
        usedPercent: 41,
        windowMinutes: 10080,
        resetsAt: 1762857600000,
        fetchedAt: NOW,
      },
    ]);
    expect(
      readDailyTokens(w.db, 'chatgpt', '2026-11-01', '2026-11-07').map((b) => b.tokens),
    ).toEqual([100, 200, 300, 400, 500, 600, 700]);
    expect(
      w.db
        .prepare(
          'SELECT kind, unit, COUNT(*) AS n FROM account_snapshot GROUP BY kind, unit ORDER BY kind',
        )
        .all(),
    ).toEqual([
      { kind: 'lifetime_tokens', unit: 'tokens', n: 1 },
      { kind: 'rate_limit', unit: 'percent', n: 2 },
    ]);
    expect(readObserved(w.db)).toEqual({ state: 'ok', at: NOW });
    expect(status(w)).toMatchObject({ id: 'chatgpt', status: 'existing', via: 'codex' });
  });

  it('asks in order — initialize, initialized, account/read, usage, rate limits, thread/list — and never starts a sign-in or asks Codex to refresh', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    await w.refresh();
    const child = w.scripted.children[0]!;
    expect(child.methods()).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'account/usage/read',
      'account/rateLimits/read',
      'thread/list',
      'thread/list',
      'thread/list',
    ]);
    const params = (n: number) =>
      child.received.filter((m) => m.method === 'thread/list')[n]?.params;
    expect(child.received.find((m) => m.method === 'account/read')?.params).toEqual({
      refreshToken: false,
    });
    expect(params(0)).toEqual({ limit: 100, sourceKinds: [], archived: false });
    expect(params(1)).toEqual({ cursor: 'page-2', limit: 100, sourceKinds: [], archived: false });
    expect(params(2)).toEqual({ limit: 100, sourceKinds: [], archived: true });
    expect(child.methods()).not.toContain('account/login/start');
  });

  it('kills the child after the read, and waits at most 10 seconds for any call', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    await w.refresh();
    expect(w.scripted.children).toHaveLength(1);
    expect(w.scripted.children[0]?.killed).toBe(true);
    expect(Math.max(...w.scripted.children[0]!.waits)).toBeLessThanOrEqual(10_000);
    // A second attempt is a second child, killed too.
    await w.refresh();
    expect(w.scripted.children.map((c) => c.killed)).toEqual([true, true]);
  });

  it('stores nothing the app-server said beyond those figures: no e-mail, plan, streak, peak, preview, limit name or notice', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    codexSession(w.db, 'codex-thread-aaa');
    await w.refresh();
    const stored = everything(w.db);
    expect(stored).not.toMatch(SENTINEL);
    expect(stored).not.toMatch(/example\.com|plus|4242|currentStreak|longestStreak|peakDaily/);
    expect(JSON.stringify(w.logs.entries)).not.toMatch(SENTINEL);
  });

  it('logs no thread name and no message text, only counts', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    codexSession(w.db, 'codex-thread-aaa');
    await w.refresh();
    const logged = JSON.stringify(w.logs.entries);
    expect(logged).not.toContain('Fix the login redirect');
    expect(logged).toContain('codex thread names applied');
  });
});

describe('Codex session names', () => {
  it('names the sessions a thread matches, from the live and the archived list, and stores the name only', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    const aaa = codexSession(w.db, 'codex-thread-aaa');
    const bbb = codexSession(w.db, 'codex-thread-bbb');
    const ccc = codexSession(w.db, 'codex-thread-ccc');
    const ddd = codexSession(w.db, 'codex-thread-ddd');
    await w.refresh();
    expect(nameOf(w.db, aaa)).toEqual({ name: 'Fix the login redirect', source: 'provider_title' });
    expect(nameOf(w.db, ccc)).toEqual({ name: 'Rename the exporter', source: 'provider_title' });
    expect(nameOf(w.db, ddd)).toEqual({ name: 'Old archived work', source: 'provider_title' });
    // A thread nobody named leaves its session unnamed, and a thread with no session adds none.
    expect(nameOf(w.db, bbb)).toEqual({ name: null, source: null });
    expect(count(w.db, 'session')).toBe(4);
  });

  it("the provider's name replaces a name Paseo gave, and a later Paseo name never takes it back", async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    const id = codexSession(w.db, 'codex-thread-aaa', {
      recordedName: 'Paseo title',
      nameSource: 'paseo',
    });
    await w.refresh();
    expect(nameOf(w.db, id)).toEqual({ name: 'Fix the login redirect', source: 'provider_title' });
    // The importer upserts the session again with a Paseo name: the provider's stays.
    codexSession(w.db, 'codex-thread-aaa');
    expect(nameOf(w.db, id).name).toBe('Fix the login redirect');
  });

  it('stores no preview text anywhere, and nothing else of a thread', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    for (const id of [
      'codex-thread-aaa',
      'codex-thread-bbb',
      'codex-thread-ccc',
      'codex-thread-ddd',
    ]) {
      codexSession(w.db, id);
    }
    const before = JSON.stringify(w.db.prepare('SELECT * FROM session ORDER BY id').all());
    await w.refresh();
    const after = w.db.prepare('SELECT * FROM session ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    expect(everything(w.db)).not.toMatch(/PREVIEW|please fix|archived work preview/i);
    // Only name columns changed: every other column of every session is as it was.
    const strip = (rows: Record<string, unknown>[]) =>
      JSON.stringify(
        rows.map((row) =>
          Object.fromEntries(Object.entries(row).filter(([key]) => !NAME_COLUMNS.has(key))),
        ),
      );
    expect(strip(after)).toBe(strip(JSON.parse(before) as Record<string, unknown>[]));
  });

  it('is read even when Codex is signed out or has an API key, because the threads are this machine’s own', async () => {
    const w = world(loadScenario('signed-out'));
    const id = codexSession(w.db, 'codex-thread-aaa');
    const report = await w.refresh();
    expect(report).toEqual({ result: 'skipped', message: CHATGPT_MESSAGE.signedOut });
    expect(nameOf(w.db, id).name).toBe('Fix the login redirect');
  });

  it('a thread list that cannot be read makes the attempt partial and keeps the account figures', async () => {
    // signed-in.json has no thread/list, so the app-server answers "method not found".
    const w = world(loadScenario('signed-in'));
    const report = await w.refresh();
    expect(report).toEqual({ result: 'partial', message: CHATGPT_MESSAGE.namesMissed });
    expect(readAccountSnapshot(w.db, 'chatgpt').lifetimeTokens?.value).toBe(123456);
  });

  it('stops at a cursor the app-server repeats instead of reading the same page forever', async () => {
    const page = { result: { data: [{ id: 'codex-thread-aaa', name: 'A' }], nextCursor: 'same' } };
    const w = world(
      withMethods(loadScenario('chatgpt-with-threads'), { 'thread/list': { sequence: [page] } }),
    );
    await w.refresh();
    // live list: page 1 (no cursor), page 2 (cursor "same"), then the repeat is seen and it stops; archived: the same.
    const calls = w.scripted.children[0]!.methods().filter((m) => m === 'thread/list').length;
    expect(calls).toBeLessThanOrEqual(5);
  });
});

describe('percent-only and null-bucket reports', () => {
  it('null buckets clear the stored sum, keep the percent windows and the lifetime figure, and say so', async () => {
    const first = world(loadScenario('chatgpt-with-threads'));
    await first.refresh();
    expect(readDailyTokenSpan(first.db, 'chatgpt')?.days).toBe(7);

    const second = world(loadScenario('buckets-null'), { db: first.db });
    second.clock.now = NOW + 60_000;
    await second.refresh();
    expect(readDailyTokenSpan(first.db, 'chatgpt')).toBeNull();
    const snapshot = readAccountSnapshot(first.db, 'chatgpt');
    expect(snapshot.rateLimits.map((r) => [r.limitId, r.usedPercent, r.windowMinutes])).toEqual([
      ['primary', 23, 300],
      ['secondary', 41, 10080],
    ]);
    expect(snapshot.lifetimeTokens?.value).toBe(123456);
  });

  it('a window the account stops reporting is removed, so the newest report is the truth', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    await w.refresh();
    const fewer = world(
      withMethods(loadScenario('chatgpt-with-threads'), {
        'account/rateLimits/read': {
          result: {
            rateLimits: {
              primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1762500000 },
            },
          },
        },
      }),
      { db: w.db },
    );
    await fewer.refresh();
    expect(
      readAccountSnapshot(w.db, 'chatgpt').rateLimits.map((r) => [r.limitId, r.usedPercent]),
    ).toEqual([['primary', 50]]);
  });

  it('drops malformed buckets and windows, counts them, and still stores the good ones', async () => {
    const w = world(loadScenario('buckets-messy'));
    const report = await w.refresh();
    expect(report).toMatchObject({ result: 'partial', unreadable: 7 });
    expect(readDailyTokens(w.db, 'chatgpt', '2026-01-01', '2026-12-31')).toEqual([
      { date: '2026-11-02', tokens: 25, fetchedAt: NOW },
      { date: '2026-11-03', tokens: 30, fetchedAt: NOW },
    ]);
    expect(readAccountSnapshot(w.db, 'chatgpt').rateLimits.map((r) => r.limitId)).toEqual([
      'primary',
      'tertiary',
    ]);
  });
});

describe('what an account figure never reaches', () => {
  it('leaves usage events, session totals, repo rows and links exactly as they were (P-35 to P-38)', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    const id = codexSession(w.db, 'codex-thread-aaa');
    localEvent(w.db, id, NOW - DAY, 60);
    const tables = [
      'usage_event',
      'repo',
      'pull_request',
      'pr_session_link',
      'owner_link_decision',
      'session_ref',
    ];
    const dump = () => tables.map((t) => JSON.stringify(w.db.prepare(`SELECT * FROM ${t}`).all()));
    const before = dump();
    await w.refresh();
    expect(dump()).toEqual(before);
    expect(count(w.db, 'session')).toBe(1);
  });
});

describe('when the read cannot be completed', () => {
  async function withReport() {
    const first = world(loadScenario('chatgpt-with-threads'));
    await first.refresh();
    return first;
  }

  it('a call that is not answered makes the attempt partial: the other half is current, the missed half keeps its last figures', async () => {
    const first = await withReport();
    const w = world(loadScenario('usage-silent'), { db: first.db });
    w.clock.now = NOW + 60_000;
    const report = await w.refresh();
    expect(report).toEqual({ result: 'partial', message: CHATGPT_MESSAGE.usageMissed });
    // The silent usage read left its last totals; the windows were read again.
    expect(readDailyTokenSpan(w.db, 'chatgpt')?.days).toBe(7);
    expect(readAccountSnapshot(w.db, 'chatgpt').rateLimits[0]?.fetchedAt).toBe(NOW + 60_000);
    expect(readAccountSnapshot(w.db, 'chatgpt').lifetimeTokens?.fetchedAt).toBe(NOW);
    expect(w.scripted.children[0]?.killed).toBe(true);
    // A child that stopped answering is not asked for names as well.
    expect(w.scripted.children[0]?.methods()).not.toContain('thread/list');
  });

  it('both reads missed is a failed attempt that keeps the last report, and the card says "last report"', async () => {
    const first = await withReport();
    const w = world(loadScenario('crash'), { db: first.db });
    w.clock.now = NOW + 60_000;
    const report = await w.refresh();
    expect(report).toMatchObject({
      result: 'failed',
      errorCode: 'appserver_closed',
      errorDetail: CHATGPT_MESSAGE.closed,
    });
    expect(readDailyTokenSpan(w.db, 'chatgpt')?.days).toBe(7);
    expect(readAccountSnapshot(w.db, 'chatgpt').rateLimits).toHaveLength(2);
    expect(w.scripted.children[0]?.killed).toBe(true);
    expect(readObserved(w.db)?.state).toBe('failed');
    expect(chatgptStatus(w.db, { now: NOW, timezone: TZ })).toMatchObject({
      status: 'failed',
      statusText: expect.stringMatching(/^Couldn’t update; last report Nov 4, 12:00 PM$/),
    });
  });

  it('an error that sounds like a refused sign-in asks to reconnect, without keeping the provider’s sentence', async () => {
    const w = world(loadScenario('auth-error'));
    const report = await w.refresh();
    expect(report).toMatchObject({ result: 'failed', errorCode: 'reconnect_needed' });
    expect(JSON.stringify(report)).not.toMatch(SENTINEL);
    expect(everything(w.db)).not.toMatch(SENTINEL);
    expect(JSON.stringify(w.logs.entries)).not.toMatch(SENTINEL);
    expect(status(w)).toMatchObject({ status: 'reconnect', via: 'codex' });
  });

  it('a program that cannot be started is a failed attempt that logs the system code and nothing else', async () => {
    const w = world(loadScenario('signed-in'), { failWith: 'EACCES' });
    const report = await w.refresh();
    expect(report).toMatchObject({ result: 'failed', errorCode: 'appserver_error' });
    expect(w.logs.entries.find((e) => e['code'] === 'appserver_start_failed')).toMatchObject({
      source: 'chatgpt_account',
      reason: 'error',
      errno: 'EACCES',
    });
  });

  it('the first read of an account that was never read leaves nothing stored when it fails', async () => {
    const w = world(loadScenario('crash'));
    await w.refresh();
    expect(count(w.db, 'account_snapshot')).toBe(0);
    expect(count(w.db, 'account_daily_tokens')).toBe(0);
  });
});

describe('when there is nothing to read', () => {
  it('Codex with an API key reports no usage here: skipped, no usage calls, card Unavailable', async () => {
    const w = world(loadScenario('api-key'));
    const report = await w.refresh();
    expect(report).toEqual({ result: 'skipped', message: CHATGPT_MESSAGE.unsupported });
    expect(w.scripted.children[0]?.methods()).not.toContain('account/usage/read');
    expect(w.scripted.children[0]?.killed).toBe(true);
    expect(status(w)).toMatchObject({ status: 'unavailable', reason: 'unsupported_sign_in' });
    expect(count(w.db, 'account_snapshot')).toBe(0);
  });

  it('Codex signed out: skipped, card Not connected', async () => {
    const w = world(loadScenario('signed-out'));
    expect(await w.refresh()).toMatchObject({ result: 'skipped' });
    expect(status(w)).toMatchObject({ status: 'notconnected', reason: 'signed_out' });
  });

  it('no codex on this machine: skipped, nothing started, card Unavailable: Codex CLI not found', async () => {
    const w = world(null);
    expect(await w.refresh()).toEqual({ result: 'skipped', message: CHATGPT_MESSAGE.noCodex });
    expect(w.scripted.children).toHaveLength(0);
    expect(status(w)).toMatchObject({
      status: 'unavailable',
      statusText: 'Unavailable: Codex CLI not found',
      reason: 'codex_not_found',
    });
  });

  it('after Disconnect the app-server is not started at all, and what was imported stays', async () => {
    const w = world(loadScenario('chatgpt-with-threads'));
    await w.refresh();
    markChatgptDisconnected(w.db);
    const report = await w.refresh();
    expect(report).toEqual({ result: 'skipped', message: CHATGPT_MESSAGE.disconnected });
    expect(w.scripted.launches()).toBe(1);
    expect(readChatgptConnection(w.db).disconnected).toBe(true);
    expect(readDailyTokenSpan(w.db, 'chatgpt')?.days).toBe(7);
  });
});

describe('as stage 4 of a run', () => {
  it('a skipped attempt records nothing, a failed one counts, a good one resets the count', async () => {
    const run = async (
      scenario: ReturnType<typeof loadScenario> | null,
      db?: ReturnType<typeof world>['db'],
    ) => {
      const w = world(scenario, db === undefined ? {} : { db });
      const runner = createRunner({
        db: w.db,
        now: w.now,
        logger: w.logs.logger,
        adapters: [w.adapter],
      });
      const started = runner.start({ trigger: 'manual', sources: ['chatgpt_account'] });
      await runner.idle();
      if (!started.started) throw new Error('not started');
      return { db: w.db, run: getRun(w.db, started.run.id) };
    };
    const failures = (db: ReturnType<typeof world>['db']) =>
      listSourceStates(db).find((s) => s.sourceId === 'chatgpt_account');

    const skipped = await run(null);
    expect(skipped.run?.sources['chatgpt_account']?.state).toBe('skipped');
    expect(failures(skipped.db)).toBeUndefined();

    const failed = await run(loadScenario('crash'), skipped.db);
    expect(failed.run?.sources['chatgpt_account']?.state).toBe('failed');
    expect(failures(failed.db)).toMatchObject({
      consecutiveFailures: 1,
      lastAttemptResult: 'failed',
    });

    const good = await run(loadScenario('chatgpt-with-threads'), failed.db);
    expect(good.run?.sources['chatgpt_account']?.state).toBe('succeeded');
    expect(failures(good.db)).toMatchObject({ consecutiveFailures: 0 });
  });
});
