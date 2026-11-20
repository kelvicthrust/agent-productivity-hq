import { describe, expect, it } from 'vitest';
import { ErrorEnvelope } from '../../src/shared/contracts/errors.ts';
import { CONTENT_SECURITY_POLICY } from '../../src/server/http/guards.ts';
import { HOST, PORT, WRITE, call, testApp } from './helpers.ts';

const corsHeaders = (res: Response) =>
  [...res.headers.keys()].filter((name) => name.startsWith('access-control-'));

describe('Host guard (DNS rebinding): wrong Host is 421', () => {
  it.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LOCALHOST:${PORT}`])(
    'allows %s',
    async (host) => {
      const { app } = testApp();
      expect((await call(app, '/api/health', { headers: { host } })).status).toBe(200);
    },
  );

  it.each([
    ['another site', 'evil.example'],
    ['another site with the right port', `evil.example:${PORT}`],
    ['a lookalike', `127.0.0.1.evil.example:${PORT}`],
    ['the wrong port', '127.0.0.1:9999'],
    ['no port', '127.0.0.1'],
    ['a LAN address', `192.168.1.20:${PORT}`],
    ['the IPv6 loopback', `[::1]:${PORT}`],
    ['any address', `0.0.0.0:${PORT}`],
  ])('answers 421 for %s', async (_name, host) => {
    const { app } = testApp();
    const res = await call(app, '/api/health', { headers: { host } });
    expect(res.status).toBe(421);
    const body = ErrorEnvelope.parse(await res.json());
    expect(body.error.code).toBe('forbidden_origin');
    expect(body.error.retryable).toBe(false);
  });

  it('answers 421 when there is no Host at all, and for the SPA and unknown paths too', async () => {
    const { app } = testApp({ staticDir: '/nonexistent' });
    expect((await call(app, '/api/health')).status).toBe(421);
    expect((await call(app, '/', { headers: { host: 'evil.example' } })).status).toBe(421);
    expect((await call(app, '/api/nothing', { headers: { host: 'evil.example' } })).status).toBe(
      421,
    );
  });

  it('checks the Host before it does anything else, so a bad Host never reaches a route', async () => {
    const { app, entries } = testApp();
    await call(app, '/api/bootstrap', { headers: { host: 'evil.example' } });
    expect(
      entries.some((e) => e['code'] === 'forbidden_origin' && e['host'] === 'evil.example'),
    ).toBe(true);
  });
});

describe('CSRF guard: non-GET needs X-Agent-Productivity-Request and a JSON content type, else 403', () => {
  const rejected = async (
    init: RequestInit & { headers: Record<string, string> },
    path = '/api/refresh',
  ) => {
    const { app } = testApp();
    const res = await call(app, path, init);
    expect(res.status).toBe(403);
    expect(ErrorEnvelope.parse(await res.json()).error.code).toBe('forbidden_origin');
  };

  it('rejects a POST with neither', () => rejected({ method: 'POST', headers: { ...HOST } }));
  it('rejects a cross-site form post (simple request, no custom header)', () =>
    rejected({
      method: 'POST',
      headers: {
        ...HOST,
        origin: 'http://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'a=1',
    }));
  it('rejects the header without a JSON content type', () =>
    rejected({
      method: 'POST',
      headers: { ...HOST, 'x-agent-productivity-request': '1', 'content-type': 'text/plain' },
      body: '{}',
    }));
  it('rejects a JSON content type without the header', () =>
    rejected({
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: '{}',
    }));
  it('rejects the header with any value but 1', () =>
    rejected({
      method: 'POST',
      headers: { ...WRITE, 'x-agent-productivity-request': '0' },
      body: '{}',
    }));
  it('rejects a lookalike JSON type', () =>
    rejected({
      method: 'POST',
      headers: { ...WRITE, 'content-type': 'application/jsonp' },
      body: '{}',
    }));
  it.each(['PUT', 'DELETE', 'PATCH', 'OPTIONS'])('rejects %s without them', (method) =>
    rejected({ method, headers: { ...HOST } }, '/api/repos/a/b'),
  );

  it('lets a request that has both through the guard (the route then decides)', async () => {
    const { app } = testApp();
    // POST /api/nothing is not a route: the 404 is the router's, so the guard did not stop it.
    const res = await call(app, '/api/nothing', {
      method: 'POST',
      headers: WRITE,
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(ErrorEnvelope.parse(await res.json()).error.code).toBe('not_found');
    const withCharset = await call(app, '/api/nothing', {
      method: 'POST',
      headers: { ...WRITE, 'content-type': 'application/json; charset=utf-8' },
      body: '{}',
    });
    expect(withCharset.status).toBe(404);
    // And a route that is built answers as itself once the guard is satisfied.
    const refresh = await call(app, '/api/refresh', { method: 'POST', headers: WRITE, body: '{}' });
    expect(refresh.status).toBe(202);
    const discover = await call(app, '/api/setup/discover', {
      method: 'POST',
      headers: WRITE,
      body: '{}',
    });
    expect(discover.status).toBe(200);
  });

  it('does not ask GET for the header', async () => {
    const { app } = testApp();
    expect((await call(app, '/api/health', { headers: HOST })).status).toBe(200);
  });
});

describe('no CORS, and the same headers on every response', () => {
  it('never sends an Access-Control header, even for a cross-site Origin or a preflight', async () => {
    const { app } = testApp();
    const get = await call(app, '/api/health', {
      headers: { ...HOST, origin: 'http://evil.example' },
    });
    expect(corsHeaders(get)).toEqual([]);
    const preflight = await call(app, '/api/refresh', {
      method: 'OPTIONS',
      headers: {
        ...HOST,
        origin: 'http://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-agent-productivity-request,content-type',
      },
    });
    expect(preflight.status).toBe(403);
    expect(corsHeaders(preflight)).toEqual([]);
  });

  it('sends the CSP and no-store on success, not-found, 421, 403 and 500', async () => {
    const { app, db } = testApp();
    const responses = [
      await call(app, '/api/health', { headers: HOST }),
      await call(app, '/api/missing', { headers: HOST }),
      await call(app, '/api/health', { headers: { host: 'evil.example' } }),
      await call(app, '/api/refresh', { method: 'POST', headers: HOST }),
    ];
    db.close(); // the next call fails inside the route
    const failure = await call(app, '/api/health', { headers: HOST });
    expect(failure.status).toBe(500);
    const body = ErrorEnvelope.parse(await failure.json());
    expect(body.error.code).toBe('internal');
    expect(body.error.retryable).toBe(true);
    expect(typeof body.error.details?.['correlationId']).toBe('string');
    responses.push(failure);

    expect(responses.map((r) => r.status)).toEqual([200, 404, 421, 403, 500]);
    for (const res of responses) {
      expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('pins the CSP to what the SPA needs', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  it('does not leak internals in a 500: no stack, path or SQL', async () => {
    const { app, db } = testApp();
    db.close();
    const text = await (await call(app, '/api/health', { headers: HOST })).text();
    expect(text).not.toMatch(/node:sqlite|\.ts|at .*\(|SELECT|app_meta/i);
  });
});
