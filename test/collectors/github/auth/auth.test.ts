import { describe, expect, it, vi } from 'vitest';
import {
  REFRESH_WINDOW_MS,
  readStoredToken,
  writeStoredToken,
} from '../../../../src/server/collectors/github/auth.ts';
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  type CredentialResult,
} from '../../../../src/server/collectors/github/ports.ts';
import { fakeGh } from '../../../fixtures/github/scripted-github.ts';
import { authFor, savedToken, signInApp, world } from './helpers.ts';

// G6_2: token precedence (gh first, then the Keychain App token), refresh with the refresh token and no client secret, and
// "Reconnect needed" with the Keychain entry gone when a refresh fails. Test double: the scripted GitHub and Keychain.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function ok(result: CredentialResult) {
  if (!result.ok) throw new Error(`expected a credential, got ${result.reason}: ${result.message}`);
  return result.credential;
}
function failed(result: CredentialResult) {
  if (result.ok) throw new Error('expected no credential');
  return result;
}
const posts = (w: ReturnType<typeof world>) => w.github.requests.filter((r) => r.method === 'POST');

describe('precedence: gh first', () => {
  it('uses gh when it is signed in, confirmed by GET /user, and never touches the Keychain', async () => {
    const w = world();
    const credential = ok(await authFor(w).credential());
    expect(credential).toEqual({ token: w.github.ghToken, via: 'gh', login: 'octo-kelvin' });
    expect(w.github.requests.map((r) => `${r.method} ${r.host}${r.path} ${r.token}`)).toEqual([
      'GET api.github.com/user gh',
    ]);
    expect(w.keyring.calls).toEqual([]);
  });

  it('prefers gh over a saved App token, and does not present the App token', async () => {
    const w = world();
    await signInApp(w);
    const credential = ok(await authFor(w).credential());
    expect(credential.via).toBe('gh');
    expect(w.github.requests.every((r) => r.token === 'gh')).toBe(true);
    expect(w.keyring.calls).toEqual([]);
  });

  it('falls back to the App token the next time gh is signed out', async () => {
    const w = world();
    const stored = await signInApp(w);
    const auth = authFor(w);
    expect(ok(await auth.credential()).via).toBe('gh');
    w.github.signOutGh();
    const credential = ok(await auth.credential());
    expect(credential).toEqual({ token: stored.access_token, via: 'app', login: 'octo-kelvin' });
    expect(w.github.requests.at(-1)).toMatchObject({ path: '/user', token: 'app' });
  });

  it('reads gh before each credential: a new gh sign-in is picked up without a restart', async () => {
    const w = world();
    const gh = vi.fn(w.github.gh);
    const auth = authFor(w, { gh });
    const first = ok(await auth.credential());
    w.github.signInGh();
    const second = ok(await auth.credential());
    expect(gh).toHaveBeenCalledTimes(2);
    expect(second.token).not.toBe(first.token);
    expect(second.token).toBe(w.github.ghToken);
  });

  it('does not read gh at all while the account service has it switched off', async () => {
    const w = world();
    const stored = await signInApp(w);
    const gh = vi.fn(w.github.gh);
    const credential = ok(await authFor(w, { gh, ghEnabled: () => false }).credential());
    expect(gh).not.toHaveBeenCalled();
    expect(credential.token).toBe(stored.access_token);
  });

  it('survives a gh that throws, as a gh that is not installed', async () => {
    const w = world();
    const gh = async () => {
      throw new Error('spawn gh ENOENT');
    };
    expect(failed(await authFor(w, { gh }).credential()).reason).toBe('not_connected');
  });

  it('goes on to the App token when GitHub refuses the gh token', async () => {
    const w = world();
    const stored = await signInApp(w);
    const credential = ok(
      await authFor(w, { gh: fakeGh('a-token-github-does-not-know') }).credential(),
    );
    expect(credential).toMatchObject({ via: 'app', token: stored.access_token });
  });

  it('says Reconnect needed when gh is refused and there is no App sign-in to stand in', async () => {
    const w = world();
    const result = failed(
      await authFor(w, { gh: fakeGh('a-token-github-does-not-know') }).credential(),
    );
    expect(result.reason).toBe('reconnect');
    expect(result.message).toMatch(/gh auth login/);
  });

  it('says GitHub could not be reached, and does not try the App, when the check of gh gets no answer', async () => {
    const w = world();
    await signInApp(w);
    w.github.failNext({ status: 503 });
    const result = failed(await authFor(w).credential());
    expect(result.reason).toBe('unreachable');
    expect(w.keyring.calls).toEqual([]);
  });
});

