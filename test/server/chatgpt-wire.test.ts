import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OverviewResponse } from '../../src/shared/contracts/overview.ts';
import { boot, type ListenFn } from '../../src/server/boot.ts';
import { listMigrations, migrate } from '../../src/server/db/migrate.ts';
import { openDatabase } from '../../src/server/db/open.ts';
import {
  markChatgptConnected,
  readAccountSnapshot,
  replaceRateLimits,
} from '../../src/server/db/queries/accounts.ts';
import { loadScenario, scriptedAppServer, withMethods } from '../collectors/chatgpt/scripted.ts';
import type { Scenario } from '../fixtures/appserver/scenario.ts';
import { makeHome } from '../integration/import/helpers.ts';
import { HOST, NOW, TZ, WRITE, call, memoryLogger, tempConfig, tempDir } from './helpers.ts';

// ChatGPT through the real boot (G9_2, G9_3, G9_4): the process is given a scripted Codex app-server (nothing is started, nothing on
// this machine is read) over a temp HOME holding the INVENTED local fixtures, and a refresh runs stage 4 after the local import.
// What these pin is the wiring, not the client (test/collectors/chatgpt has that):
//   - the card and the report arrive through GET /api/sources and GET /api/overview, the account figure beside the local one;
//   - an account read changes no local figure: the Overview KPIs are the same with and without it;
//   - Connect, poll and Disconnect reach the service, Disconnect stops the reading, and a process with no integration says so;
//   - a call that never answers ends the run and keeps what was there.

const listen: ListenFn = async () => ({ close: (callback) => callback?.() });

type Scripted = ReturnType<typeof scriptedAppServer>;

async function bootOver(
  options: { chatgpt?: Pick<Scripted, 'launch'>; callTimeoutMs?: number; now?: () => number } = {},
  config = tempConfig(),
) {
  const { logger } = memoryLogger('debug');
  const server = await boot(config, {
    logger,
    listen,
    now: options.now ?? (() => NOW),
    timezone: TZ,
    scheduler: false,
    local: { env: {}, home: makeHome() },
    ...(options.chatgpt
      ? {
          chatgpt: {
            launch: options.chatgpt.launch,
            ...(options.callTimeoutMs === undefined
              ? {}
              : { callTimeoutMs: options.callTimeoutMs }),
          },
        }
      : {}),
  });
  return server;
}
type Server = Awaited<ReturnType<typeof bootOver>>;

