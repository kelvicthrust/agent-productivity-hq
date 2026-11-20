import { describe, expect, it } from 'vitest';
import { NetError } from '../../../src/server/lib/net.ts';
import type { NetFetch } from '../../../src/server/collectors/github/ports.ts';
import { createGithubAdapter } from '../../../src/server/collectors/github/sync.ts';
import {
  getRepo,
  getRepoBySlug,
  listActiveRepos,
  stopRepo,
  trackRepo,
} from '../../../src/server/db/queries/repos.ts';
import { recomputeLinks } from '../../../src/server/services/links.ts';
import { upsertSession } from '../../../src/server/db/queries/usage.ts';
import {
  DAY,
  TZ,
  appFor,
  count,
  crew,
  graphqlCalls,
  mergedPrs,
  rows,
  type Crew,
} from './helpers.ts';

// The GitHub sync (stage 3) on the scripted GitHub: backfill in pages of 50 that are each kept, the lookback and the
// incremental overlap, the rate limit and the secondary limit, 401, "not connected", inaccessible repos, commits past the first
// 100. Every request goes through the NetFetch the adapter is given and every sign-in through the real auth over the double.

const WIDGETS = { fullName: 'Acme/Widgets', nodeId: 'R_widgets' };

function restartedRefresh(c: Crew) {
  const adapter = createGithubAdapter({ net: c.net, auth: c.auth, timezone: TZ });
  return adapter.refresh({ db: c.db, now: c.now, logger: c.logs.logger, progress: () => {} });
}

/** Tracks a repo the way adding it would, and gives the scripted GitHub its PRs. */
function track(c: Crew, repo = WIDGETS, prs = mergedPrs(c, 3, { key: repo.nodeId })): void {
  c.github.addRepo(repo, prs);
  trackRepo(c.db, {
    id: repo.fullName.toLowerCase(),
    nodeId: repo.nodeId,
    displayName: repo.fullName,
    now: c.now(),
  });
}

const prRows = (c: Crew) =>
  rows<{
    node_id: string;
    number: number;
    author_login: string | null;
    merged_by_login: string | null;
  }>(
    c.db,
    'SELECT node_id, number, author_login, merged_by_login FROM pull_request ORDER BY number',
  );

/** Makes the nth GraphQL request fail the way a dropped connection does. */
const dropGraphql =
  (nth: number) =>
  (inner: NetFetch): NetFetch => {
    let seen = 0;
    return async (url, init) => {
      if (url.endsWith('/graphql') && ++seen === nth) {
        throw new NetError('unreachable', 'api.github.com', '/graphql');
      }
      return inner(url, init);
    };
  };

/** Nothing token-shaped the double ever issued may sit in what the sync stores, logs or reports. */
function expectNoTokens(c: Crew, ...reports: unknown[]): void {
  const stored = JSON.stringify(
    ['source_state', 'repo', 'pull_request', 'pr_commit', 'github_sync_pass', 'app_meta'].map((t) =>
      rows(c.db, `SELECT * FROM ${t}`),
    ),
  );
  const seen = [stored, JSON.stringify(c.logs.entries), JSON.stringify(reports)].join('\n');
  expect(c.github.tokens.length).toBeGreaterThan(0);
  for (const token of c.github.tokens) expect(seen).not.toContain(token);
}

