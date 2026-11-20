import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  findHostNode,
  isSupportedNodeVersion,
  resolveNodeExecutable,
} from '../server/node-runtime.ts';

const packageRoot = join(import.meta.dirname, '..');
const nodeVersion = '26.13.1';
const versionFolder = `node-v${nodeVersion}-darwin-arm64`;
const nodeSha256 = 'af6202f5370a3a5209e85dc543758dfd9f44c8726626a236730cd603a67a8559';
const nativeMac = process.platform === 'darwin' && process.arch === 'arm64';

async function testHost(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'productivity-node-test-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    home,
    path: '',
    nvmDirectory: undefined,
    execPath: '',
    systemNodes: [] as string[],
  };
}

async function fakeNode(path: string, version = nodeVersion) {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(path, `#!/bin/sh\necho 'darwin arm64 ${version}'\n`, { mode: 0o700 });
  return path;
}

function cacheRoot(home: string) {
  return join(home, 'Library/Application Support/agent-productivity/paseo-runtime');
}

test('accepts stable runtimes with the required SQLite APIs, including newer majors', () => {
  for (const version of ['22.16.0', '22.17.0', '24.0.0', '25.0.0', '26.3.1', '27.0.0']) {
    assert.equal(isSupportedNodeVersion(version), true, version);
  }
  for (const version of [
    '21.99.0',
    '22.15.1',
    '23.11.1',
    '26.14.0-rc.1',
    '26.13.1+build',
    '26.13.1\n',
    '024.0.0',
    'v26.13.1',
  ]) {
    assert.equal(isSupportedNodeVersion(version), false, version);
  }
});

test('ignores relative PATH and project-local paths before selecting a patched NVM node', async (t) => {
  const host = await testHost(t);
  const checkout = join(host.home, 'checkout');
  const current = process.cwd();
  const stale = await fakeNode(join(host.home, 'old', 'bin', 'node'), '22.15.1');
  const lexical = await fakeNode(join(checkout, 'node_modules', '.bin', 'node'));
  const link = join(host.home, 'alternate-path', 'node');
  await mkdir(dirname(link));
  await symlink(lexical, link);
  const safe = await fakeNode(
    join(host.home, '.nvm', 'versions', 'node', 'v26.14.0', 'bin', 'node'),
    '26.14.0',
  );
  host.execPath = stale;
  host.path = ['node_modules/.bin', dirname(lexical), dirname(link)].join(delimiter);

  process.chdir(checkout);
  try {
    assert.equal(await findHostNode(packageRoot, new AbortController().signal, host), safe);
  } finally {
    process.chdir(current);
  }
});

test('discovers an opted-in Volta shim at HOME and probes its Node invocation in the launch directory', async (t) => {
  const host = await testHost(t);
  const current = process.cwd();
  const project = await fakeNode(join(host.home, 'workspace', 'node_modules', '.bin', 'node'));
  const shim = join(host.home, '.volta', 'bin', 'node');
  const dispatcher = join(dirname(shim), 'volta-shim');
  const cwd = await realpath(packageRoot);
  await mkdir(dirname(shim), { mode: 0o700, recursive: true });
  await writeFile(
    dispatcher,
    `#!/bin/sh
    [ "$(/usr/bin/basename "$0")" = "node" ] && [ "$PWD" = ${JSON.stringify(cwd)} ] || exit 1
    echo 'darwin arm64 ${nodeVersion}'
    `,
    { mode: 0o700 },
  );
  await symlink(dispatcher, shim);
  host.path = [dirname(project), dirname(shim)].join(delimiter);

  process.chdir(host.home);
  try {
    assert.equal(await findHostNode(packageRoot, new AbortController().signal, host), shim);
  } finally {
    process.chdir(current);
  }
});

test(
  'prefers an eligible host runtime over a private install and uses the private runtime offline',
  { skip: !nativeMac },
  async (t) => {
    const host = await testHost(t);
    const installed = join(cacheRoot(host.home), versionFolder);
    const cached = await fakeNode(join(installed, 'bin', 'node'));
    await writeFile(join(installed, 'LICENSE'), 'Fixture license', { mode: 0o600 });
    await writeFile(join(installed, 'archive.sha256'), `${nodeSha256}\n`, { mode: 0o600 });
    const node = await fakeNode(join(host.home, 'host', 'bin', 'node'), '26.14.0');
    host.path = dirname(node);
    const fetch = t.mock.method(globalThis, 'fetch', () => {
      throw new Error('Network must stay idle with a runtime available');
    });
    const { signal } = new AbortController();
    assert.equal(await resolveNodeExecutable(packageRoot, signal, true, host), node);
    host.path = '';
    assert.equal(await resolveNodeExecutable(packageRoot, signal, false, host), cached);
    assert.equal(fetch.mock.callCount(), 0);
  },
);

test(
  'requires explicit installation and discards a mismatched download without publishing it',
  { skip: !nativeMac },
  async (t) => {
    const host = await testHost(t);
    const root = cacheRoot(host.home);
    const { signal } = new AbortController();
    const mockFetch: typeof globalThis.fetch = async (url, options) => {
      assert.equal(url, `https://nodejs.org/dist/v${nodeVersion}/${versionFolder}.tar.xz`);
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.credentials, 'omit');
      return new Response('Corrupt archive');
    };
    const fetch = t.mock.method(globalThis, 'fetch', mockFetch);
    await assert.rejects(resolveNodeExecutable(packageRoot, signal, false, host), {
      reason: 'runtime-required',
    });
    assert.equal(fetch.mock.callCount(), 0);
    await assert.rejects(readdir(root), { code: 'ENOENT' });

    for (let attempts = 1; attempts <= 2; attempts++) {
      await assert.rejects(resolveNodeExecutable(packageRoot, signal, true, host), {
        reason: 'runtime-install-failed',
        message: /integrity check/,
      });
      assert.deepEqual(await readdir(root), []);
      assert.equal(fetch.mock.callCount(), attempts);
    }

    await mkdir(join(root, versionFolder), { mode: 0o700 });
    await assert.rejects(resolveNodeExecutable(packageRoot, signal, true, host), {
      reason: 'runtime-install-failed',
      message: new RegExp(`move ${versionFolder}`),
    });
    assert.equal(fetch.mock.callCount(), 2);
  },
);

test(
  'refuses to follow a symlink out of the runtime cache path',
  { skip: !nativeMac },
  async (t) => {
    const host = await testHost(t);
    const outside = join(host.home, 'outside-home');
    await mkdir(outside);
    host.home = join(host.home, 'daemon-home');
    const support = join(host.home, 'Library', 'Application Support');
    await mkdir(support, { mode: 0o700, recursive: true });
    await symlink(outside, join(support, 'agent-productivity'));
    const fetch = t.mock.method(globalThis, 'fetch', () => {
      throw new Error('An unsafe cache path must not start a download');
    });

    await assert.rejects(
      resolveNodeExecutable(packageRoot, new AbortController().signal, true, host),
      { reason: 'runtime-install-failed' },
    );
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(await readdir(outside), []);
  },
);
