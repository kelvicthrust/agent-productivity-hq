import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from '../../src/server/collectors/github/ports.ts';
import { ConnectPollResponse, ConnectResponse } from '../../src/shared/contracts/accounts.ts';
import { NOW, tempConfig } from './helpers.ts';
import {
  CLIENT_ID,
  filesText,
  scriptedGithub,
  startWithGithub,
  type Started,
} from './github-boot.ts';

// G6_7 through the real app (M6_AUTH_RATE_LIMIT): the real boot, the real routes and sync, over the scripted GitHub. When GitHub
// rate-limits the sign-in check itself (GET /user), whether it says so in the headers (retry-after, an empty quota) or only in
// the words of a bare 403 (a secondary or abuse limit), the app shows "Waiting for GitHub rate limit until <time>", keeps the pull
// requests it already has and the saved App sign-in, asks GitHub nothing inside the window, and reads again once it has passed.
// Adding a repo and Connect say the same wait instead of "couldn’t be reached" or "Reconnect needed".

const HOUR = 3_600_000;
const REPO = 'kelvin/atlas-api';
const TOKEN_SHAPE = /\bgh[pousr]_[A-Za-z0-9]{8,}/;

const SECONDARY = {
  message:
    'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  documentation_url:
    'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
};
const ABUSE = {
  message:
    'You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.',
};
const QUOTA_LEFT = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' };

type Limit = { status: number; headers?: Record<string, string>; body?: unknown };
/** The ways GitHub can limit the sign-in check, each with the wait the app must show at 13:00 in Los Angeles (21:00Z). */
const LIMITS: Record<string, { limit: Limit; until: string }> = {
  'a retry-after header': {
    limit: { status: 403, headers: { 'retry-after': '120' } },
    until: '1:02 PM',
  },
  'an empty hourly quota': {
    limit: {
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Date.parse('2026-11-04T21:30:00Z') / 1000),
      },
    },
    until: '1:30 PM',
  },
  'a bare 429': { limit: { status: 429 }, until: '1:01 PM' },
  'only the words of a secondary limit (403, quota left, no retry-after)': {
    limit: { status: 403, headers: QUOTA_LEFT, body: SECONDARY },
    until: '1:01 PM',
  },
  'only the words of an abuse limit (403, quota left, no retry-after)': {
    limit: { status: 403, headers: QUOTA_LEFT, body: ABUSE },
    until: '1:01 PM',
  },
};

const onUser = (r: { path: string }) => r.path === '/user';
const pullRequests = (db: DatabaseSync) =>
  (db.prepare('SELECT COUNT(*) AS n FROM pull_request').get() as { n: number }).n;

function dump(db: DatabaseSync): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map((t) => `${t.name} ${JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())}`)
    .join('\n');
}
const leaks = (text: string, tokens: readonly string[]): string[] => [
  ...tokens.filter((token) => text.includes(token)).map(() => 'an issued token'),
  ...(TOKEN_SHAPE.test(text) ? ['a token-shaped value'] : []),
];