describe('the first pass', () => {
  it('reads merged PRs 50 at a time, writes every page, and turns the backfill on when it reaches the end', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 120, { key: 'w' }));

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'succeeded', imported: 120 });
    expect(graphqlCalls(c)).toHaveLength(4); // Three backfill pages, then the catch-up head.
    expect(count(c.db, 'pull_request')).toBe(120);
    const repo = getRepo(c.db, 'acme/widgets');
    expect(repo).toMatchObject({
      backfillComplete: true,
      accessState: 'ok',
      lastSyncSuccessAt: c.now(),
    });
    expect(c.github.sawMutation).toBe(false);
    expectNoTokens(c, report);
  });

  it('keeps only merged PRs: a closed-unmerged PR never gets in, even if an answer carried one', async () => {
    const hostile =
      (inner: NetFetch): NetFetch =>
      async (url, init) => {
        const response = await inner(url, init);
        if (!url.endsWith('/graphql')) return response;
        const body = (await response.json()) as {
          data: { repository: { pullRequests: { nodes: Record<string, unknown>[] } } };
        };
        body.data.repository.pullRequests.nodes.push({
          id: 'PR_closed_unmerged',
          number: 999,
          title: 'Closed without merging',
          url: 'https://github.com/Acme/Widgets/pull/999',
          mergedAt: null,
          updatedAt: new Date().toISOString(),
          author: { login: 'octo-kelvin' },
          mergedBy: null,
          commits: { totalCount: 0, nodes: [] },
        });
        return new Response(JSON.stringify(body), { status: 200 });
      };
    const c = await crew({ net: hostile });
    const prs = mergedPrs(c, 2, { key: 'w' });
    prs.push({
      nodeId: 'PR_w_closed',
      number: 50,
      title: 'Closed',
      mergedAt: null,
      state: 'CLOSED',
      author: 'octo-kelvin',
      mergedBy: null,
    });
    track(c, WIDGETS, prs);

    await c.refresh();

    expect(prRows(c).map((r) => r.number)).toEqual([1, 2]);
  });

  it('counts by mergedAt and keeps the author and the merger apart', async () => {
    const c = await crew();
    track(c, WIDGETS, [
      ...mergedPrs(c, 1, { key: 'a', numberStart: 1, author: 'teammate', mergedBy: 'octo-kelvin' }),
      ...mergedPrs(c, 1, { key: 'b', numberStart: 2, author: 'octo-kelvin', mergedBy: 'teammate' }),
      ...mergedPrs(c, 1, { key: 'c', numberStart: 3, author: null, mergedBy: null }),
    ]);

    await c.refresh();

    expect(prRows(c)).toEqual([
      { node_id: 'PR_a_1', number: 1, author_login: 'teammate', merged_by_login: 'octo-kelvin' },
      { node_id: 'PR_b_2', number: 2, author_login: 'octo-kelvin', merged_by_login: 'teammate' },
      { node_id: 'PR_c_3', number: 3, author_login: null, merged_by_login: null },
    ]);
    const merged = rows<{ merged_at: number }>(
      c.db,
      'SELECT merged_at FROM pull_request WHERE number = 1',
    );
    expect(merged[0]?.merged_at).toBe(c.now() - 2 * DAY);
  });

  it('stops paging at the lookback and stores nothing merged before it', async () => {
    const c = await crew();
    track(c, WIDGETS, [
      ...mergedPrs(c, 30, { key: 'new' }),
      // Merged and last touched 400 days ago: older than today − 365 days.
      ...mergedPrs(c, 90, { key: 'old', numberStart: 100, daysBack: 400 }),
    ]);

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'succeeded', imported: 30 });
    // The first page (50) already ends in a PR older than the lookback, so a second page is never asked for.
    expect(graphqlCalls(c)).toHaveLength(1);
    expect(count(c.db, 'pull_request')).toBe(30);
    expect(getRepo(c.db, 'acme/widgets')?.backfillComplete).toBe(true);
  });

  it('asks for the commits past the first 100 with a follow-up page, and stores them all', async () => {
    const c = await crew();
    track(c, WIDGETS, [
      ...mergedPrs(c, 1, { key: 'big', numberStart: 1, commits: 230 }),
      ...mergedPrs(c, 1, { key: 'even', numberStart: 2, commits: 200 }),
      ...mergedPrs(c, 1, { key: 'small', numberStart: 3, commits: 40 }),
    ]);

    await c.refresh();

    const commitsFor = (nodeId: string) => count(c.db, 'pr_commit', `pr_node_id = '${nodeId}'`);
    expect([commitsFor('PR_big_1'), commitsFor('PR_even_2'), commitsFor('PR_small_3')]).toEqual([
      230, 200, 40,
    ]);
    expect(count(c.db, 'pull_request', 'commits_complete = 0')).toBe(0);
    const follow = c.github.requests.filter((r) => r.path.endsWith('/commits'));
    // 230 commits: pages 2 and 3. 200 commits: page 2 is full, page 3 is empty. 40 commits: no follow-up.
    expect(follow.map((r) => `${r.path}${r.query}`).sort()).toEqual([
      '/repos/acme/widgets/pulls/1/commits?per_page=100&page=2',
      '/repos/acme/widgets/pulls/1/commits?per_page=100&page=3',
      '/repos/acme/widgets/pulls/2/commits?per_page=100&page=2',
      '/repos/acme/widgets/pulls/2/commits?per_page=100&page=3',
    ]);
  });
});

