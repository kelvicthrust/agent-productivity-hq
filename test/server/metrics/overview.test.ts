import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  markChatgptConnected,
  markChatgptDisconnected,
  recordFailedChatgptRead,
  saveChatgptRateLimits,
  saveChatgptTokens,
} from '../../../src/server/db/queries/accounts.ts';
import {
  addDecision,
  addEvent,
  addLink,
  addMergedPr,
  addRepo,
  addSession,
  addSource,
  at,
  connectAs,
  get,
  memoryDb,
  metricsApp,
  overview,
  type MetricsApp,
} from './helpers.ts';

// GET /api/overview: the KPI definitions of TECH › Critical logic, the coverage strip, the repository table and the recent merges.
// The clock is Wednesday 2026-11-04 12:00 in Los Angeles; the default period is that week.

const API = 'kelvin/atlas-api';
const WEB = 'kelvin/atlas-web';
const WEEK = '?start=2026-11-02&end=2026-11-08';

/** Both sources found from 2026-01-01 and two active, reachable repos; the owner is `kelvin`. */
function world() {
  const db = memoryDb();
  addRepo(db, API);
  addRepo(db, WEB);
  addSource(db, 'codex');
  addSource(db, 'claude');
  connectAs(db, 'kelvin');
  return db;
}

const day = (date: string, time = '10:00') => at(date, time);

describe('Merged PRs', () => {
  it('counts the distinct merged PRs of the period in tracked, reachable repos by the author rule', async () => {
    const db = world();
    addRepo(db, 'kelvin/stopped', { tracking: 'stopped' });
    addRepo(db, 'kelvin/gone', { access: 'inaccessible' });
    addMergedPr(db, API, 1, day('2026-11-02'), 'kelvin');
    addMergedPr(db, WEB, 1, day('2026-11-03'), 'KELVIN'); // the login is compared without case
    addMergedPr(db, API, 2, day('2026-11-03'), 'priya-s'); // someone else's, though kelvin merged it
    addMergedPr(db, 'kelvin/stopped', 1, day('2026-11-03'), 'kelvin');
    addMergedPr(db, 'kelvin/gone', 1, day('2026-11-03'), 'kelvin');
    addMergedPr(db, API, 3, day('2026-10-31', '23:59'), 'kelvin'); // the day before the period
    const app = metricsApp(db);

    const mine = await overview(app, WEEK);
    expect(mine.kpis.mergedPrs).toMatchObject({ value: 2, delivery: 'ok' });
    expect(mine.periodMergedCount).toBe(2);
    const all = await overview(app, `${WEEK}&author=all`);
    expect(all.kpis.mergedPrs?.value).toBe(3);
    expect(all.periodMergedCount).toBe(3);
    const web = await overview(app, `${WEEK}&author=all&repos=${WEB}`);
    expect(web.kpis.mergedPrs?.value).toBe(1);
  });

  it('puts a merge at 23:59 local in its own day and one at 00:00 in the next', async () => {
    const db = world();
    addMergedPr(db, API, 1, day('2026-11-02', '23:59'));
    addMergedPr(db, API, 2, day('2026-11-03', '00:00'));
    const app = metricsApp(db);
    expect((await overview(app, '?start=2026-11-02&end=2026-11-02')).kpis.mergedPrs?.value).toBe(1);
    expect((await overview(app, '?start=2026-11-03&end=2026-11-03')).kpis.mergedPrs?.value).toBe(1);
  });

  it('compares with the previous period of equal length and names it', async () => {
    const db = world();
    addMergedPr(db, API, 1, day('2026-10-28'));
    addMergedPr(db, API, 2, day('2026-10-29'));
    addMergedPr(db, API, 3, day('2026-11-03'));
    const app = metricsApp(db);

    expect((await overview(app, WEEK)).kpis.mergedPrs?.previous).toEqual({
      label: 'Last week',
      value: 2,
      outsideLookback: false,
    });
    expect(
      (await overview(app, '?start=2026-11-04&end=2026-11-04')).kpis.mergedPrs?.previous,
    ).toEqual({
      label: 'Yesterday',
      value: 1,
      outsideLookback: false,
    });
    expect(
      (await overview(app, '?start=2026-11-03&end=2026-11-03')).kpis.mergedPrs?.previous?.label,
    ).toBe('Previous day');
    expect(
      (await overview(app, '?start=2026-10-06&end=2026-11-04')).kpis.mergedPrs?.previous,
    ).toMatchObject({
      label: 'Previous 30 days',
      value: 0,
    });
    // a Monday-to-Sunday week is "Last week"; seven other days are not
    expect(
      (await overview(app, '?start=2026-11-01&end=2026-11-07')).kpis.mergedPrs?.previous?.label,
    ).toBe('Previous 7 days');
  });

  it('says the comparison is outside the 12-month lookback rather than showing a partial count', async () => {
    const db = world();
    addMergedPr(db, API, 1, day('2025-11-10'));
    const app = metricsApp(db);
    // the previous period of a full year reaches back before 2025-11-04
    expect(
      (await overview(app, '?start=2025-11-04&end=2026-11-04')).kpis.mergedPrs?.previous,
    ).toEqual({
      label: 'Previous 366 days',
      value: null,
      outsideLookback: true,
    });
    // a period that starts a day after the lookback does too
    expect(
      (await overview(app, '?start=2025-11-05&end=2026-11-04')).kpis.mergedPrs?.previous
        ?.outsideLookback,
    ).toBe(true);
  });

  it('is null, with no comparison, when no repo is tracked or the period has not started', async () => {
    const db = memoryDb();
    addSource(db, 'codex');
    const app = metricsApp(db);
    const none = await overview(app, WEEK);
    expect(none.kpis.mergedPrs).toEqual({ value: null, delivery: 'none' });
    expect(none.kpis.linkedPrs).toEqual({ value: null, of: null });
    expect(none.trueZero).toBe(false);

    const future = await overview(metricsApp(world()), '?start=2026-11-05&end=2026-11-08');
    expect(future.kpis.mergedPrs).toEqual({ value: null, delivery: 'future' });
  });

  it('counts what is stored so far while a repo is still on its first backfill', async () => {
    const db = memoryDb();
    addRepo(db, API, { backfill: false });
    connectAs(db, 'kelvin');
    addMergedPr(db, API, 1, day('2026-11-03'));
    const { kpis, trueZero } = await overview(metricsApp(db), WEEK);
    expect(kpis.mergedPrs).toMatchObject({ value: 1, delivery: 'syncing' });
    expect(trueZero).toBe(false);
  });
});

