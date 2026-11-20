import { spawn } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';

// The CLI owns a foreground Serve session. It does not watch its parent, so this
// IPC child terminates the CLI when Paseo reloads or the launcher loses its parent.
const [binary, authority, port, target] = process.argv.slice(2);
if (!process.connected) process.exit(1);

const serve = spawn(binary, ['serve', '--bg=false', `--https=${port}`, target], {
  detached: true,
  stdio: ['ignore', 'pipe', 'inherit'],
});

let stopping = false;
let closed = false;
let stdout = '';
let acknowledged = false;
serve.stdout.setEncoding('utf8').on('data', (chunk) => {
  if (acknowledged || stopping) return;
  stdout = (stdout + chunk).slice(-8192);
  // The CLI prints the URL only after tailscaled has acknowledged SetServeConfig.
  if (
    stdout
      .split('\n')
      .some(
        (line) => line.trim() === `https://${authority}` || line.trim() === `https://${authority}/`,
      )
  ) {
    acknowledged = true;
    process.send({ type: 'ready' }, (error) => {
      if (error) stop();
    });
  }
});

function stop() {
  if (stopping) return;
  stopping = true;
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), 1_000).unref();
}

function signalGroup(signal) {
  if (closed || serve.pid === undefined) return;
  try {
    // Some installations put a shell wrapper in front of the native CLI.
    process.kill(-serve.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') console.error('[Agent HQ] Could not stop the Serve session.');
  }
}

process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
serve.once('error', () => {
  process.exitCode = 1;
});
serve.once('close', (code) => {
  closed = true;
  if (process.connected) process.disconnect();
  process.exitCode = stopping ? 0 : (code ?? 1);
});
