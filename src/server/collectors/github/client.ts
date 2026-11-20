import { NetError } from '../../lib/net.ts';
import { NO_CREDENTIAL_MESSAGE } from './auth.ts';
import { DEFAULT_BACKOFF_MS, isRateLimited, waitUntil } from './rateLimit.ts';
import type {
  CredentialResult,
  GithubAuth,
  GithubCredential,
  GithubRoute,
  NetFetch,
} from './ports.ts';

// One signed-in conversation with api.github.com, for one sync or one repo check (TECH › GitHub delivery). It holds the token
// in memory only, sends it only through the NetFetch it was given (lib/net.ts: allowlist, no redirects), and turns every
// answer into one of a few outcomes the callers can branch on, so a status code, a header or an error text never reaches a
// message, a log or the API (P-31). Nothing here writes: the callers store what they read.
//
//   401   refreshAfter401() once, then the same request again; a second 401 is `no_credential` (Reconnect needed)
//   404   not_found       403 (not a limit)   forbidden       other 4xx   rejected
//   429, 403 with retry-after / x-ratelimit-remaining 0 / "rate limit" in its text   rate_limited, with the time to wait until
//   5xx, no connection, a timeout, an answer that is not JSON   unreachable
//   a redirect (a renamed repository's 301; lib/net.ts refuses to follow it)   moved

const API = 'https://api.github.com';
const API_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
export { DEFAULT_BACKOFF_MS };

export type NoCredential = Extract<CredentialResult, { ok: false }>;

export type Reply =
  | { kind: 'ok'; body: unknown; headers: Headers }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'rejected'; status: number }
  /** `until` is epoch ms. `secondary` is GitHub's abuse limit (retry-after), as opposed to the hourly quota. */
  | { kind: 'rate_limited'; until: number; secondary: boolean }
  | { kind: 'no_credential'; failure: NoCredential }
  | { kind: 'moved' }
  | { kind: 'unreachable' };

export interface GithubSession {
  /** The sign-in in use: it changes when a 401 is answered with a refreshed token. */
  readonly credential: GithubCredential;
  readonly via: GithubRoute;
  get(path: string, signal?: AbortSignal): Promise<Reply>;
  graphql(query: string, variables: Record<string, unknown>): Promise<Reply>;
}

export type OpenSession =
  { ok: true; session: GithubSession } | { ok: false; failure: NoCredential };

const reconnect = (): NoCredential => ({
  ok: false,
  reason: 'reconnect',
  message: `${NO_CREDENTIAL_MESSAGE.reconnect}. GitHub no longer accepts this sign-in.`,
});

async function drop(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Reads one answer. The body is read only for a 2xx (the data) or a 403 (to tell a limit from a refusal), never repeated. */
async function classify(response: Response, nowMs: number): Promise<Reply> {
  const { status, headers } = response;
  if (status >= 200 && status < 300) {
    try {
      return { kind: 'ok', body: await response.json(), headers };
    } catch {
      return { kind: 'unreachable' };
    }
  }
  if (status === 403 || status === 429) {
    const text = status === 403 ? await response.text().catch(() => '') : '';
    if (status === 403) {
      if (!isRateLimited(headers, text)) return { kind: 'forbidden' };
    } else {
      await drop(response);
    }
    return {
      kind: 'rate_limited',
      until: waitUntil(headers, nowMs),
      // The hourly quota says so with a zero; everything else (retry-after, abuse text, a bare 429) is the secondary limit.
      secondary:
        headers.get('x-ratelimit-remaining') !== '0' || headers.get('retry-after') !== null,
    };
  }
  await drop(response);
  if (status === 404) return { kind: 'not_found' };
  if (status >= 500) return { kind: 'unreachable' };
  return { kind: 'rejected', status };
}

/**
 * Asks `auth` for the credential and opens the session on it. `auth` is the one the account service built (accounts.auth), so
 * it knows about "Disconnect" and records "Reconnect needed". When there is no credential the answer says why, in the words
 * Sources shows.
 */
export async function openSession(
  net: NetFetch,
  auth: GithubAuth,
  now: () => number,
): Promise<OpenSession> {
  const first = await auth.credential();
  if (!first.ok) return { ok: false, failure: first };
  let credential = first.credential;

  /** One request; a 401 is answered with a refreshed credential once, then the request is repeated. */
  async function send(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: string; json?: boolean; signal?: AbortSignal },
  ): Promise<Reply> {
    let refreshed = false;
    for (;;) {
      let response: Response;
      try {
        response = await net(`${API}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            ...API_HEADERS,
            ...(init.json ? { 'content-type': 'application/json' } : {}),
            authorization: `Bearer ${credential.token}`,
          },
          ...(init.body !== undefined ? { body: init.body } : {}),
          ...(init.signal !== undefined ? { signal: init.signal } : {}),
        });
      } catch (error) {
        // A refusal by the allowlist is a bug in this program, so it is thrown, not reported as "unreachable".
        if (error instanceof NetError && error.kind === 'refused') throw error;
        return {
          kind: error instanceof NetError && error.kind === 'redirect' ? 'moved' : 'unreachable',
        };
      }
      if (response.status !== 401) return classify(response, now());
      await drop(response);
      if (refreshed) return { kind: 'no_credential', failure: reconnect() };
      refreshed = true;
      const next = await auth.refreshAfter401(credential);
      if (!next.ok) return { kind: 'no_credential', failure: next };
      credential = next.credential;
    }
  }

  return {
    ok: true,
    session: {
      get credential() {
        return credential;
      },
      get via() {
        return credential.via;
      },
      get: (path, signal) => send(path, signal ? { signal } : {}),
      graphql: (query, variables) =>
        send('/graphql', {
          method: 'POST',
          json: true,
          body: JSON.stringify({ query, variables }),
        }),
    },
  };
}