describe('commits GitHub will not hand over', () => {
  it('leaves the PR owed, does not ask again in the same attempt, and finishes it on the next sync', async () => {
    const c = await crew();
    // PR 1 (the newest) has 230 commits; 120 PRs make three pages, so the owed PR would be retried on every page.
    track(c, WIDGETS, [
      ...mergedPrs(c, 1, { key: 'big', numberStart: 1, commits: 230 }),
      ...mergedPrs(c, 119, { key: 'w', numberStart: 2, daysBack: 1 }),
    ]);
    c.github.failNext({ match: (r) => r.path.endsWith('/commits'), status: 404 });

    const first = await c.refresh();

    expect(first).toMatchObject({ result: 'succeeded', imported: 120 });
    expect(c.github.requests.filter((r) => r.path.endsWith('/commits'))).toHaveLength(1);
    expect(count(c.db, 'pull_request', 'commits_complete = 0')).toBe(1);
    expect(count(c.db, 'pr_commit', "pr_node_id = 'PR_big_1'")).toBe(100);

    c.w.clock.now += 60 * 60_000;
    expect(await c.refresh()).toMatchObject({ result: 'succeeded' });
    expect(count(c.db, 'pull_request', 'commits_complete = 0')).toBe(0);
    expect(count(c.db, 'pr_commit', "pr_node_id = 'PR_big_1'")).toBe(230);
  });
});

describe('a partial sync is kept', () => {
  it('keeps the pages it wrote when the connection drops, then finishes the pass without a duplicate', async () => {
    const c = await crew({ net: dropGraphql(2) });
    track(c, WIDGETS, mergedPrs(c, 120, { key: 'w' }));

    const first = await c.refresh();

    expect(first).toMatchObject({ result: 'partial', imported: 50 });
    expect(count(c.db, 'pull_request')).toBe(50);
    expect(getRepo(c.db, 'acme/widgets')).toMatchObject({
      backfillComplete: false,
      lastSyncSuccessAt: null,
    });

    const second = await c.refresh();

    expect(second).toMatchObject({ result: 'succeeded' });
    expect(count(c.db, 'pull_request')).toBe(120);
    expect(getRepo(c.db, 'acme/widgets')?.backfillComplete).toBe(true);
  });

  it('resumes a saved cursor after restart and catches changes at the head before completing backfill', async () => {
    const cursors: (string | null)[] = [];
    const c = await crew({
      net: (inner) => async (url, init) => {
        if (url.endsWith('/graphql')) {
          const request = JSON.parse(init?.body ?? '') as { variables: { after: string | null } };
          cursors.push(request.variables.after);
          if (cursors.length === 2) throw new NetError('unreachable', 'api.github.com', '/graphql');
        }
        return inner(url, init);
      },
    });
    track(c, WIDGETS, mergedPrs(c, 120));
    expect(await c.refresh()).toMatchObject({ result: 'partial', imported: 50 });

    c.w.clock.now += 60_000;
    c.github.addPr('Acme/Widgets', {
      ...mergedPrs(c, 1, { numberStart: 300 })[0]!,
      mergedAt: new Date(c.now()).toISOString(),
    });
    expect(await restartedRefresh(c)).toMatchObject({ result: 'succeeded', imported: 71 });
    expect(cursors).toEqual([null, '50', '50', '100', null]);
    expect(count(c.db, 'pull_request')).toBe(121);
  });

  it('restarts a phase once when GitHub rejects its saved cursor and keeps the original pass start', async () => {
    const c = await crew({ net: dropGraphql(2) });
    track(c, WIDGETS, mergedPrs(c, 120));
    expect(await c.refresh()).toMatchObject({ result: 'partial', imported: 50 });
    const started = c.now();
    c.w.clock.now += 60_000;
    c.github.failNext({
      match: (request) => request.path === '/graphql',
      status: 200,
      body: {
        data: { repository: { pullRequests: null } },
        errors: [{ type: 'INVALID_CURSOR_ARGUMENTS', message: 'The supplied cursor is invalid.' }],
      },
    });

    expect(await restartedRefresh(c)).toMatchObject({ result: 'succeeded', imported: 70 });
    expect(getRepo(c.db, 'acme/widgets')).toMatchObject({ completeStartedAt: started });
    expect(count(c.db, 'pull_request')).toBe(120);
  });

  it('resumes the catch-up phase at its own cursor before marking the backfill complete', async () => {
    const c = await crew({ net: dropGraphql(5) });
    const prs = mergedPrs(c, 120);
    const startedAt = c.now();
    for (const pr of prs.slice(0, 60)) pr.updatedAt = new Date(startedAt).toISOString();
    track(c, WIDGETS, prs);

    expect(await c.refresh()).toMatchObject({ result: 'partial', imported: 120 });
    expect(getRepo(c.db, 'acme/widgets')?.backfillComplete).toBe(false);
    expect(rows(c.db, 'SELECT phase, started_at, cutoff_at, cursor FROM github_sync_pass')).toEqual(
      [{ phase: 'catch_up', started_at: startedAt, cutoff_at: startedAt, cursor: '50' }],
    );
    c.w.clock.now += 180_000;
    const asked = graphqlCalls(c).length;
    expect(await restartedRefresh(c)).toMatchObject({ result: 'succeeded', duplicatesSkipped: 50 });
    expect(graphqlCalls(c)).toHaveLength(asked + 1);
    expect(getRepo(c.db, 'acme/widgets')).toMatchObject({
      backfillComplete: true,
      completeStartedAt: startedAt,
    });
  });

  it('persists a commit cursor and does not re-fetch a matching completed list', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 1, { commits: 230 }));
    c.github.failNext({ match: (r) => r.query.endsWith('page=3'), status: 500 });
    expect(await c.refresh()).toMatchObject({ result: 'partial' });
    expect(count(c.db, 'pr_commit')).toBe(200);
    expect(await restartedRefresh(c)).toMatchObject({ result: 'succeeded' });
    expect(count(c.db, 'pr_commit')).toBe(230);
    expect(await c.refresh()).toMatchObject({ result: 'succeeded' });
    expect(
      c.github.requests.filter((r) => r.path.endsWith('/commits')).map((r) => r.query),
    ).toEqual(['?per_page=100&page=2', '?per_page=100&page=3', '?per_page=100&page=3']);
  });

  it('fails when nothing could be read at all, and says GitHub could not be reached', async () => {
    const c = await crew({ net: dropGraphql(1) });
    track(c);

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'failed', errorCode: 'unreachable' });
    expect(report).toMatchObject({ message: 'GitHub couldn’t be reached. Try again in a moment.' });
    expect(count(c.db, 'pull_request')).toBe(0);
  });
});