describe('no credential at all', () => {
  it('asks for the one-time App setup when no client ID is saved', async () => {
    const w = world();
    w.github.signOutGh();
    const result = failed(await authFor(w, { savedClientId: () => null }).credential());
    expect(result.reason).toBe('needs_app');
  });

  it('offers Connect when a client ID is saved', async () => {
    const w = world();
    w.github.signOutGh();
    const result = failed(await authFor(w, { savedClientId: () => 'Iv1.testclient' }).credential());
    expect(result.reason).toBe('needs_connect');
  });

  it('says not connected when it was not told about a client ID', async () => {
    const w = world();
    w.github.signOutGh();
    expect(failed(await authFor(w).credential()).reason).toBe('not_connected');
  });

  it('reads the Keychain entry by service and account', async () => {
    const w = world();
    w.github.signOutGh();
    await authFor(w).credential();
    expect(w.keyring.calls).toEqual([
      { op: 'get', service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT },
    ]);
    expect([KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT]).toEqual([
      'agent-productivity',
      'github-app-user-token',
    ]);
  });
});

describe('the Keychain', () => {
  it('answers keychain_refused, not an exception, when the Keychain is locked', async () => {
    const w = world();
    w.github.signOutGh();
    w.keyring.refuse = 'the keychain is locked';
    const result = failed(await authFor(w).credential());
    expect(result.reason).toBe('keychain_refused');
    expect(result.message).toBe('Couldn’t read the saved GitHub sign-in from your Keychain');
    expect(result.message).not.toContain('locked');
  });

  it('removes an entry it cannot read as its own and says Reconnect needed', async () => {
    const w = world();
    w.github.signOutGh();
    w.keyring.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, 'not json at all');
    expect(failed(await authFor(w).credential()).reason).toBe('reconnect');
    expect(w.keyring.snapshot()).toEqual([]);

    w.keyring.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify({ unexpected: true }));
    expect(failed(await authFor(w).credential()).reason).toBe('reconnect');
    expect(w.keyring.snapshot()).toEqual([]);
  });

  it('round-trips the secret as one JSON entry', async () => {
    const w = world();
    const stored = await signInApp(w);
    expect(w.keyring.snapshot()).toHaveLength(1);
    expect(readStoredToken(w.keyring)).toEqual({ kind: 'token', token: stored });
    w.keyring.refuse = 'locked';
    expect(readStoredToken(w.keyring)).toEqual({ kind: 'refused' });
    expect(writeStoredToken(w.keyring, stored)).toBe(false);
  });
});