async function finishedFlow(s: Started, loginId: string) {
  for (let i = 0; i < 400; i += 1) {
    const poll = ConnectPollResponse.parse(
      (await s.send('GET', `/api/accounts/github/connect/${loginId}`)).json,
    );
    if (poll.state !== 'pending') return poll;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('the sign-in did not finish');
}

/** Signed in through gh (or the App), the repo added and its three pull requests read; the clock then moves to 13:00. */
async function started(route: 'gh' | 'app'): Promise<Started> {
  const clock = { now: NOW };
  const scripted = scriptedGithub(clock);
  scripted.github.installApp('kelvin');
  const s = await startWithGithub({
    config: tempConfig(),
    clock,
    scripted,
    ghSignedIn: route === 'gh',
  });
  if (route === 'app') {
    expect((await s.send('PUT', '/api/accounts/github/app', { clientId: CLIENT_ID })).status).toBe(
      200,
    );
    const flow = ConnectResponse.parse(
      (await s.send('POST', '/api/accounts/github/connect', {})).json,
    );
    expect((await finishedFlow(s, flow.loginId as string)).state).toBe('connected');
  }
  expect((await s.send('POST', '/api/repos', { input: REPO })).status).toBe(201);
  await s.untilBackfilled(REPO);
  expect(pullRequests(s.db())).toBe(3);
  clock.now += HOUR;
  return s;
}

const githubSource = async (s: Started) =>
  (
    (await s.send('GET', '/api/sources')).json as { sources: Record<string, unknown>[] }
  ).sources.find((source) => source['id'] === 'github');
const githubAccount = async (s: Started) =>
  (
    (await s.send('GET', '/api/sources')).json as { accounts: Record<string, unknown>[] }
  ).accounts.find((account) => account['id'] === 'github');

describe('a rate limit on the sign-in check, through the real app', () => {
  describe.each(Object.entries(LIMITS))('%s', (_name, { limit, until }) => {
    it('on the gh route is a wait: the pull requests stay, nothing is asked inside the window, the next read after it works', async () => {
      const s = await started('gh');
      s.github.failNext({ ...limit, match: onUser });

      const run = await s.refreshGithub();

      expect(run.state).toBe('partial');
      expect(run.sources['github']).toMatchObject({
        state: 'partial',
        message: `Waiting for GitHub rate limit until ${until}`,
      });
      expect(pullRequests(s.db())).toBe(3);
      // Sources shows the attempt as partial (a wait), not failed
      expect(await githubSource(s)).toMatchObject({
        status: 'partial',
        lastAttemptResult: 'partial',
      });
      expect(JSON.stringify(run)).not.toMatch(/Reconnect|couldn’t be reached/);

      // inside the window the next refresh asks GitHub nothing
      const asked = s.github.requests.length;
      const inside = await s.refreshGithub();
      expect(inside.sources['github']).toMatchObject({ state: 'partial' });
      expect(s.github.requests).toHaveLength(asked);

      // the window passes: the same sign-in reads again
      s.clock.now += 2 * HOUR;
      const after = await s.refreshGithub();
      expect(after.state).toBe('succeeded');
      expect(pullRequests(s.db())).toBe(3);
      await s.stop();
    });

    it('on the App route keeps the saved sign-in: no refresh, no Keychain deletion, still connected', async () => {
      const s = await started('app');
      const before = s.keyring.snapshot();
      const issued = s.github.issued.length;
      const asked = s.github.requests.length;
      s.github.failNext({ ...limit, match: onUser });

      const run = await s.refreshGithub();

      expect(run.sources['github']).toMatchObject({
        state: 'partial',
        message: `Waiting for GitHub rate limit until ${until}`,
      });
      expect(pullRequests(s.db())).toBe(3);
      // nothing was refreshed and the saved pair is exactly what it was
      expect(s.github.issued).toHaveLength(issued);
      expect(s.github.requests.slice(asked).some((r) => r.host === 'github.com')).toBe(false);
      expect(s.keyring.snapshot()).toEqual(before);
      expect((await githubAccount(s))?.['status']).toBe('connected');

      s.clock.now += 2 * HOUR;
      expect((await s.refreshGithub()).state).toBe('succeeded');
      await s.stop();
    });
  });

  it('is the same wait when adding a repo and when pressing Connect, in the words of the same time', async () => {
    const s = await started('gh');
    s.github.addRepo({ fullName: 'Kelvin/Other-Repo', nodeId: 'R_other0001' }, []);
    s.github.failNext({
      ...LIMITS['only the words of a secondary limit (403, quota left, no retry-after)']!.limit,
      match: onUser,
    });
    s.github.failNext({ ...LIMITS['a retry-after header']!.limit, match: onUser });

    const added = await s.send('POST', '/api/repos', { input: 'kelvin/other-repo' });
    expect(added.status).toBe(502);
    expect(added.json).toMatchObject({
      error: {
        code: 'upstream_unavailable',
        retryable: true,
        message: 'GitHub is limiting requests until 1:01 PM. Try again then.',
      },
    });
    expect(((await s.send('GET', '/api/repos')).json as { active: unknown[] }).active).toHaveLength(
      1,
    );

    const connect = await s.send('POST', '/api/accounts/github/connect', {});
    expect(connect.status).toBe(502);
    expect(connect.json).toMatchObject({
      error: {
        code: 'upstream_unavailable',
        message: 'GitHub is limiting requests until 1:02 PM. Try again then.',
      },
    });
    await s.stop();
  });

  it('keeps an unrelated 403 a refusal (control): the App pair is refreshed once, refused, and Reconnect needed shows', async () => {
    const s = await started('app');
    for (let i = 0; i < 2; i += 1) {
      s.github.failNext({
        status: 403,
        headers: QUOTA_LEFT,
        body: { message: 'Sorry. Your account was suspended.' },
        match: onUser,
      });
    }

    const run = await s.refreshGithub();

    expect(run.state).toBe('failed');
    expect(JSON.stringify(run)).not.toContain('Waiting for GitHub rate limit');
    expect(s.keyring.snapshot()).toEqual([]);
    expect((await githubAccount(s))?.['status']).toBe('reconnect');
    await s.stop();
  });

  it('leaves no GitHub token in any table, any file of the data folder, the log or any answer', async () => {
    const s = await started('app');
    s.github.failNext({
      ...LIMITS['only the words of a secondary limit (403, quota left, no retry-after)']!.limit,
      match: onUser,
    });
    await s.refreshGithub();
    s.clock.now += 2 * HOUR;
    s.github.failNext({ ...LIMITS['a retry-after header']!.limit, match: onUser });
    await s.refreshGithub();
    await s.send('POST', '/api/accounts/github/connect', {});
    await s.send('GET', '/api/sources');

    // the double issued tokens and the Keychain kept the one fixed service and account
    expect(s.github.tokens.length).toBeGreaterThanOrEqual(2);
    expect(
      s.keyring.calls.every(
        (c) => c.service === KEYCHAIN_SERVICE && c.account === KEYCHAIN_ACCOUNT,
      ),
    ).toBe(true);
    const tables = dump(s.db());
    await s.stop();
    expect(leaks(tables, s.github.tokens)).toEqual([]);
    expect(leaks(filesText(s.config.dataDir), s.github.tokens)).toEqual([]);
    expect(leaks(JSON.stringify(s.entries), s.github.tokens)).toEqual([]);
    expect(leaks(s.bodies.join('\n'), s.github.tokens)).toEqual([]);
  });
});
