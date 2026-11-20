#!/usr/bin/env node
import { execFile, fork } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { loadConfig } from '../runtime/app/src/server/lib/config.js';
import { contactControl, readControl } from './local-control.js';
import { existingDashboard } from './reuse.js';

const exec = promisify(execFile);
const usage = 'Usage: agent-productivity-hq [--no-open | stop]';

function checkPlatform() {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(process.versions.node);
  const major = Number(match?.[1]);
  const supported = major >= 24 || (major === 22 && Number(match?.[2]) >= 16);
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !supported) {
    throw new Error(
      'Agent Productivity HQ requires Apple Silicon macOS and Node.js 22.x (22.16.0+) or any stable 24.0.0+.',
    );
  }
}

async function requirePrivateDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(
      `Agent Productivity HQ needs a private directory owned by your account at ${path}.`,
    );
  }
}

async function installedService() {
  const source = dirname(import.meta.dirname);
  const { name, version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (
    name !== '@kelvicthrust/agent-productivity-hq' ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)
  ) {
    throw new Error('Invalid Agent Productivity HQ package.');
  }
  const home = await realpath(homedir());
  const support = join(home, 'Library', 'Application Support');
  await mkdir(support, { recursive: true });
  const parent = await realpath(support);
  if (parent !== support)
    throw new Error(`Use a local application support directory at ${support}.`);
  const root = join(parent, 'agent-productivity-cli');
  await mkdir(root, { mode: 0o700, recursive: true });
  await requirePrivateDirectory(root);
  const release = join(root, version);
  try {
    await requirePrivateDirectory(release);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const stage = await mkdtemp(join(root, '.install-'));
    try {
      const copy = join(stage, 'package');
      await mkdir(copy, { mode: 0o700 });
      for (const name of [
        'bin',
        'runtime',
        'node_modules',
        'package.json',
        'LICENSE',
        'THIRD-PARTY-NOTICES.txt',
      ]) {
        await cp(join(source, name), join(copy, name), { recursive: true });
      }
      try {
        await rename(copy, release);
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        await requirePrivateDirectory(release);
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  return join(release, 'bin', 'service.js');
}

async function launch(service, config) {
  const env = {
    ...process.env,
    AGENT_PRODUCTIVITY_DATA_DIR: config.dataDir,
    AGENT_PRODUCTIVITY_PORT: String(config.port),
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const child = fork(service, [], {
    cwd: dirname(dirname(service)),
    detached: true,
    env,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Agent Productivity HQ did not become ready within 20 seconds.'));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Agent Productivity HQ exited before startup completed (code ${code}).`));
    });
    child.once('message', (result) => {
      clearTimeout(timeout);
      child.unref();
      child.channel?.unref();
      resolve(result);
    });
  });
}

async function openOrStart(config) {
  const existing = await existingDashboard(config.dataDir);
  if (existing) return existing;

  const result = await launch(await installedService(), config);
  if (result.kind === 'ready') return result.url;
  if (result.kind === 'busy') {
    for (let deadline = Date.now() + 8000; Date.now() < deadline;) {
      const url = await existingDashboard(config.dataDir);
      if (url) return url;
      await sleep(200);
    }
  }
  throw new Error(result.message);
}

try {
  checkPlatform();
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && !['--no-open', 'stop', '--help'].includes(args[0]))
  ) {
    throw new Error(usage);
  }
  const config = loadConfig();
  if (args[0] === '--help') {
    console.log(usage);
  } else if (args[0] === 'stop') {
    const control = await readControl(config.dataDir);
    if (!control || !(await contactControl(control, true))) {
      throw new Error(
        'No running instance started by this command was found for the selected data directory.',
      );
    }
    console.log('Agent Productivity HQ stopped.');
  } else {
    const url = await openOrStart(config);
    console.log(url);
    if (args[0] !== '--no-open') {
      await exec('/usr/bin/open', [url], { timeout: 3000 }).catch(() =>
        console.error('Could not open the browser automatically. Open the URL above.'),
      );
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
