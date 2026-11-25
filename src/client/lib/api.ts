import type { ZodType } from 'zod';
import {
  BrowserHandoffResponse,
  BrowserHandoffToken,
  PASEO_BROWSER_SESSION_HEADER,
  PASEO_HANDOFF_PATH,
} from '../../shared/contracts/browser-handoff';
import { ErrorEnvelope, type ErrorCode } from '../../shared/contracts/errors';

// The one place the browser talks to the server (ESLint fences `fetch` to this file). Every response is parsed with the
// shared zod contract, so a server that drifts from docs/tech/local-api.md fails loudly here instead of rendering
// undefined. Writes carry the app header and a JSON content type the CSRF guard asks for.

/** What a failed call looks like to the screens: the envelope's code, whether Retry makes sense, and its details. */
export type ClientErrorCode = ErrorCode | 'network' | 'unreadable';

export class ApiRequestError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  constructor(
    code: ClientErrorCode,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown> | undefined;
    } = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

const PASEO_SESSION_KEY = 'agent-productivity-hq:paseo-browser';

interface PaseoBrowser {
  location: { origin: string; pathname: string; search: string; hash: string };
  history: { state: unknown; replaceState(state: unknown, unused: string, url: string): void };
  sessionStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
}

interface PaseoSession {
  browser: PaseoBrowser;
  onExpired: () => void;
  credential: string | null;
}

let paseoSession: PaseoSession | undefined;

function rememberPaseoCredential(session: PaseoSession, credential: string | null): void {
  session.credential = credential;
  try {
    if (credential === null) session.browser.sessionStorage.removeItem(PASEO_SESSION_KEY);
    else session.browser.sessionStorage.setItem(PASEO_SESSION_KEY, credential);
  } catch {
    // If storage is blocked, the credential still works until this document reloads.
  }
}

export async function openPaseoSession(
  browser: PaseoBrowser,
  onExpired: () => void,
): Promise<boolean> {
  const session: PaseoSession = { browser, onExpired, credential: null };
  paseoSession = session;
  const { hash, pathname, search } = browser.location;
  if (!hash.startsWith('#ticket=')) {
    try {
      const saved = BrowserHandoffToken.safeParse(
        browser.sessionStorage.getItem(PASEO_SESSION_KEY),
      );
      session.credential = saved.success ? saved.data : null;
    } catch {
      return false;
    }
    return session.credential !== null;
  }

  // Remove the one-time ticket before sending it or starting the dashboard router.
  browser.history.replaceState(browser.history.state, '', pathname + search);
  rememberPaseoCredential(session, null);
  const ticket = hash.slice('#ticket='.length);
  if (!BrowserHandoffToken.safeParse(ticket).success) return false;
  try {
    const { credential } = await apiSend('POST', PASEO_HANDOFF_PATH, BrowserHandoffResponse, {
      ticket,
    });
    rememberPaseoCredential(session, credential);
    return true;
  } catch {
    return false;
  }
}

const expiredPaseoSession = () =>
  new ApiRequestError('network', 'Reopen Agent Productivity HQ from Paseo.', { status: 401 });

/** `?a=1&b=2` for the defined values, in key order; an empty string when there are none. */
export function queryString(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

async function failure(response: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = ErrorEnvelope.safeParse(body);
  if (parsed.success) {
    const { code, message, retryable, details } = parsed.data.error;
    return new ApiRequestError(code, message, { status: response.status, retryable, details });
  }
  // Not the app's own envelope (a proxy, an HTML page): say what happened without echoing the body.
  return new ApiRequestError('internal', 'The app answered with something unexpected.', {
    status: response.status,
    retryable: response.status >= 500,
  });
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: ZodType<T> | null,
  options: { query?: Query | undefined; body?: unknown; signal?: AbortSignal | undefined },
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, headers };
  let url = `${path}${queryString(options.query)}`;
  const session = paseoSession;
  let credential: string | null = null;
  if (session) {
    const origin = session.browser.location.origin;
    const target = new URL(url, origin);
    if (target.origin !== origin || !target.pathname.startsWith('/api/')) {
      throw new ApiRequestError('network', 'This request is outside the dashboard API.');
    }
    url = target.href;
    init.credentials = 'omit';
    init.mode = 'same-origin';
    init.redirect = 'error';
    if (target.pathname !== PASEO_HANDOFF_PATH) {
      credential = session.credential;
      if (!credential) throw expiredPaseoSession();
      headers[PASEO_BROWSER_SESSION_HEADER] = credential;
    }
  }
  if (options.signal) init.signal = options.signal;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Agent-Productivity-Request'] = '1';
    init.body = JSON.stringify(options.body ?? {});
  }
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError('network', 'Agent Productivity HQ could not be reached.', {
      retryable: true,
    });
  }
  if (session && credential !== null) {
    if (credential !== session.credential) throw expiredPaseoSession();
    if (response.status === 401) {
      rememberPaseoCredential(session, null);
      session.onExpired();
      throw expiredPaseoSession();
    }
  }
  if (!response.ok) throw await failure(response);
  if (schema === null || response.status === 204) return undefined as T;
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiRequestError('unreadable', 'The app answered with something unexpected.', {
      status: response.status,
    });
  }
  if (credential !== null && credential !== session?.credential) throw expiredPaseoSession();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiRequestError('unreadable', 'The app answered with something unexpected.', {
      status: response.status,
      details: { issues: parsed.error.issues.length },
    });
  }
  return parsed.data;
}

/** GET `path` with the defined `query` values, parsed with `schema`. */
export function apiGet<T>(
  path: string,
  schema: ZodType<T>,
  options: { query?: Query; signal?: AbortSignal } = {},
): Promise<T> {
  return request('GET', path, schema, options);
}

/** POST, PUT or DELETE with a JSON body. Pass `null` as the schema for a 204 answer. */
export function apiSend<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: ZodType<T> | null,
  body?: unknown,
  options: { query?: Query; signal?: AbortSignal } = {},
): Promise<T> {
  return request(method, path, schema, { body, ...options });
}
