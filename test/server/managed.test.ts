import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { boot, type ListenFn } from '../../src/server/boot.ts';
import { CONTENT_SECURITY_POLICY } from '../../src/server/http/guards.ts';
import { memoryLogger, tempConfig, tempDir } from './helpers.ts';

const ownerLogin = 'owner@example.com';
const remoteHost = 'machine.tailnet.ts.net:8443';
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };
const start = { type: 'start', ownerLogin, remoteHost, version };
const remoteHeaders = { host: remoteHost, 'Tailscale-User-Login': ownerLogin };

async function freePort(): Promise<number> {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

const loopbackAvailable = await freePort().then(
  () => true,
  (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    console.warn('managed: real loopback tests skipped because the sandbox forbids listening');
    return false;
  },
);

async function runManaged<T>(
  port: number,
  check: (child: ChildProcess, dataDir: string) => Promise<T>,
  env: NodeJS.ProcessEnv = {},
) {
  const home = tempDir();
  const dataDir = join(home, 'data');
  const child = fork(new URL('../../src/server/managed.ts', import.meta.url), [], {
    execArgv: [],
    env: {
      HOME: home,
      PATH: home,
      AGENT_PRODUCTIVITY_DATA_DIR: dataDir,
      AGENT_PRODUCTIVITY_PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    return await check(child, dataDir);
  } finally {
    if (child.connected) child.disconnect();
    const terminate = setTimeout(() => child.kill(), 7000).unref();
    try {
      await exited;
    } finally {
      clearTimeout(terminate);
    }
  }
}

function request(
  port: number,
  path = '/api/health',
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<Response>((resolve, reject) => {
    const { body, ...options } = init;
    // HTTP keeps the exact Host header that Tailscale Serve forwards.
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        ...options,
        signal: AbortSignal.timeout(1000),
      },
      (response) => {
        let content = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          content += chunk;
        });
        response.once('error', reject);
        response.once('end', () => {
          const headers = new Headers();
          for (const [name, values] of Object.entries(response.headersDistinct)) {
            for (const value of values ?? []) headers.append(name, value);
          }
          resolve(new Response(content, { status: response.statusCode!, headers }));
        });
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}

async function send(child: ChildProcess, message: object): Promise<unknown> {
  const response = once(child, 'message', { signal: AbortSignal.timeout(6000) });
  child.send(message);
  return (await response)[0];
}

it.skipIf(!loopbackAvailable)(
  'starts separate loopback listeners, denies remote requests without the exact owner and host, and releases the lock on parent disconnect',
  async () => {
    const port = await freePort();
    const { dataDir, remotePort } = await runManaged(port, async (child, dir) => {
      expect(existsSync(dir)).toBe(false);
      const ready = (await send(child, start)) as { remotePort: number };
      expect(ready).toEqual({ type: 'ready', version, port, remotePort: expect.any(Number) });
      const { remotePort } = ready;
      expect(remotePort).not.toBe(port);

      const health = await request(port);
      expect(await health.json()).toMatchObject({ status: 'ok', version });
      expect((await request(port, '/api/health', { headers: remoteHeaders })).status).toBe(421);
      const remoteHealth = await request(remotePort, '/api/health', { headers: remoteHeaders });
      expect(await remoteHealth.json()).toMatchObject({ status: 'ok', version });

      for (const path of ['/', '/assets/app.js', '/api/health', '/api/bootstrap', '/api/unknown']) {
        const rejected = await request(remotePort, path, { headers: { host: remoteHost } });
        expect(rejected.status, path).toBe(403);
        expect(rejected.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
        expect(rejected.headers.get('cache-control')).toBe('no-store');
        expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
      }
      for (const login of [
        'other@example.com',
        `${ownerLogin}, ${ownerLogin}`,
        'OWNER@example.com',
      ]) {
        const rejected = await request(remotePort, '/api/health', {
          headers: { host: remoteHost, 'Tailscale-User-Login': login },
        });
        expect(rejected.status).toBe(403);
      }
      expect(
        (
          await request(remotePort, '/api/health', {
            headers: { ...remoteHeaders, 'Tailscale-Funnel-Request': '?1' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(remotePort, '/api/health', {
            headers: { ...remoteHeaders, host: 'another.tailnet.ts.net:8443' },
          })
        ).status,
      ).toBe(421);
      expect(
        (
          await request(remotePort, '/api/health', {
            headers: { 'Tailscale-User-Login': ownerLogin },
          })
        ).status,
      ).toBe(421);
      expect(
        (
          await request(remotePort, '/api/unknown', {
            method: 'POST',
            headers: { ...remoteHeaders, 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(remotePort, '/api/unknown', {
            method: 'POST',
            headers: {
              ...remoteHeaders,
              'X-Agent-Productivity-Request': '1',
              'content-type': 'application/json',
            },
            body: '{}',
          })
        ).status,
      ).toBe(404);
      return { dataDir: dir, remotePort };
    });
    expect(existsSync(join(dataDir, 'agent-productivity.lock'))).toBe(false);
    await expect(request(port)).rejects.toThrow();
    await expect(request(remotePort)).rejects.toThrow();
  },
);

it('rejects invalid startup configuration before touching data', async () => {
  await runManaged(4317, async (child, dataDir) => {
    expect(
      await send(child, { ...start, remoteHost: 'https://machine.tailnet.ts.net/' }),
    ).toMatchObject({
      type: 'error',
      code: 'config-invalid',
      message: expect.stringContaining('Tailscale Serve host'),
    });
    expect(existsSync(dataDir)).toBe(false);
  });
});

it.skipIf(!loopbackAvailable)(
  'starts native with one listener and can attach and release an owner-guarded browser listener',
  async () => {
    const port = await freePort();
    await runManaged(port, async (child, dataDir) => {
      expect(await send(child, { type: 'start', version })).toEqual({
        type: 'ready',
        version,
        port,
      });
      const lock = join(dataDir, 'agent-productivity.lock');
      const lease = readFileSync(lock, 'utf8');
      expect(
        await send(child, {
          type: 'attach-remote',
          id: 1,
          remoteHost,
          ownerLogin: 'bad,owner',
        }),
      ).toEqual({ type: 'remote-result', id: 1, ok: false });
      expect(
        await send(child, {
          type: 'native',
          id: 2,
          request: { operation: 'bootstrap' },
        }),
      ).toMatchObject({ type: 'native-result', id: 2, result: { ok: true } });
      const attached = (await send(child, {
        type: 'attach-remote',
        id: 3,
        remoteHost,
        ownerLogin,
      })) as { port: number };
      expect(attached).toEqual({
        type: 'remote-result',
        id: 3,
        ok: true,
        port: expect.any(Number),
      });
      expect(attached.port).not.toBe(port);
      expect(
        (await request(attached.port, '/api/health', { headers: { host: remoteHost } })).status,
      ).toBe(403);
      expect(
        await (await request(attached.port, '/api/health', { headers: remoteHeaders })).json(),
      ).toEqual(await (await request(port)).json());
      expect(await send(child, { type: 'detach-remote', id: 4 })).toEqual({
        type: 'remote-result',
        id: 4,
        ok: true,
      });
      await expect(request(attached.port)).rejects.toThrow();
      expect(
        await send(child, {
          type: 'native',
          id: 5,
          request: { operation: 'bootstrap' },
        }),
      ).toMatchObject({ type: 'native-result', id: 5, result: { ok: true } });
      expect(readFileSync(lock, 'utf8')).toBe(lease);
      expect((await request(port)).ok).toBe(true);
    });
  },
);

it('refuses relative data paths before opening a database inside the installed release', async () => {
  await runManaged(
    4317,
    async (child) => {
      expect(await send(child, start)).toMatchObject({
        type: 'error',
        code: 'config-invalid',
        message: expect.stringContaining('absolute AGENT_PRODUCTIVITY_DATA_DIR'),
      });
    },
    { AGENT_PRODUCTIVITY_DATA_DIR: 'relative-dashboard' },
  );
});

it('rejects a startup requesting a different release than the independently installed runtime', async () => {
  await runManaged(4317, async (child, dataDir) => {
    expect(await send(child, { ...start, version: '0.0.0-different-runtime' })).toMatchObject({
      type: 'error',
      code: 'version-mismatch',
      message: expect.stringContaining('runtime version does not match'),
    });
    expect(existsSync(dataDir)).toBe(false);
  });
});

it('reports a database recovery condition and never announces a remote listener', async () => {
  await runManaged(4317, async (child, dataDir) => {
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'agent-productivity.db'), 'This file is not a SQLite database.');
    expect(await send(child, start)).toMatchObject({
      type: 'error',
      code: 'database-recovery',
      message: expect.stringContaining('database'),
    });
    expect(existsSync(join(dataDir, 'agent-productivity.lock'))).toBe(false);
  });
});

it.skipIf(!loopbackAvailable)(
  'honors an explicit stop message and releases the data directory',
  async () => {
    await runManaged(await freePort(), async (child, dataDir) => {
      expect(await send(child, start)).toMatchObject({ type: 'ready' });
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(6000) });
      child.send({ type: 'stop' });
      expect(await exited).toEqual([0, null]);
      expect(existsSync(join(dataDir, 'agent-productivity.lock'))).toBe(false);
    });
  },
);

it('uses the same guarded routes and shared data on separate loopback listeners', async () => {
  const config = tempConfig();
  const options: Parameters<ListenFn>[0][] = [];
  const closed: number[] = [];
  const listenerPort = 44_321;
  const listen: ListenFn = async (option) => {
    options.push(option);
    return {
      address: () => ({ port: option.port || listenerPort }),
      close: (done) => {
        closed.push(option.port);
        done?.();
      },
    };
  };
  const server = await boot(config, {
    listen,
    logger: memoryLogger().logger,
    remote: { host: remoteHost, ownerLogin },
    version,
  });
  try {
    expect(server.remotePort).toBe(listenerPort);
    expect(options.map(({ host, port }) => ({ host, port }))).toEqual([
      { host: '127.0.0.1', port: config.port },
      { host: '127.0.0.1', port: 0 },
    ]);
    const [local, remote] = options;
    const get = (headers: Record<string, string>, path = '/api/health') =>
      new Request(`http://localhost${path}`, { headers });
    const localHealth = await local!.fetch(get({ host: `127.0.0.1:${config.port}` }));
    const remoteHealth = await remote!.fetch(get(remoteHeaders));
    expect(await localHealth.json()).toEqual(await remoteHealth.json());
    expect((await remote!.fetch(get({ host: remoteHost }, '/api/bootstrap'))).status).toBe(403);
    expect(
      (await remote!.fetch(get({ ...remoteHeaders, host: `127.0.0.1:${listenerPort}` }))).status,
    ).toBe(421);
    expect((await local!.fetch(get(remoteHeaders))).status).toBe(421);
  } finally {
    await server.shutdown();
  }
  expect(closed).toEqual([config.port, 0]);
  expect(existsSync(config.lockPath)).toBe(false);
});

it('closes the local listener and releases the database when the managed listener fails to bind', async () => {
  const config = tempConfig();
  const closed: number[] = [];
  const listen: ListenFn = async ({ port }) => {
    if (port === 0) throw new Error('remote bind failed');
    return {
      close: (done) => {
        closed.push(port);
        done?.();
      },
    };
  };
  await expect(
    boot(config, {
      listen,
      logger: memoryLogger().logger,
      remote: { host: remoteHost, ownerLogin },
    }),
  ).rejects.toThrow('remote bind failed');
  expect(closed).toEqual([config.port]);
  expect(existsSync(config.lockPath)).toBe(false);
});

it('keeps managed data available while retrying and detaching an optional browser listener', async () => {
  const config = tempConfig();
  const closed: number[] = [];
  const bound: Parameters<ListenFn>[0][] = [];
  const remotePort = 44_321;
  let failRemote = true;
  const listen: ListenFn = async (options) => {
    if (options.port === 0 && failRemote) throw new Error('remote bind failed');
    bound.push(options);
    return {
      address: () => ({ port: options.port || remotePort }),
      close: (done) => {
        closed.push(options.port);
        done?.();
      },
    };
  };
  const server = await boot(config, { listen, logger: memoryLogger().logger, managed: true });
  try {
    const lease = readFileSync(config.lockPath, 'utf8');
    expect(bound.map(({ port }) => port)).toEqual([config.port]);
    const access = { host: remoteHost, ownerLogin };
    await expect(server.attachRemote!(access)).rejects.toThrow('remote bind failed');
    expect(closed).toEqual([]);
    expect(server.db?.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });

    failRemote = false;
    const browser = await server.attachRemote!(access);
    expect(browser.port).toBe(remotePort);
    const { fetch, host } = bound[1]!;
    expect(host).toBe('127.0.0.1');
    const health = (headers: Record<string, string>) =>
      fetch(new Request(`http://${host}:${remotePort}/api/health`, { headers }));
    expect((await health({ host: remoteHost })).status).toBe(403);
    expect((await health(remoteHeaders)).ok).toBe(true);
    await Promise.all([browser.close(), browser.close()]);
    expect(closed).toEqual([0]);
    expect(readFileSync(config.lockPath, 'utf8')).toBe(lease);
    expect(server.db?.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
  } finally {
    await server.shutdown();
  }
  expect(closed).toEqual([0, config.port]);
  expect(existsSync(config.lockPath)).toBe(false);
});