async function get<T>(server: Server, path: string): Promise<T> {
  const response = await call(server.app as never, path, { headers: HOST });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function post(server: Server, path: string, body: unknown = {}): Promise<Response> {
  return call(server.app as never, path, {
    method: 'POST',
    headers: WRITE,
    body: JSON.stringify(body),
  });
}

/** Starts a refresh as the Refresh button does and waits for the run to end. */
async function refresh(server: Server, sources?: readonly string[]): Promise<{ state: string }> {
  const started = await post(server, '/api/refresh', sources ? { sources } : {});
  // 409: a run is already going (Connect starts a ChatGPT-only read at once); wait for that one, as the page does.
  expect([202, 409]).toContain(started.status);
  const body = (await started.json()) as { id?: number; error?: { details?: { runId?: number } } };
  const id = body.id ?? body.error?.details?.runId;
  if (id === undefined) throw new Error('no run id in the answer');
  for (let waited = 0; waited < 10_000; waited += 10) {
    const run = await get<{ state: string }>(server, `/api/refresh/${id}`);
    if (run.state !== 'running' && run.state !== 'queued') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run did not end');
}

interface Card {
  id: string;
  status: string;
  statusText?: string;
}
interface SourcesAnswer {
  accounts?: Card[];
}
interface OverviewAnswer {
  kpis: unknown;
  accounts: { account: string; unit: string }[];
  coverage: { accounts: Card[] };
}

const WEEK = '/api/overview?start=2026-11-02&end=2026-11-08';

describe('ChatGPT through boot', () => {
  it('reads the account in stage 4 and shows its card and report, apart from every local figure', async () => {
    const app = scriptedAppServer(loadScenario('chatgpt-with-threads'));
    const server = await bootOver({ chatgpt: app });
    try {
      expect((await refresh(server)).state).not.toBe('failed');
      expect(app.launches()).toBeGreaterThan(0);

      const sources = await get<SourcesAnswer>(server, '/api/sources');
      expect(sources.accounts?.map((a) => a.id)).toEqual(['chatgpt']);
      expect(['existing', 'connected']).toContain(sources.accounts?.[0]?.status);

      const overview = await get<OverviewAnswer>(server, WEEK);
      expect(overview.accounts).toHaveLength(1);
      expect(overview.accounts[0]).toMatchObject({
        account: 'chatgpt',
        unit: 'percent',
        rateLimits: [{ windowMinutes: 10_080, usedPercent: 41 }],
      });
      expect(overview.accounts[0]).not.toHaveProperty('periodTokens');
      const card = overview.coverage.accounts.find((a) => a.id === 'chatgpt');
      expect(['existing', 'connected']).toContain(card?.status);
    } finally {
      await server.shutdown();
    }
  });

  it('changes no local figure: the Overview KPIs are the same with and without the account read', async () => {
    const without = await bootOver();
    const withChatgpt = await bootOver({
      chatgpt: scriptedAppServer(loadScenario('chatgpt-with-threads')),
    });
    try {
      await refresh(without);
      await refresh(withChatgpt);
      const plain = await get<OverviewAnswer>(without, WEEK);
      const both = await get<OverviewAnswer>(withChatgpt, WEEK);
      expect(both.kpis).toEqual(plain.kpis);
      expect(plain.accounts).toEqual([]);
      expect(both.accounts).toHaveLength(1);
    } finally {
      await without.shutdown();
      await withChatgpt.shutdown();
    }
  });

  it('requires a verified Codex weekly window after upgrade, retains it on failure, and clears it on a successful empty read', async () => {
    const config = tempConfig();
    const legacyMigrations = tempDir();
    for (const migration of listMigrations().filter(({ version }) => version <= 5)) {
      copyFileSync(migration.path, join(legacyMigrations, migration.file));
    }
    mkdirSync(config.dataDir);
    const legacyDb = openDatabase(config.dbPath);
    try {
      migrate(legacyDb, legacyMigrations);
      markChatgptConnected(legacyDb, NOW - 60_000);
      legacyDb
        .prepare(
          `INSERT INTO account_snapshot (account, kind, limit_id, unit, value, window_minutes, resets_at, fetched_at)
           VALUES ('chatgpt', 'rate_limit', 'primary', 'percent', 99, 10080, ?, ?)`,
        )
        .run(NOW + 60_000, NOW - 60_000);
      legacyDb
        .prepare("INSERT INTO chatgpt_report_read VALUES ('limits', 'succeeded', ?, ?)")
        .run(NOW - 60_000, NOW - 60_000);
    } finally {
      legacyDb.close();
    }

    const base = loadScenario('chatgpt-with-threads');
    const weekly = { usedPercent: 90, windowDurationMins: 10_080, resetsAt: (NOW + 60_000) / 1000 };
    let limits: Scenario['methods'][string] = 'silent';
    let now = NOW;
    const server = await bootOver(
      {
        now: () => now,
        chatgpt: {
          launch: () =>
            scriptedAppServer(withMethods(base, { 'account/rateLimits/read': limits })).launch(),
        },
      },
      config,
    );
    const accounts = async () => OverviewResponse.parse(await get<unknown>(server, WEEK)).accounts;
    const read = () => refresh(server, ['chatgpt_account']);

    try {
      expect(await accounts()).toEqual([]);
      expect(readAccountSnapshot(server.db!, 'chatgpt').rateLimits).toMatchObject([
        { limitId: 'primary', usedPercent: 99 },
      ]);
      expect((await get<OverviewAnswer>(server, WEEK)).coverage.accounts).toContainEqual(
        expect.objectContaining({ id: 'chatgpt', status: 'connected' }),
      );
      expect((await read()).state).toBe('partial');
      expect(await accounts()).toEqual([]);

      limits = { result: { rateLimits: { primary: weekly } } };
      expect((await read()).state).toBe('succeeded');
      expect(await accounts()).toEqual([]);

      const codex = { primary: { ...weekly, usedPercent: 0 } };
      const model = { limitId: 'codex_model', primary: weekly };
      limits = {
        result: { rateLimits: model, rateLimitsByLimitId: { codex, codex_model: model } },
      };
      expect((await read()).state).toBe('succeeded');
      const verified = await accounts();
      expect(verified).toMatchObject([
        {
          account: 'chatgpt',
          stale: false,
          refreshedAt: new Date(NOW).toISOString(),
          rateLimits: [{ limitId: 'primary', usedPercent: 0 }],
        },
      ]);

      const primary = { usedPercent: 20, windowDurationMins: 300 };
      for (const secondary of [
        { ...weekly, usedPercent: 'bad' },
        { ...weekly, windowDurationMins: 'bad' },
      ]) {
        limits = { result: { rateLimitsByLimitId: { codex: { primary, secondary } } } };
        now += 1_000;
        expect((await read()).state).toBe('partial');
        expect(await accounts()).toEqual([{ ...verified[0], stale: true }]);
      }

      limits = 'silent';
      now += 1_000;
      expect((await read()).state).toBe('partial');
      expect(await accounts()).toEqual([{ ...verified[0], stale: true }]);

      const legacyCodex = { limitId: 'codex', primary: { ...weekly, usedPercent: 18 } };
      limits = { result: { rateLimits: legacyCodex } };
      expect((await read()).state).toBe('succeeded');
      const retried = await accounts();
      expect(retried).toMatchObject([
        {
          account: 'chatgpt',
          stale: false,
          refreshedAt: new Date(now).toISOString(),
          rateLimits: [{ limitId: 'primary', usedPercent: 18 }],
        },
      ]);

      replaceRateLimits(
        server.db!,
        'chatgpt',
        [{ limitId: 'primary', usedPercent: 55, windowMinutes: 10_080, resetsAt: NOW + 60_000 }],
        now,
      );
      expect(await accounts()).toEqual([]);
      expect((await read()).state).toBe('succeeded');
      expect(await accounts()).toEqual(retried);

      limits = { result: { rateLimitsByLimitId: { codex: { primary, secondary: null } } } };
      expect((await read()).state).toBe('succeeded');
      expect(await accounts()).toEqual([]);

      limits = { result: { rateLimits: legacyCodex } };
      expect((await read()).state).toBe('succeeded');
      expect(await accounts()).toEqual(retried);

      limits = {
        result: {
          rateLimits: legacyCodex,
          rateLimitsByLimitId: { codex_model: model },
        },
      };
      expect((await read()).state).toBe('succeeded');
      expect(await accounts()).toEqual([]);
    } finally {
      await server.shutdown();
    }
  });

  it('serves Connect and Disconnect: an existing sign-in asks nothing, and Disconnect stops the reading', async () => {
    const app = scriptedAppServer(loadScenario('chatgpt-with-threads'));
    const server = await bootOver({ chatgpt: app });
    try {
      const connect = await post(server, '/api/accounts/chatgpt/connect');
      expect(connect.status).toBe(200);
      expect(await connect.json()).toEqual({ loginId: null, mode: 'existing' });

      await refresh(server, ['chatgpt_account']);
      const read = app.launches();

      const gone = await post(server, '/api/accounts/chatgpt/disconnect');
      expect(gone.status).toBe(200);
      expect(await gone.json()).toMatchObject({ id: 'chatgpt', status: 'notconnected' });

      // Disconnect stops the dashboard reading: the next run starts no Codex, and no report is shown. What was read stays stored.
      await refresh(server, ['chatgpt_account']);
      expect(app.launches()).toBe(read);
      expect((await get<OverviewAnswer>(server, WEEK)).accounts).toEqual([]);
    } finally {
      await server.shutdown();
    }
  });

  it('keeps what it had when a call never answers, and the run still ends', async () => {
    // usage-silent: account/usage/read is never answered, the rest is.
    const app = scriptedAppServer(loadScenario('usage-silent'));
    const server = await bootOver({ chatgpt: app, callTimeoutMs: 40 });
    try {
      const run = await refresh(server, ['chatgpt_account']);
      expect(['succeeded', 'partial', 'failed']).toContain(run.state);
      const overview = await get<OverviewAnswer>(server, WEEK);
      expect(overview.coverage.accounts.find((a) => a.id === 'chatgpt')).toBeDefined();
    } finally {
      await server.shutdown();
    }
  });

  it('says so, with no card, when the process has no Codex integration', async () => {
    const server = await bootOver();
    try {
      const connect = await post(server, '/api/accounts/chatgpt/connect');
      expect(connect.status).toBe(422);
      const sources = await get<SourcesAnswer>(server, '/api/sources');
      expect(sources.accounts).toBeUndefined();
      const overview = await get<OverviewAnswer>(server, WEEK);
      expect(overview.coverage.accounts.find((a) => a.id === 'chatgpt')?.status).toBe(
        'notconnected',
      );
    } finally {
      await server.shutdown();
    }
  });
});
