import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { ConnectPollResponse, ConnectResponse } from '../../../src/shared/contracts/accounts.ts';
import { ErrorEnvelope } from '../../../src/shared/contracts/errors.ts';
import { AccountStatus } from '../../../src/shared/contracts/sources.ts';
import { readObserved } from '../../../src/server/collectors/chatgpt/observed.ts';
import {
  markChatgptDisconnected,
  readChatgptConnection,
  readDailyTokenSpan,
} from '../../../src/server/db/queries/accounts.ts';
import {
  apiNotFound,
  correlation,
  errorHandler,
  type HttpEnv,
} from '../../../src/server/http/errors.ts';
import { csrfGuard, hostGuard, securityHeaders } from '../../../src/server/http/guards.ts';
import { accountRoutes } from '../../../src/server/http/routes/accounts.ts';
import { CHATGPT_FLOW_MESSAGE } from '../../../src/server/services/accounts.ts';
import { HOST, NOW, PORT, WRITE, memoryDb, memoryLogger } from '../../server/helpers.ts';
import { SENTINEL, accounts, everything, world, type Accounts } from './helpers.ts';
import { loadScenario, withMethods } from './scripted.ts';

// G9_2: Connect starts Codex's own browser sign-in and the page polls it. The routes run over the real service on a scripted
// app-server: no Codex, no browser, no network. What is asserted is what the owner and the page can observe, and that nothing of the
// sign-in (the provider's login id, its sentences, a token) is kept, logged or answered beyond the one address the browser needs.

const START = loadScenario('login-ok').methods['account/login/start'];
if (START === undefined || typeof START === 'string' || !('result' in START))
  throw new Error('login-ok');

/** A sign-in that stays pending until the test writes `account/login/completed` (no notification comes with the answer). */
const pending = () =>
  withMethods(loadScenario('login-ok'), { 'account/login/start': { result: START.result } });

const COMPLETED = (success: boolean) => ({
  method: 'account/login/completed',
  params: {
    loginId: 'SENTINEL_LOGIN_ID_d1',
    success,
    error: success ? null : 'SENTINEL_NOTE_f3 denied',
  },
});

const errorOf = (json: unknown) => ErrorEnvelope.parse(json).error;

async function connect(a: Accounts) {
  const res = await a.post('/api/accounts/chatgpt/connect');
  expect(res.status, res.text).toBe(200);
  return ConnectResponse.parse(res.json);
}

async function ended(a: Accounts, loginId: string) {
  let last: { status: number; json: unknown } = { status: 0, json: null };
  await vi.waitFor(async () => {
    last = await a.get(`/api/accounts/chatgpt/connect/${loginId}`);
    expect((last.json as { state: string }).state).not.toBe('pending');
  });
  return ConnectPollResponse.parse(last.json);
}

