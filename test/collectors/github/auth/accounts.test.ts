import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { getMeta, setMeta } from '../../../../src/server/db/queries/meta.ts';
import {
  FLOW_MESSAGE,
  GITHUB_APP_GUIDE_URL,
  STATUS_TTL_MS,
  createGithubAccounts,
  type Sleep,
} from '../../../../src/server/services/accounts-github.ts';
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
} from '../../../../src/server/collectors/github/ports.ts';
import { MemoryKeyring } from '../../../fixtures/github/scripted-github.ts';
import { memoryDb } from '../../../server/helpers.ts';
import { CLIENT_ID, savedToken, signInApp, world, type World } from './helpers.ts';

// G6_2 / G6_4: the device flow end to end on the scripted GitHub and an in-memory Keychain (the real route is E6): the
// interval and slow_down, the four designed endings, Keychain storage, refresh failure → Reconnect needed, Disconnect.

const SECOND = 1000;

interface Setup {
  w: World;
  db: DatabaseSync;
  keyring: MemoryKeyring;
  accounts: ReturnType<typeof createGithubAccounts>;
  /** Every wait the flow asked for, in milliseconds. */
  sleeps: number[];
}

/** A sleep that takes no time but moves the double's clock, so a fifteen-minute flow runs in microseconds. */
function setup(
  options: {
    keyring?: MemoryKeyring;
    sleep?: (w: World, sleeps: number[]) => Sleep;
    gh?: (w: World) => () => Promise<string | null>;
    logins?: { login?: string; appLogin?: string };
  } = {},
): Setup {
  const w = world(options.logins);
  const db = memoryDb();
  const sleeps: number[] = [];
  const keyring = options.keyring ?? w.keyring;
  const sleep: Sleep =
    options.sleep?.(w, sleeps) ??
    (async (ms) => {
      sleeps.push(ms);
      w.clock.now += ms;
    });
  const accounts = createGithubAccounts({
    db,
    net: w.github.net,
    keyring,
    gh: options.gh?.(w) ?? w.github.gh,
    now: () => w.clock.now,
    sleep,
    timezone: 'America/Los_Angeles',
  });
  return { w, db, keyring, accounts, sleeps };
}

/** A sleep that waits for the test to let it go (or for the flow to be stopped). */
function gated(w: World, sleeps: number[]) {
  const waiting: (() => void)[] = [];
  const sleep: Sleep = (ms, signal) =>
    new Promise<void>((resolve) => {
      sleeps.push(ms);
      waiting.push(() => {
        w.clock.now += ms;
        resolve();
      });
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  return {
    sleep,
    waiting,
    /** Lets the flow go on one step, once it is waiting. */
    async step() {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      waiting.shift()?.();
    },
  };
}

const saveClient = (s: Setup) => s.accounts.saveClientId(CLIENT_ID);
const settled = async (s: Setup, loginId: string) => {
  let last = await s.accounts.poll(loginId);
  await vi.waitFor(async () => {
    last = await s.accounts.poll(loginId);
    expect(last.state).not.toBe('pending');
  });
  return last;
};
async function connectDevice(s: Setup) {
  const started = await s.accounts.connect();
  expect(started.mode).toBe('device');
  return started.loginId as string;
}

/** Every row of every table, as text: where a token must never be. */
function dumpDb(db: DatabaseSync): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all()))
    .join('\n');
}

