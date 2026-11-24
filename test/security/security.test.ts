import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boot, nodeListen, type ListenFn } from '../../src/server/boot.ts';
import { ConfigError, loadConfig } from '../../src/server/lib/config.ts';
import { modeOf } from '../../src/server/lib/fsModes.ts';
import { createNet, NetError } from '../../src/server/lib/net.ts';
import { CONTENT_SECURITY_POLICY } from '../../src/server/http/guards.ts';
import { createRecoveryApp } from '../../src/server/http/recovery.ts';
import { createLogger } from '../../src/server/lib/logger.ts';
import { ConnectPollResponse, ConnectResponse } from '../../src/shared/contracts/accounts.ts';
import { CLIENT_ID, filesText, scriptedGithub, startWithGithub } from '../server/github-boot.ts';
import {
  HOST,
  NOW,
  PORT,
  TZ,
  WRITE,
  call,
  memoryLogger,
  tempConfig,
  tempDir,
  testApp,
} from '../server/helpers.ts';
import { makeHome, everythingStored, FORBIDDEN } from '../integration/import/helpers.ts';
import {
  testSnapshotPath,
  installByHand,
  removeByHand,
  fixtureBytes,
  rig,
  runChild,
  SENTINEL,
  ASSET,
} from '../claudeCapture/helpers.ts';
import { servedRoutes } from '../../src/server/http/app.ts';
import { createHookStore } from '../../src/server/services/hq/hookStore.ts';
import {
  ASSET as HOOK_ASSET,
  USER_SETTINGS,
  asText,
  rig as hooksRig,
} from '../claudeHooks/helpers.ts';
import { ROOT, techCsp, techTable } from './techTable.ts';

// One test for every row of TECH › Non-functional architecture › Security and privacy. The rows are read from TECH.md and each
// one is matched to its check below by the start of its Risk text. A row with no check fails ("has a check"), and so does a
// check whose row is gone ("every check names a row"), so the table and this file cannot drift apart unnoticed.
// Everything runs on invented fixtures in temporary folders: no real transcript, no network, no Keychain, no `gh`.

const ROWS = techTable('Security and privacy');
const CHECKS: Record<string, () => Promise<void> | void> = {};
const check = (riskStart: string, body: () => Promise<void> | void) => {
  CHECKS[riskStart] = body;
};