describe('refresh', () => {
  it('refreshes a token that expires in under five minutes, with the refresh token and no client secret', async () => {
    const w = world();
    const old = await signInApp(w, { expiresInMs: REFRESH_WINDOW_MS - 1000 });
    w.github.signOutGh();

    const credential = ok(await authFor(w).credential());

    expect(credential.via).toBe('app');
    expect(credential.token).not.toBe(old.access_token);
    const refresh = posts(w);
    expect(refresh.map((r) => `${r.host}${r.path}`)).toEqual([
      'github.com/login/oauth/access_token',
    ]);
    expect(w.github.requests.some((r) => r.clientSecret)).toBe(false);
    // the refreshed token is what GET /user was asked with
    expect(w.github.requests.at(-1)).toMatchObject({ method: 'GET', path: '/user', token: 'app' });
  });

  it('replaces both tokens in the Keychain in one write, and the old refresh token no longer works', async () => {
    const w = world();
    const old = await signInApp(w, { expiresInMs: MINUTE });
    w.github.signOutGh();
    const credential = ok(await authFor(w).credential());

    const writes = w.keyring.calls.filter((c) => c.op === 'set');
    expect(writes).toHaveLength(1);
    const now = savedToken(w.keyring);
    expect(now?.['access_token']).toBe(credential.token);
    expect(now?.['refresh_token']).not.toBe(old.refresh_token);
    expect(now?.['client_id']).toBe(old.client_id);
    expect(w.github.issued[0]?.refreshUsed).toBe(true);
    expect(w.keyring.snapshot()).toHaveLength(1);
  });

  it('keeps the expiry it is told: the new token is due again eight hours on, not now', async () => {
    const w = world();
    await signInApp(w, { expiresInMs: MINUTE });
    w.github.signOutGh();
    const auth = authFor(w);
    ok(await auth.credential());
    expect(posts(w)).toHaveLength(1);
    // an hour later nothing is due: no second refresh
    w.clock.now += HOUR;
    ok(await auth.credential());
    expect(posts(w)).toHaveLength(1);
    // seven hours and fifty-six minutes after the refresh the token has four minutes left: inside the five-minute window
    w.clock.now += 6 * HOUR + 56 * MINUTE;
    ok(await auth.credential());
    expect(posts(w)).toHaveLength(2);
  });

  it('does not refresh a token with more than five minutes left', async () => {
    const w = world();
    await signInApp(w, { expiresInMs: REFRESH_WINDOW_MS + 1000 });
    w.github.signOutGh();
    ok(await authFor(w).credential());
    expect(posts(w)).toEqual([]);
  });

  it('refreshes a token that GitHub refuses although its saved expiry has not come (revoked or cut short)', async () => {
    const w = world();
    const old = await signInApp(w);
    w.github.signOutGh();
    w.github.expireAccessToken(w.clock.now - 1);
    const credential = ok(await authFor(w).credential());
    expect(credential.token).not.toBe(old.access_token);
    expect(posts(w)).toHaveLength(1);
  });

  it('runs two credential() calls at once with one refresh, so the second does not spend a used refresh token', async () => {
    const w = world();
    await signInApp(w, { expiresInMs: MINUTE });
    w.github.signOutGh();
    const auth = authFor(w);
    const [a, b] = await Promise.all([auth.credential(), auth.credential()]);
    expect(ok(a).token).toBe(ok(b).token);
    expect(posts(w)).toHaveLength(1);
    expect(w.keyring.snapshot()).toHaveLength(1);
  });

  it('answers Reconnect needed and deletes the Keychain entry when the refresh token is refused', async () => {
    const w = world();
    await signInApp(w, { expiresInMs: MINUTE });
    w.github.signOutGh();
    w.github.revokeRefreshTokens = true;

    const result = failed(await authFor(w).credential());

    expect(result.reason).toBe('reconnect');
    expect(result.message).toBe('Reconnect needed');
    expect(w.keyring.snapshot()).toEqual([]);
    expect(w.keyring.calls.at(-1)).toMatchObject({ op: 'delete' });
  });

  it('does the same when GitHub wants a client secret, and still sends none', async () => {
    const w = world();
    await signInApp(w, { expiresInMs: MINUTE });
    w.github.signOutGh();
    w.github.refreshNeedsSecret = true;
    expect(failed(await authFor(w).credential()).reason).toBe('reconnect');
    expect(w.keyring.snapshot()).toEqual([]);
    expect(w.github.requests.some((r) => r.clientSecret)).toBe(false);
  });

  it('does the same, without asking GitHub, when the refresh token has expired on its own', async () => {
    const w = world();
    const stored = await signInApp(w, { expiresInMs: MINUTE });
    stored.refresh_expires_at = w.clock.now - 1;
    writeStoredToken(w.keyring, stored);
    w.github.signOutGh();
    w.github.requests.length = 0;
    expect(failed(await authFor(w).credential()).reason).toBe('reconnect');
    expect(w.github.requests).toEqual([]);
    expect(w.keyring.snapshot()).toEqual([]);
  });

  it('does the same when the token is refused and the refresh is refused too (the owner revoked the App)', async () => {
    const w = world();
    await signInApp(w);
    w.github.signOutGh();
    w.github.expireAccessToken(w.clock.now - 1);
    w.github.revokeRefreshTokens = true;
    expect(failed(await authFor(w).credential()).reason).toBe('reconnect');
    expect(w.keyring.snapshot()).toEqual([]);
  });

  it('keeps the Keychain entry when GitHub could not be reached: that is not a refusal', async () => {
    const w = world();
    const old = await signInApp(w, { expiresInMs: MINUTE });
    w.github.signOutGh();
    w.github.failNext({ status: 502, match: (r) => r.method === 'POST' });
    const result = failed(await authFor(w).credential());
    expect(result.reason).toBe('unreachable');
    expect(savedToken(w.keyring)?.['refresh_token']).toBe(old.refresh_token);
    // the old refresh token was not spent, so the next try works
    expect(ok(await authFor(w).credential()).via).toBe('app');
  });

  it('does not fail on a net that throws: an unreachable GitHub is an answer', async () => {
    const w = world();
    await signInApp(w, { expiresInMs: MINUTE });
    w.github.signOutGh();
    const down = async () => {
      throw new Error('offline');
    };
    const { createGithubAuth } = await import('../../../../src/server/collectors/github/auth.ts');
    const auth = createGithubAuth({
      net: down,
      keyring: w.keyring,
      gh: w.github.gh,
      now: () => w.clock.now,
    });
    expect(failed(await auth.credential()).reason).toBe('unreachable');
    expect(w.keyring.snapshot()).toHaveLength(1);
  });

  it('says Keychain refused when the new tokens cannot be saved', async () => {
    const w = world();
    await signInApp(w, { expiresInMs: MINUTE });
    w.github.signOutGh();
    const set = w.keyring.set.bind(w.keyring);
    w.keyring.set = () => {
      throw new Error('denied');
    };
    expect(failed(await authFor(w).credential()).reason).toBe('keychain_refused');
    w.keyring.set = set;
  });
});

