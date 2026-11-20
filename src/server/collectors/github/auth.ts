import { z } from 'zod';
import { NetError } from '../../lib/net.ts';
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  type CredentialResult,
  type GhRunner,
  type GithubAuth,
  type GithubCredential,
  type Keyring,
  type NetFetch,
  type NoCredential,
} from './ports.ts';
import { isRateLimited, waitUntil } from './rateLimit.ts';

// Token precedence (TECH › GitHub delivery, owner choice P2): `gh auth token` first, else the GitHub App user token from the
// macOS Keychain. Precedence is fixed. A token lives in memory for one request or one sync and is never returned in an error,
// logged or written to SQLite; the App's token pair lives only in the Keychain (one JSON secret, so a refresh replaces both
// halves in one write).
//
// The App route uses the device flow with the client ID only: no client secret is ever sent, here or anywhere (R11, E6).

const API = 'https://api.github.com';
const OAUTH = 'https://github.com';
const API_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
/** A token that expires sooner than this is refreshed before it is used (TECH: "less than 5 minutes away"). */
export const REFRESH_WINDOW_MS = 5 * 60_000;

/** What each way of having no credential says, as Sources and the API errors show it. */
export const NO_CREDENTIAL_MESSAGE = {
  not_connected: 'GitHub isn’t connected.',
  needs_connect: 'Connect GitHub to read merged PRs.',
  needs_app: 'Set up your GitHub App to connect GitHub.',
  reconnect: 'Reconnect needed',
  keychain_refused: 'Couldn’t read the saved GitHub sign-in from your Keychain',
  unreachable: 'GitHub couldn’t be reached. Try again in a moment.',
  rate_limited: 'GitHub is limiting requests. Try again later.',
} as const satisfies Record<NoCredential, string>;
const GH_REJECTED_MESSAGE =
  'Reconnect needed. GitHub no longer accepts the GitHub CLI sign-in: run gh auth login again, or connect through your GitHub App.';

// ---- the Keychain secret ----

/** What is stored under service `agent-productivity`, account `github-app-user-token`. The client ID is not a secret; it
 *  travels with the tokens so a refresh uses the App that issued them even if the saved client ID is changed later. */
const StoredToken = z.object({
  access_token: z.string().min(1),
  /** Epoch ms. null: the App issues tokens that do not expire, so there is nothing to refresh. */
  expires_at: z.number().nullable(),
  refresh_token: z.string().min(1).nullable(),
  refresh_expires_at: z.number().nullable(),
  client_id: z.string().min(1),
  owner_install_id: z.string().min(1).optional(),
});
export type StoredToken = z.infer<typeof StoredToken>;

export type ReadStored =
  | { kind: 'none' }
  | { kind: 'token'; token: StoredToken }
  /** An entry exists and cannot be read as ours. */
  | { kind: 'unreadable' }
  | { kind: 'refused' };

export function readStoredToken(keyring: Keyring): ReadStored {
  let raw: string | null;
  try {
    raw = keyring.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    return { kind: 'refused' };
  }
  if (raw === null) return { kind: 'none' };
  try {
    const parsed = StoredToken.safeParse(JSON.parse(raw));
    return parsed.success ? { kind: 'token', token: parsed.data } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** Writes the whole secret in one call. Returns false when the Keychain refuses. */
export function writeStoredToken(keyring: Keyring, token: StoredToken): boolean {
  try {
    keyring.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify(token));
    return true;
  } catch {
    return false;
  }
}

/** Deletes the entry. Returns false when the Keychain refuses (an entry that was already gone is not a refusal). */
export function deleteStoredToken(keyring: Keyring): boolean {
  try {
    keyring.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return true;
  } catch {
    return false;
  }
}

// ---- the token endpoint ----

/** The success answer of the device flow and of the refresh grant (GitHub's own field names). */
const Grant = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().positive().optional(),
});
const OAuthError = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  interval: z.number().optional(),
});
export type OAuthErrorBody = z.infer<typeof OAuthError>;

/** The token pair of a success answer, as it will be stored; null when the answer is not one. */
export function storedFromGrant(
  body: unknown,
  clientId: string,
  nowMs: number,
): StoredToken | null {
  const grant = Grant.safeParse(body);
  if (!grant.success) return null;
  const { access_token, expires_in, refresh_token, refresh_token_expires_in } = grant.data;
  return {
    access_token,
    expires_at: expires_in === undefined ? null : nowMs + expires_in * 1000,
    refresh_token: refresh_token ?? null,
    refresh_expires_at:
      refresh_token_expires_in === undefined ? null : nowMs + refresh_token_expires_in * 1000,
    client_id: clientId,
  };
}

