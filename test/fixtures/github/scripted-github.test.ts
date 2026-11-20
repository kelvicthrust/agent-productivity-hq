import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFakeGithub,
  createMemoryKeyring,
  fakeGh,
  mintToken,
  type FakeGithub,
  type FakePr,
} from './scripted-github.ts';

// The doubles every M6 test leans on: if one of them is wrong, a test built on it proves nothing. So they are tested here,
// against the behaviour the product has to cope with (data-and-sources › GitHub delivery).

const API = 'https://api.github.com';
const OAUTH = 'https://github.com';
const AUTH = 'authorization';
const bearer = (token: string): Record<string, string> => {
  const headers: Record<string, string> = {};
  headers[AUTH] = ['Bearer', token].join(' ');
  return headers;
};
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

function world(): { github: FakeGithub; clock: { now: number } } {
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  const github = createFakeGithub({ now: () => clock.now });
  return { github, clock };
}

const pr = (number: number, mergedAt: string | null, extra: Partial<FakePr> = {}): FakePr => ({
  nodeId: `PR_${number}`,
  number,
  title: `PR number ${number}`,
  mergedAt,
  author: 'octo-kelvin',
  mergedBy: 'octo-kelvin',
  ...extra,
});

describe('tokens', () => {
  it('are shaped like GitHub’s, unique, and never written out in the repository’s text', () => {
    const a = mintToken('ghu');
    const b = mintToken('ghu');
    expect(a).toMatch(/^ghu_[A-Za-z0-9]{36}$/);
    expect(mintToken('ghr')).toMatch(/^ghr_[A-Za-z0-9]{36}$/);
    expect(mintToken('gho')).toMatch(/^gho_[A-Za-z0-9]{36}$/);
    expect(a).not.toBe(b);
    for (const file of readdirSync(import.meta.dirname).filter((name) => name.endsWith('.ts'))) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      expect(text, file).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
    }
  });
});

describe('GET /user and the gh route', () => {
  it('knows the gh token and refuses anything else with 401', async () => {
    const { github } = world();
    const ok = await github.net(`${API}/user`, { headers: bearer(github.ghToken!) });
    expect(await ok.json()).toMatchObject({ login: 'octo-kelvin' });
    expect((await github.net(`${API}/user`, { headers: bearer('nope') })).status).toBe(401);
    expect((await github.net(`${API}/user`)).status).toBe(401);
    expect(github.requests.map((r) => r.token)).toEqual(['gh', 'unknown', 'none']);
  });

  it('gh answers with its token while signed in and with nothing after it signs out', async () => {
    const { github } = world();
    expect(await github.gh()).toBe(github.ghToken);
    github.signOutGh();
    expect(await github.gh()).toBeNull();
    expect(await fakeGh('x')()).toBe('x');
  });

  it('refuses a host it was not built to answer', async () => {
    const { github } = world();
    await expect(github.net('https://evil.example/user')).rejects.toThrow(/does not answer/);
  });
});