describe('status', () => {
  it('says "Using your GitHub CLI sign-in" when gh is signed in, and does not touch the Keychain', async () => {
    const s = setup();
    const status = await s.accounts.status();
    expect(status).toMatchObject({
      id: 'github',
      status: 'existing',
      via: 'gh',
      statusText: 'Using your GitHub CLI sign-in',
      appClientIdSaved: false,
    });
    expect(s.keyring.calls).toEqual([]);
  });

  it('asks for the one-time App setup when gh is out and no client ID is saved', async () => {
    const s = setup();
    s.w.github.signOutGh();
    expect(await s.accounts.status()).toMatchObject({
      status: 'needsapp',
      appClientIdSaved: false,
      via: null,
    });
  });

  it('offers Connect once a client ID is saved', async () => {
    const s = setup();
    s.w.github.signOutGh();
    const saved = saveClient(s);
    expect(saved).toMatchObject({ status: 'notconnected', appClientIdSaved: true });
    expect(await s.accounts.status()).toMatchObject({
      status: 'notconnected',
      appClientIdSaved: true,
    });
  });

  it('says "Connected through your Agent Productivity HQ GitHub App" for a saved App sign-in', async () => {
    const s = setup();
    await signInApp(s.w);
    s.w.github.signOutGh();
    setMeta(s.db, 'github_login', 'octo-kelvin');
    expect(await s.accounts.status()).toMatchObject({
      status: 'connected',
      via: 'app',
      login: 'octo-kelvin',
      statusText: 'Connected through your Agent Productivity HQ GitHub App',
    });
  });

  it('says it could not read the Keychain, without throwing', async () => {
    const s = setup();
    s.w.github.signOutGh();
    s.keyring.refuse = 'the keychain is locked';
    const status = await s.accounts.status();
    expect(status.status).toBe('failed');
    expect(status.statusText).toBe('Couldn’t read the saved GitHub sign-in from your Keychain');
    expect(JSON.stringify(status)).not.toContain('locked');
  });

  it('learns the CLI login once so Setup can open an account-scoped picker', async () => {
    const s = setup();
    expect(await s.accounts.status()).toMatchObject({ status: 'existing', login: 'octo-kelvin' });
    await s.accounts.status();
    s.w.clock.now += STATUS_TTL_MS;
    await s.accounts.status();
    expect(s.w.github.requests.map((request) => request.path)).toEqual(['/user']);
  });
});

describe('two sign-ins that belong to different people', () => {
  /** An App sign-in for `appLogin` saved by a real device flow, then gh signed in again as `login`, and gh's login learned. */
  async function bothSignedIn(logins: { login: string; appLogin: string }) {
    const s = setup({ logins });
    s.w.github.signOutGh();
    saveClient(s);
    expect((await settled(s, await connectDevice(s))).state).toBe('connected');
    s.w.github.signInGh();
    expect((await s.accounts.auth.credential()).ok).toBe(true);
    return s;
  }

  it('keeps using gh and says whose each sign-in is', async () => {
    const s = await bothSignedIn({ login: 'octo-kelvin', appLogin: 'someone-else' });
    const status = await s.accounts.status();
    expect(status).toMatchObject({
      status: 'existing',
      via: 'gh',
      login: 'octo-kelvin',
      reason: 'login_mismatch',
    });
    expect(status.statusText).toContain('octo-kelvin');
    expect(status.statusText).toContain('someone-else');
    // the sync reads as the gh login, not the App one
    const credential = await s.accounts.auth.credential();
    expect(credential).toMatchObject({ ok: true, credential: { via: 'gh', login: 'octo-kelvin' } });
  });

  it('says nothing when both are the same person, and does not read the Keychain to find out', async () => {
    const s = await bothSignedIn({ login: 'octo-kelvin', appLogin: 'octo-kelvin' });
    s.keyring.calls.length = 0;
    const status = await s.accounts.status();
    expect(status.statusText).toBe('Using your GitHub CLI sign-in');
    expect(status.reason).toBeUndefined();
    expect(s.keyring.calls).toEqual([]);
  });

  it('compares the logins without regard to case', async () => {
    const s = await bothSignedIn({ login: 'Octo-Kelvin', appLogin: 'octo-kelvin' });
    expect((await s.accounts.status()).reason).toBeUndefined();
  });

  it('drops the warning once the App sign-in is gone from the Keychain', async () => {
    const s = await bothSignedIn({ login: 'octo-kelvin', appLogin: 'someone-else' });
    expect((await s.accounts.status()).reason).toBe('login_mismatch');
    s.keyring.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    s.w.clock.now += STATUS_TTL_MS;
    const status = await s.accounts.status();
    expect(status.statusText).toBe('Using your GitHub CLI sign-in');
    expect(status.reason).toBeUndefined();
    expect(getMeta(s.db, 'github_app_login')).toBe('');
  });

  it('forgets the App login when the App sign-in is disconnected', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    await settled(s, await connectDevice(s));
    expect(getMeta(s.db, 'github_app_login')).toBe('octo-kelvin');
    await s.accounts.disconnect();
    expect(getMeta(s.db, 'github_app_login')).toBe('');
  });

  it('forgets the App login when its refresh is refused', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    await settled(s, await connectDevice(s));
    s.w.github.revokeRefreshTokens = true;
    s.w.clock.now += 9 * 60 * 60 * SECOND;
    expect(await s.accounts.auth.credential()).toMatchObject({ ok: false, reason: 'reconnect' });
    expect(getMeta(s.db, 'github_app_login')).toBe('');
  });
});

