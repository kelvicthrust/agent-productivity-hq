import assert from 'node:assert/strict';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const manifest = JSON.parse(
  await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
) as { version: string };
const version = manifest.version;
const packagePath = resolve(
  process.argv[2] ?? `dist/cli/kelvicthrust-agent-productivity-hq-${version}.tgz`,
);
const scratch = await mkdtemp(join(tmpdir(), 'agent-productivity-cli-'));
const home = join(scratch, 'home');
const cwd = join(scratch, 'unrelated-project');
const cache = join(scratch, 'npm-cache');
const data = join(scratch, 'data');
const env: NodeJS.ProcessEnv = {
  PATH: `${dirname(process.execPath)}:${process.env['PATH'] ?? ''}`,
  HOME: home,
  TMPDIR: scratch,
  npm_config_cache: cache,
  npm_config_offline: 'true',
  npm_config_ignore_scripts: 'true',
  AGENT_PRODUCTIVITY_DATA_DIR: data,
  AGENT_PRODUCTIVITY_PORT: '',
};
const npx = (...args: string[]) =>
  execute('npx', ['--yes', `--package=${packagePath}`, 'agent-productivity-hq', ...args], {
    cwd,
    env,
    timeout: 40_000,
  });
const stop = () => npx('stop');
let managed: ChildProcess | undefined;
let managedClosed: Promise<unknown> | undefined;
let portOccupier: Server | undefined;

async function claimPort() {
  const listener = createServer((connection) => connection.destroy());
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  return { listener, port: address.port };
}

const releasePort = (listener: Server) =>
  new Promise<void>((resolve) => listener.close(() => resolve()));

async function getHealth(url: string) {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { status: string; version: string };
  assert.equal(result.status, 'ok');
  assert.equal(result.version, version);
}

async function assertStopped(url: string) {
  for (let i = 0; i < 10; i++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (!response) return;
    await sleep(100);
  }
  assert.fail('Dashboard still responds after stop');
}

function print(line: string) {
  process.stdout.write(`${line}\n`);
}

try {
  await Promise.all([mkdir(home), mkdir(cwd)]);
  const { listener, port } = await claimPort();
  env['AGENT_PRODUCTIVITY_PORT'] = String(port);
  const url = `http://127.0.0.1:${port}`;
  await releasePort(listener);

  // Warm npm's cache without starting a worker. Run simultaneous first app launches.
  assert.match((await npx('--help')).stdout, /^Usage: agent-productivity-hq /);
  const [first, second] = await Promise.all([npx('--no-open'), npx('--no-open')]);
  assert.equal(first.stdout.trim(), url);
  assert.equal(second.stdout.trim(), url);
  const page = await fetch(url).then((response) => response.text());
  assert.match(page, /Agent Productivity HQ/);
  await getHealth(url);
  print('npx launches from an unrelated directory, coalesces ownership, and serves the dashboard');

  const clone = join(scratch, 'cloned-data');
  await mkdir(clone);
  const state = 'agent-productivity-cli.json';
  await copyFile(join(data, state), join(clone, state));
  await chmod(join(clone, state), 0o600);
  env['AGENT_PRODUCTIVITY_DATA_DIR'] = clone;
  await assert.rejects(stop(), /No running instance started by this command/);
  await assert.rejects(npx('--no-open'), /port/i);
  env['AGENT_PRODUCTIVITY_DATA_DIR'] = data;
  await getHealth(url);
  print('a copied control record cannot reuse or stop the original data directory');

  // Exercise the browser failure path without opening the owner's graphical session.
  const browserStub = join(scratch, 'browser-open-failure.cjs');
  await writeFile(
    browserStub,
    `const cp = require('node:child_process');
const execute = cp.execFile;
cp.execFile = function(file, args, options, callback) {
  if (file === '/usr/bin/open') return queueMicrotask(() => callback(new Error('headless')));
  return execute.apply(this, arguments);
};
require('node:module').syncBuiltinESMExports();`,
  );
  env['NODE_OPTIONS'] = `--require "${browserStub}"`;
  const headless = await npx();
  delete env['NODE_OPTIONS'];
  assert.equal(headless.stdout.trim(), url);
  assert.match(headless.stderr, /Could not open the browser automatically/);
  print('browser launch failure keeps the usable URL in stdout');

  await rm(cache, { recursive: true, force: true });
  const installed = join(home, 'Library', 'Application Support', 'agent-productivity-cli', version);
  const stylesheet = /href="([^"]+\.css)"/.exec(page)?.[1];
  assert.ok(stylesheet, 'Dashboard links to a CSS bundle');
  const asset = await fetch(new URL(stylesheet, url));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('Content-Type') ?? '', /^text\/css/);
  await asset.arrayBuffer();
  assert.equal((await npx('--no-open')).stdout.trim(), url);
  await getHealth(url);
  assert.match((await stop()).stdout, /Agent Productivity HQ stopped/);
  await assertStopped(url);
  assert.equal((await npx('--no-open')).stdout.trim(), url);
  await getHealth(url);
  await stop();
  print('dashboard survives caller exit and cache removal, then stops and restarts cleanly');

  const occupied = await claimPort();
  portOccupier = occupied.listener;
  env['AGENT_PRODUCTIVITY_PORT'] = String(occupied.port);
  await assert.rejects(npx('--no-open'), (error) => {
    assert.match(String(error), /port|already/i);
    return true;
  });
  assert.ok(portOccupier.listening);
  await releasePort(portOccupier);
  portOccupier = undefined;
  print('port conflicts preserve the unrelated listener');

  env['AGENT_PRODUCTIVITY_PORT'] = String(port);
  managed = fork(join(installed, 'runtime/app/src/server/managed.js'), [], {
    cwd,
    env,
    execArgv: [],
    silent: true,
  });
  managedClosed = once(managed, 'close');
  const deadline = AbortSignal.timeout(15_000);
  const ready = once(managed, 'message', { signal: deadline });
  managed.send({ type: 'start', version });
  assert.equal((await ready)[0].type, 'ready');
  assert.equal(
    JSON.parse(await readFile(join(data, 'agent-productivity.lock'), 'utf8')).managed,
    true,
  );
  await assert.rejects(npx('--no-open'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Paseo/i);
    assert.match(error.message, /stop/i);
    assert.ok(!error.message.includes(url));
    return true;
  });
  await assert.rejects(stop(), /No running instance started by this command/);
  assert.equal(managed.exitCode, null);
  managed.send({ type: 'stop' });
  await managedClosed;
  await assertStopped(url);
  assert.equal((await npx('--no-open')).stdout.trim(), url);
  await getHealth(url);
  await stop();
  print('npx respects the Paseo lease and serves the standalone dashboard after Paseo stops');
} finally {
  if (portOccupier) await releasePort(portOccupier);
  if (managed?.connected) managed.send({ type: 'stop' });
  if (managedClosed) await managedClosed;
  env['AGENT_PRODUCTIVITY_DATA_DIR'] = data;
  await stop().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
}
