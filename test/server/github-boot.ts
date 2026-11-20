import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boot, type BootDeps, type ListenFn, type RunningServer } from '../../src/server/boot.ts';
import type { ServerConfig } from '../../src/server/lib/config.ts';
import { RefreshRun } from '../../src/shared/contracts/sources.ts';
import {
  createFakeGithub,
  createMemoryKeyring,
  type FakeGithub,
  type MemoryKeyring,
} from '../fixtures/github/scripted-github.ts';
import { HOST, NOW, TZ, WRITE, call, memoryLogger, tempConfig } from './helpers.ts';

// Shared by the boot-level GitHub tests (restart, secrets, boot order): the real boot over a real data folder, with the scripted
// GitHub, an in-memory Keychain and an instant device-flow wait. No socket, no network, no Keychain, no `gh`.

export const CLIENT_ID = 'Iv1.testclient';
const DAY = 86_400_000;

/** GitHub as the tests know it: `kelvin/atlas-api` with three merged PRs (one by someone else, one merged by a bot). */
export function scriptedGithub(clock: { now: number }): {
  github: FakeGithub;
  keyring: MemoryKeyring;
} {
  const github = createFakeGithub({ login: 'octo-kelvin', now: () => clock.now });
  const merged = (daysAgo: number) => new Date(clock.now - daysAgo * DAY).toISOString();
  github.addRepo({ fullName: 'Kelvin/Atlas-API', nodeId: 'R_atlasapi0001' }, [
    {
      nodeId: 'PR_atlas_1',
      number: 1,
      title: 'Add the health route',
      mergedAt: merged(1),
      author: 'octo-kelvin',
      mergedBy: 'octo-kelvin',
    },
    {
      nodeId: 'PR_atlas_2',
      number: 2,
      title: 'Cache the repo list',
      mergedAt: merged(3),
      author: 'octo-kelvin',
      mergedBy: 'review-bot',
    },
    {
      nodeId: 'PR_atlas_3',
      number: 3,
      title: 'Fix a typo in the README',
      mergedAt: merged(5),
      author: 'a-colleague',
      mergedBy: 'octo-kelvin',
    },
  ]);
  return { github, keyring: createMemoryKeyring() };
}

export interface Started {
  server: RunningServer;
  config: ServerConfig;
  clock: { now: number };
  github: FakeGithub;
  keyring: MemoryKeyring;
  entries: Record<string, unknown>[];
  /** Every response body this server gave, for the scans. */
  bodies: string[];
  send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string; json: unknown }>;
  /** Starts a refresh of GitHub alone and waits for it to end. */
  refreshGithub(): Promise<RefreshRun>;
  /** Waits until the run a repo add started has ended (the repo row says the first pass is done). */
  untilBackfilled(repo: string): Promise<void>;
  db(): DatabaseSync;
  stop(): Promise<void>;
}

const noListen: ListenFn = async () => ({ close: (done) => done?.() });

export async function startWithGithub(
  options: {
    config?: ServerConfig;
    clock?: { now: number };
    scripted?: { github: FakeGithub; keyring: MemoryKeyring };
    ghSignedIn?: boolean;
    boot?: Partial<BootDeps>;
  } = {},
): Promise<Started> {
  const config = options.config ?? tempConfig();
  const clock = options.clock ?? { now: NOW };
  const { github, keyring } = options.scripted ?? scriptedGithub(clock);
  if (options.ghSignedIn === false) github.signOutGh();
  const { logger, entries } = memoryLogger();
  const server = await boot(config, {
    logger,
    listen: noListen,
    now: () => clock.now,
    timezone: TZ,
    scheduler: false,
    github: {
      net: github.net,
      keyring,
      gh: github.gh,
      sleep: async () => {
        // A wait takes no time, and the device flow's own clock does not move: a 15-minute flow runs at once.
      },
    },
    ...options.boot,
  });
  const bodies: string[] = [];
  const send: Started['send'] = async (method, path, body) => {
    const res = await call(server.app, path, {
      method,
      headers: method === 'GET' ? HOST : WRITE,
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  const wait = async <T>(read: () => Promise<T | null>, what: string): Promise<T> => {
    for (let i = 0; i < 400; i += 1) {
      const value = await read();
      if (value !== null) return value;
      await new Promise((done) => setTimeout(done, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return {
    server,
    config,
    clock,
    github,
    keyring,
    entries,
    bodies,
    send,
    refreshGithub: async () => {
      // A run that is going now (the one an add started) is waited for first, so this one is really ours.
      const started = await wait(async () => {
        const res = await send('POST', '/api/refresh', { sources: ['github'] });
        return res.status === 202 ? res : null;
      }, 'a refresh to start');
      const id = RefreshRun.parse(started.json).id;
      return wait(async () => {
        const run = RefreshRun.parse((await send('GET', `/api/refresh/${id}`)).json);
        return run.state === 'running' ? null : run;
      }, 'the refresh to end');
    },
    untilBackfilled: (repo) =>
      wait(async () => {
        const repos = (await send('GET', '/api/repos')).json as {
          active: { id: string; backfillComplete?: boolean }[];
        };
        return repos.active.find((r) => r.id === repo)?.backfillComplete ? undefined : null;
      }, `${repo} to finish its first pass`) as Promise<void>,
    db: () => server.db as DatabaseSync,
    stop: () => server.shutdown(),
  };
}

/** Every file under `dir` (the database, its write-ahead log, the logs), as text a scan can search. */
export function filesText(dir: string): string {
  const parts: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else parts.push(`${path}\n${readFileSync(path, 'latin1')}`);
    }
  };
  walk(dir);
  return parts.join('\n');
}
