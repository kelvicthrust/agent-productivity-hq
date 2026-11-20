import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { AdapterContext } from '../../../src/server/collectors/types.ts';
import { createGithubAdapter } from '../../../src/server/collectors/github/sync.ts';
import type { GithubAuth, NetFetch } from '../../../src/server/collectors/github/ports.ts';
import { setMeta } from '../../../src/server/db/queries/meta.ts';
import { correlation, errorHandler, type HttpEnv } from '../../../src/server/http/errors.ts';
import { csrfGuard, hostGuard, securityHeaders } from '../../../src/server/http/guards.ts';
import { prsRoutes } from '../../../src/server/http/routes/prs.ts';
import { repoRoutes } from '../../../src/server/http/routes/repos.ts';
import { yearRoutes } from '../../../src/server/http/routes/year.ts';
import type { FakePr } from '../../fixtures/github/scripted-github.ts';
import { HOST, PORT, TZ, WRITE, memoryDb, memoryLogger } from '../../server/helpers.ts';
import { authFor, signInApp, world, type World } from './auth/helpers.ts';

// The world every delivery test runs in: a scripted GitHub (test/fixtures/github/scripted-github.ts), a migrated in-memory
// database, the sync adapter and the routes of this slice, all on one clock the test moves by hand. No network, no Keychain,
// no `gh`. The auth is A21's real `createGithubAuth` over the double, so a 401 really goes through refresh.

export const DAY = 86_400_000;
export { TZ };

export interface Crew {
  w: World;
  db: DatabaseSync;
  /** The scripted GitHub. */
  github: World['github'];
  /** The clock: `crew.w.clock.now` is epoch ms. */
  now: () => number;
  net: NetFetch;
  auth: GithubAuth;
  adapter: ReturnType<typeof createGithubAdapter>;
  logs: ReturnType<typeof memoryLogger>;
  /** One attempt of the sync adapter, as the runner would call it. */
  refresh(): ReturnType<ReturnType<typeof createGithubAdapter>['refresh']>;
}

export async function crew(
  options: {
    /** `gh` (default), the GitHub App's token, or nobody. */
    signIn?: 'gh' | 'app' | 'none';
    /** Owners the App is installed on (only matters for the App route). */
    installed?: string[];
    login?: string;
    net?: (inner: NetFetch) => NetFetch;
  } = {},
): Promise<Crew> {
  const w = world(options.login ? { login: options.login } : {});
  const db = memoryDb();
  const signIn = options.signIn ?? 'gh';
  for (const owner of options.installed ?? []) w.github.installApp(owner);
  if (signIn === 'app') {
    await signInApp(w);
    w.github.signOutGh();
  } else if (signIn === 'none') {
    w.github.signOutGh();
  }
  const net = options.net ? options.net(w.github.net) : w.github.net;
  const auth = authFor(w);
  // The auth above talks to the double directly; the sync and the routes talk through `net`, so a test can wrap it.
  const logs = memoryLogger();
  const now = () => w.clock.now;
  const adapter = createGithubAdapter({ net, auth, timezone: TZ });
  const context: AdapterContext = { db, now, logger: logs.logger, progress: () => undefined };
  return {
    w,
    db,
    github: w.github,
    now,
    net,
    auth,
    adapter,
    logs,
    refresh: () => adapter.refresh(context),
  };
}

/** The connected login the account service would have recorded: "Authored by you" compares with it. */
export const connect = (c: Crew, login = c.github.login): void =>
  setMeta(c.db, 'github_login', login);

const sha = (a: number, b: number): string => (a * 1000 + b).toString(16).padStart(40, '0');

/**
 * `count` merged PRs, newest first: PR `numberStart + i` merged `i + 2 + daysBack` days before the clock, last touched at the
 * merge. Each has one commit unless `commits` says otherwise. `key` keeps node ids apart between repos.
 */
export function mergedPrs(
  c: Pick<Crew, 'now'>,
  count: number,
  options: {
    key?: string;
    numberStart?: number;
    daysBack?: number;
    author?: string | null;
    mergedBy?: string | null;
    commits?: number;
  } = {},
): FakePr[] {
  const key = options.key ?? 'w';
  return Array.from({ length: count }, (_, i) => {
    const number = (options.numberStart ?? 1) + i;
    const mergedAt = new Date(c.now() - (i + 2 + (options.daysBack ?? 0)) * DAY).toISOString();
    return {
      nodeId: `PR_${key}_${number}`,
      number,
      title: `Change ${number}`,
      mergedAt,
      state: 'MERGED',
      author: options.author === undefined ? 'octo-kelvin' : options.author,
      mergedBy: options.mergedBy === undefined ? 'octo-kelvin' : options.mergedBy,
      commits: Array.from({ length: options.commits ?? 1 }, (_, k) => sha(number, k)),
    };
  });
}

/** Rows as SQL sees them, for the "what is stored" assertions. */
export const rows = <T = Record<string, unknown>>(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number)[]
): T[] => db.prepare(sql).all(...args) as unknown as T[];

export const count = (db: DatabaseSync, table: string, where = '1 = 1'): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

/** The GraphQL requests the double has seen, newest last. */
export const graphqlCalls = (c: Crew) => c.github.requests.filter((r) => r.path === '/graphql');

// ---- the routes ----

/** Only the routes of this slice, behind the guards and the error handler as createApp installs them. */
export function appFor(c: Crew, options: { github?: boolean; requestSync?: () => void } = {}) {
  const app = new Hono<HttpEnv>();
  app.use('*', correlation());
  app.use('*', securityHeaders());
  app.use('*', hostGuard(PORT, c.logs.logger));
  app.use('*', csrfGuard(c.logs.logger));
  app.onError(errorHandler(c.logs.logger));
  const deps = { db: c.db, now: c.now, timezone: TZ };
  app.route(
    '/',
    repoRoutes({
      ...deps,
      github:
        options.github === false
          ? undefined
          : { net: c.net, auth: c.auth, requestSync: options.requestSync },
    }),
  );
  app.route('/', prsRoutes(deps));
  app.route('/', yearRoutes(deps));
  const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
  return {
    app,
    get: (path: string) => app.request(url(path), { headers: HOST }),
    post: (path: string, body?: unknown) =>
      app.request(url(path), {
        method: 'POST',
        headers: WRITE,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    del: (path: string) => app.request(url(path), { method: 'DELETE', headers: WRITE }),
  };
}