describe('Linked PRs', () => {
  /** Eight PRs, one per link situation, merged an hour apart (PR 8 is the newest). */
  function links() {
    const db = world();
    const codex = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    const claude = addSession(db, {
      id: 2,
      provider: 'claude',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    const pr = (n: number) =>
      addMergedPr(db, API, n, day('2026-11-02', `${String(8 + n).padStart(2, '0')}:00`));
    const prs = [1, 2, 3, 4, 5, 6, 7, 8].map(pr);
    addLink(db, prs[0]!, codex, 'evidence'); // 1 evidence
    addLink(db, prs[1]!, codex, 'suggested'); // 2 suggested only
    addDecision(db, prs[2]!, claude, 'confirmed'); // 3 owner: a link the owner added by hand
    addLink(db, prs[3]!, codex, 'evidence'); // 4 evidence marked incorrect
    addDecision(db, prs[3]!, codex, 'rejected');
    addLink(db, prs[4]!, codex, 'suggested'); // 5 suggestion dismissed
    addDecision(db, prs[4]!, codex, 'dismissed');
    addLink(db, prs[5]!, codex, 'evidence'); // 6 two evidence sessions: one PR
    addLink(db, prs[5]!, claude, 'evidence');
    addLink(db, prs[6]!, codex, 'evidence'); // 7 evidence plus a suggestion: evidence wins
    addLink(db, prs[6]!, claude, 'suggested');
    // 8 no link at all
    return metricsApp(db);
  }

  it('counts the PRs whose strongest effective link is evidence or owner, once each', async () => {
    const { kpis } = await overview(links(), WEEK);
    expect(kpis.linkedPrs).toEqual({ value: 4, of: 8, suggestedOnly: 1 });
  });

  it('is 0 of the merged PRs while no link exists (until the link engine, M8)', async () => {
    const db = world();
    addMergedPr(db, API, 1, day('2026-11-03'));
    addMergedPr(db, API, 2, day('2026-11-03'));
    const { kpis } = await overview(metricsApp(db), WEEK);
    expect(kpis.linkedPrs).toEqual({ value: 0, of: 2, suggestedOnly: 0 });
  });

  it('gives each PR in the recent list its class, link counts and providers', async () => {
    const { recentPrs } = await overview(links(), WEEK);
    expect(
      recentPrs.map((p) => [
        p.number,
        p.linkClass,
        p.linkedSessionCount,
        p.suggestedCount,
        p.providers,
      ]),
    ).toEqual([
      [8, 'unlinked', 0, 0, []],
      [7, 'evidence', 1, 1, ['codex', 'claude']],
      [6, 'evidence', 2, 0, ['codex', 'claude']],
      [5, 'unlinked', 0, 0, []],
      [4, 'unlinked', 0, 0, []],
      [3, 'owner', 1, 0, ['claude']],
    ]);
  });
});

describe('Recorded local tokens', () => {
  it('sums each provider on its own and never adds them', async () => {
    const db = world();
    const codex = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    const claude = addSession(db, {
      id: 2,
      provider: 'claude',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    addEvent(db, {
      session: codex,
      at: day('2026-11-02'),
      input: 100,
      cached: 60,
      output: 20,
      reasoning: 5,
    });
    addEvent(db, {
      session: claude,
      at: day('2026-11-03'),
      input: 10,
      cacheWrite: 5,
      cacheRead: 30,
      output: 5,
    });
    addEvent(db, { session: claude, at: day('2026-11-01'), input: 99_999 }); // before the period
    const { kpis } = await overview(metricsApp(db), WEEK);
    expect(kpis.localTokens).toEqual({
      codex: { coverage: 'ok', value: 120, note: null, coveredFrom: null },
      claude: { coverage: 'ok', value: 50, note: null, coveredFrom: null },
    });
  });

  it('names the date a partly covered provider starts from', async () => {
    const db = memoryDb();
    addRepo(db, API);
    addSource(db, 'codex', { oldest: day('2026-11-03') });
    addSource(db, 'claude');
    const codex = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: API,
      startedAt: day('2026-11-03'),
    });
    addEvent(db, { session: codex, at: day('2026-11-03'), input: 8 });
    const { kpis } = await overview(metricsApp(db), WEEK);
    expect(kpis.localTokens?.codex).toEqual({
      coverage: 'partial',
      value: 8,
      note: 'From <date> only',
      coveredFrom: '2026-11-03',
    });
    expect(kpis.localTokens?.claude?.note).toBeNull();
    expect(kpis.localTokens?.claude?.coveredFrom).toBeNull();
  });

  it('keeps the cached total but says recent days are missing after a failed refresh', async () => {
    const db = memoryDb();
    addRepo(db, API);
    addSource(db, 'codex', { result: 'failed', success: day('2026-11-02', '18:00') });
    const codex = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    addEvent(db, { session: codex, at: day('2026-11-02'), input: 8 });
    const { kpis } = await overview(metricsApp(db), WEEK);
    expect(kpis.localTokens?.codex).toEqual({
      coverage: 'stale',
      value: 8,
      note: 'Cached; recent days missing',
      coveredFrom: null,
    });
  });

  it('has no value, not a zero, for history nobody holds or a source that was never found', async () => {
    const db = memoryDb();
    addRepo(db, API);
    addSource(db, 'codex', { oldest: day('2026-11-04') });
    const app = metricsApp(db);
    const { kpis } = await overview(app, '?start=2026-10-26&end=2026-11-01');
    expect(kpis.localTokens?.codex).toEqual({
      coverage: 'unavailable',
      value: null,
      note: null,
      coveredFrom: null,
    });
    expect(kpis.localTokens?.claude).toEqual({
      coverage: 'none',
      value: null,
      note: null,
      coveredFrom: null,
    });
    // and nothing to count sessions from either
    expect(kpis.rootSessions).toEqual({ value: null });
    expect(kpis.childAgents).toEqual({ value: null });
  });

  it('follows the provider filter: only the providers in scope have a figure', async () => {
    const app = metricsApp(world());
    const { kpis } = await overview(app, `${WEEK}&provider=claude`);
    expect(Object.keys(kpis.localTokens ?? {})).toEqual(['claude']);
  });
});

describe('Root sessions and child agents', () => {
  function sessions() {
    const db = world();
    const rootA = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    const rootB = addSession(db, {
      id: 2,
      provider: 'claude',
      repo: WEB,
      startedAt: day('2026-10-01'),
    });
    const idle = addSession(db, {
      id: 3,
      provider: 'claude',
      repo: API,
      startedAt: day('2026-10-01'),
    });
    addSession(db, {
      id: 4,
      provider: 'claude',
      kind: 'child',
      parent: rootB,
      basis: 'native',
      repo: WEB,
      startedAt: day('2026-11-02'),
    });
    addSession(db, {
      id: 5,
      provider: 'codex',
      kind: 'child',
      parent: rootA,
      basis: 'paseo',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    addSession(db, {
      id: 6,
      provider: 'codex',
      kind: 'child',
      parent: rootA,
      basis: 'paseo',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    addSession(db, {
      id: 7,
      provider: 'codex',
      kind: 'child',
      parent: null,
      repo: API,
      startedAt: day('2026-11-02'),
    }); // no known parent
    addSession(db, {
      id: 8,
      provider: 'claude',
      kind: 'unknown',
      repo: null,
      startedAt: day('2026-11-02'),
    });
    // rootA resumes: two events in the period count it once; rootB resumes inside the period; idle has none inside it
    addEvent(db, { session: rootA, at: day('2026-11-02'), input: 1 });
    addEvent(db, { session: rootA, at: day('2026-11-03'), input: 1 });
    addEvent(db, { session: rootB, at: day('2026-11-03'), input: 1 });
    addEvent(db, { session: idle, at: day('2026-10-20'), input: 1 });
    for (const id of [4, 5, 6, 7, 8])
      addEvent(db, { session: id, at: day('2026-11-03'), input: 1 });
    return metricsApp(db);
  }

  it('counts distinct roots with an event in the period, and children split into Paseo and native', async () => {
    const { kpis } = await overview(sessions(), WEEK);
    expect(kpis.rootSessions).toMatchObject({ value: 2, unknownRelationship: 1 });
    expect(kpis.rootSessions?.crew?.slice().sort()).toEqual(['claude', 'codex']);
    expect(kpis.childAgents).toMatchObject({ value: 3, paseo: 2, native: 1 });
    expect(kpis.childAgents?.crew?.slice().sort()).toEqual(['claude', 'codex', 'codex']);
  });

  it('follows the provider and repo filters', async () => {
    const app = sessions();
    const codex = await overview(app, `${WEEK}&provider=codex`);
    expect(codex.kpis.rootSessions).toMatchObject({
      value: 1,
      unknownRelationship: 0,
      crew: ['codex'],
    });
    expect(codex.kpis.childAgents).toMatchObject({ value: 2, paseo: 2, native: 0 });
    const web = await overview(app, `${WEEK}&repos=${WEB}`);
    expect(web.kpis.rootSessions).toMatchObject({ value: 1, unknownRelationship: 0 });
    expect(web.kpis.childAgents).toMatchObject({ value: 1, paseo: 0, native: 1 });
  });

  it('draws at most ten buddies however many sessions there are', async () => {
    const db = world();
    for (let id = 1; id <= 14; id++) {
      const session = addSession(db, {
        id,
        provider: id % 2 ? 'codex' : 'claude',
        repo: API,
        startedAt: day('2026-11-02'),
      });
      addEvent(db, { session, at: day('2026-11-03'), input: 1 });
    }
    const { kpis } = await overview(metricsApp(db), WEEK);
    expect(kpis.rootSessions?.value).toBe(14);
    expect(kpis.rootSessions?.crew).toHaveLength(10);
  });
});

describe('the repository table', () => {
  function table() {
    const db = world();
    addRepo(db, 'kelvin/gone', { access: 'inaccessible' });
    addRepo(db, 'kelvin/stopped', { tracking: 'stopped' });
    addRepo(db, 'kelvin/idle');
    const codex = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    const claude = addSession(db, {
      id: 2,
      provider: 'claude',
      repo: API,
      startedAt: day('2026-11-02'),
    });
    const gone = addSession(db, {
      id: 3,
      provider: 'codex',
      repo: 'kelvin/gone',
      startedAt: day('2026-11-02'),
    });
    const untracked = addSession(db, {
      id: 4,
      provider: 'claude',
      repo: 'kelvin/stopped',
      startedAt: day('2026-11-02'),
    });
    const unknown = addSession(db, {
      id: 5,
      provider: 'codex',
      repo: null,
      startedAt: day('2026-11-02'),
    });
    for (const [session, input] of [
      [codex, 100],
      [claude, 10],
      [gone, 7],
      [untracked, 5],
      [unknown, 3],
    ] as const) {
      addEvent(db, { session, at: day('2026-11-03'), input });
    }
    const pr = addMergedPr(db, API, 1, day('2026-11-03'));
    addMergedPr(db, API, 2, day('2026-11-03'));
    addMergedPr(db, 'kelvin/gone', 1, day('2026-11-03'));
    addLink(db, pr, codex, 'evidence');
    return metricsApp(db);
  }

  it('lists every tracked repo, then the usage-only groups', async () => {
    const { repoRows } = await overview(table(), WEEK);
    expect(repoRows).toEqual([
      {
        group: 'tracked',
        repo: API,
        accessState: 'ok',
        mergedPrs: 2,
        linkedPrs: 1,
        tokens: { codex: 100, claude: 10 },
        rootSessions: 2,
      },
      {
        group: 'tracked',
        repo: WEB,
        accessState: 'ok',
        mergedPrs: 0,
        linkedPrs: 0,
        tokens: { codex: 0, claude: 0 },
        rootSessions: 0,
      },
      {
        group: 'tracked',
        repo: 'kelvin/gone',
        accessState: 'inaccessible',
        mergedPrs: null,
        linkedPrs: null,
        tokens: { codex: 7, claude: 0 },
        rootSessions: 1,
      },
      {
        group: 'tracked',
        repo: 'kelvin/idle',
        accessState: 'ok',
        mergedPrs: 0,
        linkedPrs: 0,
        tokens: { codex: 0, claude: 0 },
        rootSessions: 0,
      },
      {
        group: 'untracked',
        repo: null,
        mergedPrs: null,
        linkedPrs: null,
        tokens: { codex: 0, claude: 5 },
        rootSessions: 1,
      },
      {
        group: 'unknown',
        repo: null,
        mergedPrs: null,
        linkedPrs: null,
        tokens: { codex: 3, claude: 0 },
        rootSessions: 1,
      },
    ]);
  });

  it('drops the usage-only groups, and the other repos, when a repo filter is set', async () => {
    const { repoRows } = await overview(table(), `${WEEK}&repos=${API}`);
    expect(repoRows.map((row) => [row.group, row.repo])).toEqual([['tracked', API]]);
  });

  it('shows only the providers in scope, and a null where that provider has no covered dates', async () => {
    const app = table();
    const claude = await overview(app, `${WEEK}&provider=claude`);
    expect(claude.repoRows[0]!.tokens).toEqual({ claude: 10 });

    const db = memoryDb();
    addRepo(db, API);
    addSource(db, 'codex');
    const none = await overview(metricsApp(db), WEEK);
    expect(none.repoRows).toEqual([
      {
        group: 'tracked',
        repo: API,
        accessState: 'ok',
        mergedPrs: 0,
        linkedPrs: 0,
        tokens: { codex: 0, claude: null },
        rootSessions: 0,
      },
    ]);
  });

  it('is empty when nothing is tracked and nothing was recorded', async () => {
    const { repoRows, recentPrs } = await overview(metricsApp(memoryDb()), WEEK);
    expect(repoRows).toEqual([]);
    expect(recentPrs).toEqual([]);
  });
});

describe('recently merged', () => {
  it('lists the six newest merges of the period, newest first', async () => {
    const db = world();
    for (let n = 1; n <= 9; n++)
      addMergedPr(db, API, n, day('2026-11-02', `${String(8 + n).padStart(2, '0')}:00`));
    addMergedPr(db, API, 99, day('2026-10-30')); // before the period
    const { recentPrs, periodMergedCount } = await overview(metricsApp(db), WEEK);
    expect(recentPrs.map((p) => p.number)).toEqual([9, 8, 7, 6, 5, 4]);
    expect(periodMergedCount).toBe(9);
    expect(recentPrs[0]).toMatchObject({
      repo: API,
      url: `https://github.com/${API}/pull/9`,
      author: 'kelvin',
      authoredByMe: true,
    });
  });

  it('marks a PR somebody else wrote when all authors are shown', async () => {
    const db = world();
    addMergedPr(db, API, 1, day('2026-11-03'), 'dependabot[bot]');
    const { recentPrs } = await overview(metricsApp(db), `${WEEK}&author=all`);
    expect(recentPrs[0]).toMatchObject({ author: 'dependabot[bot]', authoredByMe: false });
  });
});

describe('coverage and accounts', () => {
  function sourced() {
    const db = world();
    addRepo(db, 'kelvin/gone', { access: 'inaccessible' });
    addRepo(db, 'kelvin/stopped', { tracking: 'stopped' });
    db.prepare("UPDATE source_state SET last_attempt_at = ? WHERE source_id = 'codex'").run(
      Date.parse('2026-11-04T18:00:00Z'),
    );
    db.prepare("UPDATE source_state SET last_attempt_at = ? WHERE source_id = 'claude'").run(
      Date.parse('2026-11-04T19:30:00Z'),
    );
    return db;
  }

  it('describes the machine: sources, tracked and inaccessible repos, and no connected account while none has been read', async () => {
    const { coverage, accounts } = await overview(metricsApp(sourced()), WEEK);
    expect(coverage.sources?.map((s) => [s.id, s.status])).toEqual([
      ['codex', 'ok'],
      ['claude', 'ok'],
    ]);
    expect(coverage.github).toEqual({ tracked: 3, inaccessible: 1 }); // stopped is not tracked; inaccessible is tracked but unreadable
    expect(coverage.accounts).toEqual([
      {
        id: 'chatgpt',
        name: 'ChatGPT',
        status: 'notconnected',
        statusText: 'Not connected',
        via: null,
      },
      {
        id: 'claude',
        name: 'Claude',
        status: 'notconnected',
        statusText: 'Plan limits haven’t been checked',
        via: null,
        planLimits: { state: 'unchecked', lastCheckedAt: null, retryAt: null, report: null },
      },
    ]);
    expect(coverage.lastRefreshAt).toBe('2026-11-04T19:30:00.000Z');
    expect(coverage.refreshFailed).toBe(false);
    expect(accounts).toEqual([]);
  });

  it('is account-wide: the repo and provider filters leave coverage and accounts as they were', async () => {
    const app = metricsApp(sourced());
    const everything = await overview(app, WEEK);
    const filtered = await overview(app, `${WEEK}&repos=${API}&provider=codex&author=all`);
    expect(filtered.coverage).toEqual(everything.coverage);
    expect(filtered.accounts).toEqual(everything.accounts);
  });

  it('shows only the Codex weekly quota across Overview filters even when daily account tokens are available', async () => {
    const db = sourced();
    const fetchedAt = day('2026-11-04', '09:00');
    const resetsAt = day('2026-11-09');
    markChatgptConnected(db, fetchedAt);
    saveChatgptRateLimits(
      db,
      [
        { limitId: 'primary', usedPercent: 41, windowMinutes: 10_080, resetsAt },
        { limitId: 'secondary', usedPercent: 80, windowMinutes: 300, resetsAt: null },
      ],
      fetchedAt,
      'codex',
    );
    saveChatgptTokens(
      db,
      { lifetimeTokens: 200, buckets: [{ date: '2026-11-03', tokens: 100 }] },
      fetchedAt + 1,
    );
    recordFailedChatgptRead(db, fetchedAt + 2, 'tokens');

    const app = metricsApp(db);
    const { accounts } = await overview(app, WEEK);
    expect(accounts).toEqual([
      {
        account: 'chatgpt',
        unit: 'percent',
        scopeLabel: 'ChatGPT subscription plan limits',
        refreshedAt: new Date(fetchedAt).toISOString(),
        stale: false,
        rateLimits: [
          {
            limitId: 'primary',
            label: 'Weekly',
            usedPercent: 41,
            windowMinutes: 10_080,
            resetsAt: new Date(resetsAt).toISOString(),
          },
        ],
      },
    ]);
    const filtered = await overview(
      app,
      `?start=2026-10-01&end=2026-10-07&repos=${API}&provider=claude&author=all`,
    );
    expect(filtered.accounts).toEqual(accounts);

    recordFailedChatgptRead(db, fetchedAt + 3, 'limits');
    expect((await overview(app, WEEK)).accounts).toEqual([{ ...accounts[0], stale: true }]);

    markChatgptDisconnected(db);
    expect((await overview(app, WEEK)).accounts).toEqual([]);
  });

  it('retains a passed reset as stale and omits the report when the weekly window disappears', async () => {
    const db = sourced();
    const fetchedAt = day('2026-11-03');
    const resetsAt = day('2026-11-04', '09:00');
    const short = { limitId: 'primary', usedPercent: 11, windowMinutes: 300, resetsAt: null };
    markChatgptConnected(db, fetchedAt);
    saveChatgptRateLimits(
      db,
      [short, { limitId: 'secondary', usedPercent: 65, windowMinutes: 10_080, resetsAt }],
      fetchedAt,
      'codex',
    );
    const app = metricsApp(db);
    expect((await overview(app, WEEK)).accounts).toMatchObject([
      {
        account: 'chatgpt',
        stale: true,
        refreshedAt: new Date(fetchedAt).toISOString(),
        rateLimits: [{ limitId: 'secondary', usedPercent: 65 }],
      },
    ]);
    saveChatgptRateLimits(db, [short], fetchedAt + 1, 'codex');
    const { accounts, coverage } = await overview(app, WEEK);
    expect(accounts).toEqual([]);
    expect(coverage.accounts?.find((account) => account.id === 'chatgpt')?.status).toBe(
      'connected',
    );
  });

  it('reports a failed refresh, and has no refresh time before anything ran', async () => {
    const db = sourced();
    db.prepare(
      "UPDATE source_state SET last_attempt_result = 'failed' WHERE source_id = 'claude'",
    ).run();
    expect((await overview(metricsApp(db), WEEK)).coverage.refreshFailed).toBe(true);

    const bare = await overview(metricsApp(memoryDb()), WEEK);
    expect(bare.coverage).toMatchObject({
      sources: [],
      github: { tracked: 0, inaccessible: 0 },
      lastRefreshAt: null,
      refreshFailed: false,
    });
  });
});

describe('the quiet panel (true zero)', () => {
  const quiet = (db: DatabaseSync, query = WEEK) =>
    overview(metricsApp(db), query).then((o) => o.trueZero);

  it('is true when every in-scope source covered the elapsed range and nothing happened', async () => {
    expect(await quiet(world())).toBe(true);
  });

  it('is false the moment there is an event or a merge in the period', async () => {
    const withEvent = world();
    addEvent(withEvent, {
      session: addSession(withEvent, { id: 1, repo: API, startedAt: day('2026-11-02') }),
      at: day('2026-11-03'),
      input: 1,
    });
    expect(await quiet(withEvent)).toBe(false);

    const withMerge = world();
    addMergedPr(withMerge, API, 1, day('2026-11-03'), 'priya-s');
    expect(await quiet(withMerge, `${WEEK}&author=all`)).toBe(false);
  });

  it('is false when history is only partly covered, stale, still syncing or not tracked', async () => {
    const partial = world();
    partial
      .prepare("UPDATE source_state SET oldest_event_at = ? WHERE source_id = 'codex'")
      .run(day('2026-11-03'));
    expect(await quiet(partial)).toBe(false);

    const stale = world();
    stale
      .prepare(
        "UPDATE source_state SET last_attempt_result = 'failed', last_success_at = ? WHERE source_id = 'claude'",
      )
      .run(day('2026-11-02'));
    expect(await quiet(stale)).toBe(false);

    const syncing = memoryDb();
    addRepo(syncing, API, { backfill: false });
    addSource(syncing, 'codex');
    addSource(syncing, 'claude');
    expect(await quiet(syncing)).toBe(false);

    const untracked = memoryDb();
    addSource(untracked, 'codex');
    addSource(untracked, 'claude');
    expect(await quiet(untracked)).toBe(false);
  });

  it('only needs the providers in scope to be covered', async () => {
    const db = memoryDb();
    addRepo(db, API);
    addSource(db, 'codex');
    expect(await quiet(db)).toBe(false); // claude was never found
    expect(await quiet(db, `${WEEK}&provider=codex`)).toBe(true);
  });

  it('is false for a period that has not started', async () => {
    expect(await quiet(world(), '?start=2026-11-05&end=2026-11-08')).toBe(false);
  });
});

describe('GET /api/overview errors', () => {
  it('refuses a bad filter or range with the error envelope', async () => {
    const app: MetricsApp = metricsApp(memoryDb());
    const range = await get(app, '/api/overview?start=2026-11-08&end=2026-11-02');
    expect(range.status).toBe(400);
    expect(range.body).toMatchObject({ error: { code: 'invalid_range' } });
    const provider = await get(app, '/api/overview?provider=openai');
    expect(provider.status).toBe(400);
    expect(provider.body).toMatchObject({
      error: { code: 'invalid_input', details: { fields: { provider: expect.any(String) } } },
    });
  });

  it('defaults to the current Monday-start week', async () => {
    const { scope } = await overview(metricsApp(world()));
    expect(scope).toMatchObject({ start: '2026-11-02', end: '2026-11-08', gran: 'day' });
  });
});
