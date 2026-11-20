import { describe, expect, it, vi } from 'vitest';
import { NetError, createNet } from '../../../../src/server/lib/net.ts';
import { mintToken } from '../../../fixtures/github/scripted-github.ts';

// G6_3: the one outbound module. Every request that is not on its list must be refused BEFORE anything is sent, and the error
// must name the host and path and nothing else. `send` below stands in for the platform's fetch and records what reaches it:
// a refused request must leave it untouched.

type Send = typeof globalThis.fetch;

function recorder(answer: () => Response = () => new Response('{}', { status: 200 })) {
  const send = vi.fn<Send>(async () => answer());
  return { send, net: createNet({ fetch: send }) };
}

const GET = 'GET' as const;
const POST = 'POST' as const;

describe('what the allowlist lets through', () => {
  const allowed: [name: string, url: string, method: 'GET' | 'POST'][] = [
    ['GET /user', 'https://api.github.com/user', GET],
    [
      'GET any api path with a query',
      'https://api.github.com/repos/a/b/pulls/1/commits?per_page=100&page=2',
      GET,
    ],
    ['GET /user/installations', 'https://api.github.com/user/installations', GET],
    ['POST /graphql', 'https://api.github.com/graphql', POST],
    ['POST the device code', 'https://github.com/login/device/code', POST],
    ['POST the token endpoint', 'https://github.com/login/oauth/access_token', POST],
    ['the default port spelled out', 'https://api.github.com:443/user', GET],
    ['an upper-case host', 'https://API.GitHub.com/user', GET],
  ];
  for (const [name, url, method] of allowed) {
    it(`sends ${name}`, async () => {
      const { send, net } = recorder();
      const init = method === POST ? { method, body: 'a=b' } : { method };
      const response = await net(url, init);
      expect(response.status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
    });
  }

  it('sends what it was given, never follows a redirect, and names itself in the User-Agent', async () => {
    const { send, net } = recorder();
    const marker = 'Bearer ' + mintToken('ghu');
    await net('https://api.github.com/graphql', {
      method: POST,
      headers: { authorization: marker, accept: 'application/json' },
      body: '{"query":"query { viewer { login } }"}',
    });
    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/graphql');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      body: '{"query":"query { viewer { login } }"}',
    });
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(marker);
    expect(headers['user-agent']).toBe('agent-productivity');
  });

  it('keeps a User-Agent the caller chose, whatever its case', async () => {
    const { send, net } = recorder();
    await net('https://api.github.com/user', { headers: { 'User-Agent': 'mine' } });
    expect(send.mock.calls[0]?.[1]?.headers).toEqual({ 'User-Agent': 'mine' });
  });

  it('hands the answer back untouched', async () => {
    const { net } = recorder(() => new Response('{"login":"x"}', { status: 404 }));
    const response = await net('https://api.github.com/user');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ login: 'x' });
  });

  it('lets a 304 through: it answers a conditional request and leads nowhere', async () => {
    const { net } = recorder(() => new Response(null, { status: 304 }));
    expect((await net('https://api.github.com/user')).status).toBe(304);
  });
});

