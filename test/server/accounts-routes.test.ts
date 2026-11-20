import { describe, expect, it, vi } from 'vitest';
import { ConnectPollResponse, ConnectResponse } from '../../src/shared/contracts/accounts.ts';
import { ErrorEnvelope } from '../../src/shared/contracts/errors.ts';
import { AccountStatus, SourcesResponse } from '../../src/shared/contracts/sources.ts';
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from '../../src/server/collectors/github/ports.ts';
import { createGithubAccounts } from '../../src/server/services/accounts-github.ts';
import {
  createFakeGithub,
  createMemoryKeyring,
  mintToken,
} from '../fixtures/github/scripted-github.ts';
import { HOST, PORT, WRITE, call, memoryDb, testApp } from './helpers.ts';

// G6_2 to G6_4 at the HTTP layer: the four account routes over the real account service, on the scripted GitHub and an
// in-memory Keychain (the real route is E6). The scan at the end follows a whole sign-in, refresh and disconnect and looks for
// every token the double issued in every table, the log and every response body.

const CLIENT_ID = 'Iv1.testclient';
const T0 = Date.parse('2026-11-04T20:00:00Z');
const HOUR = 3_600_000;

function setup() {
  const clock = { now: T0 };
  const github = createFakeGithub({ now: () => clock.now });
  const keyring = createMemoryKeyring();
  const db = memoryDb();
  const accounts = createGithubAccounts({
    db,
    net: github.net,
    keyring,
    gh: github.gh,
    now: () => clock.now,
    // A wait takes no time but moves the double's clock, so a 15-minute flow runs at once.
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  const harness = testApp({ db, github: accounts });
  /** Every response body this test read, for the scan. */
  const bodies: string[] = [];
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await call(harness.app, path, {
      method,
      headers: method === 'GET' ? HOST : WRITE,
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text, json: (text ? JSON.parse(text) : null) as unknown };
  };
  return { clock, github, keyring, accounts, bodies, send, ...harness };
}

type Setup = ReturnType<typeof setup>;

const errorOf = (json: unknown) => ErrorEnvelope.parse(json).error;

async function finished(s: Setup, loginId: string) {
  let last: { status: number; json: unknown } = { status: 0, json: null };
  await vi.waitFor(async () => {
    last = await s.send('GET', `/api/accounts/github/connect/${loginId}`);
    expect((last.json as { state: string }).state).not.toBe('pending');
  });
  return ConnectPollResponse.parse(last.json);
}

async function signInThroughRoutes(s: Setup) {
  s.github.signOutGh();
  expect((await s.send('PUT', '/api/accounts/github/app', { clientId: CLIENT_ID })).status).toBe(
    200,
  );
  const started = await s.send('POST', '/api/accounts/github/connect', {});
  expect(started.status).toBe(200);
  const connect = ConnectResponse.parse(started.json);
  expect(connect.mode).toBe('device');
  return finished(s, connect.loginId as string);
}

describe('GET /api/sources', () => {
  it('carries no accounts when the process has no GitHub integration', async () => {
    const h = testApp();
    const res = await call(h.app, '/api/sources', { headers: HOST });
    expect(res.status).toBe(200);
    expect(Object.keys(SourcesResponse.parse(await res.json()))).not.toContain('accounts');
  });

  it('carries the GitHub card, from the account service', async () => {
    const s = setup();
    const res = await s.send('GET', '/api/sources');
    const parsed = SourcesResponse.parse(res.json);
    expect(parsed.accounts).toEqual([
      expect.objectContaining({
        id: 'github',
        name: 'GitHub',
        status: 'existing',
        via: 'gh',
        statusText: 'Using your GitHub CLI sign-in',
        appClientIdSaved: false,
      }),
    ]);
  });

  it('keeps the local sources and the running run beside it', async () => {
    const s = setup();
    const parsed = SourcesResponse.parse((await s.send('GET', '/api/sources')).json);
    expect(parsed.running).toBeNull();
    expect(Array.isArray(parsed.sources)).toBe(true);
  });
});

describe('POST /api/accounts/github/connect', () => {
  it('answers {mode: existing} when gh is signed in, and starts no device flow', async () => {
    const s = setup();
    const res = await s.send('POST', '/api/accounts/github/connect', {});
    expect(res.status).toBe(200);
    expect(ConnectResponse.parse(res.json)).toEqual({ loginId: null, mode: 'existing' });
    expect(s.github.requests.some((r) => r.host === 'github.com')).toBe(false);
  });

  it('works with no body at all (a bare POST)', async () => {
    const s = setup();
    const res = await call(s.app, '/api/accounts/github/connect', {
      method: 'POST',
      headers: WRITE,
    });
    expect(res.status).toBe(200);
  });

  it('asks for the one-time App setup, with the guide address, when gh is out and no client ID is saved', async () => {
    const s = setup();
    s.github.signOutGh();
    const res = await s.send('POST', '/api/accounts/github/connect', {});
    expect(res.status).toBe(422);
    const error = errorOf(res.json);
    expect(error.code).toBe('github_app_required');
    expect(error.details).toEqual({ guideUrl: '/sources' });
    expect(error.retryable).toBe(false);
  });

  it('names the App setting to change when device flow is off', async () => {
    const s = setup();
    s.github.signOutGh();
    await s.send('PUT', '/api/accounts/github/app', { clientId: CLIENT_ID });
    s.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve', disabled: true };
    const res = await s.send('POST', '/api/accounts/github/connect', {});
    expect(res.status).toBe(422);
    expect(errorOf(res.json)).toMatchObject({
      code: 'github_app_required',
      details: { reason: 'device_flow_disabled' },
    });
    expect(errorOf(res.json).message).toContain('Enable Device Flow');
  });

  it('says 502 upstream_unavailable (retryable) when GitHub cannot be reached', async () => {
    const s = setup();
    s.github.signOutGh();
    await s.send('PUT', '/api/accounts/github/app', { clientId: CLIENT_ID });
    s.github.failNext({ status: 502, match: (r) => r.path === '/login/device/code' });
    const res = await s.send('POST', '/api/accounts/github/connect', {});
    expect(res.status).toBe(502);
    expect(errorOf(res.json)).toMatchObject({ code: 'upstream_unavailable', retryable: true });
  });
});

describe('the device flow through the routes', () => {
  it('shows the code, connects, shows on Sources, and disconnects', async () => {
    const s = setup();
    s.github.signOutGh();
    await s.send('PUT', '/api/accounts/github/app', { clientId: CLIENT_ID });
    s.github.device = { interval: 5, pendingPolls: 2, outcome: 'approve' };

    const started = await s.send('POST', '/api/accounts/github/connect', {});
    const connect = ConnectResponse.parse(started.json);
    expect(connect).toMatchObject({
      mode: 'device',
      userCode: 'WXYZ-0000',
      verificationUri: 'https://github.com/login/device',
    });
    expect(typeof connect.loginId).toBe('string');

    const done = await finished(s, connect.loginId as string);
    expect(done.state).toBe('connected');
    expect(done.account).toMatchObject({ id: 'github', status: 'connected', via: 'app' });

    const sources = SourcesResponse.parse((await s.send('GET', '/api/sources')).json);
    expect(sources.accounts?.[0]).toMatchObject({
      status: 'connected',
      statusText: 'Connected through your Agent Productivity HQ GitHub App',
      login: 'octo-kelvin',
      appClientIdSaved: true,
    });
    expect(s.keyring.snapshot()).toHaveLength(1);

    const out = await s.send('POST', '/api/accounts/github/disconnect', {});
    expect(out.status).toBe(200);
    expect(AccountStatus.parse(out.json)).toMatchObject({ status: 'notconnected', via: null });
    expect(s.keyring.snapshot()).toEqual([]);
    expect(
      SourcesResponse.parse((await s.send('GET', '/api/sources')).json).accounts?.[0]?.status,
    ).toBe('notconnected');
  });

  it('reads "expired" as an ending, with its sentence, and stores nothing', async () => {
    const s = setup();
    s.github.signOutGh();
    await s.send('PUT', '/api/accounts/github/app', { clientId: CLIENT_ID });
    s.github.device = { interval: 5, pendingPolls: 0, outcome: 'expire' };
    const connect = ConnectResponse.parse(
      (await s.send('POST', '/api/accounts/github/connect', {})).json,
    );
    const done = await finished(s, connect.loginId as string);
    expect(done).toMatchObject({ state: 'expired', message: 'The code expired, start again' });
    expect(s.keyring.snapshot()).toEqual([]);
  });

  it('answers 404 for a sign-in it never started, and for a wrong account', async () => {
    const s = setup();
    const unknown = await s.send('GET', '/api/accounts/github/connect/not-a-flow');
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown.json).code).toBe('not_found');
    const chatgpt = await s.send('GET', '/api/accounts/chatgpt/connect/anything');
    expect(chatgpt.status).toBe(404);
    const nobody = await s.send('GET', '/api/accounts/nobody/connect/anything');
    expect(nobody.status).toBe(404);
  });
});

