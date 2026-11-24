import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { startDashboard } from '../server/processes.ts';

const authority = 'mini.example-tailnet.ts.net:4317';
const ownerLogin = 'owner@example.com';
const browserTicket = { ticket: 'A'.repeat(43), expiresAt: 2_000_000_000_000 };
const serveSession = fileURLToPath(new URL('../server/serve-session.mjs', import.meta.url));

async function scratch(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'productivity-launch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('receives the matching IPC handshake from a live child and rejects a different package version', async (t) => {
  const directory = await scratch(t);
  const entry = join(directory, 'dashboard.cjs');
  await writeFile(
    entry,
    `
    let read;
    let first;
    let attached = false;
    process.on('message', ({ type, id, ownerLogin, remoteHost, version, request, ...response }) => {
      if (type === 'start') {
        if (ownerLogin !== undefined || remoteHost !== undefined) process.exit(2);
        if (version === '1.2.5') {
          process.send({ type: 'error', code: 'port-in-use', message: 'Sensitive local process details' });
        } else {
          process.send({ type: 'paseo-read', id: 1, request: { kind: 'usage' } });
        }
      }
      if (type === 'paseo-read-result' && id === 1) {
        read = response;
        process.send({ type: 'ready', version: '1.2.3', port: 4317 });
      }
      if (type === 'native') {
        const result = { type: 'native-result', id, result: { ok: true, data: { request, read } } };
        if (!first) {
          first = result;
          return;
        }
        process.send({ type: 'remote-result', id: first.id, ok: false });
        process.send({ ...first, id: 9876 });
        process.send(result);
        process.send(first);
      }
      if (type === 'attach-remote') {
        if (ownerLogin !== ${JSON.stringify(ownerLogin)} || remoteHost !== ${JSON.stringify(authority)}) process.exit(2);
        attached = true;
        process.send({ type: 'remote-result', id, ok: true, port: 53270 });
      }
      if (type === 'detach-remote') {
        attached = false;
        process.send({ type: 'remote-result', id, ok: true });
      }
      if (type === 'issue-browser-ticket') {
        if (ownerLogin !== undefined || remoteHost !== undefined || Object.keys(response).length) process.exit(2);
        process.send({ type: 'remote-result', id, ok: false });
        process.send(attached
          ? { type: 'browser-ticket-result', id, ok: true, ...${JSON.stringify(browserTicket)} }
          : { type: 'browser-ticket-result', id, ok: false });
      }
    });
  `,
  );
  const paths = { directory, version: '1.2.3', node: process.execPath, entry, serveSession };
  const host = { authority, ownerLogin, addresses: ['100.90.0.2'] };
  const { signal } = new AbortController();
  const child = await startDashboard(paths, 4317, signal, async ({ kind }) => ({ kind }));
  t.after(() => child.stop());
  assert.equal(child.alive(), true);
  const requests = [{ operation: 'bootstrap' }, { operation: 'roster' }] as const;
  assert.deepEqual(
    await Promise.all(requests.map((request) => child.native(request))),
    requests.map((request) => ({
      ok: true,
      data: { request, read: { ok: true, value: { kind: 'usage' } } },
    })),
  );
  await assert.rejects(child.issueBrowserTicket());
  assert.equal(await child.attachRemote(host), 53270);
  assert.deepEqual(await child.issueBrowserTicket(), browserTicket);
  await child.detachRemote();
  await assert.rejects(child.issueBrowserTicket());
  await child.stop();
  assert.equal(child.alive(), false);
  await assert.rejects(startDashboard({ ...paths, version: '1.2.4' }, 4317, signal));
  await assert.rejects(startDashboard({ ...paths, version: '1.2.5' }, 4317, signal), {
    message: /The local dashboard port is already in use/,
  });
});

test(
  'a killed launcher releases the foreground Serve child even through a shell CLI wrapper',
  { timeout: 10_000 },
  async (t) => {
    const directory = await scratch(t);
    const fakeCli = join(directory, 'tailscale');
    const lease = join(directory, 'foreground-lease');
    const implementation = join(directory, 'tailscale.cjs');
    await writeFile(
      fakeCli,
      '#!/bin/sh\n"$AGENT_PRODUCTIVITY_TEST_NODE" "$AGENT_PRODUCTIVITY_TEST_TAILSCALE" "$@"\n',
      { mode: 0o700 },
    );
    await writeFile(
      implementation,
      `
    const { writeFileSync } = require('node:fs');
    const [command, mode, port, target] = process.argv.slice(2);
    if (command !== 'serve' || mode !== '--bg=false' || port !== '--https=4317' || target !== 'http://127.0.0.1:53270') process.exit(2);
    writeFileSync(${JSON.stringify(lease)}, 'active');
    process.once('SIGTERM', () => {
      writeFileSync(${JSON.stringify(lease)}, 'released');
      process.exit(0);
    });
    process.stdout.write('Available within your tailnet:\\n\\nhttps://${authority}/\\n');
    setInterval(() => {}, 1000);
  `,
    );
    const launcher = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
    import { startServe } from ${JSON.stringify(new URL('../server/processes.ts', import.meta.url).href)};
    const paths = ${JSON.stringify({ directory, node: process.execPath, serveSession })};
    await startServe(paths, ${JSON.stringify(fakeCli)}, ${JSON.stringify(authority)}, 53270, new AbortController().signal);
    process.stdout.write('ready\\n');
  `,
      ],
      {
        env: {
          ...process.env,
          AGENT_PRODUCTIVITY_TEST_NODE: process.execPath,
          AGENT_PRODUCTIVITY_TEST_TAILSCALE: implementation,
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const closed = once(launcher, 'close');
    t.after(async () => {
      launcher.kill('SIGKILL');
      await closed;
    });
    const [ready] = await Promise.race([once(launcher.stdout, 'data'), closed]);
    assert.equal(String(ready).trim(), 'ready');
    assert.equal(await readFile(lease, 'utf8'), 'active');
    launcher.kill('SIGKILL');
    await closed;
    assert.equal(await readFile(lease, 'utf8'), 'released');
  },
);
