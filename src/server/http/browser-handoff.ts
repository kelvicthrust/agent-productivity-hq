import { randomBytes } from 'node:crypto';
import type { Handler, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  BrowserHandoffRequest,
  BrowserHandoffToken,
  PASEO_BROWSER_SESSION_HEADER,
} from '../../shared/contracts/browser-handoff.ts';
import { ApiError, type ErrorEnvelope } from '../../shared/contracts/errors.ts';
import type { HttpEnv } from './errors.ts';

// These are the web equivalents of the native Paseo reporting and management operations.
// Setup runs in Paseo. Owner-only actions, even read-only previews, require the owner session.
const operations: Readonly<Record<string, readonly RegExp[]>> = {
  GET: [
    /^\/api\/(?:bootstrap|hq|overview|series|year|models|records|sources|paseo-quota)$/,
    /^\/api\/prs(?:\/[^/]+)?$/,
    /^\/api\/usage\/(?:categories|groups(?:\/[^/]+\/roots)?)$/,
    /^\/api\/repos(?:\/discover)?$/,
    /^\/api\/refresh\/\d+$/,
    /^\/api\/accounts\/(?:github|chatgpt)\/connect\/[^/]+$/,
  ],
  POST: [
    /^\/api\/(?:refresh|repos)$/,
    /^\/api\/repos\/[^/]+\/[^/]+\/recheck$/,
    /^\/api\/paseo-quota\/(?:claude|codex)\/check$/,
    /^\/api\/accounts\/(?:github|chatgpt)\/(?:connect|disconnect)$/,
  ],
  PUT: [/^\/api\/prs\/[^/]+\/links\/\d+$/, /^\/api\/accounts\/github\/app$/],
  DELETE: [/^\/api\/prs\/[^/]+\/links\/\d+$/, /^\/api\/repos\/[^/]+\/[^/]+$/],
};

const appPage = /^\/paseo(?:\/(?:trends|delivery|usage|hq|sources)?)?$/;
const appAsset = /^\/assets\/[a-z0-9_.-]+-[a-z0-9_-]{8}\.(?:js|css|woff2)$/i;
const TICKET_AGE_MS = 2 * 60 * 1_000;
const SESSION_AGE_MS = 8 * 60 * 60 * 1_000;
const MAX_ACTIVE = 256;
const unavailable = {
  error: {
    code: 'forbidden_origin',
    message: 'Reopen the dashboard from Paseo.',
    retryable: false,
  },
} satisfies ErrorEnvelope;

export interface BrowserTicket {
  ticket: string;
  expiresAt: number;
}

export function createBrowserHandoff(origin: string, now: () => number) {
  const tickets = new Map<string, number>();
  const sessions = new Map<string, number>();
  let active = true;

  function issue(store: Map<string, number>, age: number) {
    if (!active) return null;
    const time = now();
    for (const [token, expires] of store) {
      if (expires <= time) store.delete(token);
    }
    if (store.size >= MAX_ACTIVE) return null;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = time + age;
    store.set(token, expiresAt);
    return { token, expiresAt };
  }

  const limitBody = bodyLimit({ maxSize: 1024 });
  const exchange: Handler<HttpEnv> = async (c) => {
    if (c.req.header('origin') !== origin) return c.json(unavailable, 403);
    const input = BrowserHandoffRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new ApiError('invalid_input', 'Invalid browser handoff request.');
    const { ticket } = input.data;
    const expires = tickets.get(ticket);
    tickets.delete(ticket);
    if (!active || expires === undefined || expires <= now()) return c.json(unavailable, 401);

    // No await between consuming the ticket and issuing the credential.
    const session = issue(sessions, SESSION_AGE_MS);
    if (!session) return c.json(unavailable, 503);
    return c.json({ credential: session.token });
  };

  function authorize(owner: MiddlewareHandler<HttpEnv>): MiddlewareHandler<HttpEnv> {
    return async (c, next) => {
      const { method, path } = c.req;
      if (
        method === 'GET' &&
        (appPage.test(path) || appAsset.test(path) || path === '/logbook.svg')
      ) {
        return next();
      }
      const header = c.req.header(PASEO_BROWSER_SESSION_HEADER);
      if (!path.startsWith('/api/') || header === undefined) return owner(c, next);
      const credential = BrowserHandoffToken.safeParse(header);
      const expires = credential.success ? sessions.get(credential.data) : undefined;
      if (!active || expires === undefined || expires <= now()) return c.json(unavailable, 401);
      if (!operations[method]?.some((route) => route.test(path))) return c.json(unavailable, 403);
      return next();
    };
  }

  return {
    limitBody,
    exchange,
    authorize,
    issueTicket(): BrowserTicket | null {
      const issued = issue(tickets, TICKET_AGE_MS);
      return issued && { ticket: issued.token, expiresAt: issued.expiresAt };
    },
    close() {
      active = false;
      tickets.clear();
      sessions.clear();
    },
  };
}