const listFiles = (dir: string, pattern: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
const SRC_FILES = listFiles(join(ROOT, 'src'), /\.(ts|tsx|mjs)$/);
const read = (path: string) => readFileSync(path, 'utf8');
const rel = (path: string) => relative(ROOT, path);
/** Source with comments removed, so a rule that says "never use eval" is not itself a finding. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address() as { port: number };
      listener.close(() => resolvePort(port));
    });
  });

/** What connecting to host:port does: its error code, or 'connected'. */
const probe = (host: string, port: number) =>
  new Promise<string>((done) => {
    const socket = connect({ host, port, timeout: 2000 });
    socket.once('connect', () => {
      socket.destroy();
      done('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      done('timeout');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'error'));
  });

// ---- 1. Other devices reach the API ----------------------------------------------------------------------------------------

check('Other devices or macOS users reach the managed API', async () => {
  // There is no way to ask for another address: any AGENT_PRODUCTIVITY_HOST that is not 127.0.0.1 is refused, and the config always says 127.0.0.1.
  const env = { AGENT_PRODUCTIVITY_DATA_DIR: join(tempDir(), 'data') };
  for (const host of ['0.0.0.0', '::', '::1', '192.168.1.20', 'localhost', 'example.com'])
    expect(() => loadConfig({ ...env, AGENT_PRODUCTIVITY_HOST: host }), host).toThrow(ConfigError);
  expect(loadConfig(env).host).toBe('127.0.0.1');

  // The real process refuses to start with a non-loopback host: it exits 1, says why, and has not even made its data folder.
  const dataDir = join(tempDir(), 'data');
  const run = spawnSync(process.execPath, ['src/server/main.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: tempDir(),
      AGENT_PRODUCTIVITY_HOST: '0.0.0.0',
      AGENT_PRODUCTIVITY_DATA_DIR: dataDir,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('only listens on 127.0.0.1');
  expect(existsSync(dataDir)).toBe(false);

  // Boot asks the listener for 127.0.0.1 and nothing else.
  const asked: { host: string }[] = [];
  const recording: ListenFn = async (options) => {
    asked.push({ host: options.host });
    return { close: (done) => done?.() };
  };
  const quiet = await boot(tempConfig(), {
    listen: recording,
    logger: memoryLogger().logger,
    now: () => NOW,
    timezone: TZ,
  });
  await quiet.shutdown();
  expect(asked).toEqual([{ host: '127.0.0.1' }]);

  // The real listener is bound to 127.0.0.1 and nothing else, and a connection through this machine's other addresses (the LAN
  // address, the IPv6 loopback) is refused. Two things can keep this part from running, and each is logged, never silent: a
  // sandbox that refuses local sockets (EPERM), and a machine with no interface besides loopback.
  const port = await freePort().catch(() => null);
  if (port === null) {
    console.warn(
      'security: this sandbox refuses local sockets (EPERM), so the real-socket probe was NOT run',
    );
    return;
  }
  let listening: Server | undefined;
  const listen: ListenFn = async (options) => {
    listening = (await nodeListen(options)) as Server;
    return listening;
  };
  const config = loadConfig({
    AGENT_PRODUCTIVITY_DATA_DIR: join(tempDir(), 'data'),
    AGENT_PRODUCTIVITY_PORT: String(port),
  });
  const server = await boot(config, {
    listen,
    logger: memoryLogger().logger,
    now: () => NOW,
    timezone: TZ,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPERM') throw error;
    console.warn(
      'security: this sandbox refuses local sockets (EPERM), so the real-socket probe was NOT run',
    );
    return null;
  });
  if (!server) return;
  try {
    expect(listening?.address()).toMatchObject({ address: '127.0.0.1', port });
    expect(await probe('127.0.0.1', port)).toBe('connected');
    // The IPv6 loopback is not bound either (a machine with IPv6 switched off answers with an unreachable code instead).
    expect(['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH']).toContain(await probe('::1', port));
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a!.address);
    for (const address of others) expect(await probe(address, port), address).toBe('ECONNREFUSED');
    if (others.length === 0)
      console.warn(
        'security: no non-loopback IPv4 interface here, so the LAN-address probe was NOT run',
      );
  } finally {
    await server.shutdown();
  }
});

// ---- 2. DNS rebinding and cross-site writes ---------------------------------------------------------------------------------

const corsHeaders = (res: Response) =>
  [...res.headers.keys()].filter((n) => n.startsWith('access-control-'));

check('Malicious web page uses DNS rebinding', async () => {
  const { app } = testApp();
  const recovery = createRecoveryApp({
    port: PORT,
    logger: memoryLogger().logger,
    info: { reason: 'corrupt', dbPath: '/x/agent-productivity.db', detail: 'damaged' },
  });
  for (const [name, target] of [
    ['the app', app],
    ['the recovery app', recovery],
  ] as const) {
    const request = (path: string, init: RequestInit = {}) =>
      target.request(`http://127.0.0.1:${PORT}${path}`, init);
    // Host allowlist: another site's name, a lookalike, the wrong port, a LAN address -> 421, with no CORS headers.
    for (const host of [
      'evil.example',
      `evil.example:${PORT}`,
      `127.0.0.1.evil.example:${PORT}`,
      '127.0.0.1:9999',
      `192.168.1.20:${PORT}`,
    ]) {
      const res = await request('/api/health', { headers: { host } });
      expect(res.status, `${name} ${host}`).toBe(421);
      expect(corsHeaders(res)).toEqual([]);
    }
    // A write without X-Agent-Productivity-Request, or without a JSON body type, is 403: that is every cross-site form post.
    const noHeader = await request('/api/refresh', { method: 'POST', headers: { ...HOST } });
    expect(noHeader.status, name).toBe(403);
    const form = await request('/api/refresh', {
      method: 'POST',
      headers: {
        ...HOST,
        origin: 'http://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'a=1',
    });
    expect(form.status, name).toBe(403);
    const plain = await request('/api/refresh', {
      method: 'POST',
      headers: { ...HOST, 'x-agent-productivity-request': '1', 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(plain.status, name).toBe(403);
    // A cross-site preflight gets nothing that would let the page send the custom header.
    const preflight = await request('/api/refresh', {
      method: 'OPTIONS',
      headers: {
        ...HOST,
        origin: 'http://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-agent-productivity-request,content-type',
      },
    });
    expect(preflight.status, name).toBeGreaterThanOrEqual(400);
    expect(corsHeaders(preflight)).toEqual([]);
  }
  // The guards let the app's own writes through, so the refusals above are the guards and not a broken route.
  const ok = await call(app, '/api/refresh', { method: 'POST', headers: WRITE, body: '{}' });
  expect([200, 202]).toContain(ok.status);
  expect(corsHeaders(ok)).toEqual([]);
});

// ---- 3. Conversation content or secrets persisted -----------------------------------------------------------------------------

const TOKEN_PREFIX = /\bgh[ur]_[A-Za-z0-9]{4,}/;

check('Conversation content or secrets persisted', async () => {
  // The fixture logs plant SENTINEL_PROMPT, SENTINEL_REPLY, SENTINEL_TOOL… in prompts, replies, tool text and broken lines. The
  // real boot imports them from a temp HOME (twice: the second pass reads them again) while GitHub is connected through the
  // scripted device flow, which puts ghu_/ghr_-shaped tokens through the process. Then every place data could land is scanned.
  const clock = { now: NOW };
  const scripted = scriptedGithub(clock);
  scripted.github.installApp('kelvin');
  const config = tempConfig();
  const home = makeHome();
  expect(filesText(home), 'the fixture logs plant the sentinels').toMatch(FORBIDDEN);
  const logLines: string[] = [];
  const fileLogger = createLogger({
    sink: (line) => void logLines.push(line),
    level: 'debug',
    now: () => NOW,
  });
  const s = await startWithGithub({
    config,
    clock,
    scripted,
    ghSignedIn: false,
    boot: { logger: fileLogger, local: { env: {}, home }, scheduler: false },
  });
  const poll = async (loginId: string) => {
    for (let i = 0; i < 400; i += 1) {
      const p = ConnectPollResponse.parse(
        (await s.send('GET', `/api/accounts/github/connect/${loginId}`)).json,
      );
      if (p.state !== 'pending') return p.state;
      await new Promise((done) => setTimeout(done, 5));
    }
    return 'timeout';
  };
  await s.send('PUT', '/api/accounts/github/app', { clientId: CLIENT_ID });
  const started = ConnectResponse.parse(
    (await s.send('POST', '/api/accounts/github/connect', {})).json,
  );
  expect(await poll(started.loginId as string)).toBe('connected');
  expect(s.keyring.snapshot()).toHaveLength(1); // a token exists, in the Keychain double only

  for (let pass = 0; pass < 2; pass += 1) {
    for (let tries = 0; tries < 400; tries += 1) {
      const res = await s.send('POST', '/api/refresh', {});
      if (res.status === 202) {
        const id = (res.json as { id: number }).id;
        for (let i = 0; i < 400; i += 1) {
          if (
            ((await s.send('GET', `/api/refresh/${id}`)).json as { state: string }).state !==
            'running'
          )
            break;
          await new Promise((done) => setTimeout(done, 5));
        }
        break;
      }
      await new Promise((done) => setTimeout(done, 5));
    }
  }
  for (const path of [
    '/api/bootstrap',
    '/api/sources',
    '/api/repos',
    '/api/accounts',
    '/api/overview',
    '/api/series',
    '/api/usage/categories',
    '/api/usage/groups',
    '/api/records',
    '/api/models',
    '/api/delivery',
    '/api/setup',
  ])
    await s.send('GET', path);
  const events = s.db().prepare('SELECT COUNT(*) AS n FROM usage_event').get() as { n: number };
  expect(events.n, 'the import ran').toBeGreaterThan(0);

  const tokens = s.github.tokens;
  expect(tokens.length).toBeGreaterThan(0);
  const stored = everythingStored(s.db());
  const places: Record<string, string> = {
    ...Object.fromEntries(Object.entries(stored).map(([table, text]) => [`table ${table}`, text])),
    'data folder files': filesText(config.dataDir),
    'log lines': `${logLines.join('\n')}\n${JSON.stringify(s.entries)}`,
    'api responses': s.bodies.join('\n'),
  };
  await s.stop();
  for (const [place, text] of Object.entries(places)) {
    expect(text, `${place}: conversation text`).not.toMatch(FORBIDDEN);
    expect(text, `${place}: a token prefix`).not.toMatch(TOKEN_PREFIX);
    for (const token of tokens)
      expect(text.includes(token), `${place}: an issued token`).toBe(false);
  }
  // The scan can fail: planted text is found (negative control).
  expect('x SENTINEL_PROMPT_zz y').toMatch(FORBIDDEN);
  expect('ghu_AbCd1234efGh').toMatch(TOKEN_PREFIX);
  // The Keychain's one fixed service and account is the only home of the App token.
  expect(
    s.keyring.calls.every(
      (c) => c.service === 'agent-productivity' && c.account === 'github-app-user-token',
    ),
  ).toBe(true);
});

// ---- 4. Data leaves the machine ----------------------------------------------------------------------------------------------

check('Data leaves the machine', async () => {
  const sent: string[] = [];
  const net = createNet({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  const allowed: [string, 'GET' | 'POST'][] = [
    ['https://api.github.com/user', 'GET'],
    ['https://api.github.com/repos/kelvin/atlas-api?per_page=1', 'GET'],
    ['https://api.github.com/graphql', 'POST'],
    ['https://github.com/login/device/code', 'POST'],
    ['https://github.com/login/oauth/access_token', 'POST'],
  ];
  for (const [url, method] of allowed) {
    await net(url, method === 'POST' ? { method, body: '{}' } : { method });
  }
  expect(sent).toHaveLength(allowed.length);
  const refused: [string, 'GET' | 'POST'][] = [
    ['http://api.github.com/user', 'GET'], // not https
    ['https://evil.example/collect', 'GET'],
    ['https://api.github.com.evil.example/user', 'GET'],
    ['https://api.anthropic.com/v1/usage', 'GET'], // there is no Anthropic entry
    ['https://api.openai.com/v1/models', 'GET'],
    ['https://github.com/kelvin/atlas-api', 'GET'], // github.com is for the two device-flow POSTs only
    ['https://api.github.com/user', 'POST'], // POST only to /graphql
    ['https://github.com/login/device/code?x=1', 'POST'],
    ['https://github.com/login/oauth/authorize', 'POST'],
    ['https://api.github.com:8443/user', 'GET'],
    ['https://user:pw@api.github.com/user', 'GET'],
    ['https://127.0.0.1/user', 'GET'],
  ];
  for (const [url, method] of refused) {
    const error = await net(url, method === 'POST' ? { method, body: '{}' } : { method }).catch(
      (e: unknown) => e,
    );
    expect(error, url).toBeInstanceOf(NetError);
    expect((error as NetError).kind, url).toBe('refused');
  }
  expect(sent).toHaveLength(allowed.length); // a refusal sent nothing
  // Only net.ts may send: no `fetch` or socket client anywhere else in the server, and the client reaches only its own origin.
  const outside = SRC_FILES.filter(
    (f) => f.includes('/src/server/') && !f.endsWith('/lib/net.ts'),
  ).filter((f) =>
    /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|node:https|node:http2|node:tls|node:dgram|\bundici\b|node-fetch|axios|@octokit/.test(
      code(f),
    ),
  );
  expect(outside.map(rel)).toEqual([]);
  const clientFetches = SRC_FILES.filter(
    (f) => f.includes('/src/client/') && /\bfetch\s*\(/.test(code(f)),
  );
  expect(clientFetches.map(rel)).toEqual(['src/client/lib/api.ts']);
  expect(code(join(ROOT, 'src/client/lib/api.ts'))).not.toMatch(/fetch\(\s*['"`]https?:/);
  // No analytics, telemetry or error-reporting SDK is a dependency, and the page loads nothing from another origin.
  const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as {
    dependencies: object;
    devDependencies: object;
  };
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  expect(
    names.filter((n) =>
      /sentry|segment|analytics|posthog|mixpanel|amplitude|datadog|bugsnag|rollbar|newrelic|telemetry|logrocket|fullstory|hotjar|gtag|plausible/i.test(
        n,
      ),
    ),
  ).toEqual([]);
  expect(read(join(ROOT, 'index.html'))).not.toMatch(/(src|href)\s*=\s*["']https?:\/\//i);
});

// ---- 5. Local file permissions -----------------------------------------------------------------------------------------------

check('Local file permissions', async () => {
  const previous = process.umask(0); // a wide-open umask must not loosen anything
  try {
    // The data folder, the database (and its -wal and -shm), the lock and the log.
    const config = tempConfig();
    const listen: ListenFn = async () => ({ close: (done) => done?.() });
    const server = await boot(config, { listen, now: () => NOW, timezone: TZ }); // the default logger writes <data>/logs/agent-productivity.log
    server.db!.prepare("INSERT INTO app_meta (key, value) VALUES ('probe', '1')").run();
    expect(modeOf(config.dataDir)).toBe(0o700);
    expect(modeOf(config.logDir)).toBe(0o700);
    const files = readdirSync(config.dataDir).filter(
      (n) => n.startsWith('agent-productivity.db') || n === 'agent-productivity.lock',
    );
    expect(files).toEqual(
      expect.arrayContaining(['agent-productivity.db', 'agent-productivity.lock']),
    );
    for (const name of files) expect(modeOf(join(config.dataDir, name)), name).toBe(0o600);
    expect(modeOf(join(config.logDir, 'agent-productivity.log'))).toBe(0o600);
    await server.shutdown();

    // The hook script, its config, the state record and the snapshot the hook writes.
    const world = rig({ settings: 'other-keys.json' });
    installByHand(world);
    const { paths } = world.capture;
    expect(modeOf(paths.dataDir)).toBe(0o700);
    expect(modeOf(paths.captureDir)).toBe(0o700);
    const command = (world.readSettingsJson()['statusLine'] as { command: string }).command;
    await runChild('/bin/sh', ['-c', command], { stdin: fixtureBytes('stdin', 'full.json') });
    for (const file of [paths.script, paths.config, paths.state, testSnapshotPath(world.dataDir)])
      expect(modeOf(file), rel(file)).toBe(0o600);
  } finally {
    process.umask(previous);
  }
});

// ---- 6. The status-line hook ---------------------------------------------------------------------------------------------------

check('A legacy status-line hook runs code inside Claude Code', async () => {
  // Dependency-free, no network: it imports only these four Node modules, and nothing that opens a socket.
  const script = code(ASSET);
  const imports = [...script.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  expect(imports.sort()).toEqual(['node:child_process', 'node:fs', 'node:path', 'node:url']);
  expect(script).not.toMatch(
    /\b(fetch|XMLHttpRequest|WebSocket)\b|node:(net|http|https|http2|tls|dns|dgram)|\brequire\s*\(/,
  );

  // Whatever arrives on stdin (malformed, not an object, huge), it exits 0, and the snapshot has only the allowed fields.
  const world = rig({ settings: 'other-keys.json' });
  const before = world.readSettingsJson();
  installByHand(world);
  const command = (world.readSettingsJson()['statusLine'] as { command: string }).command;
  const run = (stdin: Buffer | string) => runChild('/bin/sh', ['-c', command], { stdin });
  for (const stdin of [
    fixtureBytes('stdin', 'malformed.txt'),
    fixtureBytes('stdin', 'not-an-object.json'),
    '',
    Buffer.alloc(200_000, 0x7b),
  ])
    expect((await run(stdin)).code).toBe(0);
  await run(fixtureBytes('stdin', 'full.json'));
  const saved = JSON.parse(read(testSnapshotPath(world.dataDir))) as Record<string, unknown>;
  expect(Object.keys(saved).sort()).toEqual([
    'captured_at',
    'claude_version',
    'five_hour',
    'invoked_at',
    'seven_day',
    'v',
  ]);
  expect(read(testSnapshotPath(world.dataDir))).not.toMatch(SENTINEL);

  // Only the user-level `statusLine` key changed, and no project or local settings file was written.
  const after = world.readSettingsJson();
  const { statusLine: _wasThere, ...restBefore } = before;
  void _wasThere;
  const { statusLine: _after, ...restAfter } = after;
  expect(restAfter).toEqual(restBefore);
  expect(_after).toBeDefined();
  expect(existsSync(join(world.configDir, 'settings.local.json'))).toBe(false);
  // Undoing it puts back exactly what was there.
  removeByHand(world, null);
  expect(world.readSettingsJson()).toEqual(before);
});

// ---- 6b. HQ's Claude Code hooks (opt-in) -------------------------------------------------------------------------------------------

check(
  "A local process posts hook events to the server (HQ's Claude Code hooks, opt-in)",
  async () => {
    // The script: five Node built-ins, no child process, no shell, nothing that is not the loopback POST; it forwards five fields.
    const script = code(HOOK_ASSET);
    const imports = [...script.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(['node:fs', 'node:http', 'node:path', 'node:url']);
    expect(script).not.toMatch(
      /\b(fetch|XMLHttpRequest|WebSocket|spawn|exec)\b|node:(child_process|net|https|tls)|\brequire\s*\(/,
    );
    expect(script).toContain("host: '127.0.0.1'");
    for (const name of ['message', 'tool_input', 'tool_response', 'prompt', 'transcript_path'])
      expect(script, `the script never reads ${name}`).not.toMatch(
        new RegExp(`input\\.${name}\\b`),
      );

    // The route: mounted on the loopback listener only, token compared in constant time, and it never logs.
    const route = code(join(ROOT, 'src/server/http/routes/hqHooks.ts'));
    expect(route).toMatch(/timingSafeEqual/);
    expect(route).not.toMatch(/\blogger\b|console\./);
    const ingest = { store: createHookStore({ now: () => NOW }), token: 'k'.repeat(43) };
    const key = 'POST /api/hq/hooks/claude';
    expect(servedRoutes(testApp({ hookIngest: ingest }).app)).toContain(key);
    expect(servedRoutes(testApp().app)).not.toContain(key);
    expect(
      servedRoutes(
        testApp({ hookIngest: ingest, remote: { host: 'x.ts.net', ownerLogin: 'o' } }).app,
      ),
    ).not.toContain(key);

    // The token: 32 random bytes, and a wrong or missing one is a 401 that says nothing and keeps nothing.
    expect(code(join(ROOT, 'src/server/integrations/claudeHooks/index.ts'))).toMatch(
      /randomBytes\(32\)/,
    );
    const { app } = testApp({ hookIngest: ingest });
    const send = (authorization: string | undefined) =>
      call(app, '/api/hq/hooks/claude', {
        method: 'POST',
        headers: { ...WRITE, ...(authorization === undefined ? {} : { authorization }) },
        body: JSON.stringify({ hook_event_name: 'Stop', session_id: 's', message: 'SENTINEL_X' }),
      });
    for (const header of [undefined, 'Bearer wrong', `Bearer ${'k'.repeat(42)}`]) {
      const res = await send(header);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('');
    }
    // Even with the token, a field beyond the five is refused, not kept.
    expect((await send(`Bearer ${ingest.token}`)).status).toBe(400);
    expect(ingest.store.read().size).toBe(0);

    // The registry is owner-only, and the script is run the way Claude Code runs it: it posts nothing it should not and exits 0.
    const world = hooksRig({ settings: '{}' });
    await world.hooks.listening({ port: 4317, token: ingest.token });
    await world.hooks.set(true);
    expect(modeOf(world.hooks.paths.registry)).toBe(0o600);
    expect(modeOf(world.hooks.paths.dir)).toBe(0o700);
    const ran = spawnSync(process.execPath, [world.hooks.paths.script], {
      input: Buffer.alloc(200_000, 0x7b),
      timeout: 5_000,
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout.length + ran.stderr.length).toBe(0);
  },
);

check(
  "Agent Productivity HQ edits Claude Code's settings (HQ's hooks switch, opt-in, previewed, undoable)",
  async () => {
    // Previewing writes nothing; turning on keeps every other setting and hook; turning off gives back what was there.
    const world = hooksRig({ settings: asText(USER_SETTINGS) });
    const before = readFileSync(world.settings, 'utf8');
    await world.hooks.status();
    expect(readFileSync(world.settings, 'utf8')).toBe(before);
    await world.hooks.set(true);
    const on = JSON.parse(readFileSync(world.settings, 'utf8')) as typeof USER_SETTINGS;
    expect(on.permissions).toEqual(USER_SETTINGS.permissions);
    expect(on.hooks.PreToolUse).toEqual(USER_SETTINGS.hooks.PreToolUse);
    expect(readFileSync(`${world.settings}.agent-productivity-backup`, 'utf8')).toBe(before);
    await world.hooks.set(false);
    expect(JSON.parse(readFileSync(world.settings, 'utf8'))).toEqual(USER_SETTINGS);
    // A project's settings are never a target, and a file that cannot be understood is left as it was.
    const broken = hooksRig({ settings: '{ SENTINEL_NOT_JSON' });
    await expect(broken.hooks.set(true)).rejects.toThrow();
    expect(readFileSync(broken.settings, 'utf8')).toBe('{ SENTINEL_NOT_JSON');
    expect(existsSync(broken.hooks.paths.dir)).toBe(false);
    // Nothing in the app changes settings but this integration, and it never names the status line.
    const writers = SRC_FILES.filter(
      (f) => /renameSync|linkSync/.test(code(f)) && /settings/.test(code(f)),
    );
    expect(
      writers.map(rel).every((f) => f.startsWith('src/server/integrations/claudeHooks/')),
    ).toBe(true);
    expect(code(join(ROOT, 'src/server/integrations/claudeHooks/settings.ts'))).not.toMatch(
      /statusLine/,
    );
  },
);

// ---- 7. Child process injection ------------------------------------------------------------------------------------------------

check('Child process injection', () => {
  // Every child is started with an argument array and no shell. The provider ports start Codex and gh.
  // Browser access checks macOS ACLs with a fixed system binary and a separate path argument.
  const users = SRC_FILES.filter(
    (f) => /child_process/.test(code(f)) && !f.endsWith('claude-statusline.mjs'),
  );
  expect(users.map(rel).sort()).toEqual([
    'src/server/collectors/chatgpt/live.ts',
    'src/server/collectors/github/live.ts',
    'src/server/http/owner-browser.ts',
  ]);
  for (const file of users) {
    const text = code(file);
    expect(text, rel(file)).not.toMatch(/\b(exec|execSync)\s*\(|\bshell\s*:\s*(true|['"`])/);
    const calls = [...text.matchAll(/\b(spawn|spawnSync|execFile|execFileSync)\s*\(/g)];
    const withArray = [
      ...text.matchAll(
        /\b(spawn|spawnSync|execFile|execFileSync)\s*\(\s*(?:[\w.]+|'\/bin\/ls')\s*,\s*\[/g,
      ),
    ];
    expect(calls.length, rel(file)).toBeGreaterThan(0);
    expect(withArray.length, `${rel(file)}: every start passes its arguments as an array`).toBe(
      calls.length,
    );
  }
  expect(code(join(ROOT, 'src/server/collectors/chatgpt/live.ts'))).toMatch(
    /options\.program \?\? 'codex'[\s\S]*options\.args \?\? \['app-server'\]/,
  );
  expect(code(join(ROOT, 'src/server/collectors/github/live.ts'))).toMatch(
    /run\('gh', \['auth', 'token'/,
  );
  const browser = code(join(ROOT, 'src/server/http/owner-browser.ts'));
  expect(browser.match(/\b(spawn|spawnSync|execFile|execFileSync)\s*\(/g)).toHaveLength(1);
  expect(browser).toMatch(/spawnSync\('\/bin\/ls', \['-delBn', '--', path\]/);
});

// ---- 8. Supply chain -----------------------------------------------------------------------------------------------------------

check('Supply chain', () => {
  expect(existsSync(join(ROOT, 'pnpm-lock.yaml'))).toBe(true);
  const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  // Small dependency set, every one an exact version (no ^ or ~).
  const runtime = Object.keys(pkg.dependencies);
  expect(runtime.length).toBeLessThanOrEqual(15);
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
    expect(range, name).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  // This project runs no install script, and pnpm blocks every dependency's (allowBuilds lists only decided ones, none enabled).
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'])
    expect(pkg.scripts[hook], hook).toBeUndefined();
  const workspace = read(join(ROOT, 'pnpm-workspace.yaml'));
  expect(workspace).not.toMatch(/^\s+['"]?[@\w/-]+['"]?:\s*true\s*$/m); // no `allowBuilds` entry set to true
  expect(workspace).not.toMatch(/onlyBuiltDependencies:\s*\n\s+-/); // or a non-empty allowlist
  // The same pin checks `pnpm check:pins` runs.
  const pins = spawnSync(process.execPath, ['scripts/check-pins.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(pins.status, pins.stdout + pins.stderr).toBe(0);
});

// ---- 9. XSS --------------------------------------------------------------------------------------------------------------------

check('XSS', async () => {
  // No way for markup to become DOM in the client: no raw-HTML props or sinks, no eval.
  const sinks =
    /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/;
  const clientSinks = SRC_FILES.filter((f) => f.includes('/src/client/') && sinks.test(code(f)));
  expect(clientSinks.map(rel)).toEqual([]);

  // The CSP on every kind of answer is exactly the one TECH names.
  expect(CONTENT_SECURITY_POLICY).toBe(techCsp());
  const dir = tempDir();
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><div id="root"></div>');
  const { app } = testApp({ staticDir: dir });
  const recovery = createRecoveryApp({
    port: PORT,
    logger: memoryLogger().logger,
    info: { reason: 'corrupt', dbPath: '/x/agent-productivity.db', detail: 'damaged' },
  });
  const answers: [string, Response][] = [
    ['the page', await call(app, '/', { headers: HOST })],
    ['a deep link', await call(app, '/usage', { headers: HOST })],
    ['an API answer', await call(app, '/api/health', { headers: HOST })],
    ['an API error', await call(app, '/api/nothing-here', { headers: HOST })],
    ['a refusal', await call(app, '/api/health', { headers: { host: 'evil.example' } })],
    ['the recovery page', await recovery.request(`http://127.0.0.1:${PORT}/`, { headers: HOST })],
  ];
  for (const [name, res] of answers) {
    expect(res.headers.get('content-security-policy'), name).toBe(techCsp());
    expect(res.headers.get('x-content-type-options'), name).toBe('nosniff');
  }
  // The page itself has no inline script for markup to join (the client is one external bundle).
  expect((await answers[0]![1].text()).match(/<script\b(?![^>]*\bsrc=)/gi)).toBeNull();
  expect(statSync(join(ROOT, 'index.html')).isFile()).toBe(true);
  expect(read(join(ROOT, 'index.html'))).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>[^<]/i);
});

// ---- the table and the checks agree ---------------------------------------------------------------------------------------------

describe('Security and privacy (TECH › Non-functional architecture)', () => {
  it('reads nine rows', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(9);
  });
  it('every check names a row of the table', () => {
    const stale = Object.keys(CHECKS).filter(
      (start) => !ROWS.some((row) => row.risk.startsWith(start)),
    );
    expect(stale, 'checks whose TECH row is gone or reworded').toEqual([]);
  });
  for (const row of ROWS) {
    const start = Object.keys(CHECKS).find((s) => row.risk.startsWith(s));
    it(`${row.risk.length > 70 ? `${row.risk.slice(0, 67)}...` : row.risk}`, async () => {
      expect(start, `TECH has a security row with no check here: "${row.risk}"`).toBeDefined();
      await CHECKS[start!]!();
    }, 90_000);
  }
});
