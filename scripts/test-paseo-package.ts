import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listMigrations } from '../src/server/db/migrate.ts';
import {
  nunitoLicenseSource,
  nunitoNoticeFile,
  playpenLicenseSource,
  playpenNoticeFile,
  thirdPartyNoticesFile,
} from './third-party-notices.ts';

const root = resolve(import.meta.dirname, '..');
const { name, version } = JSON.parse(
  readFileSync(join(root, 'plugins/paseo-agent-productivity/package.json'), 'utf8'),
) as { name: string; version: string };
const tarball = resolve(
  process.argv[2] ?? join(root, 'dist/paseo', `${name.slice(1).replace('/', '-')}-${version}.tgz`),
);

function checkArchiveNotices(plugin: string) {
  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n');
  const dependencies = files.flatMap((file) => {
    const path = /^package\/(node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json)$/.exec(file)?.[1];
    if (!path) return [];
    const manifest = JSON.parse(readFileSync(join(plugin, path), 'utf8')) as {
      name: string;
      version: string;
    };
    return `${manifest.name}@${manifest.version}`;
  });
  const app = 'runtime/app/dist/client';
  assert.ok(
    files.some((file) =>
      /^package\/runtime\/app\/dist\/client\/assets\/nunito-latin-wght-.*\.woff2$/.test(file),
    ),
    'The plugin archive must include the self-hosted font',
  );
  assert.ok(
    files.some((file) =>
      /^package\/runtime\/app\/dist\/client\/assets\/playpen-sans-latin-wght-.*\.woff2$/.test(file),
    ),
    'The plugin archive must include the self-hosted HQ font',
  );
  for (const file of [
    thirdPartyNoticesFile,
    `${app}/${thirdPartyNoticesFile}`,
    `${app}/${nunitoNoticeFile}`,
    `${app}/${playpenNoticeFile}`,
    'assets/OFL-PlaypenSans.txt',
    'assets/OFL-Nunito.txt',
  ]) {
    assert.ok(files.includes(`package/${file}`), `The plugin archive is missing ${file}`);
  }
  assert.deepEqual(
    readFileSync(join(plugin, app, nunitoNoticeFile)),
    readFileSync(nunitoLicenseSource),
    'The plugin archive must include the original Nunito OFL text',
  );
  assert.deepEqual(
    readFileSync(join(plugin, app, playpenNoticeFile)),
    readFileSync(playpenLicenseSource),
    'The plugin archive must include the original Playpen Sans OFL text',
  );
  assert.deepEqual(
    readFileSync(join(plugin, 'assets/OFL-PlaypenSans.txt')),
    readFileSync(playpenLicenseSource),
    'The native outline bundle must carry the original Playpen Sans OFL text',
  );
  assert.deepEqual(
    readFileSync(join(plugin, 'assets/OFL-Nunito.txt')),
    readFileSync(nunitoLicenseSource),
    'The native display font must carry the original Nunito OFL text',
  );
  const browser = readFileSync(join(plugin, app, thirdPartyNoticesFile), 'utf8');
  assert.match(browser, /^## react@\S+ \(MIT\)$/m);
  assert.match(browser, /^## tailwindcss@\S+ \(MIT\)$/m);
  assert.match(browser, /Copyright \(c\) Tailwind Labs, Inc\./);

  const server = readFileSync(join(plugin, thirdPartyNoticesFile), 'utf8');
  const covered = [...server.matchAll(/^## (\S+@\S+) \(/gm)].map((match) => match[1]);
  assert.deepEqual(covered.sort(), dependencies.sort());

  const paseoLicense = readFileSync(
    join(root, 'scripts/licenses/paseo-0.15.3.txt'),
    'utf8',
  ).trimEnd();
  for (const name of ['client', 'protocol', 'relay']) {
    assert.ok(
      server.includes(
        `## @getpaseo/${name}@0.15.3 (Apache-2.0)\n\nLICENSE (upstream)\n\n${paseoLicense}`,
      ),
      `The notice for @getpaseo/${name} must include its upstream copyright and Apache license`,
    );
  }
  const nativeNotices = 'node_modules/@napi-rs/keyring-darwin-arm64/LICENSE.third-party.md';
  assert.ok(files.includes(`package/${nativeNotices}`));
  assert.ok(
    server.includes(readFileSync(join(plugin, nativeNotices), 'utf8').trimEnd()),
    'The native Keyring crate notices must be included',
  );
  assert.ok(
    server.includes(readFileSync(join(root, 'scripts/licenses/napi-rs.txt'), 'utf8').trimEnd()),
    'The native N-API crate notice must include the upstream copyright',
  );
}

function checkSystemLibraries(binary: string) {
  const installName = execFileSync('otool', ['-D', binary], { encoding: 'utf8' })
    .trimEnd()
    .split('\n')[1];
  const linkedLibraries = execFileSync('otool', ['-L', binary], { encoding: 'utf8' })
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0])
    .filter((library) => library !== installName);
  assert.ok(linkedLibraries.length > 0, `Missing dynamic library information for ${binary}`);
  for (const library of linkedLibraries) {
    assert.match(
      library ?? '',
      /^\/(usr\/lib|System\/Library)\//,
      `Non-system library in ${binary}`,
    );
  }
}

async function availablePort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => socket.close(() => done()));
  return address.port;
}