describe('verified repository names', () => {
  it('uses the new name, retains the local id and links, and accepts historical and current slugs', async () => {
    const c = await crew();
    track(c);
    await c.refresh();
    const db = c.db;
    const addSession =
      db.prepare(`INSERT INTO session (provider, provider_session_id, kind, repo_id, started_at, started_basis)
      VALUES ('codex', ?, 'root', ?, ?, 'source_start')`);
    addSession.run('using-old-slug', 'acme/widgets', c.now() - 2 * DAY);
    addSession.run('using-new-slug', 'other/wrenches', c.now() - 2 * DAY);
    const ref = db.prepare("INSERT INTO session_ref VALUES (?, 'pr_url', ?, ?)");
    ref.run(1, 'acme/widgets#1', c.now());
    ref.run(2, 'other/wrenches#1', c.now());
    db.prepare(
      "INSERT INTO owner_link_decision VALUES ('PR_R_widgets_1', 1, 'confirmed', NULL, NULL, ?)",
    ).run(c.now());

    c.github.renameRepo(WIDGETS.nodeId, 'Other/Wrenches');
    expect(await c.refresh()).toMatchObject({ result: 'succeeded' });
    expect(getRepoBySlug(db, 'other/wrenches')).toMatchObject({
      id: 'acme/widgets',
      displayName: 'Other/Wrenches',
    });
    upsertSession(db, {
      provider: 'codex',
      providerSessionId: 'imported-after-rename',
      kind: 'root',
      repoId: 'other/wrenches',
      startedAt: c.now() - 2 * DAY,
      startedBasis: 'source_start',
    });
    expect(rows(db, 'SELECT DISTINCT repo_id FROM session')).toEqual([{ repo_id: 'acme/widgets' }]);
    expect(rows(db, 'SELECT value FROM session_ref ORDER BY session_id')).toEqual([
      { value: 'acme/widgets#1' },
      { value: 'other/wrenches#1' },
    ]);
    recomputeLinks(db, c.now());
    expect(
      count(db, 'pr_session_link', "pr_node_id = 'PR_R_widgets_1' AND basis = 'pr_reference'"),
    ).toBe(2);
    expect(
      count(db, 'owner_link_decision', "pr_node_id = 'PR_R_widgets_1' AND decision = 'confirmed'"),
    ).toBe(1);
    const { get } = appFor(c);
    for (const slug of ['acme/widgets', 'other/wrenches']) {
      const response = await get(
        `/api/prs?start=2026-10-01&end=2026-11-04&repos=${slug}&author=all`,
      );
      expect(await response.json()).toMatchObject({
        scope: { repos: ['acme/widgets'] },
        items: expect.arrayContaining([
          expect.objectContaining({ url: 'https://github.com/Other/Wrenches/pull/1' }),
        ]),
      });
    }
  });

  it('refuses to claim a slug already reserved for another node without moving historical PRs', async () => {
    const c = await crew();
    const alpha = { fullName: 'Acme/Alpha', nodeId: 'R_alpha' };
    track(c, alpha);
    track(c);
    await c.refresh();
    c.github.renameRepo(WIDGETS.nodeId, 'Acme/NewWidgets');
    c.github.renameRepo(alpha.nodeId, WIDGETS.fullName);
    c.github.addPr(WIDGETS.fullName, mergedPrs(c, 1, { key: 'colliding', numberStart: 100 })[0]!);

    expect(await c.refresh()).toMatchObject({ result: 'partial', errorCode: 'inaccessible' });
    expect(getRepo(c.db, 'acme/alpha')).toMatchObject({
      nodeId: alpha.nodeId,
      accessState: 'inaccessible',
    });
    expect(getRepoBySlug(c.db, 'acme/widgets')?.nodeId).toBe(WIDGETS.nodeId);
    expect(count(c.db, 'pull_request', "repo_id = 'acme/alpha'")).toBe(3);
    expect(count(c.db, 'pull_request', "repo_id = 'acme/widgets'")).toBe(3);
    expect(count(c.db, 'pull_request', 'number = 100')).toBe(0);
  });
});