describe('the status cache', () => {
  /** A `gh` that counts how often it was asked. */
  function counted() {
    const asked = { n: 0 };
    const gh = (w: World) => async () => {
      asked.n += 1;
      return w.github.gh();
    };
    return { asked, gh };
  }

  it('reuses one answer for ten seconds, so the polling Sources page does not run gh each time', async () => {
    const { asked, gh } = counted();
    const s = setup({ gh });
    const first = await s.accounts.status();
    await s.accounts.status();
    s.w.clock.now += STATUS_TTL_MS - 1;
    expect(await s.accounts.status()).toEqual(first);
    expect(asked.n).toBe(1);
    s.w.clock.now += 1;
    await s.accounts.status();
    expect(asked.n).toBe(2);
  });

  it('shows a change made outside the app after the ten seconds, not before', async () => {
    const s = setup();
    expect((await s.accounts.status()).status).toBe('existing');
    s.w.github.signOutGh();
    expect((await s.accounts.status()).status).toBe('existing');
    s.w.clock.now += STATUS_TTL_MS;
    expect((await s.accounts.status()).status).toBe('needsapp');
  });

  it('is dropped by saving a client ID, so Connect appears at once', async () => {
    const s = setup();
    s.w.github.signOutGh();
    expect((await s.accounts.status()).status).toBe('needsapp');
    saveClient(s);
    expect((await s.accounts.status()).status).toBe('notconnected');
  });

  it('is dropped by starting and finishing a device flow', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    expect((await s.accounts.status()).status).toBe('notconnected');
    const loginId = await connectDevice(s);
    await settled(s, loginId);
    expect(await s.accounts.status()).toMatchObject({ status: 'connected', login: 'octo-kelvin' });
  });

  it('is dropped by Disconnect', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    await settled(s, await connectDevice(s));
    expect((await s.accounts.status()).status).toBe('connected');
    await s.accounts.disconnect();
    expect((await s.accounts.status()).status).toBe('notconnected');
  });

  it('is dropped when the sync learns the App sign-in is refused', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    await settled(s, await connectDevice(s));
    expect((await s.accounts.status()).status).toBe('connected');
    s.w.github.revokeRefreshTokens = true;
    s.w.clock.now += 9 * 60 * 60 * SECOND - STATUS_TTL_MS;
    await s.accounts.auth.credential();
    expect((await s.accounts.status()).status).toBe('reconnect');
  });

  it('hands out copies, so a caller cannot change what the next one reads', async () => {
    const s = setup();
    const first = await s.accounts.status();
    first.statusText = 'changed';
    expect((await s.accounts.status()).statusText).toBe('Using your GitHub CLI sign-in');
  });
});

describe('the client ID', () => {
  it('is saved in app_meta and answers with the new status', () => {
    const s = setup();
    const status = s.accounts.saveClientId('Iv23liABC123.def');
    expect(getMeta(s.db, 'github_app_client_id')).toBe('Iv23liABC123.def');
    expect(status.appClientIdSaved).toBe(true);
  });

  it('replaces a saved one', () => {
    const s = setup();
    s.accounts.saveClientId('Iv1.one');
    s.accounts.saveClientId('Iv1.two');
    expect(getMeta(s.db, 'github_app_client_id')).toBe('Iv1.two');
  });

  for (const [name, value] of [
    ['empty', ''],
    ['too long', 'I'.repeat(41)],
    ['with a space', 'Iv1 abc'],
    ['with a dash', 'Iv1-abc'],
    ['with a slash', 'Iv1/abc'],
    ['a URL', 'https://github.com/settings/apps/x'],
  ] as const) {
    it(`refuses one that is ${name}, and keeps the saved one`, () => {
      const s = setup();
      s.accounts.saveClientId('Iv1.keep');
      expect(() => s.accounts.saveClientId(value)).toThrowError(
        expect.objectContaining({ code: 'invalid_input', status: 400 }),
      );
      expect(getMeta(s.db, 'github_app_client_id')).toBe('Iv1.keep');
    });
  }
});