async function checkPackagedService(plugin: string, scratch: string) {
  // Exercise the installed launcher's discovery against the same PATH Paseo would inherit.
  const { resolveNodeExecutable } = (await import(join(plugin, 'server/node-runtime.ts'))) as {
    resolveNodeExecutable: (
      directory: string,
      signal: AbortSignal,
      install: boolean,
    ) => Promise<string>;
  };
  const runtime = await resolveNodeExecutable(plugin, AbortSignal.timeout(10_000), false);
  const app = join(plugin, 'runtime/app');
  const binding = join(
    plugin,
    'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node',
  );
  const entrypoint = join(app, 'src/server/managed.js');
  const data = join(scratch, 'data');
  const home = join(scratch, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const port = await availablePort();
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    TMPDIR: scratch,
    AGENT_PRODUCTIVITY_PORT: String(port),
    AGENT_PRODUCTIVITY_DATA_DIR: data,
  };
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  checkSystemLibraries(binding);
  assert.ok(!existsSync(join(plugin, 'runtime/node')), 'Plugin unexpectedly bundles Node.js');
  assert.ok(
    existsSync(join(app, 'src/server/integrations/claudeCapture/assets/claude-statusline.mjs')),
  );
  assert.ok(existsSync(join(app, 'src/server/integrations/claudeHooks/assets/claude-hook.mjs')));
  execFileSync(
    runtime,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
     import { AsyncEntry, Entry } from '@napi-rs/keyring';
     import { createPaseoClient } from '@getpaseo/client';
     assert.equal(typeof AsyncEntry, 'function');
     assert.equal(typeof Entry, 'function');
     assert.equal(typeof createPaseoClient, 'function');`,
    ],
    { cwd: app, env },
  );

  const remoteHost = 'machine.tailnet.ts.net';
  const ownerLogin = 'owner@example.test';
  const child = fork(entrypoint, [], {
    cwd: scratch,
    execPath: runtime,
    execArgv: [],
    env,
    silent: true,
  });
  const closed = once(child, 'close');
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), 15_000);
  let diagnostics = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  try {
    const response = Promise.race([
      once(child, 'message', { signal: deadline.signal }).then(
        ([message]) =>
          message as {
            type: string;
            version: string;
            port: number;
            remotePort: number;
          },
      ),
      closed.then(([code]) => {
        throw new Error(`Dashboard exited with ${String(code)} before readiness`);
      }),
    ]);
    child.send({ type: 'start', version });
    const ready = await response;
    assert.equal(ready.type, 'ready', JSON.stringify(ready));
    assert.equal(ready.version, version);
    assert.equal(ready.port, port);
    assert.equal(ready.remotePort, undefined, 'Native startup must not start a browser share');
    const ownerCodePath = join(data, 'paseo-browser-code.txt');
    assert.ok(!existsSync(ownerCodePath));
    let nextId = 0;
    async function call(command: Record<string, string | { operation: string }>) {
      const id = ++nextId;
      const result = once(child, 'message', { signal: deadline.signal });
      child.send({ ...command, id });
      const [answer] = await result;
      assert.equal(answer.id, id);
      return answer as {
        ok?: boolean;
        port?: number;
        result?: { ok: boolean; data: { setupComplete?: boolean } };
      };
    }
    const fresh = await call({ type: 'native', request: { operation: 'bootstrap' } });
    assert.equal(fresh.result?.ok, true);
    assert.equal(fresh.result?.data.setupComplete, false);
    const quotaId = ++nextId;
    const hostRequest = once(child, 'message', { signal: deadline.signal });
    child.send({ type: 'native', id: quotaId, request: { operation: 'usage' } });
    const [read] = await hostRequest;
    assert.equal(read.type, 'paseo-read');
    assert.deepEqual(read.request, { kind: 'usage' });
    const quotaReply = once(child, 'message', { signal: deadline.signal });
    child.send({
      type: 'paseo-read-result',
      id: read.id,
      ok: true,
      value: {
        fetchedAt: new Date().toISOString(),
        providers: [
          {
            providerId: 'codex',
            status: 'available',
            windows: [
              {
                id: 'weekly',
                label: 'Weekly',
                usedPct: 36,
                resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
              },
            ],
          },
        ],
      },
    });
    const [quota] = await quotaReply;
    assert.equal(quota.id, quotaId);
    assert.equal(quota.result.ok, true);
    assert.equal(quota.result.data.providers[0].source, 'paseo');
    assert.equal(quota.result.data.providers[0].usedPercent, 36);
    const share = await call({ type: 'attach-remote', ownerLogin, remoteHost });
    assert.equal(share.ok, true);
    const remotePort = share.port;
    assert.ok(remotePort && remotePort !== port);
    const expectedHealth = { status: 'ok', version, schemaVersion: listMigrations().length };
    const local = `http://127.0.0.1:${port}`;
    const signal = deadline.signal;
    const writeHeaders = {
      'content-type': 'application/json',
      'x-agent-productivity-request': '1',
    };
    const hookPath = '/api/hq/hooks/claude';
    const hookSettingsPath = '/api/hq/claude-hooks';
    for (const path of [
      '/',
      '/api/health',
      '/api/hq',
      '/api/paseo-quota',
      '/api/overview',
      hookSettingsPath,
    ]) {
      assert.equal((await fetch(local + path, { signal })).status, 404, path);
    }
    for (const [method, path] of [
      ['POST', '/api/setup/reset'],
      ['PUT', hookSettingsPath],
    ] as const) {
      assert.equal(
        (await fetch(local + path, { method, headers: writeHeaders, body: '{}', signal })).status,
        404,
        path,
      );
    }
    const protectedProbe = (
      path: string,
      init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ) =>
      new Promise<Response>((done, fail) => {
        const { body: payload, ...options } = init;
        const probe = request(
          {
            hostname: '127.0.0.1',
            port: remotePort,
            path,
            ...options,
            headers: { host: remoteHost, ...options.headers },
            signal,
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.once('error', fail);
            response.once('end', () => {
              const headers = new Headers();
              for (const [name, values] of Object.entries(response.headersDistinct)) {
                for (const value of values ?? []) headers.append(name, value);
              }
              const status = response.statusCode!;
              done(new Response(status === 204 ? null : body, { status, headers }));
            });
          },
        );
        probe.once('error', fail);
        probe.end(payload);
      });
    const tailscaleHeaders = { 'Tailscale-User-Login': ownerLogin };
    assert.equal((await protectedProbe('/api/health')).status, 403);
    assert.equal((await protectedProbe('/api/health', { headers: tailscaleHeaders })).status, 401);
    assert.equal(
      (
        await protectedProbe('/api/setup/reset', {
          method: 'POST',
          headers: { ...tailscaleHeaders, ...writeHeaders },
          body: '{}',
        })
      ).status,
      401,
    );
    const unlockPage = await protectedProbe('/sources', { headers: tailscaleHeaders });
    assert.match(await unlockPage.text(), /name="code"/);
    const ownerFile = statSync(ownerCodePath);
    assert.equal(ownerFile.mode & 0o777, 0o600);
    assert.equal(ownerFile.uid, process.getuid!());
    const unlock = await protectedProbe('/unlock', {
      method: 'POST',
      headers: {
        ...tailscaleHeaders,
        'content-type': 'application/x-www-form-urlencoded',
        origin: `https://${remoteHost}`,
      },
      body: new URLSearchParams({
        code: readFileSync(ownerCodePath, 'utf8').trim(),
        next: '/sources',
      }).toString(),
    });
    assert.equal(unlock.status, 303);
    assert.equal(unlock.headers.get('location'), '/sources');
    const cookie = unlock.headers.get('set-cookie');
    assert.ok(cookie?.startsWith('__Host-agent-hq-owner='));
    const ownerHeaders = { ...tailscaleHeaders, cookie: cookie!.split(';')[0]! };
    const protectedHealth = await protectedProbe('/api/health', { headers: ownerHeaders });
    assert.equal(protectedHealth.status, 200);
    assert.deepEqual(await protectedHealth.json(), expectedHealth);

    const page = await protectedProbe('/sources', { headers: ownerHeaders });
    assert.equal(page.status, 200);
    const html = await page.text();
    const asset = html.match(/<script[^>]*\bsrc="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(asset, 'Missing a production JavaScript bundle in the packaged dashboard');
    assert.equal((await protectedProbe(asset, { headers: tailscaleHeaders })).status, 401);
    const javascript = await protectedProbe(asset, { headers: ownerHeaders });
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get('content-type') ?? '', /^text\/javascript/);
    await javascript.arrayBuffer();

    const preview = (await (
      await protectedProbe(hookSettingsPath, { headers: ownerHeaders })
    ).json()) as { preview: string };
    assert.equal(
      (
        await protectedProbe(hookSettingsPath, {
          method: 'PUT',
          headers: { ...ownerHeaders, ...writeHeaders },
          body: JSON.stringify({ enabled: true, preview: preview.preview }),
        })
      ).status,
      200,
    );
    const { token } = JSON.parse(
      readFileSync(join(data, 'claude-hooks', 'registry.json'), 'utf8'),
    ) as { token: string };
    const hook = {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'fixture-session' }),
    };
    const hookHeaders = { ...writeHeaders, authorization: `Bearer ${token}` };
    assert.equal(
      (await fetch(local + hookPath, { ...hook, headers: writeHeaders, signal })).status,
      401,
    );
    assert.equal(
      (await fetch(local + hookPath, { ...hook, headers: hookHeaders, signal })).status,
      204,
    );
    assert.equal(
      (await fetch(`${local}/api/overview`, { headers: hookHeaders, signal })).status,
      404,
    );
    assert.equal(
      (await protectedProbe(hookPath, { ...hook, headers: { ...ownerHeaders, ...hookHeaders } }))
        .status,
      404,
    );

    assert.equal((await call({ type: 'detach-remote' })).ok, true);
    assert.ok(!existsSync(ownerCodePath));
    await assert.rejects(protectedProbe('/api/health', { headers: ownerHeaders }));
    assert.equal(
      (await call({ type: 'native', request: { operation: 'bootstrap' } })).result?.ok,
      true,
    );

    child.send({ type: 'stop' });
    const [code] = await Promise.race([
      closed,
      once(deadline.signal, 'abort').then(() => {
        throw new Error('Dashboard did not stop gracefully');
      }),
    ]);
    assert.equal(code, 0);
    assert.ok(existsSync(join(data, 'agent-productivity.db')));
    assert.ok(!existsSync(join(data, 'agent-productivity.lock')));
  } catch (error) {
    throw new Error(`Packaged dashboard check failed\n${diagnostics}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'agent-productivity-package-test-'));
try {
  const npmConsumer = join(scratch, 'npm-consumer');
  mkdirSync(npmConsumer);
  writeFileSync(
    join(npmConsumer, 'package.json'),
    JSON.stringify({ private: true, dependencies: { [name]: `file:${tarball}` } }),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
      '--package-lock=true',
      '--lockfile-version=3',
      '--include=prod',
      '--omit=dev',
      '--global=false',
      '--workspaces=false',
      '--cache',
      join(scratch, 'npm-cache'),
    ],
    { cwd: npmConsumer, stdio: 'inherit' },
  );
  // Paseo loads a directory plugin outside node_modules. Node can execute its TypeScript there.
  const unpacked = join(scratch, 'package');
  execFileSync('tar', ['-xzf', tarball, '-C', scratch]);
  checkArchiveNotices(unpacked);
  await checkPackagedService(unpacked, scratch);
  console.log(
    `${name}@${version} installed offline, served the protected browser dashboard and kept native data behind IPC.`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
