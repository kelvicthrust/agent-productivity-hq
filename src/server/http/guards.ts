import type { MiddlewareHandler } from 'hono';
import type { ErrorEnvelope } from '../../shared/contracts/errors.ts';
import { LOOPBACK_HOST } from '../lib/config.ts';
import type { Logger } from '../lib/logger.ts';

// The transport guards (TECH › Security). They run before any route:
//   Host not 127.0.0.1:<port> or localhost:<port>  -> 421   (DNS-rebinding guard)
//   non-GET without X-Agent-Productivity-Request: 1 and a JSON content type -> 403
// No CORS headers are ever sent: a browser cannot make the custom header cross-site without a preflight this server never approves.

export const CSRF_HEADER = 'X-Agent-Productivity-Request';
export const CSRF_VALUE = '1';
export const TAILSCALE_LOGIN_HEADER = 'Tailscale-User-Login';

export interface TailscaleAccess {
  host: string;
  ownerLogin: string;
}

/** Exactly what the SPA may load: itself, inline styles, data: images, and its own API. Nothing can embed it. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";

export const allowedHosts = (port: number): ReadonlySet<string> =>
  new Set([`${LOOPBACK_HOST}:${port}`, `localhost:${port}`]);

const forbidden = (message: string): ErrorEnvelope => ({
  error: { code: 'forbidden_origin', message, retryable: false },
});

/** Wrong or missing Host: 421 Misdirected Request. The offending value is logged truncated, never echoed back. */
export function hostGuard(port: number, logger: Logger, remoteHost?: string): MiddlewareHandler {
  const hosts = remoteHost === undefined ? allowedHosts(port) : new Set([remoteHost]);
  return async (c, next) => {
    const host = c.req.header('host')?.toLowerCase();
    if (!host || !hosts.has(host)) {
      logger.warn('rejected request: unexpected Host', {
        source: 'http',
        code: 'forbidden_origin',
        host: host?.slice(0, 100) ?? null,
      });
      return c.json(
        forbidden('This request was not addressed to this computer’s own address.'),
        421,
      );
    }
    await next();
  };
}

/** The managed listener is a loopback backend specifically for Tailscale Serve, which replaces this header. */
export function tailscaleOwnerGuard(ownerLogin: string): MiddlewareHandler {
  return async (c, next) => {
    if (
      c.req.header(TAILSCALE_LOGIN_HEADER) !== ownerLogin ||
      c.req.header('Tailscale-Funnel-Request') !== undefined
    ) {
      return c.json(forbidden('Open this dashboard through Tailscale Serve as its owner.'), 403);
    }
    await next();
  };
}

const isJson = (contentType: string | undefined): boolean =>
  /^application\/json\s*(;|$)/i.test(contentType?.trim() ?? '');

/** Every non-GET request must say it comes from this app: the custom header and a JSON content type. */
export function csrfGuard(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'GET') {
      const marked = c.req.header(CSRF_HEADER) === CSRF_VALUE;
      if (!marked || !isJson(c.req.header('content-type'))) {
        logger.warn('rejected request: missing app header or JSON content type', {
          source: 'http',
          code: 'forbidden_origin',
          method: c.req.method,
        });
        return c.json(
          forbidden(
            `Requests that change data must send "${CSRF_HEADER}: ${CSRF_VALUE}" and a JSON content type.`,
          ),
          403,
        );
      }
    }
    await next();
  };
}

/** CSP and no-store on every response, including errors and guard rejections. Never adds an Access-Control-* header. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    }
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    // The unlock form needs a same-origin policy for browsers to send Origin on submit.
    if (!c.res.headers.has('Referrer-Policy')) c.header('Referrer-Policy', 'no-referrer');
  };
}