describe('Connect with no sign-in yet', () => {
  it('starts Codex’s browser sign-in and answers with the address to open, a login id of its own and when it runs out', async () => {
    const a = accounts(pending(), { hold: true });
    const answer = await connect(a);
    expect(answer).toMatchObject({
      mode: 'browser',
      authUrl: expect.stringMatching(/^https:\/\/auth\.example\.test\/oauth\/authorize/),
      userCode: null,
      verificationUri: null,
      expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    });
    // The id is the dashboard's own: Codex's login id is not handed to the browser or the page.
    expect(answer.loginId).toMatch(/^[0-9a-f-]{36}$/);
    const child = a.world.scripted.children[0]!;
    expect(child.methods()).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'account/login/start',
    ]);
    expect(child.received.at(-1)?.params).toEqual({ type: 'chatgpt' });
    // The app-server listens for the browser's return, so the child stays while the sign-in is pending.
    expect(child.killed).toBe(false);
    expect(a.service.status()).toMatchObject({
      status: 'connecting',
      statusText: 'Waiting for sign-in…',
    });
  });

  it('polls pending, then connected once Codex says it finished, and the child is gone', async () => {
    const a = accounts(pending(), { hold: true });
    const { loginId } = await connect(a);
    const first = ConnectPollResponse.parse(
      (await a.get(`/api/accounts/chatgpt/connect/${loginId}`)).json,
    );
    expect(first).toEqual({ state: 'pending' });

    a.world.scripted.children[0]!.emit(COMPLETED(true));
    const done = await ended(a, loginId!);
    expect(done.state).toBe('connected');
    expect(AccountStatus.parse(done.account)).toMatchObject({
      id: 'chatgpt',
      status: 'connected',
      via: 'codex',
    });
    expect(a.world.scripted.children[0]?.killed).toBe(true);
    expect(readChatgptConnection(a.world.db)).toEqual({ disconnected: false, connectedAt: NOW });
    expect(readObserved(a.world.db)?.state).toBe('ok');
    // The process is told, so the card fills at once instead of at the next timer.
    expect(a.connected()).toBe(1);
  });

  it('a sign-in Codex refuses ends failed with a sentence of ours, stores nothing and tells nobody', async () => {
    const a = accounts(loadScenario('login-denied'), { hold: true });
    const { loginId } = await connect(a);
    const done = await ended(a, loginId!);
    expect(done).toEqual({ state: 'failed', message: CHATGPT_FLOW_MESSAGE.failed });
    expect(JSON.stringify(done)).not.toMatch(SENTINEL);
    expect(readChatgptConnection(a.world.db).connectedAt).toBeNull();
    expect(a.connected()).toBe(0);
    expect(a.world.scripted.children[0]?.killed).toBe(true);
    expect(a.service.status()).toMatchObject({ status: 'notconnected' });
  });

  it('a sign-in that is not finished in time ends expired and the child is killed', async () => {
    // Not held: the child has nothing more to say, so the wait runs out at once.
    const a = accounts(pending());
    const { loginId } = await connect(a);
    expect(await ended(a, loginId!)).toEqual({
      state: 'expired',
      message: CHATGPT_FLOW_MESSAGE.expired,
    });
    expect(a.world.scripted.children[0]?.killed).toBe(true);
    expect(a.connected()).toBe(0);
  });

  it('Cancel ends a waiting sign-in, kills the child and stores nothing', async () => {
    const a = accounts(pending(), { hold: true });
    const { loginId } = await connect(a);
    a.service.cancel(loginId!);
    expect(
      ConnectPollResponse.parse((await a.get(`/api/accounts/chatgpt/connect/${loginId}`)).json),
    ).toEqual({
      state: 'cancelled',
      message: CHATGPT_FLOW_MESSAGE.cancelled,
    });
    expect(a.world.scripted.children[0]?.killed).toBe(true);
    expect(a.connected()).toBe(0);
    expect(a.service.status().status).toBe('notconnected');
  });

  it('starting another sign-in ends the one that is waiting, so only one child listens at a time', async () => {
    const a = accounts(pending(), { hold: true });
    const first = await connect(a);
    const second = await connect(a);
    expect(second.loginId).not.toBe(first.loginId);
    const [one, two] = a.world.scripted.children;
    expect(one?.killed).toBe(true);
    expect(two?.killed).toBe(false);
    expect((await a.get(`/api/accounts/chatgpt/connect/${first.loginId}`)).json).toMatchObject({
      state: 'cancelled',
    });
    expect((await a.get(`/api/accounts/chatgpt/connect/${second.loginId}`)).json).toEqual({
      state: 'pending',
    });
  });

  it('two Connect presses at once start one sign-in after the other, never two beside each other', async () => {
    const a = accounts(pending(), { hold: true });
    const [x, y] = await Promise.all([
      a.post('/api/accounts/chatgpt/connect'),
      a.post('/api/accounts/chatgpt/connect'),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const alive = a.world.scripted.children.filter((child) => !child.killed);
    expect(alive).toHaveLength(1);
  });

  it('Disconnect while a sign-in is waiting ends it', async () => {
    const a = accounts(pending(), { hold: true });
    const { loginId } = await connect(a);
    const res = await a.post('/api/accounts/chatgpt/disconnect');
    expect(res.status).toBe(200);
    expect((await a.get(`/api/accounts/chatgpt/connect/${loginId}`)).json).toMatchObject({
      state: 'cancelled',
    });
    expect(a.world.scripted.children[0]?.killed).toBe(true);
  });

  it('close() kills the child of a sign-in that is still waiting', async () => {
    const a = accounts(pending(), { hold: true });
    await connect(a);
    a.service.close();
    expect(a.world.scripted.children[0]?.killed).toBe(true);
  });
});