describe('a 403 from GET /user', () => {
  it('that is a rate limit leaves the saved sign-in alone: nothing is refreshed and nothing is deleted', async () => {
    const w = world();
    const old = await signInApp(w);
    w.github.signOutGh();
    w.github.failNext({
      status: 403,
      headers: { 'retry-after': '30' },
      match: (r) => r.path === '/user',
    });
    const limit = failed(await authFor(w).credential());
    // "try later, at this time": not "unreachable", and the time GitHub gave is kept (M6_AUTH_RATE_LIMIT)
    expect(limit.reason).toBe('rate_limited');
    expect(limit.until).toBe(w.clock.now + 30_000);
    expect(posts(w)).toEqual([]);
    expect(savedToken(w.keyring)?.['refresh_token']).toBe(old.refresh_token);
    // the limit passes and the same sign-in works
    expect(ok(await authFor(w).credential()).via).toBe('app');
  });

  it('with no rate-limit header is still a refusal: refreshed once, then Reconnect needed with the entry gone', async () => {
    const w = world();
    await signInApp(w);
    w.github.signOutGh();
    w.github.failNext({ status: 403, match: (r) => r.path === '/user' });
    w.github.failNext({ status: 403, match: (r) => r.path === '/user' });
    expect(failed(await authFor(w).credential()).reason).toBe('reconnect');
    expect(w.keyring.snapshot()).toEqual([]);
  });
});