describe('rate limits', () => {
  it('stops under 100 points left: partial, "Waiting for GitHub rate limit until …", the page is kept', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 120, { key: 'w' }));
    // The double spends one point a request: 100 → 99 on the first page.
    c.github.setRateLimit(100, '2026-11-04T21:00:00Z');

    const report = await c.refresh();

    expect(report).toMatchObject({
      result: 'partial',
      message: 'Waiting for GitHub rate limit until 1:00 PM',
      imported: 50,
    });
    expect(graphqlCalls(c)).toHaveLength(1);
    expect(count(c.db, 'pull_request')).toBe(50);
    expect(getRepo(c.db, 'acme/widgets')?.backfillComplete).toBe(false);
  });

  it('does not ask GitHub again until the reset, then carries on and completes the pass', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 120, { key: 'w' }));
    c.github.setRateLimit(100, '2026-11-04T21:00:00Z');
    await c.refresh();
    const asked = c.github.requests.length;

    c.w.clock.now += 30 * 60_000;
    const waiting = await c.refresh();
    expect(waiting).toMatchObject({
      result: 'partial',
      message: 'Waiting for GitHub rate limit until 1:00 PM',
    });
    expect(c.github.requests).toHaveLength(asked);

    c.w.clock.now = Date.parse('2026-11-04T21:00:01Z');
    c.github.setRateLimit(4900);
    const resumed = await c.refresh();
    expect(resumed).toMatchObject({ result: 'succeeded' });
    expect(count(c.db, 'pull_request')).toBe(120);
    expect(getRepo(c.db, 'acme/widgets')?.backfillComplete).toBe(true);
  });

  it('does not start the next repo once the quota is spent', async () => {
    const c = await crew();
    track(c, { fullName: 'Acme/Alpha', nodeId: 'R_alpha' }, mergedPrs(c, 2, { key: 'a' }));
    track(c, WIDGETS, mergedPrs(c, 2, { key: 'w' }));
    c.github.setRateLimit(100, '2026-11-04T21:00:00Z');

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'partial' });
    expect(graphqlCalls(c)).toHaveLength(1);
    expect(getRepo(c.db, 'acme/alpha')?.backfillComplete).toBe(true);
    expect(getRepo(c.db, 'acme/widgets')?.backfillComplete).toBe(false);
  });

  it('persists the cooldown and starts with the next repo when the quota resets', async () => {
    const c = await crew();
    track(c, { fullName: 'Acme/Alpha', nodeId: 'R_alpha' }, mergedPrs(c, 120, { key: 'a' }));
    track(c, WIDGETS);
    c.github.setRateLimit(100, '2026-11-04T21:00:00Z');
    expect(await c.refresh()).toMatchObject({ result: 'partial', imported: 50 });
    const asked = c.github.requests.length;
    expect(await restartedRefresh(c)).toMatchObject({
      result: 'partial',
      errorCode: 'rate_limited',
    });
    expect(c.github.requests).toHaveLength(asked);

    c.w.clock.now = Date.parse('2026-11-04T21:00:01Z');
    c.github.setRateLimit(100, '2026-11-04T22:00:00Z');
    expect(await restartedRefresh(c)).toMatchObject({ result: 'partial', imported: 3 });
    expect(getRepo(c.db, 'acme/widgets')?.backfillComplete).toBe(true);
    expect(getRepo(c.db, 'acme/alpha')?.backfillComplete).toBe(false);
  });

  it('a primary limit with nothing left to read is not a wait: the sync just finishes', async () => {
    const c = await crew();
    track(c);
    c.github.setRateLimit(50);

    expect(await c.refresh()).toMatchObject({ result: 'succeeded' });
  });

  it('keeps commit follow-ups queued when the final GraphQL page drops below the limit', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 1, { commits: 230 }));
    c.github.setRateLimit(100, '2026-11-04T21:00:00Z');
    expect(await c.refresh()).toMatchObject({ result: 'partial', errorCode: 'rate_limited' });
    expect(count(c.db, 'pr_commit')).toBe(100);
    expect(c.github.requests.filter((request) => request.path.endsWith('/commits'))).toHaveLength(
      0,
    );
    expect(getRepo(c.db, 'acme/widgets')?.backfillComplete).toBe(true);
  });

  it('backs off as retry-after says on a secondary-limit 403, and leaves the stored PRs readable', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 5, { key: 'w' }));
    await c.refresh();
    const stored = count(c.db, 'pull_request');
    c.w.clock.now += 60 * 60_000;
    c.github.failNext({
      match: (r) => r.path === '/graphql',
      status: 403,
      headers: { 'retry-after': '120' },
      body: { message: 'You have exceeded a secondary rate limit.' },
    });

    const limited = await c.refresh();

    // 21:00Z + 120 s = 13:02 in Los Angeles.
    expect(limited).toMatchObject({
      result: 'partial',
      message: 'Waiting for GitHub rate limit until 1:02 PM',
    });
    expect(count(c.db, 'pull_request')).toBe(stored);
    const asked = c.github.requests.length;
    expect(await c.refresh()).toMatchObject({ result: 'partial' });
    expect(c.github.requests).toHaveLength(asked);

    c.w.clock.now += 3 * 60_000;
    expect(await c.refresh()).toMatchObject({ result: 'succeeded' });
  });

  it('reads an exhausted hourly quota (403, x-ratelimit-remaining 0) as a wait until its reset', async () => {
    const c = await crew();
    track(c);
    c.github.failNext({
      match: (r) => r.path === '/graphql',
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Date.parse('2026-11-04T21:30:00Z') / 1000),
      },
    });

    expect(await c.refresh()).toMatchObject({
      result: 'partial',
      message: 'Waiting for GitHub rate limit until 1:30 PM',
    });
  });
});

