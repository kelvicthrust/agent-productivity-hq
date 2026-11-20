import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { contactControl, readControl } from './local-control.js';

const exec = promisify(execFile);

async function filesHeldBy(pid, args) {
  const { stdout } = await exec(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(pid), '-Fn', ...args],
    { timeout: 2000, maxBuffer: 32_768 },
  );
  return stdout.split('\n').filter((line) => line.startsWith('n'));
}

// A Paseo or source install has no CLI control socket. Confirm its process has both the
// selected data directory's SQLite lease file open and the advertised loopback listener.
async function dashboardFromDirectory(dataDir) {
  try {
    const lock = join(dataDir, 'agent-productivity.lock');
    const stat = await lstat(lock);
    if (!stat.isFile() || stat.uid !== process.getuid()) return null;
    const record = await readFile(lock, 'utf8');
    const { pid, port, version } = JSON.parse(record);
    if (
      version !== 2 ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return null;
    }
    const lease = await realpath(join(dataDir, 'agent-productivity-lock.sqlite'));
    const url = `http://127.0.0.1:${port}`;
    const [leases, listeners, health] = await Promise.all([
      filesHeldBy(pid, [lease]),
      filesHeldBy(pid, [`-iTCP:${port}`, '-sTCP:LISTEN']),
      fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' }),
    ]);
    if (
      leases.includes(`n${lease}`) &&
      listeners.includes(`n127.0.0.1:${port}`) &&
      health.ok &&
      (await health.json()).status === 'ok' &&
      (await readFile(lock, 'utf8')) === record
    ) {
      return url;
    }
  } catch {
    // The diagnostic could be stale, or a process may still be starting.
  }
  return null;
}

export async function existingDashboard(dataDir) {
  return (await contactControl(await readControl(dataDir))) ?? dashboardFromDirectory(dataDir);
}