describe('a rate limit on the sign-in check (M6_AUTH_RATE_LIMIT)', () => {
  it('on the gh route is a wait until the time GitHub gave: the App sign-in is not tried and the Keychain is not touched', async () => {
    const w = world();
    w.github.failNext({
      status: 429,
      headers: { 'retry-after': '45' },
      match: (r) => r.path === '/user',
    });
    const limit = failed(await authFor(w).credential());
    expect(limit).toMatchObject({ reason: 'rate_limited', until: w.clock.now + 45_000 });
    expect(w.keyring.calls).toEqual([]);
    expect(w.github.requests.filter((r) => r.path === '/user')).toHaveLength(1);
    // the limit passes and gh works again
    expect(ok(await authFor(w).credential()).via).toBe('gh');
  });

  it('on the App route, with the hourly quota empty, waits until the reset and keeps the saved pair', async () => {
    const w = world();
    const old = await signInApp(w);
    w.github.signOutGh();
    const reset = Math.floor((w.clock.now + 20 * 60_000) / 1000);
    w.github.failNext({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      match: (r) => r.path === '/user',
    });
    const limit = failed(await authFor(w).credential());
    expect(limit).toMatchObject({ reason: 'rate_limited', until: reset * 1000 });
    expect(posts(w)).toEqual([]);
    expect(savedToken(w.keyring)?.['refresh_token']).toBe(old.refresh_token);
    expect(ok(await authFor(w).credential()).via).toBe('app');
  });

  it('without a time from GitHub waits the default minute', async () => {
    const w = world();
    w.github.failNext({ status: 429, match: (r) => r.path === '/user' });
    expect(failed(await authFor(w).credential())).toMatchObject({
      reason: 'rate_limited',
      until: w.clock.now + 60_000,
    });
  });

  it('after a refresh keeps the new pair when the check that follows is limited', async () => {
    const w = world();
    await signInApp(w, { expiresInMs: 60_000 });
    w.github.signOutGh();
    w.github.failNext({
      status: 429,
      headers: { 'retry-after': '90' },
      match: (r) => r.path === '/user',
    });
    const limit = failed(await authFor(w).credential());
    expect(limit.reason).toBe('rate_limited');
    expect(limit.until).toBe(w.clock.now + 90_000);
    expect(savedToken(w.keyring)).not.toBeNull();
    expect(ok(await authFor(w).credential()).via).toBe('app');
  });

  // GitHub's secondary and abuse limits can arrive as a bare 403 with no retry-after and a non-empty quota: its sentence is
  // the only sign. The request client reads that sentence; the sign-in check has to read it the same way.
  describe('that only its answer text gives away', () => {
    const secondary = {
      message:
        'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      documentation_url:
        'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
    };
    const abuse = {
      message:
        'You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.',
    };
    const quotaLeft = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' };

    it('on the gh route is a wait of the default minute: the App sign-in is not tried and the Keychain is not touched', async () => {
      const w = world();
      w.github.failNext({
        status: 403,
        headers: quotaLeft,
        body: secondary,
        match: (r) => r.path === '/user',
      });
      const limit = failed(await authFor(w).credential());
      expect(limit).toMatchObject({ reason: 'rate_limited', until: w.clock.now + 60_000 });
      expect(w.keyring.calls).toEqual([]);
      expect(posts(w)).toEqual([]);
      expect(w.github.requests.filter((r) => r.path === '/user')).toHaveLength(1);
      expect(ok(await authFor(w).credential()).via).toBe('gh');
    });

    it('on the App route (abuse wording) keeps the saved pair: nothing is refreshed or deleted', async () => {
      const w = world();
      const old = await signInApp(w);
      w.github.signOutGh();
      w.github.failNext({
        status: 403,
        headers: quotaLeft,
        body: abuse,
        match: (r) => r.path === '/user',
      });
      const limit = failed(await authFor(w).credential());
      expect(limit).toMatchObject({ reason: 'rate_limited', until: w.clock.now + 60_000 });
      expect(posts(w)).toEqual([]);
      expect(savedToken(w.keyring)?.['refresh_token']).toBe(old.refresh_token);
      expect(ok(await authFor(w).credential()).via).toBe('app');
    });

    it('still uses the time GitHub gave when the answer also carries one', async () => {
      const w = world();
      w.github.failNext({
        status: 403,
        headers: { ...quotaLeft, 'retry-after': '75' },
        body: secondary,
        match: (r) => r.path === '/user',
      });
      expect(failed(await authFor(w).credential())).toMatchObject({
        reason: 'rate_limited',
        until: w.clock.now + 75_000,
      });
    });

    it('is not mistaken for a refusal of an unrelated 403: that one is still refreshed once, then Reconnect needed', async () => {
      const w = world();
      await signInApp(w);
      w.github.signOutGh();
      for (let i = 0; i < 2; i += 1) {
        w.github.failNext({
          status: 403,
          headers: quotaLeft,
          body: { message: 'Sorry. Your account was suspended.' },
          match: (r) => r.path === '/user',
        });
      }
      expect(failed(await authFor(w).credential()).reason).toBe('reconnect');
      expect(w.keyring.snapshot()).toEqual([]);
    });
  });
});

