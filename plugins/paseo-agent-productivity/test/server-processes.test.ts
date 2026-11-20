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
    process.on('message', ({ type, ownerLogin, remoteHost, version }) => {
      if (type !== 'start' || ownerLogin !== ${JSON.stringify(ownerLogin)} || remoteHost !== ${JSON.stringify(authority)}) process.exit(2);
      if (version === '1.2.5') {
        process.send({ type: 'error', code: 'port-in-use', message: 'Sensitive local process details' });
      } else {
        process.send({ type: 'ready', version: '1.2.3', port: 4317, remotePort: 53270 });
      }
    });
  `,
  );
  const paths = { directory, version: '1.2.3', node: process.execPath, entry, serveSession };
  const host = { authority, ownerLogin, addresses: ['100.90.0.2'] };
  const { signal } = new AbortController();
  const child = await startDashboard(paths, host, 4317, signal);
  t.after(() => child.stop());
  assert.equal(child.alive(), true);
  assert.equal(child.remotePort, 53270);
  await child.stop();
  assert.equal(child.alive(), false);
  await assert.rejects(startDashboard({ ...paths, version: '1.2.4' }, host, 4317, signal));
  await assert.rejects(startDashboard({ ...paths, version: '1.2.5' }, host, 4317, signal), {
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
