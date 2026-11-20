import { describe, expect, it, vi } from 'vitest';
import { NetError } from '../../../src/server/lib/net.ts';
import type { NetFetch } from '../../../src/server/collectors/github/ports.ts';
import { ErrorEnvelope } from '../../../src/shared/contracts/errors.ts';
import { AddRepoResponse, ReposResponse } from '../../../src/shared/contracts/repos.ts';
import { readLinkHealth } from '../../../src/server/db/queries/link-health.ts';
import { setMeta } from '../../../src/server/db/queries/meta.ts';
import { trackRepo } from '../../../src/server/db/queries/repos.ts';
import { upsertSession } from '../../../src/server/db/queries/usage.ts';
import { recomputeLinks } from '../../../src/server/services/links.ts';
import { appFor, count, crew, mergedPrs, rows, type Crew } from './helpers.ts';

// POST and DELETE /api/repos and POST /api/repos/{owner}/{name}/recheck on the scripted GitHub (G6_5, P-14 … P-18): add by URL
// or owner/name, no duplicates, stop and add again with the same rows, and what each way GitHub can say no looks like.

const WIDGETS = { fullName: 'Acme/Widgets', nodeId: 'R_widgets' };
const error = async (response: Response) => ErrorEnvelope.parse(await response.json()).error;
const repoRows = (c: Crew) =>
  rows<{ id: string; tracking_state: string; github_node_id: string }>(
    c.db,
    'SELECT id, tracking_state, github_node_id FROM repo ORDER BY id',
  );

/** A world where GitHub knows Acme/Widgets and the sign-in is `gh`. */
async function widgets(options: Parameters<typeof crew>[0] = {}) {
  const c = await crew(options);
  c.github.addRepo(WIDGETS, mergedPrs(c, 4, { key: 'w' }));
  return c;
}