describe('a 401 after a credential was issued', () => {
  it('re-reads gh: a token gh has since replaced is used', async () => {
    const w = world();
    const auth = authFor(w);
    const used = ok(await auth.credential());
    w.github.signInGh();
    const next = ok(await auth.refreshAfter401(used));
    expect(next.token).toBe(w.github.ghToken);
    expect(next.token).not.toBe(used.token);
  });

  it('falls back to the App token when gh gives back the token that was just refused', async () => {
    const w = world();
    const stored = await signInApp(w);
    const auth = authFor(w);
    const used = { token: w.github.ghToken!, via: 'gh' as const, login: 'octo-kelvin' };
    const next = ok(await auth.refreshAfter401(used));
    expect(next).toMatchObject({ via: 'app', token: stored.access_token });
  });

  it('says Reconnect needed when gh gives back the refused token and there is no App sign-in', async () => {
    const w = world();
    const auth = authFor(w);
    const used = ok(await auth.credential());
    expect(failed(await auth.refreshAfter401(used)).reason).toBe('reconnect');
  });

  it('refreshes the App token, even one with time left, because a request was refused with it', async () => {
    const w = world();
    const stored = await signInApp(w);
    w.github.signOutGh();
    const auth = authFor(w);
    const used = ok(await auth.credential());
    expect(used.token).toBe(stored.access_token);
    w.github.requests.length = 0;

    const next = ok(await auth.refreshAfter401(used));

    expect(next.token).not.toBe(used.token);
    expect(posts(w)).toHaveLength(1);
    expect(savedToken(w.keyring)?.['access_token']).toBe(next.token);
  });

  it('does not refresh again when something else already did: the Keychain holds a newer token', async () => {
    const w = world();
    await signInApp(w);
    w.github.signOutGh();
    const auth = authFor(w);
    const used = ok(await auth.credential());
    // another caller refreshes first
    const next = ok(await auth.refreshAfter401(used));
    w.github.requests.length = 0;
    const again = ok(await auth.refreshAfter401(used));
    expect(again.token).toBe(next.token);
    expect(posts(w)).toEqual([]);
  });

  it('answers Reconnect needed and deletes the entry when the refresh after a 401 fails', async () => {
    const w = world();
    await signInApp(w);
    w.github.signOutGh();
    const auth = authFor(w);
    const used = ok(await auth.credential());
    w.github.revokeRefreshTokens = true;
    const result = failed(await auth.refreshAfter401(used));
    expect(result.reason).toBe('reconnect');
    expect(w.keyring.snapshot()).toEqual([]);
  });
});

describe('what an answer never carries', () => {
  it('has no token in any message, and sends no client secret in any scenario', async () => {
    const w = world();
    const messages: string[] = [];
    const auth = authFor(w);
    const record = (r: CredentialResult) => messages.push(r.ok ? '' : r.message);

    record(await auth.credential());
    await signInApp(w, { expiresInMs: MINUTE });
    w.github.signOutGh();
    w.github.revokeRefreshTokens = true;
    record(await auth.credential());
    w.keyring.refuse = 'locked';
    record(await auth.credential());
    record(await authFor(w, { gh: fakeGh('x') }).credential());

    for (const message of messages)
      for (const token of w.github.tokens) expect(message).not.toContain(token);
    expect(w.github.requests.some((r) => r.clientSecret)).toBe(false);
  });
});