describe('a rate limit on the sign-in check itself (M6_AUTH_RATE_LIMIT)', () => {
  it('is a wait, not a failed attempt: "Waiting for GitHub rate limit until …", the PRs already loaded stay, and the window is respected', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 5, { key: 'w' }));
    await c.refresh();
    const stored = count(c.db, 'pull_request');
    c.w.clock.now += 60 * 60_000;
    c.github.failNext({
      match: (r) => r.path === '/user',
      status: 403,
      headers: { 'retry-after': '120' },
    });

    const limited = await c.refresh();

    // 21:00Z + 120 s = 13:02 in Los Angeles.
    expect(limited).toMatchObject({
      result: 'partial',
      errorCode: 'rate_limited',
      message: 'Waiting for GitHub rate limit until 1:02 PM',
    });
    expect(limited).not.toMatchObject({ result: 'failed' });
    expect(count(c.db, 'pull_request')).toBe(stored);
    // inside the window nothing is asked of GitHub at all
    const asked = c.github.requests.length;
    expect(await c.refresh()).toMatchObject({
      result: 'partial',
      message: 'Waiting for GitHub rate limit until 1:02 PM',
    });
    expect(c.github.requests).toHaveLength(asked);
    // the window passes and the next refresh reads again
    c.w.clock.now += 3 * 60_000;
    expect(await c.refresh()).toMatchObject({ result: 'succeeded' });
    expectNoTokens(c, limited);
  });

  it('a limit with no time from GitHub waits a minute', async () => {
    const c = await crew();
    track(c);
    c.github.failNext({ match: (r) => r.path === '/user', status: 429 });
    // 20:00Z + 60 s = 12:01 in Los Angeles.
    expect(await c.refresh()).toMatchObject({
      result: 'partial',
      message: 'Waiting for GitHub rate limit until 12:01 PM',
    });
  });

  it('a secondary limit that only the text of the 403 gives away (no retry-after, quota left) is a wait too, and keeps the PRs', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 5, { key: 'w' }));
    await c.refresh();
    const stored = count(c.db, 'pull_request');
    c.w.clock.now += 60 * 60_000;
    c.github.failNext({
      match: (r) => r.path === '/user',
      status: 403,
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' },
      body: {
        message:
          'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      },
    });

    const limited = await c.refresh();

    // 21:00Z + the default minute = 13:01 in Los Angeles.
    expect(limited).toMatchObject({
      result: 'partial',
      errorCode: 'rate_limited',
      message: 'Waiting for GitHub rate limit until 1:01 PM',
    });
    expect(limited).not.toMatchObject({ result: 'failed' });
    expect(JSON.stringify(limited)).not.toContain('Reconnect');
    expect(count(c.db, 'pull_request')).toBe(stored);
    const asked = c.github.requests.length;
    expect(await c.refresh()).toMatchObject({ result: 'partial' });
    expect(c.github.requests).toHaveLength(asked);
    c.w.clock.now += 2 * 60_000;
    expect(await c.refresh()).toMatchObject({ result: 'succeeded' });
    expectNoTokens(c, limited);
  });
});