describe('cancelling a sign-in that is waiting', () => {
  it('is Disconnect: the poll then says cancelled, and nothing is stored', async () => {
    const clock = { now: T0 };
    const github = createFakeGithub({ now: () => clock.now });
    github.signOutGh();
    const keyring = createMemoryKeyring();
    const db = memoryDb();
    const accounts = createGithubAccounts({
      db,
      net: github.net,
      keyring,
      gh: github.gh,
      now: () => clock.now,
      // The flow waits for GitHub's interval until it is told to stop.
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve())),
    });
    const { app } = testApp({ db, github: accounts });
    const send = async (method: string, path: string, body?: unknown) => {
      const res = await call(app, path, {
        method,
        headers: method === 'GET' ? HOST : WRITE,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: (await res.json()) as unknown };
    };
    await send('PUT', '/api/accounts/github/app', { clientId: CLIENT_ID });
    const started = ConnectResponse.parse(
      (await send('POST', '/api/accounts/github/connect', {})).json,
    );
    const poll = `/api/accounts/github/connect/${started.loginId}`;
    expect((await send('GET', poll)).json).toEqual({ state: 'pending' });

    const stopped = await send('POST', '/api/accounts/github/disconnect', {});
    expect(stopped.status).toBe(200);
    expect(AccountStatus.parse(stopped.json).status).not.toBe('connecting');
    expect((await send('GET', poll)).json).toEqual({
      state: 'cancelled',
      message: 'Sign-in was cancelled',
    });
    expect(keyring.snapshot()).toEqual([]);
    expect(
      SourcesResponse.parse((await send('GET', '/api/sources')).json).accounts?.[0]?.status,
    ).toBe('notconnected');
  });
});