describe('POST /api/repos', () => {
  it('tracks a repo added by owner/name, with the canonical id from GitHub, and it survives a "restart"', async () => {
    const c = await widgets();
    const { post, get } = appFor(c);

    const res = await post('/api/repos', { input: 'acme/WIDGETS' });

    expect(res.status).toBe(201);
    const body = AddRepoResponse.parse(await res.json());
    expect(body).toMatchObject({
      id: 'acme/widgets',
      displayName: 'Acme/Widgets',
      trackingState: 'active',
      accessState: 'ok',
      backfillComplete: false,
      reactivated: false,
    });
    expect(repoRows(c)).toEqual([
      { id: 'acme/widgets', tracking_state: 'active', github_node_id: 'R_widgets' },
    ]);

    // A new app over the same database: the repo is still there (P-14).
    const again = appFor(c);
    const list = ReposResponse.parse(await (await again.get('/api/repos')).json());
    expect(list.active?.map((r) => r.id)).toEqual(['acme/widgets']);
    expect(await get('/api/repos')).toHaveProperty('status', 200);
  });

  it('accepts a github.com address with a path after the name', async () => {
    const c = await widgets();
    const { post } = appFor(c);

    const res = await post('/api/repos', {
      input: 'https://github.com/Acme/Widgets/pulls?q=is%3Aclosed',
    });

    expect(res.status).toBe(201);
    expect(AddRepoResponse.parse(await res.json()).id).toBe('acme/widgets');
  });

  it('answers 409 already_tracked for a repo that is already active, and adds no row (P-15)', async () => {
    const c = await widgets();
    const { post } = appFor(c);
    await post('/api/repos', { input: 'acme/widgets' });

    for (const input of ['acme/widgets', 'ACME/Widgets', 'https://github.com/acme/widgets.git']) {
      const res = await post('/api/repos', { input });
      expect(res.status).toBe(409);
      expect((await error(res)).code).toBe('already_tracked');
    }
    expect(repoRows(c)).toHaveLength(1);
  });

  it('finds a renamed repo by its node id: adding it under the new name is already tracked, not a second row', async () => {
    const c = await crew();
    // Tracked before the rename, under the old name. GitHub now spells it Acme/Widgets and answers the old name too.
    trackRepo(c.db, {
      id: 'acme/old-widgets',
      nodeId: 'R_widgets',
      displayName: 'Acme/Old-Widgets',
      now: c.now(),
    });
    c.github.addRepo({ ...WIDGETS, aliases: ['acme/old-widgets'] }, []);
    upsertSession(c.db, {
      provider: 'codex',
      providerSessionId: 'observed-new-slug',
      kind: 'root',
      repoId: 'acme/widgets',
      startedAt: c.now(),
      startedBasis: 'source_start',
    });
    recomputeLinks(c.db, c.now());
    const requestSync = vi.fn(() => readLinkHealth(c.db).state);
    const { post } = appFor(c, { requestSync });

    const res = await post('/api/repos', { input: 'acme/widgets' });

    expect(res.status).toBe(409);
    expect((await error(res)).details).toMatchObject({ repo: 'acme/old-widgets' });
    expect(repoRows(c).map((r) => r.id)).toEqual(['acme/old-widgets']);
    expect(rows(c.db, 'SELECT repo_id FROM session')).toEqual([{ repo_id: 'acme/old-widgets' }]);
    expect(readLinkHealth(c.db).state).toBe('stale');
    expect(requestSync.mock.results).toEqual([{ type: 'return', value: 'stale' }]);
  });

  it('quarantines a reused alias while preserving older references and stable repository membership', async () => {
    const c = await widgets();
    const requestSync = vi.fn();
    const { get, post } = appFor(c, { requestSync });
    await post('/api/repos', { input: 'acme/widgets' });
    await c.refresh();
    c.github.renameRepo(WIDGETS.nodeId, 'Acme/Interim');
    await c.refresh();
    const addSession = (providerSessionId: string) => {
      const id = upsertSession(c.db, {
        provider: 'codex',
        providerSessionId,
        kind: 'root',
        repoId: 'acme/interim',
        startedAt: c.now(),
        startedBasis: 'source_start',
      });
      c.db
        .prepare("INSERT INTO session_ref VALUES (?, 'pr_url', 'acme/interim#1', ?)")
        .run(id, c.now());
      return id;
    };
    const before = addSession('before');
    recomputeLinks(c.db, c.now());
    c.github.renameRepo(WIDGETS.nodeId, 'Acme/Current');
    await c.refresh();
    recomputeLinks(c.db, c.now());
    c.w.clock.now += 60_000;
    c.github.addRepo({ fullName: 'Acme/Interim', nodeId: 'R_unrelated' });
    requestSync.mockClear();

    const collision = await post('/api/repos', { input: 'acme/interim' });

    expect(collision.status).toBe(422);
    expect(readLinkHealth(c.db).state).toBe('stale');
    expect(requestSync).toHaveBeenCalledTimes(1);
    const after = addSession('after');
    recomputeLinks(c.db, c.now());
    expect(rows(c.db, 'SELECT id, repo_id FROM session ORDER BY id')).toEqual([
      { id: before, repo_id: 'acme/widgets' },
      { id: after, repo_id: null },
    ]);
    expect(
      rows(
        c.db,
        "SELECT session_id FROM pr_session_link WHERE pr_node_id = 'PR_w_1' AND basis = 'pr_reference'",
      ),
    ).toEqual([{ session_id: before }]);
    const filtered = await get('/api/prs?repos=acme/interim');
    expect(await filtered.json()).toMatchObject({
      scope: { repos: [], ignoredRepos: ['acme/interim'] },
    });
    expect(repoRows(c)).toHaveLength(1);
  });

  it('starts a refresh once a repo is tracked, and a failing starter does not undo the add', async () => {
    const c = await widgets();
    const requestSync = vi.fn(() => {
      throw new Error('no runner');
    });
    const { post } = appFor(c, { requestSync });

    expect((await post('/api/repos', { input: 'acme/widgets' })).status).toBe(201);

    expect(requestSync).toHaveBeenCalledTimes(1);
    expect(repoRows(c)).toHaveLength(1);
  });

  it('refuses input that is not a repository, naming the field, and stores nothing (P-16)', async () => {
    const c = await widgets();
    const { post } = appFor(c);

    for (const body of [
      { input: 'not a repo' },
      { input: '' },
      { input: 42 },
      {},
      { input: 'x'.repeat(301) },
    ]) {
      const res = await post('/api/repos', body);
      expect(res.status).toBe(400);
      const e = await error(res);
      expect(e.code).toBe('invalid_input');
      expect(Object.keys((e.details?.['fields'] as Record<string, string>) ?? {})).toEqual([
        'input',
      ]);
    }
    const bad = await appFor(c).app.request('http://127.0.0.1:4317/api/repos', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4317',
        'x-agent-productivity-request': '1',
        'content-type': 'application/json',
      },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    expect(c.github.requests).toHaveLength(0);
    expect(count(c.db, 'repo')).toBe(0);
  });

  describe('when GitHub says no', () => {
    it('a repo this sign-in cannot read is 422 repo_inaccessible with the input kept, and nothing is stored', async () => {
      const c = await widgets();
      const { post } = appFor(c);

      const res = await post('/api/repos', { input: 'acme/secret-stuff' });

      expect(res.status).toBe(422);
      const e = await error(res);
      expect(e).toMatchObject({ code: 'repo_inaccessible', retryable: false });
      expect(e.message).toContain('acme/secret-stuff');
      expect(count(c.db, 'repo')).toBe(0);
    });

    it('under the App token a 404 says to install the App on that owner, with a link', async () => {
      const c = await widgets({ signIn: 'app', installed: ['somewhere-else'] });
      const { post } = appFor(c);

      const res = await post('/api/repos', { input: 'acme/widgets' });

      expect(res.status).toBe(422);
      const e = await error(res);
      expect(e.code).toBe('repo_inaccessible');
      expect(e.message).toBe(
        'Install your Agent Productivity HQ GitHub App on acme and give it this repository, then check again.',
      );
      expect(e.details).toMatchObject({
        reason: 'app_not_installed',
        owner: 'acme',
        installUrl: 'https://github.com/settings/installations',
      });
      expect(count(c.db, 'repo')).toBe(0);
    });

    it('under the App token with the App installed, the repo is added', async () => {
      const c = await widgets({ signIn: 'app', installed: ['Acme'] });
      const { post } = appFor(c);

      expect((await post('/api/repos', { input: 'acme/widgets' })).status).toBe(201);
    });

    it('a redirect (a renamed repo’s 301, which is never followed) is answered with a plain sentence', async () => {
      const moved =
        (inner: NetFetch): NetFetch =>
        async (url, init) => {
          if (url.includes('/repos/'))
            throw new NetError('redirect', 'api.github.com', '/repos/acme/widgets');
          return inner(url, init);
        };
      const c = await widgets({ net: moved });
      const { post } = appFor(c);

      const res = await post('/api/repos', { input: 'acme/widgets' });

      expect(res.status).toBe(422);
      const e = await error(res);
      expect(e.code).toBe('repo_inaccessible');
      expect(e.message).toBe(
        'GitHub says acme/widgets has moved to a new name. Add it again using its current owner/name.',
      );
      expect(e.details).toMatchObject({ reason: 'moved' });
      expect(count(c.db, 'repo')).toBe(0);
    });

    it('a 403 that is not a limit is inaccessible too', async () => {
      const c = await widgets();
      c.github.failNext({
        match: (r) => r.path.startsWith('/repos/'),
        status: 403,
        body: { message: 'Resource not accessible' },
      });
      const { post } = appFor(c);

      const res = await post('/api/repos', { input: 'acme/widgets' });

      expect(res.status).toBe(422);
      expect((await error(res)).code).toBe('repo_inaccessible');
    });

    it('a rate limit is 502 upstream_unavailable (retryable) and names when to try again', async () => {
      const c = await widgets();
      c.github.failNext({
        match: (r) => r.path.startsWith('/repos/'),
        status: 403,
        headers: { 'retry-after': '600' },
      });
      const { post } = appFor(c);

      const res = await post('/api/repos', { input: 'acme/widgets' });

      expect(res.status).toBe(502);
      const e = await error(res);
      expect(e).toMatchObject({ code: 'upstream_unavailable', retryable: true });
      // T0 is 12:00 in Los Angeles; ten minutes on.
      expect(e.message).toBe('GitHub is limiting requests until 12:10 PM. Try again then.');
      expect(count(c.db, 'repo')).toBe(0);
    });

    it('a rate limit on the sign-in check says when to try again too, not "couldn’t be reached"', async () => {
      const c = await widgets();
      c.github.failNext({
        match: (r) => r.path === '/user',
        status: 429,
        headers: { 'retry-after': '600' },
      });
      const { post } = appFor(c);

      const res = await post('/api/repos', { input: 'acme/widgets' });

      expect(res.status).toBe(502);
      const e = await error(res);
      expect(e).toMatchObject({ code: 'upstream_unavailable', retryable: true });
      expect(e.message).toBe('GitHub is limiting requests until 12:10 PM. Try again then.');
      expect(count(c.db, 'repo')).toBe(0);
    });

    it('a secondary limit that only the text of the sign-in check answer gives away is the same wait (M6_AUTH_RATE_LIMIT)', async () => {
      const c = await widgets();
      c.github.failNext({
        match: (r) => r.path === '/user',
        status: 403,
        headers: { 'x-ratelimit-remaining': '4999' },
        body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' },
      });
      const { post } = appFor(c);

      const res = await post('/api/repos', { input: 'acme/widgets' });

      expect(res.status).toBe(502);
      const e = await error(res);
      expect(e).toMatchObject({ code: 'upstream_unavailable', retryable: true });
      // no time from GitHub: the default minute after T0 (12:00 in Los Angeles)
      expect(e.message).toBe('GitHub is limiting requests until 12:01 PM. Try again then.');
      expect(count(c.db, 'repo')).toBe(0);
    });

    it('a 500, or no connection at all, is 502 upstream_unavailable', async () => {
      const c = await widgets();
      c.github.failNext({ match: (r) => r.path.startsWith('/repos/'), status: 500 });
      const { post } = appFor(c);
      const first = await post('/api/repos', { input: 'acme/widgets' });
      expect(first.status).toBe(502);
      expect((await error(first)).message).toBe(
        'GitHub couldn’t be reached. Try again in a moment.',
      );

      const down = await widgets({
        net: () => async () => {
          throw new NetError('unreachable', 'api.github.com', '/user', 'ENOTFOUND');
        },
      });
      // The auth talks to the double, so the check is what finds the connection down.
      const second = await appFor(down).post('/api/repos', { input: 'acme/widgets' });
      expect(second.status).toBe(502);
    });

    it('a 401 that cannot be refreshed is "Reconnect needed" (422 github_not_connected)', async () => {
      const c = await widgets();
      c.github.failNext({ match: (r) => r.path.startsWith('/repos/'), status: 401 });
      const { post } = appFor(c);

      const res = await post('/api/repos', { input: 'acme/widgets' });

      expect(res.status).toBe(422);
      const e = await error(res);
      expect(e.code).toBe('github_not_connected');
      expect(e.message).toContain('Reconnect needed');
    });

    it('not connected is 422 github_not_connected; no App set up is 422 github_app_required with the guide', async () => {
      const none = await widgets({ signIn: 'none' });
      const res = await appFor(none).post('/api/repos', { input: 'acme/widgets' });
      expect(res.status).toBe(422);
      expect((await error(res)).code).toBe('github_not_connected');

      // The auth the account service shares knows whether a client ID is saved; ask it the way it would.
      const needsApp = await widgets({ signIn: 'none' });
      const asked = appFor({
        ...needsApp,
        auth: {
          credential: async () => ({
            ok: false,
            reason: 'needs_app',
            message: 'Set up your GitHub App to connect GitHub.',
          }),
          refreshAfter401: async () => ({ ok: false, reason: 'needs_app', message: 'x' }),
        },
      });
      const guide = await asked.post('/api/repos', { input: 'acme/widgets' });
      expect(guide.status).toBe(422);
      const e = await error(guide);
      expect(e.code).toBe('github_app_required');
      expect(e.details).toMatchObject({ guideUrl: '/sources' });
    });

    it('without GitHub ports in this process it is 422 github_not_connected', async () => {
      const c = await widgets();
      const res = await appFor(c, { github: false }).post('/api/repos', { input: 'acme/widgets' });
      expect(res.status).toBe(422);
      expect((await error(res)).code).toBe('github_not_connected');
    });
  });
});

