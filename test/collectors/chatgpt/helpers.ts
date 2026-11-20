import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { createChatgptAdapter } from '../../../src/server/collectors/chatgpt/collector.ts';
import type { AdapterContext } from '../../../src/server/collectors/types.ts';
import { upsertSession, type SessionUpsert } from '../../../src/server/db/queries/usage.ts';
import {
  apiNotFound,
  correlation,
  errorHandler,
  type HttpEnv,
} from '../../../src/server/http/errors.ts';
import { csrfGuard, hostGuard, securityHeaders } from '../../../src/server/http/guards.ts';
import { accountRoutes } from '../../../src/server/http/routes/accounts.ts';
import {
  createChatgptAccounts,
  type ChatgptAccountsDeps,
} from '../../../src/server/services/accounts.ts';
import { HOST, NOW, PORT, TZ, WRITE, memoryDb, memoryLogger } from '../../server/helpers.ts';
import { scriptedAppServer, type Scripted, type ScriptedOptions } from './scripted.ts';
import type { Scenario } from '../../fixtures/appserver/scenario.ts';

export { NOW, TZ };
export const DAY = 86_400_000;

/** Every string a fixture plants where real text would be. None of them may reach a table, a log or a response. */
export const SENTINEL = /SENTINEL_/;

export interface World {
  db: DatabaseSync;
  clock: { now: number };
  now: () => number;
  logs: ReturnType<typeof memoryLogger>;
  scripted: Scripted;
  context: AdapterContext;
  adapter: ReturnType<typeof createChatgptAdapter>;
  /** One attempt of the collector, as the runner would call it. */
  refresh: () => ReturnType<ReturnType<typeof createChatgptAdapter>['refresh']>;
}

/** A migrated in-memory database, a scripted app-server and the collector over them, on a clock the test moves by hand. */
export function world(
  scenario: Scenario | null,
  options: ScriptedOptions & { db?: DatabaseSync } = {},
): World {
  const db = options.db ?? memoryDb();
  const clock = { now: NOW };
  const logs = memoryLogger('debug');
  const scripted = scriptedAppServer(scenario, options);
  const now = () => clock.now;
  const context: AdapterContext = { db, now, logger: logs.logger, progress: () => undefined };
  const adapter = createChatgptAdapter({ launch: scripted.launch, clientVersion: '0.0.0-test' });
  return {
    db,
    clock,
    now,
    logs,
    scripted,
    context,
    adapter,
    refresh: () => adapter.refresh(context),
  };
}

/** A Codex session as the importer would have stored it, by its provider session id. */
export function codexSession(
  db: DatabaseSync,
  id: string,
  extra: Partial<SessionUpsert> = {},
): number {
  return upsertSession(db, {
    provider: 'codex',
    providerSessionId: id,
    kind: 'root',
    startedAt: NOW - 3 * DAY,
    startedBasis: 'source_start',
    firstEventAt: NOW - 3 * DAY,
    lastEventAt: NOW - 3 * DAY,
    ...extra,
  });
}

export const nameOf = (db: DatabaseSync, id: number) =>
  db
    .prepare('SELECT recorded_name AS name, name_source AS source FROM session WHERE id = ?')
    .get(id) as { name: string | null; source: string | null };

/** One Codex usage event of this machine, for the "this machine recorded" figure beside the account's. */
export function localEvent(
  db: DatabaseSync,
  sessionId: number,
  at: number,
  total: number,
  key = `e-${at}`,
): void {
  db.prepare(
    `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total)
     VALUES ('codex', ?, ?, ?, 'm', ?)`,
  ).run(key, sessionId, at, total);
}

/** Every row of every table as one string, for "this text is nowhere in the database". */
export function everything(db: DatabaseSync): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return tables
    .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all()))
    .join('\n');
}

export const count = (db: DatabaseSync, table: string, where = '1 = 1'): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

// ---- the service and the routes ----

export interface Accounts {
  world: World;
  service: ReturnType<typeof createChatgptAccounts>;
  /** How many times the process was told a sign-in finished. */
  connected: () => number;
  get: (path: string) => Promise<{ status: number; json: unknown; text: string }>;
  post: (path: string) => Promise<{ status: number; json: unknown; text: string }>;
}

/** The ChatGPT account service over a scripted app-server, with the account routes mounted behind the guards. */
export function accounts(
  scenario: Scenario | null,
  options: ScriptedOptions & Partial<Pick<ChatgptAccountsDeps, 'loginWaitMs'>> = {},
): Accounts {
  const w = world(scenario, options);
  let connected = 0;
  const service = createChatgptAccounts({
    db: w.db,
    launch: w.scripted.launch,
    now: w.now,
    timezone: TZ,
    ...(options.loginWaitMs === undefined ? {} : { loginWaitMs: options.loginWaitMs }),
    onConnected: () => {
      connected += 1;
    },
  });
  const app = new Hono<HttpEnv>();
  app.use('*', correlation());
  app.use('*', securityHeaders());
  app.use('*', hostGuard(PORT, w.logs.logger));
  app.use('*', csrfGuard(w.logs.logger));
  app.onError(errorHandler(w.logs.logger));
  app.route('/', accountRoutes({ chatgpt: service }));
  app.all('/api/*', apiNotFound);
  const send = async (method: 'GET' | 'POST', path: string) => {
    const res = await app.request(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: method === 'GET' ? HOST : WRITE,
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, json: (text ? JSON.parse(text) : null) as unknown };
  };
  return {
    world: w,
    service,
    connected: () => connected,
    get: (path) => send('GET', path),
    post: (path) => send('POST', path),
  };
}