describe('PUT /api/accounts/github/app', () => {
  it('saves the client ID and answers the new status', async () => {
    const s = setup();
    s.github.signOutGh();
    const res = await s.send('PUT', '/api/accounts/github/app', { clientId: 'Iv23liABC123.def' });
    expect(res.status).toBe(200);
    expect(AccountStatus.parse(res.json)).toMatchObject({
      id: 'github',
      status: 'notconnected',
      appClientIdSaved: true,
    });
    // the client ID is the only thing stored
    expect(
      s.db.prepare("SELECT value FROM app_meta WHERE key = 'github_app_client_id'").get(),
    ).toEqual({ value: 'Iv23liABC123.def' });
  });

  for (const [name, body] of [
    ['empty', { clientId: '' }],
    ['too long', { clientId: 'I'.repeat(41) }],
    ['with a space', { clientId: 'Iv1 abc' }],
    ['a URL', { clientId: 'https://github.com/settings/apps/x' }],
    ['not a string', { clientId: 123 }],
    ['missing', {}],
    ['an array', ['Iv1.abc']],
    ['a string', '"Iv1.abc"'],
    ['not JSON', '{clientId'],
  ] as const) {
    it(`refuses a body that is ${name}, with 400 and no change`, async () => {
      const s = setup();
      const res = await s.send('PUT', '/api/accounts/github/app', body);
      expect(res.status).toBe(400);
      expect(errorOf(res.json).code).toBe('invalid_input');
      expect(s.db.prepare("SELECT 1 FROM app_meta WHERE key = 'github_app_client_id'").get()).toBe(
        undefined,
      );
    });
  }

  it('never accepts a client secret, and does not repeat what it was sent', async () => {
    const s = setup();
    const secret = 'not-a-real-secret-value-0123456789';
    const res = await s.send('PUT', '/api/accounts/github/app', {
      clientId: CLIENT_ID,
      clientSecret: secret,
    });
    expect(res.status).toBe(400);
    expect(errorOf(res.json).message).toContain('client secret');
    expect(res.text).not.toContain(secret);
    expect(s.db.prepare("SELECT 1 FROM app_meta WHERE key = 'github_app_client_id'").get()).toBe(
      undefined,
    );
    expect(JSON.stringify(s.entries)).not.toContain(secret);
  });
});