describe('the sign-in', () => {
  it('is skipped, and records nothing, when GitHub is not connected', async () => {
    const c = await crew({ signIn: 'none' });
    track(c);

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'skipped', message: 'GitHub isn’t connected.' });
    expect(graphqlCalls(c)).toHaveLength(0);
    expect(count(c.db, 'pull_request')).toBe(0);
  });

  it('is skipped when no repository is tracked, without asking GitHub anything', async () => {
    const c = await crew();
    expect(await c.refresh()).toMatchObject({ result: 'skipped' });
    expect(c.github.requests).toHaveLength(0);
  });

  it('fails on a 401 that no refresh can fix: Reconnect needed, and the stored PRs stay', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 5, { key: 'w' }));
    await c.refresh();
    c.github.failNext({
      match: (r) => r.path === '/graphql',
      status: 401,
      body: { message: 'Bad credentials' },
    });

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'failed', errorCode: 'reconnect_needed' });
    expect(JSON.stringify(report)).toContain('Reconnect needed');
    expect(count(c.db, 'pull_request')).toBe(5);
    expectNoTokens(c, report);
  });

  it('answers a 401 on the App route with one refresh and carries on', async () => {
    const c = await crew({ signIn: 'app', installed: ['Acme'] });
    track(c, WIDGETS, mergedPrs(c, 5, { key: 'w' }));
    c.github.failNext({
      match: (r) => r.path === '/graphql',
      status: 401,
      body: { message: 'Bad credentials' },
    });

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'succeeded', imported: 5 });
    expect(c.github.issued).toHaveLength(2);
    expect(c.github.issued[0]?.refreshUsed).toBe(true);
    expectNoTokens(c, report);
  });

  it('fails when the App route is refused twice in a row', async () => {
    const c = await crew({ signIn: 'app', installed: ['Acme'] });
    track(c);
    c.github.failNext({ match: (r) => r.path === '/graphql', status: 401 });
    c.github.failNext({ match: (r) => r.path === '/graphql', status: 401 });

    expect(await c.refresh()).toMatchObject({ result: 'failed', errorCode: 'reconnect_needed' });
  });
});

