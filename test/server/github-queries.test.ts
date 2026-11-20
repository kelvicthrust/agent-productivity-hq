import { describe, expect, it } from 'vitest';
import {
  getRepo,
  getRepoByNodeId,
  listActiveRepos,
  markSyncFinished,
  markSyncStarted,
  setRepoAccess,
  stopRepo,
  trackRepo,
} from '../../src/server/db/queries/repos.ts';
import {
  addPullRequestCommits,
  anyRepoBackfilling,
  countPullRequests,
  countTrackedReachableRepos,
  listInaccessibleActiveRepos,
  listMergeTimes,
  listPullRequests,
  listPullRequestsWithMoreCommits,
  upsertPullRequests,
  type PrFilter,
  type PullRequestInput,
} from '../../src/server/db/queries/prs.ts';
import { dateInZone, utcBounds } from '../../src/shared/domain/periods.ts';
import { memoryDb, TZ } from './helpers.ts';

// The SQL behind adding, stopping and re-adding a repo and behind the PR views (TECH › GitHub delivery; P-14 to P-21). These
// run on a real migrated database; the HTTP and the GitHub calls come later and are tested with the scripted GitHub.

const T0 = Date.parse('2026-11-04T20:00:00Z');

const pr = (
  number: number,
  mergedAt: string,
  extra: Partial<PullRequestInput> = {},
): PullRequestInput => ({
  nodeId: `PR_${number}`,
  repoId: 'acme/widgets',
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  authorLogin: 'Octo-Kelvin',
  mergedByLogin: 'someone-else',
  mergedAt: Date.parse(mergedAt),
  headRef: 'feature',
  baseRef: 'main',
  mergeCommitSha: null,
  commits: [],
  commitsComplete: true,
  ...extra,
});

const wide = (extra: Partial<PrFilter> = {}): PrFilter => ({
  fromMs: 0,
  toMs: Number.MAX_SAFE_INTEGER,
  repos: [],
  author: { mode: 'all' },
  ...extra,
});

function tracked(db = memoryDb()) {
  trackRepo(db, { id: 'acme/widgets', nodeId: 'R_1', displayName: 'Acme/Widgets', now: T0 });
  return db;
}