describe('disconnect and the other accounts', () => {
  it('stops reading gh on the gh route, and says so', async () => {
    const s = setup();
    const res = await s.send('POST', '/api/accounts/github/disconnect', {});
    expect(res.status).toBe(200);
    expect(AccountStatus.parse(res.json).status).toBe('needsapp');
    // it only looked at the Keychain to describe what is left; nothing was written or deleted
    expect(s.keyring.calls.filter((call) => call.op !== 'get')).toEqual([]);
    // and gh stays signed in: Connect puts it back in use
    expect(s.github.ghToken).not.toBeNull();
    const again = await s.send('POST', '/api/accounts/github/connect', {});
    expect(ConnectResponse.parse(again.json).mode).toBe('existing');
    const sources = SourcesResponse.parse((await s.send('GET', '/api/sources')).json);
    expect(sources.accounts?.[0]?.status).toBe('existing');
  });

  it('guides callers to the available account actions when generic sign-in is unavailable', async () => {
    const s = setup();
    for (const [path, text] of [
      ['/api/accounts/chatgpt/connect', 'ChatGPT sign-in isn’t available yet.'],
      ['/api/accounts/chatgpt/disconnect', 'ChatGPT sign-in isn’t available yet.'],
      [
        '/api/accounts/claude/connect',
        'Use Sources to check plan limits with your Claude Code sign-in.',
      ],
      ['/api/accounts/claude/disconnect', 'Claude has no sign-in to disconnect here.'],
    ] as const) {
      const res = await s.send('POST', path, {});
      expect(res.status, path).toBe(422);
      expect(errorOf(res.json).message).toBe(text);
    }
  });

  it('answers 404 for an account that does not exist', async () => {
    const s = setup();
    expect((await s.send('POST', '/api/accounts/nobody/connect', {})).status).toBe(404);
    expect((await s.send('POST', '/api/accounts/nobody/disconnect', {})).status).toBe(404);
  });
});

describe('a process with no GitHub integration', () => {
  it('says GitHub is not available here, as github_not_connected', async () => {
    const h = testApp();
    for (const [method, path, body] of [
      ['POST', '/api/accounts/github/connect', {}],
      ['GET', '/api/accounts/github/connect/x', undefined],
      ['POST', '/api/accounts/github/disconnect', {}],
      ['PUT', '/api/accounts/github/app', { clientId: CLIENT_ID }],
    ] as const) {
      const res = await call(h.app, path, {
        method,
        headers: method === 'GET' ? HOST : WRITE,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, `${method} ${path}`).toBe(422);
      expect(errorOf(await res.json()).code).toBe('github_not_connected');
    }
  });
});

describe('the guards cover the account routes', () => {
  it('refuses a write without the request header (403) and a foreign Host (421)', async () => {
    const s = setup();
    for (const [method, path] of [
      ['POST', '/api/accounts/github/connect'],
      ['POST', '/api/accounts/github/disconnect'],
      ['PUT', '/api/accounts/github/app'],
    ] as const) {
      const noHeader = await call(s.app, path, {
        method,
        headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID }),
      });
      expect(noHeader.status, `${method} ${path}`).toBe(403);
      const foreign = await call(s.app, path, {
        method,
        headers: { ...WRITE, host: 'evil.example:4317' },
        body: JSON.stringify({ clientId: CLIENT_ID }),
      });
      expect(foreign.status, `${method} ${path}`).toBe(421);
    }
    const poll = await call(s.app, '/api/accounts/github/connect/x', {
      headers: { host: 'evil.example:4317' },
    });
    expect(poll.status).toBe(421);
    // none of that reached the service
    expect(s.github.requests).toEqual([]);
    expect(s.db.prepare("SELECT 1 FROM app_meta WHERE key = 'github_app_client_id'").get()).toBe(
      undefined,
    );
  });
});