describe('connect', () => {
  it('uses gh when it is signed in: {mode: existing}, no device flow, no Keychain, and the login is remembered', async () => {
    const s = setup();
    expect(await s.accounts.connect()).toEqual({ loginId: null, mode: 'existing' });
    expect(s.w.github.requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
      'GET api.github.com/user',
    ]);
    expect(s.keyring.calls).toEqual([]);
    expect(getMeta(s.db, 'github_login')).toBe('octo-kelvin');
  });

  it('uses a valid Keychain sign-in without a device flow', async () => {
    const s = setup();
    await signInApp(s.w);
    s.w.github.signOutGh();
    expect(await s.accounts.connect()).toEqual({ loginId: null, mode: 'existing' });
    expect(s.w.github.requests.some((r) => r.host === 'github.com')).toBe(false);
  });

  it('answers github_app_required with the guide when gh is out and no client ID is saved', async () => {
    const s = setup();
    s.w.github.signOutGh();
    await expect(s.accounts.connect()).rejects.toMatchObject({
      code: 'github_app_required',
      status: 422,
      details: { guideUrl: GITHUB_APP_GUIDE_URL },
    });
    expect(s.w.github.requests.some((r) => r.host === 'github.com')).toBe(false);
  });

  it('says when GitHub is limiting requests, with the time it gave, when the check of gh is rate-limited', async () => {
    const s = setup();
    s.w.github.failNext({
      status: 429,
      headers: { 'retry-after': '600' },
      match: (r) => r.path === '/user',
    });
    // T0 is 12:00 in Los Angeles; ten minutes on.
    await expect(s.accounts.connect()).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'GitHub is limiting requests until 12:10 PM. Try again then.',
    });
    expect(s.keyring.calls).toEqual([]);
  });

  it('says the same when the limit is only in the words of the check’s 403 (a secondary limit, no retry-after)', async () => {
    const s = setup();
    s.w.github.failNext({
      status: 403,
      headers: { 'x-ratelimit-remaining': '4999' },
      body: {
        message: 'You have triggered an abuse detection mechanism. Please wait a few minutes.',
      },
      match: (r) => r.path === '/user',
    });
    // T0 is 12:00 in Los Angeles; GitHub gave no time, so the default minute.
    await expect(s.accounts.connect()).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'GitHub is limiting requests until 12:01 PM. Try again then.',
    });
    expect(s.keyring.calls).toEqual([]);
  });

  it('says upstream_unavailable when the check of gh gets no answer', async () => {
    const s = setup();
    s.w.github.failNext({ status: 503 });
    await expect(s.accounts.connect()).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('says upstream_unavailable when GitHub cannot be reached for the device code', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    s.w.github.failNext({ status: 502, match: (r) => r.path === '/login/device/code' });
    await expect(s.accounts.connect()).rejects.toMatchObject({
      code: 'upstream_unavailable',
      retryable: true,
    });
  });

  it('says the Keychain refused, and does not start a flow that could not be saved', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    s.keyring.refuse = 'locked';
    await expect(s.accounts.connect()).rejects.toThrowError(/Keychain/);
    expect(s.w.github.requests.some((r) => r.host === 'github.com')).toBe(false);
  });
});