describe('Connect when it cannot start', () => {
  it('an address that is not https is no sign-in: nothing is opened and the child is killed', async () => {
    for (const authUrl of [
      'http://auth.example.test/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
    ]) {
      const a = accounts(
        withMethods(loadScenario('login-ok'), {
          'account/login/start': { result: { type: 'chatgpt', loginId: 'x', authUrl } },
        }),
      );
      const res = await a.post('/api/accounts/chatgpt/connect');
      expect(res.status, authUrl).toBe(502);
      expect(errorOf(res.json).code).toBe('upstream_unavailable');
      expect(a.world.scripted.children[0]?.killed, authUrl).toBe(true);
    }
  });

  it('no codex on this computer is a 422 in plain words, and the card says so', async () => {
    const a = accounts(null);
    const res = await a.post('/api/accounts/chatgpt/connect');
    expect(res.status).toBe(422);
    expect(errorOf(res.json)).toMatchObject({
      code: 'invalid_input',
      message: CHATGPT_FLOW_MESSAGE.noCodex,
      details: { reason: 'codex_not_found' },
    });
    expect(a.service.status()).toMatchObject({ status: 'unavailable', reason: 'codex_not_found' });
  });

  it('Codex that does not answer is a 502 that can be retried, and the child is killed', async () => {
    const a = accounts(withMethods(loadScenario('login-ok'), { initialize: 'silent' }));
    const res = await a.post('/api/accounts/chatgpt/connect');
    expect(res.status).toBe(502);
    expect(errorOf(res.json)).toMatchObject({
      code: 'upstream_unavailable',
      retryable: true,
      message: CHATGPT_FLOW_MESSAGE.slow,
    });
    expect(a.world.scripted.children[0]?.killed).toBe(true);
  });

  it('a program that cannot be started is a 502 too', async () => {
    const a = accounts(loadScenario('login-ok'), { failWith: 'EACCES' });
    const res = await a.post('/api/accounts/chatgpt/connect');
    expect(res.status).toBe(502);
    expect(errorOf(res.json).message).toBe(CHATGPT_FLOW_MESSAGE.broken);
  });
});

describe('Connect when Codex is already signed in with ChatGPT', () => {
  it('asks nothing of the owner: mode existing, no sign-in started, the child killed', async () => {
    const a = accounts(loadScenario('signed-in'));
    const answer = await connect(a);
    expect(answer).toEqual({ loginId: null, mode: 'existing' });
    const child = a.world.scripted.children[0]!;
    expect(child.methods()).not.toContain('account/login/start');
    expect(child.killed).toBe(true);
    expect(a.service.status()).toMatchObject({ status: 'existing' });
  });

  it('puts reading back after Disconnect without asking for anything', async () => {
    const a = accounts(loadScenario('signed-in'));
    markChatgptDisconnected(a.world.db);
    expect(a.service.status()).toMatchObject({ status: 'notconnected', reason: 'disconnected' });
    expect(await connect(a)).toEqual({ loginId: null, mode: 'existing' });
    expect(readChatgptConnection(a.world.db).disconnected).toBe(false);
    expect(a.service.status()).toMatchObject({ status: 'connected' });
    expect(a.connected()).toBe(1);
  });
});

describe('Disconnect', () => {
  it('stops the dashboard reading, starts no program, signs nobody out and keeps what was imported', async () => {
    const a = accounts(loadScenario('chatgpt-with-threads'));
    await a.world.refresh();
    const launches = a.world.scripted.launches();
    const res = await a.post('/api/accounts/chatgpt/disconnect');
    expect(res.status).toBe(200);
    expect(AccountStatus.parse(res.json)).toMatchObject({
      id: 'chatgpt',
      status: 'notconnected',
      reason: 'disconnected',
      via: null,
    });
    expect(a.world.scripted.launches()).toBe(launches);
    expect(a.world.scripted.children.flatMap((c) => c.methods())).not.toEqual(
      expect.arrayContaining(['account/logout']),
    );
    expect(readDailyTokenSpan(a.world.db, 'chatgpt')?.days).toBe(7);
    // And a refresh does not start Codex either.
    expect(await a.world.refresh()).toMatchObject({ result: 'skipped' });
    expect(a.world.scripted.launches()).toBe(launches);
  });

  it('is the same card when pressed twice', async () => {
    const a = accounts(null);
    const one = await a.post('/api/accounts/chatgpt/disconnect');
    const two = await a.post('/api/accounts/chatgpt/disconnect');
    expect(two.json).toEqual(one.json);
  });
});

