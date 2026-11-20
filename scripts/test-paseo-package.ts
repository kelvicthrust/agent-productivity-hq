import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  mkdirSync(home);
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
    child.send({ type: 'start', ownerLogin, version, remoteHost });
    const ready = await response;
    assert.equal(ready.type, 'ready', JSON.stringify(ready));
    assert.equal(ready.version, version);
    assert.equal(ready.port, port);
    assert.notEqual(ready.remotePort, port);
    const expectedHealth = { status: 'ok', version, schemaVersion: listMigrations().length };
    const local = `http://127.0.0.1:${port}`;
    const signal = deadline.signal;
    const health = await fetch(`${local}/api/health`, { signal });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), expectedHealth);
    const protectedHealth = await new Promise<{ status: number | undefined; body: string }>(
      (done, fail) => {
        const probe = request(
          {
            hostname: '127.0.0.1',
            port: ready.remotePort,
            path: '/api/health',
            headers: { Host: remoteHost, 'Tailscale-User-Login': ownerLogin },
            signal,
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.once('error', fail);
            response.once('end', () => done({ status: response.statusCode, body }));
          },
        );
        probe.once('error', fail);
        probe.end();
      },
    );
    assert.equal(protectedHealth.status, 200);
    assert.deepEqual(JSON.parse(protectedHealth.body), expectedHealth);

    const page = await fetch(local, { signal });
    assert.equal(page.status, 200);
    const html = await page.text();
    const asset = html.match(/<script[^>]*\bsrc="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(asset, 'Missing a production JavaScript bundle in the packaged dashboard');
    const javascript = await fetch(`${local}${asset}`, { signal });
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get('content-type') ?? '', /^text\/javascript/);
    await javascript.arrayBuffer();

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
    `${name}@${version} installed offline and served the built dashboard using host Node.js.`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
