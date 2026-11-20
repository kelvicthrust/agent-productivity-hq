import { describe, expect, it, vi } from 'vitest';
import { stopRepo, trackRepo } from '../../../src/server/db/queries/repos.ts';
import { RepoDiscoveryResponse } from '../../../src/shared/contracts/repos.ts';
import { appFor, count, crew } from './helpers.ts';

const account = { login: 'octo-kelvin', via: 'gh' };
const discover = (page = 1) =>
  `/api/repos/discover?login=${account.login}&via=${account.via}&page=${page}`;
const pushedAt = '2026-10-16T18:00:00Z';

describe('repository discovery', () => {
  it('lists metadata in push order, finds renamed tracked repositories by node ID, and imports nothing', async () => {
    const c = await crew();
    const sync = vi.fn();
    trackRepo(c.db, {
      id: 'acme/old',
      nodeId: 'node-for-current',
      displayName: 'Acme/Old',
      now: c.now(),
    });
    stopRepo(c.db, 'acme/old', c.now());
    c.github.failNext({
      match: (request) => request.path === '/user/repos',
      status: 200,
      body: [
        {
          full_name: 'Acme/Current',
          node_id: 'node-for-current',
          pushed_at: pushedAt,
          private: true,
          temp_clone_token: 'never project this',
        },
        { full_name: 'Acme/Other', node_id: 'node-for-other', pushed_at: null, private: false },
      ],
      headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
    });

    const response = await appFor(c, { requestSync: sync }).get(discover());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      repositories: [
        {
          displayName: 'Acme/Current',
          nodeId: 'node-for-current',
          pushedAt,
          visibility: 'private',
          trackingState: 'stopped',
          trackedRepoId: 'acme/old',
        },
        {
          displayName: 'Acme/Other',
          nodeId: 'node-for-other',
          pushedAt: null,
          visibility: 'public',
          trackingState: 'untracked',
          trackedRepoId: null,
        },
      ],
      nextPage: 2,
    });
    expect(count(c.db, 'repo')).toBe(1);
    expect(count(c.db, 'pull_request')).toBe(0);
    expect(sync).not.toHaveBeenCalled();
    expect(c.github.requests.some((request) => request.path === '/graphql')).toBe(false);
  });

  it('rejects a stale picker account before reading another account’s repository list', async () => {
    const c = await crew({ login: 'another-account' });

    const response = await appFor(c).get(discover(2));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'github_account_changed' } });
    expect(c.github.requests.some((request) => request.path === '/user/repos')).toBe(false);
  });

  it('keeps an App listing within its installed owners and reads a continuation with the same account', async () => {
    const c = await crew({ signIn: 'app', installed: ['Acme'] });
    for (let i = 0; i < 31; i += 1) {
      c.github.addRepo({ fullName: `Acme/Repo-${i}`, nodeId: `repo-node-${i}` });
    }
    c.github.addRepo({ fullName: 'Other/Private', nodeId: 'inaccessible-node' });
    const { get } = appFor(c);
    const url = `/api/repos/discover?login=${c.github.appLogin}&via=app`;

    const first = await get(url);
    expect(first.status).toBe(200);
    const firstPage = RepoDiscoveryResponse.parse(await first.json());
    expect(firstPage.repositories).toHaveLength(30);
    expect(firstPage.nextPage).toBe(2);
    const last = await get(`${url}&page=${firstPage.nextPage}`);
    expect(last.status).toBe(200);
    expect(await last.json()).toMatchObject({
      repositories: [{ displayName: 'Acme/Repo-30' }],
      nextPage: null,
    });
    expect(c.github.requests.filter((request) => request.path === '/user/repos')).toEqual([
      expect.objectContaining({
        token: 'app',
        query: '?sort=pushed&direction=desc&per_page=30&page=1',
      }),
      expect.objectContaining({
        token: 'app',
        query: '?sort=pushed&direction=desc&per_page=30&page=2',
      }),
    ]);
  });

  it('stops a discovery retry when a 401 changes the credential route or login', async () => {
    const c = await crew();
    const auth = {
      credential: async () =>
        ({ ok: true, credential: { token: 'initial-fixture', ...account, via: 'gh' } }) as const,
      refreshAfter401: async () =>
        ({
          ok: true,
          credential: { token: 'different-fixture', login: 'another-login', via: 'app' },
        }) as const,
    };
    const net = vi.fn(async () => new Response(null, { status: 401 }));
    const response = await appFor({ ...c, auth, net }).get(discover());

    expect(response.status).toBe(409);
    expect(net).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ error: { code: 'github_account_changed' } });
  });

  it('rejects a discovered row when the slug now names a different repository', async () => {
    const c = await crew();
    c.github.addRepo({ fullName: 'Acme/Reused', nodeId: 'different-node' });
    const response = await appFor(c).post('/api/repos', {
      input: 'Acme/Reused',
      githubAccount: account,
      repositoryNodeId: 'old-node',
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'repo_inaccessible' } });
    expect(count(c.db, 'repo')).toBe(0);
  });
});