describe('repositories GitHub does not hand over', () => {
  it('marks one inaccessible, keeps its rows, still reads the others, and reports partial', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 2, { key: 'w' }));
    trackRepo(c.db, { id: 'acme/gone', nodeId: 'R_gone', displayName: 'Acme/Gone', now: c.now() });

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'partial', errorCode: 'inaccessible' });
    expect(JSON.stringify(report)).toContain('Acme/Gone');
    expect(getRepo(c.db, 'acme/gone')).toMatchObject({
      accessState: 'inaccessible',
      backfillComplete: false,
    });
    expect(getRepo(c.db, 'acme/gone')?.accessError).toContain('acme/gone');
    expect(count(c.db, 'pull_request')).toBe(2);

    // GitHub grants it later: the next pass reads it and the repo is reachable again.
    c.github.addRepo(
      { fullName: 'Acme/Gone', nodeId: 'R_gone' },
      mergedPrs(c, 1, { key: 'g', numberStart: 10 }),
    );
    expect(await c.refresh()).toMatchObject({ result: 'succeeded' });
    expect(getRepo(c.db, 'acme/gone')).toMatchObject({
      accessState: 'ok',
      accessError: null,
      backfillComplete: true,
    });
  });

  it('under the App token, a repo whose owner the App is not installed on says to install it', async () => {
    const c = await crew({ signIn: 'app', installed: ['Acme'] });
    track(c, { fullName: 'Other/Thing', nodeId: 'R_thing' }, mergedPrs(c, 1, { key: 't' }));

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'partial' });
    expect(getRepo(c.db, 'other/thing')?.accessError).toBe(
      'Install your Agent Productivity HQ GitHub App on other and give it this repository, then check again.',
    );
  });

  it('does not read a repo that was stopped, and keeps its PRs', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 3, { key: 'w' }));
    await c.refresh();
    expect(stopRepo(c.db, 'acme/widgets', c.now())).toBe('stopped');
    const asked = c.github.requests.length;

    expect(await c.refresh()).toMatchObject({ result: 'skipped' });

    expect(c.github.requests).toHaveLength(asked);
    expect(listActiveRepos(c.db)).toHaveLength(0);
    expect(count(c.db, 'pull_request')).toBe(3);
  });
});

describe('later passes', () => {
  it('stop at the last sync’s start minus a day, and re-read what was edited', async () => {
    const c = await crew();
    const prs = mergedPrs(c, 120, { key: 'w' });
    track(c, WIDGETS, prs);
    await c.refresh();
    expect(graphqlCalls(c)).toHaveLength(4);

    c.w.clock.now += 60 * 60_000;
    // One merge since, and an old PR whose title was edited just now (GitHub moves it to the top by updatedAt).
    c.github.addPr('Acme/Widgets', {
      nodeId: 'PR_w_500',
      number: 500,
      title: 'Brand new',
      mergedAt: new Date(c.now() - 30 * 60_000).toISOString(),
      author: 'octo-kelvin',
      mergedBy: 'octo-kelvin',
    });
    const edited = prs[4];
    if (!edited) throw new Error('fixture');
    edited.title = 'Edited title';
    edited.updatedAt = new Date(c.now()).toISOString();

    const report = await c.refresh();

    expect(report).toMatchObject({ result: 'succeeded', imported: 1 });
    // One page: its last PR is older than the cutoff, so the other two pages are not read again.
    expect(graphqlCalls(c)).toHaveLength(5);
    expect(count(c.db, 'pull_request')).toBe(121);
    expect(
      rows<{ title: string }>(c.db, 'SELECT title FROM pull_request WHERE number = 5')[0]?.title,
    ).toBe('Edited title');
  });

  it('after a failed attempt, reads back to the last COMPLETE sync, not to the failed attempt', async () => {
    const c = await crew();
    track(c, WIDGETS, mergedPrs(c, 5, { key: 'w' }));
    await c.refresh();
    const completeAt = c.now();

    // Two days later a pass dies on its first request: it moves last_sync_started_at but read nothing.
    c.w.clock.now += 2 * DAY;
    c.github.failNext({ match: (r) => r.path === '/graphql', status: 500 });
    expect(await c.refresh()).toMatchObject({ result: 'failed' });
    expect(getRepo(c.db, 'acme/widgets')?.lastSyncStartedAt).toBe(c.now());

    // 60 PRs merged in the day after the complete sync, so they fill a page and a bit more. Reading back only to the failed
    // attempt's start − 1 day (one day before now) would stop after the first page and lose ten of them.
    for (let n = 0; n < 60; n += 1) {
      c.github.addPr('Acme/Widgets', {
        nodeId: `PR_gap_${n}`,
        number: 100 + n,
        title: `Merged in the gap ${n}`,
        mergedAt: new Date(completeAt + (n + 1) * 60_000).toISOString(),
        author: 'octo-kelvin',
        mergedBy: 'octo-kelvin',
      });
    }
    c.w.clock.now += 60_000;

    expect(await c.refresh()).toMatchObject({ result: 'succeeded', imported: 60 });
    expect(count(c.db, 'pull_request', 'number >= 100')).toBe(60);
  });
});
