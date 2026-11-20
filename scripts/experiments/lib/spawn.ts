import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProcessSession, SpawnOptions, SpawnResult } from './types.ts';

// The only place an experiment can start a program. Programs come from meta.spawns, are run with an argument array and
// `shell: false` (so `;`, `|` and `$()` in an argument are just characters), and are killed when the run ends. What a
// program prints is returned to the script, never printed by the guard.

export class ProgramNotAllowedError extends Error {
  constructor(program: string) {
    super(`"${program.slice(0, 40)}" is not in this script's list of programs it may start.`);
    this.name = 'ProgramNotAllowedError';
  }
}

export interface SpawnerConfig {
  allowed: readonly string[];
  /** `name=path` overrides from --bin. A .js, .mjs, .cjs or .ts path is run with this Node. */
  bins: ReadonlyMap<string, string>;
  announce(line: string): void;
}

export interface Spawner {
  run(program: string, args: string[], options?: SpawnOptions): Promise<SpawnResult>;
  session(program: string, args: string[]): Promise<ProcessSession>;
  started(): string[];
  killAll(): void;
}

const SCRIPT_EXT = /\.(?:[cm]?js|ts)$/;
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

const quote = (arg: string): string =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : JSON.stringify(arg);

export function createSpawner(config: SpawnerConfig): Spawner {
  const started = new Set<string>();
  const live = new Set<ChildProcessWithoutNullStreams>();

  const resolveCommand = (program: string, args: string[]): { command: string; argv: string[] } => {
    if (!config.allowed.includes(program)) throw new ProgramNotAllowedError(program);
    const override = config.bins.get(program);
    if (override && SCRIPT_EXT.test(override))
      return { command: process.execPath, argv: [override, ...args] };
    return { command: override ?? program, argv: args };
  };

  const start = (program: string, args: string[]): ChildProcessWithoutNullStreams => {
    const { command, argv } = resolveCommand(program, args);
    config.announce(`Will start: ${program} ${args.map(quote).join(' ')}`.trim());
    started.add(program);
    const child = nodeSpawn(command, argv, { shell: false, env: process.env });
    live.add(child);
    child.once('close', () => live.delete(child));
    return child;
  };

  return {
    started: () => [...started].sort(),
    killAll: () => {
      for (const child of live) child.kill('SIGKILL');
    },

    run(program, args, options = {}) {
      return new Promise<SpawnResult>((resolvePromise) => {
        const child = start(program, args);
        const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
        let stdout = '';
        let stderr = '';
        let size = 0;
        let timedOut = false;
        let found = true;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs ?? DEFAULT_TIMEOUT);
        const take = (which: 'out' | 'err') => (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            child.kill('SIGKILL');
            return;
          }
          if (which === 'out') stdout += chunk.toString('utf8');
          else stderr += chunk.toString('utf8');
        };
        child.stdout.on('data', take('out'));
        child.stderr.on('data', take('err'));
        child.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') found = false;
        });
        child.once('close', (status, signal) => {
          clearTimeout(timer);
          resolvePromise({
            found,
            status: found ? status : null,
            signal: signal ?? null,
            timedOut,
            stdout,
            stderr,
          });
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.input ?? '');
      });
    },

    async session(program, args) {
      const child = start(program, args);
      const lines: string[] = [];
      const waiters: ((line: string | null) => void)[] = [];
      let carry = '';
      let found = true;
      let ended = false;
      const deliver = (line: string | null) => {
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else if (line !== null) lines.push(line);
      };
      const finish = () => {
        ended = true;
        for (const waiter of waiters.splice(0)) waiter(null);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        carry += chunk.toString('utf8');
        let index = carry.indexOf('\n');
        while (index >= 0) {
          const line = carry.slice(0, index).replace(/\r$/, '');
          carry = carry.slice(index + 1);
          if (line !== '') deliver(line);
          index = carry.indexOf('\n');
        }
      });
      child.stderr.on('data', () => undefined);
      child.stdin.on('error', () => undefined);
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') found = false;
        finish();
      });
      child.once('close', finish);
      // Let a missing program report ENOENT before the caller looks at `found`.
      await new Promise((r) => setImmediate(r));
      return {
        get found() {
          return found;
        },
        send(line) {
          child.stdin.write(`${line}\n`);
        },
        nextLine(timeoutMs) {
          const queued = lines.shift();
          if (queued !== undefined) return Promise.resolve(queued);
          if (ended) return Promise.resolve(null);
          return new Promise<string | null>((resolveLine) => {
            const timer = setTimeout(() => {
              const at = waiters.indexOf(wrapped);
              if (at >= 0) waiters.splice(at, 1);
              resolveLine(null);
            }, timeoutMs);
            const wrapped = (line: string | null) => {
              clearTimeout(timer);
              resolveLine(line);
            };
            waiters.push(wrapped);
          });
        },
        kill() {
          child.kill('SIGKILL');
        },
      };
    },
  };
}
