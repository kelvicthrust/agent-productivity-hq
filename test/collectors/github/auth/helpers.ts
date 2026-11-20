import {
  createFakeGithub,
  createMemoryKeyring,
  type FakeGithub,
  type MemoryKeyring,
} from '../../../fixtures/github/scripted-github.ts';
import {
  createGithubAuth,
  storedFromGrant,
  writeStoredToken,
  type StoredToken,
} from '../../../../src/server/collectors/github/auth.ts';
import type { GithubAuth } from '../../../../src/server/collectors/github/ports.ts';

// Shared by the GitHub auth tests. Everything here is scripted: the GitHub is test/fixtures/github/scripted-github.ts, the
// Keychain is its in-memory one, `gh` is its fake. No network, no real Keychain, no `gh` program. The clock is a plain object a
// test moves by hand, so a token's eight hours pass in one line.

export const T0 = Date.parse('2026-11-04T20:00:00Z');
export const CLIENT_ID = 'Iv1.testclient';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

export interface World {
  clock: { now: number };
  github: FakeGithub;
  keyring: MemoryKeyring;
}

export function world(options: { login?: string; appLogin?: string } = {}): World {
  const clock = { now: T0 };
  const github = createFakeGithub({ now: () => clock.now, ...options });
  return { clock, github, keyring: createMemoryKeyring() };
}

export const form = (fields: Record<string, string>): string =>
  new URLSearchParams(fields).toString();

/** Runs the device flow against the double by hand and returns GitHub's token answer, as the service would receive it. */
export async function issueTokens(github: FakeGithub): Promise<Record<string, unknown>> {
  github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
  const code = (await (
    await github.net('https://github.com/login/device/code', {
      method: 'POST',
      headers: FORM,
      body: form({ client_id: CLIENT_ID }),
    })
  ).json()) as { device_code: string };
  const answer = await github.net('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: FORM,
    body: form({ client_id: CLIENT_ID, device_code: code.device_code, grant_type: DEVICE_GRANT }),
  });
  return (await answer.json()) as Record<string, unknown>;
}

/**
 * Puts an App sign-in in the Keychain, the way a finished device flow leaves it, and forgets the requests that took.
 * `expiresInMs` is when the SAVED expiry falls (the service's own rule decides when to refresh); GitHub's own token stays valid.
 */
export async function signInApp(
  w: World,
  options: { expiresInMs?: number } = {},
): Promise<StoredToken> {
  const answer = await issueTokens(w.github);
  const stored = storedFromGrant(answer, CLIENT_ID, w.clock.now);
  if (!stored) throw new Error('the double did not issue a token pair');
  if (options.expiresInMs !== undefined) stored.expires_at = w.clock.now + options.expiresInMs;
  if (!writeStoredToken(w.keyring, stored)) throw new Error('the Keychain refused');
  w.github.requests.length = 0;
  w.keyring.calls.length = 0;
  return stored;
}

/** The auth under test, wired to the double. */
export function authFor(
  w: World,
  extra: {
    gh?: () => Promise<string | null>;
    ghEnabled?: () => boolean;
    savedClientId?: () => string | null;
  } = {},
): GithubAuth {
  return createGithubAuth({
    net: w.github.net,
    keyring: w.keyring,
    gh: extra.gh ?? w.github.gh,
    now: () => w.clock.now,
    ...(extra.ghEnabled ? { ghEnabled: extra.ghEnabled } : {}),
    ...(extra.savedClientId ? { savedClientId: extra.savedClientId } : {}),
  });
}

/** What the Keychain holds, parsed (the one entry the integration owns), or null. */
export function savedToken(keyring: MemoryKeyring): Record<string, unknown> | null {
  const [entry] = keyring.snapshot();
  return entry ? (JSON.parse(entry.secret) as Record<string, unknown>) : null;
}
