import type { NetFetch, NetInit } from '../collectors/github/ports.ts';

// The ONLY file under src/ that may send a request (ESLint's no-restricted-globals and test/lint/outbound.test.ts enforce
// it). Every outbound byte of the server passes `createNet(...)` (TECH › Security and privacy):
//
//   https://api.github.com   GET any path (with its query), and POST /graphql
//   https://github.com       POST /login/device/code and POST /login/oauth/access_token (the device flow and the refresh)
//   https://api.anthropic.com GET /api/oauth/usage in the dedicated Claude plan-check scope
//   https://api.openai.com    GET /v1/models and POST /v1/responses in the Work Review inference scope
//   https://auth.openai.com   GET /.well-known/jwks.json and POST OAuth token/revoke in the Work Review sign-in scope
//
// Anything else is refused BEFORE a socket is opened: another scheme, host, port, path or method, a URL with a user name or
// password in it, a query on a POST, a body on a GET. A redirect is never followed (`redirect: 'manual'`): a 3xx answer is
// refused too, so a response cannot lead the request anywhere the list does not already name.
//
// What an error says: the kind of refusal, the host and the path. Never a header, a body, a query string or a token, and
// not the underlying error's message either (it can quote the request).

export type NetErrorKind =
  /** The request is not one the allowlist names. Nothing was sent. */
  | 'refused'
  /** The answer was a redirect (or was reached through one). It was not followed. */
  | 'redirect'
  /** No answer within the time allowed. */
  | 'timeout'
  /** The caller's own signal stopped the request. */
  | 'aborted'
  /** No connection, or the connection broke. */
  | 'unreachable';

export class NetError extends Error {
  readonly kind: NetErrorKind;
  readonly host: string;
  readonly path: string;
  /** A short system code such as `ENOTFOUND`, when the platform gave one. */
  readonly code: string | undefined;

  constructor(kind: NetErrorKind, host: string, path: string, code?: string) {
    super(NetError.describe(kind, host, path, code));
    this.name = 'NetError';
    this.kind = kind;
    this.host = host;
    this.path = path;
    this.code = code;
  }

  private static describe(kind: NetErrorKind, host: string, path: string, code?: string): string {
    const where = `${host}${path}`;
    switch (kind) {
      case 'refused':
        return `Outbound request refused: ${where} is not on the allowlist.`;
      case 'redirect':
        return `Outbound request refused: ${where} answered with a redirect.`;
      case 'timeout':
        return `No answer from ${where} in time.`;
      case 'aborted':
        return `The request to ${where} was stopped.`;
      case 'unreachable':
        return `Could not reach ${where}${code ? ` (${code})` : ''}.`;
    }
  }
}

export const API_HOST = 'api.github.com';
export const OAUTH_HOST = 'github.com';
export const CLAUDE_PLAN_LIMITS_URL = 'https://api.anthropic.com/api/oauth/usage';
export const WORK_REVIEW_MODELS_URL = 'https://api.openai.com/v1/models';
export const WORK_REVIEW_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const WORK_REVIEW_JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';
export const WORK_REVIEW_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const WORK_REVIEW_REVOKE_URL = 'https://auth.openai.com/api/accounts/oauth/revoke';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const USER_AGENT = 'agent-productivity';

const POST_PATHS: Record<string, readonly string[]> = {
  [API_HOST]: ['/graphql'],
  [OAUTH_HOST]: ['/login/device/code', '/login/oauth/access_token'],
};

export interface NetOptions {
  /** The function that really sends. Defaults to the platform's `fetch`; a test hands in a recorder. */
  fetch?: typeof globalThis.fetch;
  /** How long one request may take, in milliseconds. */
  timeoutMs?: number;
  /** Each opt-in integration receives only its own destinations. The default is the GitHub scope. */
  scope?: 'claude-plan' | 'work-review' | 'work-review-auth';
}

/** True when the allowlist does not name this request. Looks only at the URL, the method and whether there is a body. */
function refusal(url: URL, method: string, hasBody: boolean): boolean {
  if (url.protocol !== 'https:') return true;
  if (url.username !== '' || url.password !== '') return true;
  // `url.port` is '' for the default port, also when the text spelled `:443`; any other port is a different service.
  if (url.port !== '') return true;
  if (url.hostname !== API_HOST && url.hostname !== OAUTH_HOST) return true;
  if (method === 'GET') {
    // Reading is allowed anywhere on the API host, and nowhere on github.com (it has no read the integration needs).
    return url.hostname !== API_HOST || hasBody;
  }
  if (method === 'POST') {
    // A POST carries its parameters in the body: a query string on one has no use here, so it is not let through.
    return !POST_PATHS[url.hostname]?.includes(url.pathname) || url.search !== '';
  }
  return true;
}

function matchesScope(
  scope: NonNullable<NetOptions['scope']>,
  target: string,
  method: string,
  hasBody: boolean,
): boolean {
  switch (scope) {
    case 'claude-plan':
      return target === CLAUDE_PLAN_LIMITS_URL && method === 'GET' && !hasBody;
    case 'work-review':
      return (
        (target === WORK_REVIEW_MODELS_URL && method === 'GET' && !hasBody) ||
        (target === WORK_REVIEW_RESPONSES_URL && method === 'POST' && hasBody)
      );
    case 'work-review-auth':
      return (
        (target === WORK_REVIEW_JWKS_URL && method === 'GET' && !hasBody) ||
        ((target === WORK_REVIEW_TOKEN_URL || target === WORK_REVIEW_REVOKE_URL) &&
          method === 'POST' &&
          hasBody)
      );
  }
}

/** The short system code of a failed connection (`ENOTFOUND`, `ECONNRESET`…), if it has one that looks like one. */
function codeOf(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{3,40}$/.test(code) ? code : undefined;
}

export function createNet(options: NetOptions = {}): NetFetch {
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (target: string, init: NetInit = {}): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      // The text is not echoed: a malformed URL may still have carried a credential.
      throw new NetError('refused', '(invalid URL)', '');
    }
    const method = init.method ?? 'GET';
    // A refusal names the host and path only, so a user name or password in the URL is never repeated.
    const refused = options.scope
      ? !matchesScope(options.scope, target, method, init.body !== undefined)
      : refusal(url, method, init.body !== undefined);
    if (refused) {
      throw new NetError('refused', url.hostname, url.pathname);
    }

    const headers: Record<string, string> = { ...init.headers };
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
      headers['user-agent'] = USER_AGENT;
    }
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init.signal) signals.push(init.signal);

    let response: Response;
    try {
      response = await send(`${url.origin}${url.pathname}${url.search}`, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.any(signals),
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (error) {
      if (init.signal?.aborted) throw new NetError('aborted', url.hostname, url.pathname);
      if (signals[0]?.aborted) throw new NetError('timeout', url.hostname, url.pathname);
      throw new NetError('unreachable', url.hostname, url.pathname, codeOf(error));
    }

    // A 304 answers a conditional request and is not a redirect; every other 3xx is, and is never followed. `redirected`
    // catches a `fetch` that followed one anyway.
    const redirect =
      response.redirected ||
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400 && response.status !== 304);
    if (redirect) {
      await response.body?.cancel().catch(() => undefined);
      throw new NetError('redirect', url.hostname, url.pathname);
    }
    return response;
  };
}
