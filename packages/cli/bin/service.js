import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { AlreadyRunningError, boot } from '../runtime/app/src/server/boot.js';
import { loadConfig } from '../runtime/app/src/server/lib/config.js';
import { liveBootDeps } from '../runtime/app/src/server/live.js';
import { controlToken, publishControl, removeControl } from './local-control.js';

const reply = (message) =>
  new Promise((resolve) => {
    if (process.connected) process.send(message, resolve);
    else resolve();
  });

let dashboard;
let control;
let ownsControl = false;
let socketDirectory;
const removeSocketDirectory = () =>
  socketDirectory && rm(socketDirectory, { recursive: true, force: true });
let shutdown;
const secret = randomBytes(32).toString('hex');

try {
  const config = loadConfig();
  dashboard = await boot(config, liveBootDeps());
  if (dashboard.mode === 'already_running') throw new AlreadyRunningError(null, config.lockPath);

  const stop = () =>
    (shutdown ??= (async () => {
      // Remove our record while the application still owns its data-directory lease.
      try {
        await removeControl(config.dataDir);
      } finally {
        ownsControl = false;
        await dashboard.shutdown();
      }
    })());

  const token = await controlToken(config.dataDir, secret);
  control = createServer((request, response) => {
    if (request.url !== '/' || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === 'POST') {
      void stop().then(
        () => response.writeHead(204).end(() => control.close()),
        () => response.writeHead(500).end(() => control.close()),
      );
    } else if (request.method === 'GET' && !shutdown) {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end(dashboard.url);
    } else {
      response.writeHead(405).end();
    }
  });
  // macOS limits Unix socket paths to 103 bytes, so use a short private directory.
  socketDirectory = await mkdtemp('/tmp/agent-productivity-');
  const path = join(socketDirectory, 'control.sock');
  control.once('close', () => {
    void removeSocketDirectory().catch(() => {
      process.exitCode = 1;
    });
  });
  control.listen(path);
  await once(control, 'listening');
  await publishControl(config.dataDir, { path, secret });
  ownsControl = true;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      control.close();
      control.closeAllConnections();
      void stop().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  await reply({ kind: 'ready', url: dashboard.url });
} catch (error) {
  control?.close();
  await removeSocketDirectory();
  if (ownsControl) await removeControl(loadConfig().dataDir);
  await dashboard?.shutdown();
  await reply({
    kind: error instanceof AlreadyRunningError && !error.managed ? 'busy' : 'error',
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
