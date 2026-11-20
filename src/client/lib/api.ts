import type { ZodType } from 'zod';
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
  if (options.signal) init.signal = options.signal;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Agent-Productivity-Request'] = '1';
    init.body = JSON.stringify(options.body ?? {});
  }
  let response: Response;
  try {
    response = await fetch(`${path}${queryString(options.query)}`, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError('network', 'Agent Productivity HQ could not be reached.', {
      retryable: true,
    });
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
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return request(method, path, schema, { body, ...options });
}