describe('the device flow and the token endpoint', () => {
  async function startFlow(github: FakeGithub, clientId = 'Iv1.testclient') {
    const res = await github.net(`${OAUTH}/login/device/code`, {
      method: 'POST',
      headers: { ...FORM, accept: 'application/json' },
      body: form({ client_id: clientId }),
    });
    return (await res.json()) as {
      device_code: string;
      user_code: string;
      interval: number;
      verification_uri: string;
    };
  }
  const poll = (github: FakeGithub, deviceCode: string) =>
    github.net(`${OAUTH}/login/oauth/access_token`, {
      method: 'POST',
      headers: { ...FORM, accept: 'application/json' },
      body: form({
        client_id: 'Iv1.testclient',
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

  it('answers pending, then slow_down with five seconds more, then the token pair', async () => {
    const { github, clock } = world();
    github.device = { interval: 5, pendingPolls: 1, slowDownAt: 2, outcome: 'approve' };
    const started = await startFlow(github);
    expect(started).toMatchObject({
      user_code: 'WXYZ-0000',
      verification_uri: 'https://github.com/login/device',
      interval: 5,
    });
    expect(await (await poll(github, started.device_code)).json()).toEqual({
      error: 'authorization_pending',
    });
    clock.now += 5000;
    expect(await (await poll(github, started.device_code)).json()).toEqual({
      error: 'slow_down',
      interval: 10,
    });
    clock.now += 10_000;
    const done = (await (await poll(github, started.device_code)).json()) as Record<
      string,
      unknown
    >;
    expect(done).toMatchObject({ token_type: 'bearer', expires_in: 28800 });
    expect(String(done['access_token'])).toMatch(/^ghu_/);
    expect(String(done['refresh_token'])).toMatch(/^ghr_/);
    expect(github.devicePolls).toEqual([clock.now - 15_000, clock.now - 10_000, clock.now]);
    expect(github.requests.some((r) => r.clientSecret)).toBe(false);
  });

  it('answers access_denied, expired_token, a disabled flow and a wrong client id', async () => {
    for (const outcome of ['deny', 'expire'] as const) {
      const { github } = world();
      github.device = { interval: 5, pendingPolls: 0, outcome };
      const started = await startFlow(github);
      const body = (await (await poll(github, started.device_code)).json()) as { error: string };
      expect(body.error).toBe(outcome === 'deny' ? 'access_denied' : 'expired_token');
    }
    const disabled = world().github;
    disabled.device = { interval: 5, pendingPolls: 0, outcome: 'approve', disabled: true };
    expect(await startFlow(disabled)).toMatchObject({ error: 'device_flow_disabled' });
    const wrong = world().github;
    wrong.validClientId = 'Iv1.right';
    expect(await startFlow(wrong, 'Iv1.wrong')).toMatchObject({
      error: 'incorrect_client_credentials',
    });
    expect(await startFlow(wrong, 'Iv1.right')).toHaveProperty('device_code');
  });

  it('refreshes with the refresh token alone, rotates it, and refuses it a second time', async () => {
    const { github } = world();
    github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
    const started = await startFlow(github);
    const first = (await (await poll(github, started.device_code)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const refresh = (token: string) =>
      github.net(`${OAUTH}/login/oauth/access_token`, {
        method: 'POST',
        headers: { ...FORM, accept: 'application/json' },
        body: form({
          client_id: 'Iv1.testclient',
          grant_type: 'refresh_token',
          refresh_token: token,
        }),
      });
    const second = (await (await refresh(first.refresh_token)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await (await refresh(first.refresh_token)).json()).toEqual({
      error: 'bad_refresh_token',
    });
    github.refreshNeedsSecret = true;
    expect(await (await refresh(second.refresh_token)).json()).toEqual({
      error: 'incorrect_client_credentials',
    });
    github.refreshNeedsSecret = false;
    github.revokeRefreshTokens = true;
    expect(await (await refresh(second.refresh_token)).json()).toEqual({
      error: 'bad_refresh_token',
    });
    expect(github.requests.some((r) => r.clientSecret)).toBe(false);
  });

  it('accepts the App token until it expires, then answers 401', async () => {
    const { github, clock } = world();
    github.device = { interval: 5, pendingPolls: 0, outcome: 'approve', accessTtl: 60 };
    const started = await startFlow(github);
    const grant = (await (await poll(github, started.device_code)).json()) as {
      access_token: string;
    };
    expect((await github.net(`${API}/user`, { headers: bearer(grant.access_token) })).status).toBe(
      200,
    );
    clock.now += 61_000;
    expect((await github.net(`${API}/user`, { headers: bearer(grant.access_token) })).status).toBe(
      401,
    );
  });
});

describe('repositories', () => {
  it('answers the gh token for any repo, and an App token only where the App is installed', async () => {
    const { github } = world();
    github
      .addRepo({ fullName: 'Acme/Widgets', nodeId: 'R_1' })
      .addRepo({ fullName: 'Other/Thing', nodeId: 'R_2' });
    github.installApp('acme');
    github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
    const code = (await (
      await github.net(`${OAUTH}/login/device/code`, {
        method: 'POST',
        body: form({ client_id: 'x' }),
      })
    ).json()) as { device_code: string };
    const grant = (await (
      await github.net(`${OAUTH}/login/oauth/access_token`, {
        method: 'POST',
        body: form({
          client_id: 'x',
          device_code: code.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    ).json()) as { access_token: string };

    const viaGh = (path: string) =>
      github.net(`${API}${path}`, { headers: bearer(github.ghToken!) });
    const viaApp = (path: string) =>
      github.net(`${API}${path}`, { headers: bearer(grant.access_token) });
    expect(await (await viaGh('/repos/acme/widgets')).json()).toMatchObject({
      full_name: 'Acme/Widgets',
      node_id: 'R_1',
    });
    expect((await viaGh('/repos/other/thing')).status).toBe(200);
    expect((await viaApp('/repos/acme/widgets')).status).toBe(200);
    expect((await viaApp('/repos/other/thing')).status).toBe(404);
    expect((await viaGh('/repos/nobody/none')).status).toBe(404);
  });

  it('resolves a renamed repository to its new name', async () => {
    const { github } = world();
    github.addRepo({ fullName: 'Acme/New-Name', nodeId: 'R_9', aliases: ['Acme/Old-Name'] });
    const res = await github.net(`${API}/repos/acme/old-name`, {
      headers: bearer(github.ghToken!),
    });
    expect(await res.json()).toMatchObject({ full_name: 'Acme/New-Name', node_id: 'R_9' });
  });
});

describe('the merged-PR GraphQL page', () => {
  const query = (
    github: FakeGithub,
    variables: Record<string, unknown>,
    text = 'query MergedPRs { repository { id } }',
  ) =>
    github.net(`${API}/graphql`, {
      method: 'POST',
      headers: bearer(github.ghToken!),
      body: JSON.stringify({ query: text, variables }),
    });

  it('returns merged PRs only, newest update first, 50 at a time with a cursor, and counts the rate limit down', async () => {
    const { github } = world();
    const merged = Array.from({ length: 60 }, (_, i) =>
      pr(i + 1, `2026-10-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`, {
        updatedAt: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T10:30:00Z`,
      }),
    );
    github.addRepo({ fullName: 'Acme/Widgets', nodeId: 'R_1' }, [
      ...merged,
      pr(100, null, { state: 'CLOSED' }),
      pr(101, null, { state: 'OPEN' }),
    ]);
    const first = (await (
      await query(github, { owner: 'acme', name: 'widgets', after: null })
    ).json()) as {
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: { number: number; mergedAt: string }[];
          };
        };
        rateLimit: { remaining: number; cost: number };
      };
    };
    const page = first.data.repository.pullRequests;
    expect(page.nodes).toHaveLength(50);
    expect(page.pageInfo.hasNextPage).toBe(true);
    expect(page.nodes.every((n) => n.mergedAt !== null)).toBe(true);
    expect(page.nodes.map((n) => n.number)).not.toContain(100);
    expect(first.data.rateLimit).toMatchObject({ remaining: 4899, cost: 1 });
    const second = (await (
      await query(github, { owner: 'acme', name: 'widgets', after: page.pageInfo.endCursor })
    ).json()) as typeof first;
    expect(second.data.repository.pullRequests.nodes).toHaveLength(10);
    expect(second.data.repository.pullRequests.pageInfo.hasNextPage).toBe(false);
    const seen = new Set(
      [...page.nodes, ...second.data.repository.pullRequests.nodes].map((n) => n.number),
    );
    expect(seen.size).toBe(60);
  });

  it('carries the first 100 commits and the true total, and serves the rest on the REST page', async () => {
    const { github } = world();
    const commits = Array.from({ length: 130 }, (_, i) => `sha${String(i).padStart(3, '0')}`);
    github.addRepo({ fullName: 'Acme/Widgets', nodeId: 'R_1' }, [
      pr(7, '2026-10-02T10:00:00Z', { commits }),
    ]);
    const body = (await (await query(github, { owner: 'acme', name: 'widgets' })).json()) as {
      data: {
        repository: {
          pullRequests: { nodes: { commits: { totalCount: number; nodes: unknown[] } }[] };
        };
      };
    };
    expect(body.data.repository.pullRequests.nodes[0]?.commits).toMatchObject({ totalCount: 130 });
    expect(body.data.repository.pullRequests.nodes[0]?.commits.nodes).toHaveLength(100);
    const rest = (await (
      await github.net(`${API}/repos/acme/widgets/pulls/7/commits?per_page=100&page=2`, {
        headers: bearer(github.ghToken!),
      })
    ).json()) as { sha: string }[];
    expect(rest.map((c) => c.sha)).toEqual(commits.slice(100));
  });

  it('says NOT_FOUND for a repo the token cannot see, refuses a mutation and flags it, and honours a scripted failure', async () => {
    const { github } = world();
    github.addRepo({ fullName: 'Acme/Widgets', nodeId: 'R_1' });
    const missing = (await (await query(github, { owner: 'nobody', name: 'none' })).json()) as {
      data: { repository: unknown };
      errors: { type: string }[];
    };
    expect(missing.data.repository).toBeNull();
    expect(missing.errors[0]?.type).toBe('NOT_FOUND');
    expect(
      (await query(github, {}, 'mutation { addStar(input: {}) { clientMutationId } }')).status,
    ).toBe(400);
    expect(github.sawMutation).toBe(true);
    github.failNext({
      status: 403,
      headers: { 'retry-after': '30' },
      body: { message: 'secondary rate limit' },
    });
    const limited = await query(github, { owner: 'acme', name: 'widgets' });
    expect(limited.status).toBe(403);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect((await query(github, { owner: 'acme', name: 'widgets' })).status).toBe(200);
  });
});

describe('the in-memory Keychain', () => {
  it('stores, reads and deletes by service and account, records its calls, and can refuse like a locked Keychain', () => {
    const keyring = createMemoryKeyring();
    expect(keyring.get('s', 'a')).toBeNull();
    keyring.set('s', 'a', 'secret-1');
    expect(keyring.get('s', 'a')).toBe('secret-1');
    expect(keyring.get('s', 'b')).toBeNull();
    expect(keyring.snapshot()).toEqual([{ service: 's', account: 'a', secret: 'secret-1' }]);
    expect(keyring.delete('s', 'a')).toBe(true);
    expect(keyring.delete('s', 'a')).toBe(false);
    keyring.refuse = 'User interaction is not allowed.';
    expect(() => keyring.get('s', 'a')).toThrow('User interaction is not allowed.');
    expect(keyring.calls.map((c) => c.op)).toEqual([
      'get',
      'set',
      'get',
      'get',
      'delete',
      'delete',
      'get',
    ]);
  });
});