describe('tracking a repo', () => {
  it('adds a new one active, access ok, backfill not complete', () => {
    const db = memoryDb();
    const result = trackRepo(db, {
      id: 'acme/widgets',
      nodeId: 'R_1',
      displayName: 'Acme/Widgets',
      now: T0,
    });
    expect(result.outcome).toBe('added');
    expect(result.repo).toMatchObject({
      id: 'acme/widgets',
      nodeId: 'R_1',
      displayName: 'Acme/Widgets',
      trackingState: 'active',
      accessState: 'ok',
      backfillComplete: false,
      addedAt: T0,
    });
    expect(listActiveRepos(db).map((r) => r.id)).toEqual(['acme/widgets']);
  });

  it('says already tracked for an active one and writes nothing (P-15)', () => {
    const db = tracked();
    const again = trackRepo(db, {
      id: 'acme/widgets',
      nodeId: 'R_1',
      displayName: 'Acme/Widgets',
      now: T0 + 1000,
    });
    expect(again.outcome).toBe('already_tracked');
    expect(again.repo.addedAt).toBe(T0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM repo').get() as { n: number }).n).toBe(1);
  });

  it('finds a renamed repo by its node id and keeps its rows, never adding a second row', () => {
    const db = tracked();
    const renamed = trackRepo(db, {
      id: 'acme/gadgets',
      nodeId: 'R_1',
      displayName: 'Acme/Gadgets',
      now: T0,
    });
    expect(renamed.outcome).toBe('already_tracked');
    expect(renamed.repo.id).toBe('acme/widgets');
    expect((db.prepare('SELECT COUNT(*) AS n FROM repo').get() as { n: number }).n).toBe(1);
    expect(getRepoByNodeId(db, 'R_1')?.id).toBe('acme/widgets');
  });

  it('stops, keeps every row, is idempotent, and re-adding reactivates the same rows once (P-17, P-18)', () => {
    const db = tracked();
    upsertPullRequests(db, [pr(1, '2026-10-20T17:00:00Z'), pr(2, '2026-10-21T17:00:00Z')]);
    markSyncFinished(db, 'acme/widgets', { now: T0, complete: true });
    expect(getRepo(db, 'acme/widgets')).toMatchObject({
      backfillComplete: true,
      lastSyncSuccessAt: T0,
    });

    expect(stopRepo(db, 'acme/widgets', T0 + 5)).toBe('stopped');
    expect(stopRepo(db, 'acme/widgets', T0 + 9)).toBe('already_stopped');
    expect(stopRepo(db, 'nobody/none', T0)).toBe('not_found');
    expect(getRepo(db, 'acme/widgets')).toMatchObject({
      trackingState: 'stopped',
      stoppedAt: T0 + 5,
    });
    expect(listActiveRepos(db)).toEqual([]);
    expect(countPullRequests(db, wide())).toBe(0); // out of the active views
    expect((db.prepare('SELECT COUNT(*) AS n FROM pull_request').get() as { n: number }).n).toBe(2); // rows kept

    const back = trackRepo(db, {
      id: 'acme/widgets',
      nodeId: 'R_1',
      displayName: 'Acme/Widgets',
      now: T0 + 100,
    });
    expect(back.outcome).toBe('reactivated');
    expect(back.repo).toMatchObject({
      trackingState: 'active',
      stoppedAt: null,
      accessState: 'ok',
      backfillComplete: false,
      lastSyncStartedAt: null,
    });
    expect(countPullRequests(db, wide())).toBe(2);
    // the sync that follows reads the same PRs again and adds none
    expect(
      upsertPullRequests(db, [pr(1, '2026-10-20T17:00:00Z'), pr(2, '2026-10-21T17:00:00Z')]),
    ).toEqual({ inserted: 0, updated: 2 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM repo').get() as { n: number }).n).toBe(1);
  });

  it('records access and sync times: only a complete sync moves the last success and the backfill', () => {
    const db = tracked();
    markSyncStarted(db, 'acme/widgets', T0 + 1);
    markSyncFinished(db, 'acme/widgets', { now: T0 + 2, complete: false });
    expect(getRepo(db, 'acme/widgets')).toMatchObject({
      lastSyncStartedAt: T0 + 1,
      lastSyncSuccessAt: null,
      backfillComplete: false,
    });
    expect(anyRepoBackfilling(db)).toBe(true);
    markSyncFinished(db, 'acme/widgets', { now: T0 + 3, complete: true });
    expect(getRepo(db, 'acme/widgets')).toMatchObject({
      lastSyncSuccessAt: T0 + 3,
      backfillComplete: true,
    });
    expect(anyRepoBackfilling(db)).toBe(false);

    setRepoAccess(db, 'acme/widgets', {
      state: 'inaccessible',
      error: 'GitHub didn’t grant access.',
    });
    expect(getRepo(db, 'acme/widgets')).toMatchObject({
      accessState: 'inaccessible',
      accessError: 'GitHub didn’t grant access.',
    });
    expect(listInaccessibleActiveRepos(db)).toEqual(['acme/widgets']);
    expect(countTrackedReachableRepos(db)).toBe(0);
    setRepoAccess(db, 'acme/widgets', { state: 'ok', error: 'ignored' });
    expect(getRepo(db, 'acme/widgets')).toMatchObject({ accessState: 'ok', accessError: null });
  });
});

describe('storing pull requests', () => {
  it('upserts on the node id: a second run changes rows and never adds one (P-25)', () => {
    const db = tracked();
    expect(
      upsertPullRequests(db, [pr(1, '2026-10-20T17:00:00Z'), pr(2, '2026-10-21T17:00:00Z')]),
    ).toEqual({ inserted: 2, updated: 0 });
    expect(
      upsertPullRequests(db, [
        pr(1, '2026-10-20T17:00:00Z', { title: 'Renamed' }),
        pr(3, '2026-10-22T17:00:00Z'),
      ]),
    ).toEqual({ inserted: 1, updated: 1 });
    expect(
      (
        db.prepare('SELECT title FROM pull_request WHERE node_id = ?').get('PR_1') as {
          title: string;
        }
      ).title,
    ).toBe('Renamed');
    expect((db.prepare('SELECT COUNT(*) AS n FROM pull_request').get() as { n: number }).n).toBe(3);
  });

  it('keeps author and merger apart and has no way to store a PR that was never merged (P-19, P-20)', () => {
    const db = tracked();
    upsertPullRequests(db, [
      pr(1, '2026-10-20T17:00:00Z', { authorLogin: 'author-a', mergedByLogin: 'merger-b' }),
    ]);
    expect(
      db.prepare('SELECT author_login AS a, merged_by_login AS m FROM pull_request').get(),
    ).toEqual({ a: 'author-a', m: 'merger-b' });
    expect(() =>
      db
        .prepare(
          "INSERT INTO pull_request (node_id, repo_id, number, title, url, merged_at) VALUES ('PR_x', 'acme/widgets', 9, 't', 'https://example.test', NULL)",
        )
        .run(),
    ).toThrow(/NOT NULL/);
  });

  it('keeps commits as identifiers, adds a follow-up page, and lists the PRs still owed one', () => {
    const db = tracked();
    upsertPullRequests(db, [
      pr(1, '2026-10-20T17:00:00Z', { commits: ['a1', 'a2'], commitsComplete: false }),
    ]);
    expect(listPullRequestsWithMoreCommits(db, 'acme/widgets')).toEqual([
      { nodeId: 'PR_1', number: 1, nextPage: 2 },
    ]);
    addPullRequestCommits(db, 'PR_1', ['a2', 'a3'], true);
    expect(listPullRequestsWithMoreCommits(db, 'acme/widgets')).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pr_commit').get() as { n: number }).n).toBe(3);
  });
});

describe('reading the views', () => {
  it('puts a merge at local 23:59 in its day and one at local 00:00 in the next, on an ordinary day and on the day DST ends', () => {
    const db = tracked();
    for (const [day, number] of [
      ['2026-10-31', 10],
      ['2026-11-01', 20],
    ] as const) {
      const { start, end } = utcBounds(day, TZ);
      upsertPullRequests(db, [
        pr(number, new Date(start).toISOString()), // 00:00 local
        pr(number + 1, new Date(end - 60_000).toISOString()), // 23:59 local
      ]);
    }
    const day = (date: string) => {
      const { start, end } = utcBounds(date, TZ);
      return listPullRequests(db, wide({ fromMs: start, toMs: end }), { limit: 50 })
        .map((row) => row.number)
        .sort((a, b) => a - b);
    };
    expect(day('2026-10-31')).toEqual([10, 11]);
    expect(day('2026-11-01')).toEqual([20, 21]); // a 25-hour day: 23:59 is still the 1st
    expect(day('2026-11-02')).toEqual([]);
    expect(listMergeTimes(db, wide()).map((ms) => dateInZone(ms, TZ))).toEqual([
      '2026-10-31',
      '2026-10-31',
      '2026-11-01',
      '2026-11-01',
    ]);
  });

  it('filters by repo, by author (mine compares the author only, ignoring case) and by search', () => {
    const db = tracked();
    trackRepo(db, { id: 'acme/other', nodeId: 'R_2', displayName: 'Acme/Other', now: T0 });
    upsertPullRequests(db, [
      pr(1, '2026-10-20T17:00:00Z', { title: 'Add year grid' }),
      pr(2, '2026-10-21T17:00:00Z', {
        authorLogin: 'teammate',
        mergedByLogin: 'Octo-Kelvin',
        title: 'Fix the Sync',
      }),
      pr(3, '2026-10-22T17:00:00Z', {
        repoId: 'acme/other',
        nodeId: 'PR_o3',
        number: 3,
        title: 'Other thing',
        url: 'https://github.com/acme/other/pull/3',
      }),
    ]);
    const numbers = (filter: PrFilter) =>
      listPullRequests(db, filter, { limit: 50 }).map((r) => r.nodeId);
    expect(numbers(wide({ author: { mode: 'mine', login: 'octo-kelvin' } }))).toEqual([
      'PR_o3',
      'PR_1',
    ]); // PR 2 was merged by me but authored by a teammate
    expect(numbers(wide({ author: { mode: 'mine', login: null } }))).toEqual([]);
    expect(numbers(wide())).toEqual(['PR_o3', 'PR_2', 'PR_1']);
    expect(numbers(wide({ repos: ['acme/other'] }))).toEqual(['PR_o3']);
    expect(numbers(wide({ search: 'YEAR grid' }))).toEqual(['PR_1']);
    expect(numbers(wide({ search: 'acme/other#3' }))).toEqual(['PR_o3']);
    expect(numbers(wide({ search: '#2' }))).toEqual(['PR_2']);
    expect(numbers(wide({ search: '100%' }))).toEqual([]); // % is text, not a wildcard
    expect(countPullRequests(db, wide({ search: 'thing' }))).toBe(1);
  });

  it('leaves an inaccessible repo out of the views and names it, and keeps its rows', () => {
    const db = tracked();
    upsertPullRequests(db, [pr(1, '2026-10-20T17:00:00Z')]);
    setRepoAccess(db, 'acme/widgets', { state: 'inaccessible', error: 'No access.' });
    expect(countPullRequests(db, wide())).toBe(0);
    expect(listMergeTimes(db, wide())).toEqual([]);
    expect(listInaccessibleActiveRepos(db)).toEqual(['acme/widgets']);
    setRepoAccess(db, 'acme/widgets', { state: 'ok' });
    expect(countPullRequests(db, wide())).toBe(1);
  });

  it('pages newest first with a cursor that never skips or repeats a PR, even for equal merge times', () => {
    const db = tracked();
    const same = '2026-10-20T17:00:00Z';
    upsertPullRequests(db, [
      pr(1, same),
      pr(2, same),
      pr(3, same),
      pr(4, '2026-10-21T17:00:00Z'),
      pr(5, '2026-10-19T17:00:00Z'),
    ]);
    const pages: string[][] = [];
    let after: { mergedAt: number; nodeId: string } | undefined;
    for (let guard = 0; guard < 5; guard += 1) {
      const rows = listPullRequests(db, wide(), after ? { limit: 2, after } : { limit: 2 });
      const shown = rows.slice(0, 2);
      pages.push(shown.map((r) => r.nodeId));
      if (rows.length <= 2) break;
      const last = shown.at(-1)!;
      after = { mergedAt: last.mergedAt, nodeId: last.nodeId };
    }
    expect(pages.flat()).toEqual(['PR_4', 'PR_3', 'PR_2', 'PR_1', 'PR_5']);
  });

  it('counts a repo with none tracked as none, and a repo still backfilling as syncing', () => {
    const db = memoryDb();
    expect(countTrackedReachableRepos(db)).toBe(0);
    expect(anyRepoBackfilling(db)).toBe(false);
    tracked(db);
    expect(countTrackedReachableRepos(db)).toBe(1);
    expect(anyRepoBackfilling(db)).toBe(true);
  });
});