/** `{error: …}` when the body is an OAuth error answer. */
export function oauthErrorOf(body: unknown): OAuthErrorBody | null {
  const parsed = OAuthError.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export type OAuthAnswer =
  | { kind: 'answer'; status: number; body: unknown }
  /** No usable answer: unreachable, timed out, or stopped by `signal`. Never carries what was sent. */
  | { kind: 'unreachable'; aborted: boolean };

/**
 * One POST to github.com's device-flow or token endpoint: form-encoded, JSON answer. `client_id` is in `params`; a client
 * secret never is. A refusal by the allowlist is a bug in this program, so it is thrown, not reported as "unreachable".
 */
export async function oauthPost(
  net: NetFetch,
  path: '/login/device/code' | '/login/oauth/access_token',
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<OAuthAnswer> {
  try {
    const response = await net(`${OAUTH}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { kind: 'answer', status: response.status, body };
  } catch (error) {
    if (error instanceof NetError && error.kind === 'refused') throw error;
    return { kind: 'unreachable', aborted: error instanceof NetError && error.kind === 'aborted' };
  }
}

// ---- GET /user ----

export type WhoAmI =
  | { kind: 'ok'; login: string }
  /** GitHub answered 401, or a 403 that is not a rate limit: it does not accept this token. */
  | { kind: 'rejected' }
  /** GitHub is limiting requests (429, or a 403 that says so): try again at `until` (epoch ms). The token is fine. */
  | { kind: 'rate_limited'; until: number }
  /** No answer, a server error, or an answer that is not a user. */
  | { kind: 'unreachable' };

const User = z.object({ login: z.string().min(1) });

/** `GET /user` with a token: who it belongs to, or why it cannot be used. `now` (epoch ms) turns a `retry-after` into a time. */
export async function whoAmI(
  net: NetFetch,
  token: string,
  now: () => number = Date.now,
): Promise<WhoAmI> {
  try {
    const response = await net(`${API}/user`, {
      headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
    });
    if (response.status === 200) {
      const user = User.safeParse(await response.json().catch(() => null));
      return user.success ? { kind: 'ok', login: user.data.login } : { kind: 'unreachable' };
    }
    // A rate limit (primary or secondary) is "try later, at this time", not "this token is dead" and not "GitHub is down":
    // reading it as a refusal would spend a refresh token and could delete a good sign-in, and reading it as "unreachable"
    // would lose the time GitHub gave. Any other 403 (a suspended App, a blocked account) is a no.
    if (response.status === 403) {
      // GitHub's secondary and abuse limits can arrive as a bare 403 whose only sign is its sentence, so the body is read
      // once, exactly as the request session does (client.ts classify), and the same rule decides. The text is only
      // matched against: it is never kept, returned or logged.
      const text = await response.text().catch(() => '');
      return isRateLimited(response.headers, text)
        ? { kind: 'rate_limited', until: waitUntil(response.headers, now()) }
        : { kind: 'rejected' };
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return { kind: 'rejected' };
    if (response.status === 429) {
      return { kind: 'rate_limited', until: waitUntil(response.headers, now()) };
    }
    return { kind: 'unreachable' };
  } catch (error) {
    if (error instanceof NetError && error.kind === 'refused') throw error;
    return { kind: 'unreachable' };
  }
}

// ---- precedence ----

export interface GithubAuthOptions {
  net: NetFetch;
  keyring: Keyring;
  gh: GhRunner;
  /** Epoch ms. */
  now: () => number;
  /**
   * False after "Disconnect" on the gh route: `gh` is not read again until Connect is pressed. Defaults to always reading it.
   * (The account service owns that choice; it hands this in when it builds the auth it shares with the sync.)
   */
  ghEnabled?: () => boolean;
  /** False after a reset, until this installation signs in through its GitHub App again. */
  appEnabled?: () => boolean;
  /**
   * The saved GitHub App client ID, or null. Lets "no credential" say whether Connect can start the device flow
   * (`needs_connect`) or the one-time App setup comes first (`needs_app`); without it the answer is `not_connected`.
   */
  savedClientId?: () => string | null;
}

type Fail = Extract<CredentialResult, { ok: false }>;
const fail = (reason: NoCredential, message: string = NO_CREDENTIAL_MESSAGE[reason]): Fail => ({
  ok: false,
  reason,
  message,
});
/** GitHub limited the sign-in check itself: nothing is refreshed or deleted, and `until` reaches the sync and the forms. */
const limited = (until: number): Fail => ({ ...fail('rate_limited'), until });
const granted = (token: string, via: 'gh' | 'app', login: string): CredentialResult => ({
  ok: true,
  credential: { token, via, login },
});

export function createGithubAuth(options: GithubAuthOptions): GithubAuth {
  const { net, keyring, now } = options;

  // credential() and refreshAfter401() run one at a time. A refresh token works once: two syncs refreshing at the same time
  // would spend it twice, and the second would answer `bad_refresh_token` and delete a perfectly good sign-in.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  type GhStep =
    | { kind: 'ok'; credential: GithubCredential }
    | { kind: 'none' }
    | { kind: 'rejected' }
    | { kind: 'rate_limited'; until: number }
    | { kind: 'unreachable' };

  /** `gh auth token`, confirmed by `GET /user`. `skip` is a token a request already learned GitHub refuses. */
  async function viaGh(skip?: string): Promise<GhStep> {
    if (options.ghEnabled && !options.ghEnabled()) return { kind: 'none' };
    let token: string | null;
    try {
      token = await options.gh();
    } catch {
      token = null;
    }
    if (!token) return { kind: 'none' };
    if (token === skip) return { kind: 'rejected' };
    const who = await whoAmI(net, token, now);
    if (who.kind === 'ok')
      return { kind: 'ok', credential: { token, via: 'gh', login: who.login } };
    if (who.kind === 'rate_limited') return who;
    return who.kind === 'rejected' ? { kind: 'rejected' } : { kind: 'unreachable' };
  }

  /** The Keychain entry is useless: remove it and say Reconnect needed. */
  function reconnect(): Fail {
    deleteStoredToken(keyring);
    return fail('reconnect');
  }

  function noToken(): Fail {
    if (!options.savedClientId) return fail('not_connected');
    return options.savedClientId() ? fail('needs_connect') : fail('needs_app');
  }

  type Refreshed = { ok: true; token: StoredToken } | { ok: false; result: Fail };

  /** The refresh grant: refresh token and client ID, no client secret. The old pair stops working once this succeeds. */
  async function refresh(stored: StoredToken): Promise<Refreshed> {
    if (
      stored.refresh_token === null ||
      (stored.refresh_expires_at !== null && stored.refresh_expires_at <= now())
    ) {
      return { ok: false, result: reconnect() };
    }
    const answer = await oauthPost(net, '/login/oauth/access_token', {
      client_id: stored.client_id,
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
    });
    if (answer.kind === 'unreachable' || answer.status >= 500 || answer.status === 429) {
      return { ok: false, result: fail('unreachable') };
    }
    const error = oauthErrorOf(answer.body);
    if (error) {
      // GitHub says no to this refresh token (`bad_refresh_token`: used, expired or revoked) or to this client. Either way
      // the saved sign-in cannot be repaired, so it goes. A passing "try again later" answer is not a no.
      return error.error === 'slow_down' || error.error === 'temporarily_unavailable'
        ? { ok: false, result: fail('unreachable') }
        : { ok: false, result: reconnect() };
    }
    const next = storedFromGrant(answer.body, stored.client_id, now());
    if (!next) return { ok: false, result: fail('unreachable') };
    if (stored.owner_install_id !== undefined) next.owner_install_id = stored.owner_install_id;
    // The old refresh token is spent. If the new pair cannot be saved, the saved sign-in is dead either way; say so.
    if (!writeStoredToken(keyring, next)) return { ok: false, result: fail('keychain_refused') };
    return { ok: true, token: next };
  }

  /**
   * The App route. `force` refreshes first even when the token has time left (a request learned it is refused), unless the
   * Keychain already holds a different token than the refused one (another caller refreshed in the meantime).
   */
  async function viaApp(force: boolean, refused?: string): Promise<CredentialResult> {
    if (options.appEnabled?.() === false) return noToken();
    const read = readStoredToken(keyring);
    if (read.kind === 'none') return noToken();
    if (read.kind === 'refused') return fail('keychain_refused');
    if (read.kind === 'unreadable') return reconnect();

    let stored = read.token;
    let refreshed = false;
    const due =
      (force && stored.access_token === refused) ||
      (stored.expires_at !== null && stored.expires_at - now() < REFRESH_WINDOW_MS);
    if (due) {
      const next = await refresh(stored);
      if (!next.ok) return next.result;
      stored = next.token;
      refreshed = true;
    }

    let who = await whoAmI(net, stored.access_token, now);
    if (who.kind === 'rejected' && !refreshed) {
      // Revoked, or expired without the clock noticing: one refresh, then ask again.
      const next = await refresh(stored);
      if (!next.ok) return next.result;
      stored = next.token;
      who = await whoAmI(net, stored.access_token, now);
    }
    if (who.kind === 'ok') return granted(stored.access_token, 'app', who.login);
    // A limit is "try later": the saved sign-in stays, and the time GitHub gave goes on to the screen.
    if (who.kind === 'rate_limited') return limited(who.until);
    return who.kind === 'rejected' ? reconnect() : fail('unreachable');
  }

  /** gh, then the App; `skipGh` names a gh token a request has just been refused. */
  async function resolve(skipGh?: string): Promise<CredentialResult> {
    const gh = await viaGh(skipGh);
    if (gh.kind === 'ok') return { ok: true, credential: gh.credential };
    if (gh.kind === 'unreachable') return fail('unreachable');
    // gh's sign-in is limited, not refused: the App sign-in is not tried in its place and nothing is deleted.
    if (gh.kind === 'rate_limited') return limited(gh.until);
    const app = await viaApp(false);
    if (app.ok || gh.kind === 'none') return app;
    // gh holds a token GitHub refuses and no App sign-in could stand in: that is "Reconnect needed", not "not connected".
    return app.reason === 'not_connected' ||
      app.reason === 'needs_connect' ||
      app.reason === 'needs_app'
      ? fail('reconnect', GH_REJECTED_MESSAGE)
      : app;
  }

  return {
    credential: () => serial(() => resolve()),

    refreshAfter401: (used) =>
      serial(() => (used.via === 'gh' ? resolve(used.token) : viaApp(true, used.token))),
  };
}