describe('the device flow', () => {
  it('shows the code, waits GitHub’s interval, stores the token pair in the Keychain and says connected', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    s.w.github.device = { interval: 5, pendingPolls: 2, outcome: 'approve' };
    const startedAt = s.w.clock.now;

    const started = await s.accounts.connect();
    expect(started).toMatchObject({
      mode: 'device',
      userCode: 'WXYZ-0000',
      verificationUri: 'https://github.com/login/device',
      expiresAt: new Date(startedAt + 900 * SECOND).toISOString(),
    });
    const done = await settled(s, started.loginId as string);

    expect(done.state).toBe('connected');
    expect(done.account).toMatchObject({
      id: 'github',
      status: 'connected',
      via: 'app',
      login: 'octo-kelvin',
    });
    // one wait of the interval before each poll, and the polls came that far apart
    expect(s.sleeps).toEqual([5000, 5000, 5000]);
    expect(s.w.github.devicePolls).toEqual([5000, 10_000, 15_000].map((ms) => startedAt + ms));

    // the token pair is in the Keychain, under the fixed service and account, and nowhere else
    expect(s.keyring.snapshot()).toHaveLength(1);
    expect(s.keyring.snapshot()[0]).toMatchObject({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT,
    });
    const saved = savedToken(s.keyring);
    const issued = s.w.github.issued[0];
    expect(saved?.['access_token']).toBe(issued?.access);
    expect(saved?.['refresh_token']).toBe(issued?.refresh);
    expect(saved?.['client_id']).toBe(CLIENT_ID);
    expect(saved?.['expires_at']).toBe(s.w.clock.now + 28_800 * SECOND);
    expect(getMeta(s.db, 'github_login')).toBe('octo-kelvin');
  });

  it('sends the client ID and never a client secret', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    await settled(s, await connectDevice(s));
    expect([...s.w.github.clientIds]).toEqual([CLIENT_ID]);
    expect(s.w.github.requests.some((r) => r.clientSecret)).toBe(false);
    // only the three endpoints of the flow, and GET /user with the new token
    expect(
      [...new Set(s.w.github.requests.map((r) => `${r.method} ${r.host}${r.path}`))].sort(),
    ).toEqual([
      'GET api.github.com/user',
      'POST github.com/login/device/code',
      'POST github.com/login/oauth/access_token',
    ]);
  });

  it('is shown as connecting while it waits, then as connected', async () => {
    const gate = { current: undefined as ReturnType<typeof gated> | undefined };
    const s = setup({
      sleep: (w, sleeps) => {
        gate.current = gated(w, sleeps);
        return gate.current.sleep;
      },
    });
    s.w.github.signOutGh();
    saveClient(s);
    s.w.github.device = { interval: 5, pendingPolls: 1, outcome: 'approve' };
    const id = await connectDevice(s);

    expect(await s.accounts.poll(id)).toEqual({ state: 'pending' });
    expect(await s.accounts.status()).toMatchObject({
      status: 'connecting',
      statusText: 'Waiting for sign-in…',
    });
    await gate.current?.step();
    await vi.waitFor(() => expect(s.w.github.devicePolls).toHaveLength(1));
    expect(await s.accounts.poll(id)).toEqual({ state: 'pending' });
    await gate.current?.step();
    expect((await settled(s, id)).state).toBe('connected');
    expect(await s.accounts.status()).toMatchObject({ status: 'connected' });
  });

  it('waits five seconds more after slow_down, and goes on at the slower pace', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    s.w.github.device = { interval: 5, pendingPolls: 1, slowDownAt: 2, outcome: 'approve' };
    const startedAt = s.w.clock.now;
    const done = await settled(s, await connectDevice(s));
    expect(done.state).toBe('connected');
    expect(s.sleeps).toEqual([5000, 5000, 10_000]);
    expect(s.w.github.devicePolls).toEqual([5000, 10_000, 20_000].map((ms) => startedAt + ms));
  });

  it('honours an interval longer than the one asked for at the start', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    s.w.github.device = { interval: 12, pendingPolls: 1, outcome: 'approve' };
    await settled(s, await connectDevice(s));
    expect(s.sleeps).toEqual([12_000, 12_000]);
  });

  it('survives a poll or two that fail to connect, and gives up after three in a row', async () => {
    const onToken = (r: { path: string }) => r.path === '/login/oauth/access_token';
    const retry = setup();
    retry.w.github.signOutGh();
    saveClient(retry);
    retry.w.github.failNext({ status: 503, match: onToken });
    retry.w.github.failNext({ status: 503, match: onToken });
    expect((await settled(retry, await connectDevice(retry))).state).toBe('connected');

    const giveUp = setup();
    giveUp.w.github.signOutGh();
    saveClient(giveUp);
    for (let i = 0; i < 3; i += 1) giveUp.w.github.failNext({ status: 503, match: onToken });
    const done = await settled(giveUp, await connectDevice(giveUp));
    expect(done).toEqual({ state: 'failed', message: FLOW_MESSAGE.unreachable });
    expect(giveUp.keyring.snapshot()).toEqual([]);
  });

  describe('how it ends badly (nothing is stored)', () => {
    it('access_denied: failed, "Sign-in was cancelled"', async () => {
      const s = setup();
      s.w.github.signOutGh();
      saveClient(s);
      s.w.github.device = { interval: 5, pendingPolls: 1, outcome: 'deny' };
      const done = await settled(s, await connectDevice(s));
      expect(done).toEqual({ state: 'failed', message: 'Sign-in was cancelled' });
      expect(s.keyring.snapshot()).toEqual([]);
      expect(await s.accounts.status()).toMatchObject({ status: 'notconnected' });
    });

    it('expired_token: expired, "The code expired, start again"', async () => {
      const s = setup();
      s.w.github.signOutGh();
      saveClient(s);
      s.w.github.device = { interval: 5, pendingPolls: 0, outcome: 'expire' };
      const done = await settled(s, await connectDevice(s));
      expect(done).toEqual({ state: 'expired', message: 'The code expired, start again' });
      expect(s.keyring.snapshot()).toEqual([]);
    });

    it('stops at the end of the code’s fifteen minutes on its own, polling no more after that', async () => {
      const s = setup();
      s.w.github.signOutGh();
      saveClient(s);
      s.w.github.device = { interval: 5, pendingPolls: 1_000_000, outcome: 'approve' };
      const startedAt = s.w.clock.now;
      const done = await settled(s, await connectDevice(s));
      expect(done).toEqual({ state: 'expired', message: FLOW_MESSAGE.expired });
      expect(s.w.clock.now).toBe(startedAt + 900 * SECOND);
      expect(s.w.github.devicePolls.every((at) => at < startedAt + 900 * SECOND)).toBe(true);
      expect(s.w.github.devicePolls.length).toBeLessThanOrEqual(180);
      expect(s.keyring.snapshot()).toEqual([]);
    });

    it('device_flow_disabled: github_app_required naming the App setting, and the client ID is kept', async () => {
      const s = setup();
      s.w.github.signOutGh();
      saveClient(s);
      s.w.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve', disabled: true };
      const error = await s.accounts.connect().catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'github_app_required',
        status: 422,
        details: { reason: 'device_flow_disabled' },
      });
      expect((error as Error).message).toMatch(/Enable Device Flow/);
      expect(getMeta(s.db, 'github_app_client_id')).toBe(CLIENT_ID);
      expect(await s.accounts.status()).toMatchObject({ status: 'notconnected' });
      expect(s.sleeps).toEqual([]);
    });

    it('incorrect_client_credentials: github_app_required naming the client ID, and the client ID is kept', async () => {
      const s = setup();
      s.w.github.signOutGh();
      s.accounts.saveClientId('Iv1.wrong');
      s.w.github.validClientId = CLIENT_ID;
      const error = await s.accounts.connect().catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'github_app_required',
        details: { reason: 'incorrect_client_credentials' },
      });
      expect((error as Error).message).toMatch(/client ID/);
      expect((error as Error).message).not.toMatch(/secret.*(paste|enter)/i);
      expect(getMeta(s.db, 'github_app_client_id')).toBe('Iv1.wrong');
    });

    it('a Keychain that refuses to save: failed, and nothing is half-written', async () => {
      class NoWrite extends MemoryKeyring {
        override set(): void {
          this.calls.push({ op: 'set', service: '', account: '' });
          throw new Error('denied');
        }
      }
      const s = setup({ keyring: new NoWrite() });
      s.w.github.signOutGh();
      saveClient(s);
      const done = await settled(s, await connectDevice(s));
      expect(done).toEqual({ state: 'failed', message: FLOW_MESSAGE.keychain });
      expect(s.keyring.snapshot()).toEqual([]);
      expect(getMeta(s.db, 'github_login')).toBeNull();
    });
  });

  describe('cancel', () => {
    it('stops the flow: cancelled, nothing polled afterwards, nothing stored', async () => {
      const gate = { current: undefined as ReturnType<typeof gated> | undefined };
      const s = setup({
        sleep: (w, sleeps) => {
          gate.current = gated(w, sleeps);
          return gate.current.sleep;
        },
      });
      s.w.github.signOutGh();
      saveClient(s);
      const id = await connectDevice(s);
      await vi.waitFor(() => expect(gate.current?.waiting.length).toBe(1));

      s.accounts.cancel(id);

      expect(await s.accounts.poll(id)).toEqual({
        state: 'cancelled',
        message: 'Sign-in was cancelled',
      });
      expect(await s.accounts.status()).toMatchObject({ status: 'notconnected' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(s.w.github.devicePolls).toEqual([]);
      expect(s.keyring.snapshot()).toEqual([]);
    });

    it('does nothing to a flow that has ended, or one it does not know', async () => {
      const s = setup();
      s.w.github.signOutGh();
      saveClient(s);
      const id = await connectDevice(s);
      expect((await settled(s, id)).state).toBe('connected');
      s.accounts.cancel(id);
      s.accounts.cancel('no-such-flow');
      expect((await s.accounts.poll(id)).state).toBe('connected');
    });

    it('is what starting a second flow does to the first', async () => {
      const gate = { current: undefined as ReturnType<typeof gated> | undefined };
      const s = setup({
        sleep: (w, sleeps) => {
          gate.current = gated(w, sleeps);
          return gate.current.sleep;
        },
      });
      s.w.github.signOutGh();
      saveClient(s);
      const first = await connectDevice(s);
      const second = await connectDevice(s);
      expect(second).not.toBe(first);
      expect((await s.accounts.poll(first)).state).toBe('cancelled');
      expect((await s.accounts.poll(second)).state).toBe('pending');
    });

    it('is what changing the client ID does to a flow that is running', async () => {
      const gate = { current: undefined as ReturnType<typeof gated> | undefined };
      const s = setup({
        sleep: (w, sleeps) => {
          gate.current = gated(w, sleeps);
          return gate.current.sleep;
        },
      });
      s.w.github.signOutGh();
      saveClient(s);
      const id = await connectDevice(s);
      s.accounts.saveClientId('Iv1.other');
      expect((await s.accounts.poll(id)).state).toBe('cancelled');
    });
  });

  it('answers not_found for a flow it never started', async () => {
    const s = setup();
    await expect(s.accounts.poll('nope')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('Reconnect needed', () => {
  it('is shown after a refresh fails, the Keychain entry is gone, and Connect starts the device flow again', async () => {
    const s = setup();
    saveClient(s);
    await signInApp(s.w, { expiresInMs: 60_000 });
    s.w.github.signOutGh();
    s.w.github.revokeRefreshTokens = true;

    // the sync asks for a credential through the auth the service shares with it
    const result = await s.accounts.auth.credential();
    expect(result).toMatchObject({ ok: false, reason: 'reconnect', message: 'Reconnect needed' });
    expect(s.keyring.snapshot()).toEqual([]);
    expect(await s.accounts.status()).toMatchObject({
      status: 'reconnect',
      statusText: 'Reconnect needed',
      via: 'app',
    });

    // Connect: a new device flow; success clears the notice
    s.w.github.revokeRefreshTokens = false;
    const done = await settled(s, await connectDevice(s));
    expect(done.state).toBe('connected');
    expect(await s.accounts.status()).toMatchObject({ status: 'connected' });
    expect(s.keyring.snapshot()).toHaveLength(1);
  });

  it('is remembered across a restart: a new service over the same database still says so', async () => {
    const s = setup();
    saveClient(s);
    await signInApp(s.w, { expiresInMs: 60_000 });
    s.w.github.signOutGh();
    s.w.github.revokeRefreshTokens = true;
    await s.accounts.auth.credential();

    const again = createGithubAccounts({
      db: s.db,
      net: s.w.github.net,
      keyring: s.keyring,
      gh: s.w.github.gh,
      now: () => s.w.clock.now,
      sleep: async () => undefined,
    });
    expect((await again.status()).status).toBe('reconnect');
  });

  it('is cleared by Disconnect', async () => {
    const s = setup();
    saveClient(s);
    await signInApp(s.w, { expiresInMs: 60_000 });
    s.w.github.signOutGh();
    s.w.github.revokeRefreshTokens = true;
    await s.accounts.auth.credential();
    expect((await s.accounts.disconnect()).status).toBe('notconnected');
  });
});

describe('the auth shared with the sync', () => {
  it('remembers the login it resolves', async () => {
    const s = setup();
    await s.accounts.auth.credential();
    expect(getMeta(s.db, 'github_login')).toBe('octo-kelvin');
  });

  it('tells Connect apart from setup once the client ID is known', async () => {
    const s = setup();
    s.w.github.signOutGh();
    expect(await s.accounts.auth.credential()).toMatchObject({ ok: false, reason: 'needs_app' });
    saveClient(s);
    expect(await s.accounts.auth.credential()).toMatchObject({
      ok: false,
      reason: 'needs_connect',
    });
  });
});

describe('Disconnect', () => {
  it('on the App route deletes the Keychain entry', async () => {
    const s = setup();
    saveClient(s);
    s.w.github.signOutGh();
    await settled(s, await connectDevice(s));
    expect(s.keyring.snapshot()).toHaveLength(1);

    const status = await s.accounts.disconnect();

    expect(s.keyring.snapshot()).toEqual([]);
    expect(status).toMatchObject({ status: 'notconnected', appClientIdSaved: true });
    expect(await s.accounts.auth.credential()).toMatchObject({
      ok: false,
      reason: 'needs_connect',
    });
  });

  it('on the gh route stops reading gh until Connect is pressed, and leaves the Keychain alone', async () => {
    const s = setup();
    saveClient(s);
    const gh = vi.fn(s.w.github.gh);
    const accounts = createGithubAccounts({
      db: s.db,
      net: s.w.github.net,
      keyring: s.keyring,
      gh,
      now: () => s.w.clock.now,
      sleep: async () => undefined,
    });
    expect((await accounts.status()).status).toBe('existing');

    const status = await accounts.disconnect();

    expect(status).toMatchObject({ status: 'notconnected' });
    expect(s.keyring.calls.some((c) => c.op === 'delete')).toBe(false);
    // the sync no longer gets gh's token, though gh is still signed in
    gh.mockClear();
    expect(await accounts.auth.credential()).toMatchObject({ ok: false, reason: 'needs_connect' });
    expect(gh).not.toHaveBeenCalled();
    expect((await accounts.status()).status).toBe('notconnected');

    // it is still off after a restart…
    const again = createGithubAccounts({
      db: s.db,
      net: s.w.github.net,
      keyring: s.keyring,
      gh: s.w.github.gh,
      now: () => s.w.clock.now,
      sleep: async () => undefined,
    });
    expect((await again.status()).status).toBe('notconnected');
    // …and Connect puts it back
    expect(await again.connect()).toEqual({ loginId: null, mode: 'existing' });
    expect((await again.status()).status).toBe('existing');
  });

  it('cancels a flow that is waiting', async () => {
    const gate = { current: undefined as ReturnType<typeof gated> | undefined };
    const s = setup({
      sleep: (w, sleeps) => {
        gate.current = gated(w, sleeps);
        return gate.current.sleep;
      },
    });
    s.w.github.signOutGh();
    saveClient(s);
    const id = await connectDevice(s);
    await s.accounts.disconnect();
    expect((await s.accounts.poll(id)).state).toBe('cancelled');
  });

  it('says so when the Keychain refuses to delete, and keeps the entry', async () => {
    const s = setup();
    await signInApp(s.w);
    s.w.github.signOutGh();
    s.keyring.refuse = 'locked';
    await expect(s.accounts.disconnect()).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('what never leaves the Keychain', () => {
  it('keeps every token out of the database, every status, every poll and every error', async () => {
    const s = setup();
    s.w.github.signOutGh();
    saveClient(s);
    const seen: string[] = [];
    const note = (value: unknown) => seen.push(JSON.stringify(value));

    note(await s.accounts.status());
    const started = await s.accounts.connect();
    note(started);
    const done = await settled(s, started.loginId as string);
    note(done);
    note(await s.accounts.status());
    note(
      await s.accounts.auth
        .credential()
        .then((r) => (r.ok ? { ok: true, via: r.credential.via } : r)),
    );
    // a refresh, and a refusal of it
    s.w.clock.now += 9 * 60 * 60 * SECOND;
    await s.accounts.auth.credential();
    s.w.github.revokeRefreshTokens = true;
    s.w.clock.now += 9 * 60 * 60 * SECOND;
    note(await s.accounts.auth.credential());
    note(await s.accounts.status());
    s.w.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve', disabled: true };
    note(
      await s.accounts
        .connect()
        .catch((e: Error & { details?: unknown }) => ({ m: e.message, d: e.details })),
    );

    const text = [...seen, dumpDb(s.db)].join('\n');
    expect(s.w.github.tokens.length).toBeGreaterThan(2);
    for (const token of s.w.github.tokens) expect(text).not.toContain(token);
    expect(text).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
    expect(s.w.github.requests.some((r) => r.clientSecret)).toBe(false);
  });

  it('keeps every key it stores in app_meta to the logins, the client ID and its two on/off notes', async () => {
    const s = setup();
    saveClient(s);
    await s.accounts.auth.credential();
    await s.accounts.disconnect();
    const keys = (s.db.prepare('SELECT key FROM app_meta').all() as { key: string }[]).map(
      (row) => row.key,
    );
    for (const key of keys.filter((k) => k.startsWith('github_'))) {
      expect([
        'github_login',
        'github_app_client_id',
        'github_gh_disconnected',
        'github_reconnect_needed',
        'github_gh_login',
        'github_app_login',
      ]).toContain(key);
    }
  });
});