describe('what it refuses, before anything is sent', () => {
  const refused: [name: string, url: string, method?: string, body?: string][] = [
    // scheme
    ['http', 'http://api.github.com/user'],
    ['ws', 'wss://api.github.com/user'],
    ['ftp', 'ftp://api.github.com/user'],
    ['a file', 'file:///etc/hosts'],
    // host
    ['github.com for a read', 'https://github.com/login/device/code'],
    ['github.com for a read of the device page', 'https://github.com/login/device'],
    ['the upload host', 'https://uploads.github.com/repos/a/b'],
    ['the raw host', 'https://raw.githubusercontent.com/a/b/main/x'],
    ['a subdomain of the API host', 'https://x.api.github.com/user'],
    ['a look-alike suffix', 'https://api.github.com.example.net/user'],
    ['a trailing dot', 'https://api.github.com./user'],
    ['the API host in the path of another', 'https://example.net/https://api.github.com/user'],
    ['the API host as a user name', 'https://api.github.com@example.net/user'],
    ['another host', 'https://example.com/'],
    ['another provider', 'https://api.anthropic.com/api/oauth/usage'],
    ['localhost', 'https://localhost/user'],
    ['an address', 'https://127.0.0.1/user'],
    ['a decimal address', 'https://2130706433/user'],
    // port
    ['another port', 'https://api.github.com:8443/user'],
    ['another port on github.com', 'https://github.com:444/login/device/code', 'POST', 'a=b'],
    // user info
    ['a user name', 'https://someone@api.github.com/user'],
    ['a user name and password', 'https://someone:secret@api.github.com/user'],
    // path
    ['POST to the API', 'https://api.github.com/user', 'POST', 'a=b'],
    ['POST to another API path', 'https://api.github.com/repos/a/b/issues', 'POST', '{}'],
    ['POST /graphql with a query string', 'https://api.github.com/graphql?x=1', 'POST', '{}'],
    ['POST /graphql with a trailing slash', 'https://api.github.com/graphql/', 'POST', '{}'],
    ['POST the device page', 'https://github.com/login/device', 'POST', 'a=b'],
    ['POST the authorize page', 'https://github.com/login/oauth/authorize', 'POST', 'a=b'],
    [
      'POST a sub-path of the token endpoint',
      'https://github.com/login/oauth/access_token/x',
      'POST',
      'a=b',
    ],
    [
      'POST the token endpoint with a trailing slash',
      'https://github.com/login/oauth/access_token/',
      'POST',
      'a=b',
    ],
    [
      'POST the token endpoint with a query',
      'https://github.com/login/oauth/access_token?client_secret=x',
      'POST',
      'a=b',
    ],
    [
      'POST the token endpoint in other case',
      'https://github.com/LOGIN/OAUTH/access_token',
      'POST',
      'a=b',
    ],
    ['POST github.com root', 'https://github.com/', 'POST', 'a=b'],
    [
      'a dot-dot out of the device code path',
      'https://github.com/login/device/code/../../../logout',
      'POST',
      'a=b',
    ],
    [
      'an encoded dot-dot',
      'https://github.com/login/device/code/%2e%2e/%2e%2e/logout',
      'POST',
      'a=b',
    ],
    // method
    ['PUT', 'https://api.github.com/user', 'PUT', 'a=b'],
    ['PATCH', 'https://api.github.com/user', 'PATCH', 'a=b'],
    ['DELETE', 'https://api.github.com/user', 'DELETE'],
    ['HEAD', 'https://api.github.com/user', 'HEAD'],
    ['OPTIONS', 'https://api.github.com/user', 'OPTIONS'],
    ['a lower-case post', 'https://github.com/login/device/code', 'post', 'a=b'],
    // body
    ['a body on a GET', 'https://api.github.com/user', 'GET', 'a=b'],
    // not a URL
    ['text that is not a URL', 'not a url'],
    ['a relative path', '/user'],
    ['nothing', ''],
  ];
  for (const [name, url, method, body] of refused) {
    it(`refuses ${name}`, async () => {
      const { send, net } = recorder();
      const init = {
        ...(method ? { method: method as 'GET' | 'POST' } : {}),
        ...(body !== undefined ? { body } : {}),
      };
      const error = await net(url, init).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(NetError);
      expect((error as NetError).kind).toBe('refused');
      expect(send).not.toHaveBeenCalled();
    });
  }

  it('treats a request with no method as a GET', async () => {
    const { net } = recorder();
    await expect(net('https://github.com/login/device/code')).rejects.toMatchObject({
      kind: 'refused',
    });
    await expect(net('https://api.github.com/user')).resolves.toBeInstanceOf(Response);
  });

  it('names the host and path of a refusal, and nothing the request carried', async () => {
    const { net } = recorder();
    const token = mintToken('gho');
    const error = await net('https://example.net/steal/here?token=' + token + '#frag', {
      method: POST,
      headers: { authorization: 'Bearer ' + token, 'x-secret-header': token },
      body: 'client_secret=' + token,
    }).then(
      () => null,
      (e: unknown) => e as NetError,
    );
    expect(error?.message).toContain('example.net/steal/here');
    expect(error?.host).toBe('example.net');
    expect(error?.path).toBe('/steal/here');
    for (const text of [error?.message, JSON.stringify(error), String(error?.stack)]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain('x-secret-header');
      expect(text).not.toContain('authorization');
    }
  });

  it('does not repeat a user name or password from the URL', async () => {
    const { net } = recorder();
    const error = (await net('https://octo:hunter2@api.github.com/user').catch(
      (e: unknown) => e,
    )) as NetError;
    expect(error.message).not.toContain('octo');
    expect(error.message).not.toContain('hunter2');
    const invalid = (await net('https://hunter2 not a url').catch((e: unknown) => e)) as NetError;
    expect(invalid.message).not.toContain('hunter2');
  });

  it('uses the platform’s fetch when none is handed in, and still refuses before calling it', async () => {
    // The platform's fetch is replaced for this test: if a refusal ever failed, nothing would reach a real network.
    const platform = vi.fn<Send>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', platform);
    try {
      const net = createNet();
      await expect(net('https://example.net/')).rejects.toMatchObject({ kind: 'refused' });
      await expect(net('http://api.github.com/user')).rejects.toMatchObject({ kind: 'refused' });
      expect(platform).not.toHaveBeenCalled();
      await net('https://api.github.com/user');
      expect(platform).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('redirects', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`refuses a ${status} and does not follow it`, async () => {
      const { send, net } = recorder(
        () => new Response(null, { status, headers: { location: 'https://example.net/collect' } }),
      );
      await expect(net('https://api.github.com/user')).rejects.toMatchObject({
        kind: 'redirect',
        host: 'api.github.com',
        path: '/user',
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    });
  }

  it('refuses an answer that was reached through a redirect, even a 200', async () => {
    const { net } = recorder(() => {
      const response = new Response('{}', { status: 200 });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });
    await expect(net('https://api.github.com/user')).rejects.toMatchObject({ kind: 'redirect' });
  });

  it('refuses a redirect from the token endpoint too, and never repeats the Location', async () => {
    const { net } = recorder(
      () => new Response(null, { status: 302, headers: { location: 'https://example.net/leak' } }),
    );
    const error = (await net('https://github.com/login/oauth/access_token', {
      method: POST,
      body: 'a=b',
    }).catch((e: unknown) => e)) as NetError;
    expect(error.kind).toBe('redirect');
    expect(error.message).not.toContain('example.net');
  });
});

describe('time, and failures of the connection', () => {
  it('gives up after the timeout and says so', async () => {
    const send: Send = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const net = createNet({ fetch: send, timeoutMs: 20 });
    await expect(net('https://api.github.com/user')).rejects.toMatchObject({
      kind: 'timeout',
      host: 'api.github.com',
      path: '/user',
    });
  });

  it('stops when the caller’s signal does, and tells that apart from a timeout', async () => {
    const send: Send = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const net = createNet({ fetch: send, timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = net('https://github.com/login/oauth/access_token', {
      method: POST,
      body: 'a=b',
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('turns a failed connection into an error that has the system code and not the platform’s message or cause', async () => {
    const token = mintToken('ghu');
    const cause = Object.assign(new Error('connect failed for Bearer ' + token), {
      code: 'ENOTFOUND',
    });
    const send: Send = async () => {
      throw new TypeError('fetch failed for ' + token, { cause });
    };
    const net = createNet({ fetch: send });
    const error = (await net('https://api.github.com/user', {
      headers: { authorization: 'Bearer ' + token },
    }).catch((e: unknown) => e)) as NetError;
    expect(error).toBeInstanceOf(NetError);
    expect(error.kind).toBe('unreachable');
    expect(error.code).toBe('ENOTFOUND');
    expect(error.message).toContain('api.github.com/user');
    expect(error.message).not.toContain(token);
    expect(error.cause).toBeUndefined();
  });
});