describe('DELETE /api/repos/{owner}/{name}', () => {
  it('stops tracking, keeps every stored row, and is idempotent (P-17)', async () => {
    const c = await widgets();
    const { post, del, get } = appFor(c);
    await post('/api/repos', { input: 'acme/widgets' });
    await c.refresh();
    expect(count(c.db, 'pull_request')).toBe(4);

    const first = await del('/api/repos/Acme/Widgets');
    const second = await del('/api/repos/acme/widgets');

    expect([first.status, second.status]).toEqual([204, 204]);
    expect(await first.text()).toBe('');
    const list = ReposResponse.parse(await (await get('/api/repos')).json());
    expect(list.active).toEqual([]);
    expect(list.stopped?.[0]).toMatchObject({ id: 'acme/widgets', trackingState: 'stopped' });
    expect(list.stopped?.[0]?.stoppedAt).toBe(new Date(c.now()).toISOString());
    expect(count(c.db, 'pull_request')).toBe(4);
  });

  it('is 404 for a repo this machine never saw', async () => {
    const c = await widgets();
    const res = await appFor(c).del('/api/repos/acme/never-added');
    expect(res.status).toBe(404);
    expect((await error(res)).code).toBe('not_found');
  });

  it('adding a stopped repo again brings it back with the same rows and no duplicate (P-18)', async () => {
    const c = await widgets();
    const { post, del, get } = appFor(c);
    await post('/api/repos', { input: 'acme/widgets' });
    await c.refresh();
    const before = rows<{ node_id: string }>(
      c.db,
      'SELECT node_id FROM pull_request ORDER BY node_id',
    );
    await del('/api/repos/acme/widgets');
    // A PR merged while it was not tracked.
    c.github.addPr('Acme/Widgets', {
      nodeId: 'PR_w_9',
      number: 9,
      title: 'While stopped',
      mergedAt: new Date(c.now() - 3_600_000).toISOString(),
      author: 'octo-kelvin',
      mergedBy: 'octo-kelvin',
    });

    const res = await post('/api/repos', { input: 'https://github.com/Acme/Widgets' });

    expect(res.status).toBe(201);
    const body = AddRepoResponse.parse(await res.json());
    expect(body).toMatchObject({
      id: 'acme/widgets',
      trackingState: 'active',
      reactivated: true,
      mergedPrsLast12Months: 4,
      backfillComplete: false,
      stoppedAt: null,
    });
    expect(repoRows(c)).toHaveLength(1);
    expect(rows(c.db, 'SELECT node_id FROM pull_request ORDER BY node_id')).toEqual(before);

    // The next pass fills the gap by upserting, never doubling a row.
    expect(await c.refresh()).toMatchObject({ result: 'succeeded', imported: 1 });
    expect(count(c.db, 'pull_request')).toBe(5);
    const list = ReposResponse.parse(await (await get('/api/repos')).json());
    expect(list.active?.[0]).toMatchObject({ mergedPrsLast12Months: 5, backfillComplete: true });
  });
});