describe('the routes', () => {
  it('an unknown sign-in is a 404 in plain words', async () => {
    const a = accounts(null);
    const res = await a.get('/api/accounts/chatgpt/connect/not-a-login');
    expect(res.status).toBe(404);
    expect(errorOf(res.json).code).toBe('not_found');
  });

  it('only the page may press Connect or Disconnect: a request without the app header is refused', async () => {
    const a = accounts(loadScenario('login-ok'));
    const app = new Hono<HttpEnv>();
    const logs = memoryLogger();
    app.use('*', correlation());
    app.use('*', securityHeaders());
    app.use('*', hostGuard(PORT, logs.logger));
    app.use('*', csrfGuard(logs.logger));
    app.onError(errorHandler(logs.logger));
    app.route('/', accountRoutes({ chatgpt: a.service }));
    for (const path of ['/api/accounts/chatgpt/connect', '/api/accounts/chatgpt/disconnect']) {
      const res = await app.request(`http://127.0.0.1:${PORT}${path}`, {
        method: 'POST',
        headers: HOST,
        body: '{}',
      });
      expect(res.status, path).toBe(403);
    }
    expect(a.world.scripted.launches()).toBe(0);
  });

  it('a process with no ChatGPT service answers as it did before M9, and Claude still has no sign-in', async () => {
    const app = new Hono<HttpEnv>();
    const logs = memoryLogger();
    app.onError(errorHandler(logs.logger));
    app.route('/', accountRoutes({}));
    app.all('/api/*', apiNotFound);
    const post = (path: string) =>
      app.request(`http://127.0.0.1:${PORT}${path}`, {
        method: 'POST',
        headers: WRITE,
        body: '{}',
      });
    for (const path of ['/api/accounts/chatgpt/connect', '/api/accounts/chatgpt/disconnect']) {
      const res = await post(path);
      expect(res.status, path).toBe(422);
      expect(errorOf(await res.json()).message).toBe('ChatGPT sign-in isn’t available yet.');
    }
    expect((await post('/api/accounts/claude/connect')).status).toBe(422);
    expect(
      (
        await app.request(`http://127.0.0.1:${PORT}/api/accounts/chatgpt/connect/x`, {
          headers: HOST,
        })
      ).status,
    ).toBe(404);
  });

  it('GitHub’s routes are untouched by the ChatGPT ones', async () => {
    const a = accounts(null);
    // No GitHub integration is mounted here, so GitHub answers its own "not available" error, not a ChatGPT one.
    const res = await a.post('/api/accounts/github/connect');
    expect(errorOf(res.json).code).toBe('github_not_connected');
  });
});

describe('what is kept of a sign-in', () => {
  it('nothing the app-server said: not its login id, its sentences, or the address beyond the one answer that needs it', async () => {
    const a = accounts(pending(), { hold: true });
    const bodies: string[] = [];
    const connectRes = await a.post('/api/accounts/chatgpt/connect');
    const { loginId } = ConnectResponse.parse(connectRes.json);
    // The browser address is the one thing that is handed on, once, in this answer.
    expect(connectRes.text).toContain('SENTINEL_STATE_e2');
    expect(connectRes.text).not.toContain('SENTINEL_LOGIN_ID');

    bodies.push((await a.get(`/api/accounts/chatgpt/connect/${loginId}`)).text);
    a.world.scripted.children[0]!.emit(COMPLETED(true));
    await ended(a, loginId!);
    bodies.push((await a.get(`/api/accounts/chatgpt/connect/${loginId}`)).text);
    bodies.push(JSON.stringify(a.service.status()));
    bodies.push((await a.post('/api/accounts/chatgpt/disconnect')).text);

    for (const body of bodies) expect(body).not.toMatch(SENTINEL);
    expect(everything(a.world.db)).not.toMatch(SENTINEL);
    expect(JSON.stringify(a.world.logs.entries)).not.toMatch(SENTINEL);
  });
});

describe('the world the helpers build', () => {
  it('a fresh database has no ChatGPT connection state', () => {
    const w = world(null, { db: memoryDb() });
    expect(readChatgptConnection(w.db)).toEqual({ disconnected: false, connectedAt: null });
  });
});
