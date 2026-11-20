import { spawn, type ChildProcess } from 'node:child_process';
import type { AppServerProcess, LaunchAppServer, NextLine } from './ports.ts';

// The LIVE side of the app-server port (collectors/chatgpt/ports.ts): `codex app-server` started for real. `pnpm start` hands this to
// boot; the preview command and every test hand a scripted one instead, so only the real app ever starts Codex. This file is the only
// one in the project that starts a program for the ChatGPT integration, and it does it one way: `spawn` with an argument array and
// no `shell` option, so nothing is ever interpreted by a shell and nothing the owner or a provider said can become a command.
//
//   standard input   the JSON-RPC requests, one line each
//   standard output  the JSON-RPC answers, read line by line
//   standard error   ignored: it is the app-server's own log, and the dashboard never keeps text it did not write
//
// `kill()` stops the child (SIGTERM, then SIGKILL if it is still there two seconds later), so a read never leaves one behind.

export interface LiveOptions {
  /** The program to start. `codex`, found on PATH, unless a test points it at a stand-in. */
  program?: string;
  /** Its arguments. `['app-server']` unless a test points `program` at a stand-in that needs more. */
  args?: readonly string[];
  /** The child's environment. This process's own unless a test gives one. */
  env?: NodeJS.ProcessEnv;
}

/** A line longer than this is not JSON-RPC from Codex; the child is stopped rather than let it fill memory. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

function wrap(child: ChildProcess): AppServerProcess {
  const queue: string[] = [];
  let buffered = '';
  let closed = false;
  let wake: (() => void) | null = null;
  const poke = (): void => {
    const waiting = wake;
    wake = null;
    waiting?.();
  };

  const stop = (): void => {
    if (closed) return;
    child.stdin?.end();
    child.kill('SIGTERM');
    // A child that ignores SIGTERM is not left running.
    setTimeout(() => {
      if (!closed) child.kill('SIGKILL');
    }, KILL_GRACE_MS).unref();
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at).replace(/\r$/, '');
      buffered = buffered.slice(at + 1);
      if (line.trim() !== '') queue.push(line);
    }
    if (buffered.length > MAX_LINE_BYTES) {
      buffered = '';
      stop();
    }
    poke();
  });
  child.once('close', () => {
    closed = true;
    poke();
  });
  // Errors after the child started (a failed kill, a broken pipe) end it; they are not thrown into the process.
  child.on('error', () => {
    closed = true;
    poke();
  });
  child.stdin?.on('error', () => undefined);

  return {
    send(line) {
      if (!closed && child.stdin?.writable) child.stdin.write(`${line}\n`);
    },
    async nextLine(timeoutMs): Promise<NextLine> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const line = queue.shift();
        if (line !== undefined) return { kind: 'line', line };
        if (closed) return { kind: 'closed' };
        const left = deadline - Date.now();
        if (left <= 0) return { kind: 'timeout' };
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, left);
          function done(): void {
            clearTimeout(timer);
            if (wake === done) wake = null;
            resolve();
          }
          wake = done;
        });
      }
    },
    kill: stop,
  };
}

/** `codex app-server`, for real. Resolves null when there is no `codex` on PATH. */
export function createLiveLauncher(options: LiveOptions = {}): LaunchAppServer {
  const program = options.program ?? 'codex';
  const args = options.args ?? ['app-server'];
  return () =>
    new Promise((resolve, reject) => {
      const child = spawn(program, [...args], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      let settled = false;
      // Not installed (ENOENT) is a state of the machine; any other failure to start is an error.
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (error.code === 'ENOENT') resolve(null);
        else reject(error);
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        resolve(wrap(child));
      });
    });
}