describe('POST /api/repos/{owner}/{name}/recheck', () => {
  it('marks computed links stale and starts a refresh when an accessible repository was renamed', async () => {
    const c = await widgets();
    const requestSync = vi.fn(() => readLinkHealth(c.db).state);
    const { post } = appFor(c, { requestSync });
    await post('/api/repos', { input: 'acme/widgets' });
    requestSync.mockClear();
    recomputeLinks(c.db, c.now());
    c.github.failNext({
      match: (request) => request.path === '/repos/acme/widgets',
      status: 200,
      body: { full_name: 'Acme/Tools', node_id: WIDGETS.nodeId },
    });

    const result = await post('/api/repos/acme/widgets/recheck');

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ displayName: 'Acme/Tools', accessState: 'ok' });
    expect(readLinkHealth(c.db).state).toBe('stale');
    expect(requestSync.mock.results).toEqual([{ type: 'return', value: 'stale' }]);
  });

  it('stores "inaccessible" and the sentence for a repo GitHub no longer hands over, then ok when it is back', async () => {
    const c = await widgets({ signIn: 'app', installed: ['Acme'] });
    const requestSync = vi.fn();
    const { post } = appFor(c, { requestSync });
    await post('/api/repos', { input: 'acme/widgets' });
    requestSync.mockClear();
    // The App is uninstalled from the owner.
    c.github.installedOwners.clear();

    const gone = await post('/api/repos/acme/widgets/recheck');

    expect(gone.status).toBe(200);
    expect(AddRepoResponse.parse(await gone.json())).toMatchObject({
      accessState: 'inaccessible',
      accessError:
        'Install your Agent Productivity HQ GitHub App on acme and give it this repository, then check again.',
    });
    expect(requestSync).not.toHaveBeenCalled();

    c.github.installApp('acme');
    const back = await post('/api/repos/acme/widgets/recheck');

    expect(AddRepoResponse.parse(await back.json())).toMatchObject({
      accessState: 'ok',
      accessError: null,
    });
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it('is 404 for an unknown repo, and an error (nothing changed) when GitHub gives no answer', async () => {
    const c = await widgets();
    const { post } = appFor(c);
    expect((await post('/api/repos/acme/nope/recheck')).status).toBe(404);

    await post('/api/repos', { input: 'acme/widgets' });
    c.github.failNext({ match: (r) => r.path.startsWith('/repos/'), status: 500 });
    const res = await post('/api/repos/acme/widgets/recheck');

    expect(res.status).toBe(502);
    expect(repoRows(c)).toHaveLength(1);
    expect(
      rows<{ access_state: string }>(c.db, 'SELECT access_state FROM repo')[0]?.access_state,
    ).toBe('ok');
  });
});

describe('what the add and the sync never expose', () => {
  it('keeps every token out of responses, the database and the log', async () => {
    const c = await widgets({ signIn: 'app', installed: ['Acme'] });
    setMeta(c.db, 'github_login', c.github.appLogin);
    const { post } = appFor(c);
    const texts: string[] = [];
    for (const input of ['acme/widgets', 'acme/widgets', 'acme/missing', 'nonsense']) {
      texts.push(await (await post('/api/repos', { input })).text());
    }
    texts.push(JSON.stringify(await c.refresh()));
    texts.push(JSON.stringify(rows(c.db, 'SELECT * FROM repo')), JSON.stringify(c.logs.entries));

    expect(c.github.tokens.length).toBeGreaterThan(0);
    for (const token of c.github.tokens) expect(texts.join('\n')).not.toContain(token);
    expect(c.github.requests.some((r) => r.clientSecret)).toBe(false);
  });
});