// ---- G6_4: no token in SQLite, the log or an API response ----

/** Every row of every table, as text. */
function dumpDb(s: Setup): string {
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map((t) => `${t.name} ${JSON.stringify(s.db.prepare(`SELECT * FROM "${t.name}"`).all())}`)
    .join('\n');
}

const TOKEN_SHAPE = /\bgh[pousr]_[A-Za-z0-9]{8,}/;

/** What a scan of `text` finds: the tokens this double issued and anything token-shaped. */
function leaks(text: string, tokens: readonly string[]): string[] {
  return [
    ...tokens.filter((token) => text.includes(token)).map(() => 'an issued token'),
    ...(TOKEN_SHAPE.test(text) ? ['a token-shaped value'] : []),
  ];
}

describe('no token appears in SQLite, the log or any response', () => {
  it('survives a whole sign-in, refresh, refused refresh, error path and disconnect', async () => {
    const s = setup();

    // sign in through the device flow
    expect((await signInThroughRoutes(s)).state).toBe('connected');
    await s.send('GET', '/api/sources');

    // a refresh: the access token is about to expire, the sync's credential check refreshes it
    s.clock.now += 8 * HOUR - 60_000;
    expect((await s.accounts.auth.credential()).ok).toBe(true);
    await s.send('GET', '/api/sources');

    // a refused refresh: Reconnect needed, entry deleted
    s.github.revokeRefreshTokens = true;
    s.clock.now += 9 * HOUR;
    expect(await s.accounts.auth.credential()).toMatchObject({ ok: false, reason: 'reconnect' });
    s.clock.now += 60_000;
    await s.send('GET', '/api/sources');

    // an error path with the App's settings wrong, and a disconnect
    s.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve', disabled: true };
    await s.send('POST', '/api/accounts/github/connect', {});
    await s.send('POST', '/api/accounts/github/disconnect', {});

    // gh signs in too: its token is in the double's list as well
    s.github.signInGh();
    s.clock.now += 60_000;
    await s.send('POST', '/api/accounts/github/connect', {});
    await s.send('GET', '/api/sources');

    // the double really issued tokens: two App pairs' worth plus gh's own
    expect(s.github.tokens.length).toBeGreaterThanOrEqual(3);

    expect(leaks(dumpDb(s), s.github.tokens)).toEqual([]);
    expect(leaks(JSON.stringify(s.entries), s.github.tokens)).toEqual([]);
    expect(leaks(s.bodies.join('\n'), s.github.tokens)).toEqual([]);
    // and nothing was ever sent to GitHub with a client secret
    expect(s.github.requests.some((r) => r.clientSecret)).toBe(false);
  });

  it('puts the App token in the Keychain, under the fixed service and account, and nowhere else', async () => {
    const s = setup();
    await signInThroughRoutes(s);
    const [entry] = s.keyring.snapshot();
    expect(entry).toMatchObject({ service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT });
    const issued = s.github.issued[0];
    expect(entry?.secret).toContain(issued?.access);
    expect(leaks(dumpDb(s), s.github.tokens)).toEqual([]);
    expect(leaks(s.bodies.join('\n'), s.github.tokens)).toEqual([]);
  });

  // The scan must be able to fail: a negative control with a token planted in each place.
  it('would notice a token in a table, a log line or a response (negative control)', async () => {
    const s = setup();
    await signInThroughRoutes(s);
    const planted = s.github.issued[0]?.access as string;
    s.db.prepare("INSERT INTO app_meta (key, value) VALUES ('leak', ?)").run(planted);
    expect(leaks(dumpDb(s), s.github.tokens)).toEqual(['an issued token', 'a token-shaped value']);
    expect(leaks(JSON.stringify({ msg: `failed with ${planted}` }), s.github.tokens)).toContain(
      'an issued token',
    );
    // a token the double never issued is still caught by its shape
    expect(leaks(`x ${mintToken('ghu')} y`, [])).toEqual(['a token-shaped value']);
    expect(leaks(`x ${mintToken('ghr')} y`, [])).toEqual(['a token-shaped value']);
  });
});
