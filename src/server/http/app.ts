import { Hono } from 'hono';
import type { DiscoveryInput } from '../collectors/discovery.ts';
import type { GithubAccounts } from '../collectors/github/ports.ts';
import type { PaseoAdapterOptions } from '../collectors/paseo/index.ts';
import type { Runner } from '../collectors/runner.ts';
import type { Db } from '../db/open.ts';
import type { Logger } from '../lib/logger.ts';
import type { ChatgptAccounts } from '../services/accounts.ts';
import type { ClaudeAccounts } from '../services/claude-account.ts';
import type { ClaudeHooks } from '../integrations/claudeHooks/index.ts';
import type { HqService } from '../services/hq/service.ts';
import { apiNotFound, correlation, errorHandler, type HttpEnv } from './errors.ts';
import {
  csrfGuard,
  hostGuard,
  securityHeaders,
  tailscaleOwnerGuard,
  type TailscaleAccess,
} from './guards.ts';
import { accountRoutes } from './routes/accounts.ts';
import { bootstrapRoutes } from './routes/bootstrap.ts';
import { healthRoutes } from './routes/health.ts';
import { hqRoutes } from './routes/hq.ts';
import { hqHooksRoutes, type HookIngest } from './routes/hqHooks.ts';
import { linksRoutes } from './routes/links.ts';
import { modelsRoutes } from './routes/models.ts';
import { overviewRoutes } from './routes/overview.ts';
import { prsRoutes } from './routes/prs.ts';
import { recordsRoutes } from './routes/records.ts';
import { refreshRoutes } from './routes/refresh.ts';
import { repoRoutes, type RepoGithub } from './routes/repos.ts';
import { seriesRoutes } from './routes/series.ts';
import { setupRoutes } from './routes/setup.ts';
import { sourcesRoutes } from './routes/sources.ts';
import { usageRoutes } from './routes/usage.ts';
import { yearRoutes } from './routes/year.ts';
import { staticHandler } from './static.ts';

/** What first-launch Setup looks at (services/setup.ts). Every field is optional: a process that has no machine looks at none. */
export interface SetupMachine {
  /** This machine's environment and home folder: given, discovery looks at the documented Codex and Claude Code folders and the PATH. */
  local?: DiscoveryInput | undefined;
  /** Paseo's daemon: given, discovery connects without a password and hangs up. */
  paseo?: PaseoAdapterOptions | undefined;
  /** Whether `codex` is on the PATH, when it is not read from `local.env`. */
  codexOnPath?: (() => boolean | Promise<boolean>) | undefined;
}

export interface AppDeps {
  db: Db;
  logger: Logger;
  /** The refresh runner, with the adapters this process has (none in production until the collectors land). */
  runner: Runner;
  /** The port the server listens on; the Host allowlist is built from it. */
  port: number;
  /** The managed Tailscale Serve listener accepts only this authority and owner identity. */
  remote?: TailscaleAccess;
  /** Injected clock (epoch ms): a fixed clock in the seeded preview and tests. */
  now: () => number;
  /** The report timezone (IANA). */
  timezone: string;
  version: string;
  /** The built SPA, or null to serve the API only. */
  staticDir: string | null;
  /**
   * The GitHub account service (services/accounts-github.ts): the account routes and the GitHub card of GET /api/sources.
   * Without it GitHub is "not available in this session" (a process that was given no GitHub ports).
   */
  github?: GithubAccounts | undefined;
  /**
   * The ChatGPT account service (services/accounts.ts): Connect, poll and Disconnect, and the ChatGPT card of GET /api/sources.
   * Without it the ChatGPT routes say so and the card is read from stored rows alone (a process with no Codex app-server).
   */
  chatgpt?: ChatgptAccounts | undefined;
  /** The Claude plan-usage capture (services/claude-account.ts): the preview and switch routes and the Claude card. */
  claude?: ClaudeAccounts | undefined;
  /**
   * The live HQ roster (services/hq/service.ts) behind GET /api/hq. Without it the route answers with every feed unavailable and no
   * agents: no live feeder is wired yet.
   */
  hq?: HqService | undefined;
  /** The owner's opt-in switch for Claude Code hooks (integrations/claudeHooks): the preview and switch routes and `exactPrompts`. */
  claudeHooks?: ClaudeHooks | undefined;
  /**
   * What the hook script posts to. Given to the loopback listener's app only: the Tailscale listener's app never mounts the route,
   * whatever is given here.
   */
  hookIngest?: HookIngest | undefined;
  /** What adding, re-checking and stopping a repo reach GitHub with (the same sign-in as `github`). Without it adding says so. */
  repos?: RepoGithub | undefined;
  /**
   * What first-launch Setup's discovery looks at. `pnpm start` gives this machine; the preview and the tests give a temporary,
   * invented one or none, and with none discovery reads back what is stored and looks at nothing on disk.
   */
  setup?: SetupMachine | undefined;
  /** A note shown on every page of the SPA, e.g. "Synthetic preview data". Set only by the preview command. */
  previewLabel?: string | undefined;
}

const exactPrompts = (hooks: ClaudeHooks | undefined) =>
  hooks ? hooks.state() : Promise.resolve('unavailable' as const);

/** Hono's `:param` path to OpenAPI's `{param}`, so served routes can be compared with docs/tech/local-api.md. */
export const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/**
 * The product app. Order matters: headers wrap everything, the Host guard runs before any route, the CSRF guard before any
 * write, and only then the API routes and the SPA.
 */
export function createApp(deps: AppDeps): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.use('*', correlation());
  app.use('*', securityHeaders());
  if (deps.remote) app.use('*', tailscaleOwnerGuard(deps.remote.ownerLogin));
  app.use('*', hostGuard(deps.port, deps.logger, deps.remote?.host));
  app.use('*', csrfGuard(deps.logger));
  app.onError(errorHandler(deps.logger));

  app.route('/', healthRoutes({ db: deps.db, version: deps.version }));
  app.route('/', bootstrapRoutes({ db: deps.db, now: deps.now, timezone: deps.timezone }));
  app.route(
    '/',
    repoRoutes({ db: deps.db, now: deps.now, timezone: deps.timezone, github: deps.repos }),
  );
  app.route('/', prsRoutes({ db: deps.db, now: deps.now, timezone: deps.timezone }));
  // PR links (M8): a PR's evidence and the owner's decisions about it.
  app.route('/', linksRoutes({ db: deps.db, now: deps.now, timezone: deps.timezone }));
  app.route('/', yearRoutes({ db: deps.db, now: deps.now, timezone: deps.timezone }));
  app.route('/', usageRoutes({ db: deps.db, now: deps.now, timezone: deps.timezone }));
  // The review surfaces (M7): one clock and one report timezone for every figure on a page.
  const review = { db: deps.db, now: deps.now, timezone: deps.timezone };
  app.route('/', overviewRoutes({ ...review, claude: deps.claude }));
  app.route('/', seriesRoutes(review));
  app.route('/', recordsRoutes(review));
  app.route('/', modelsRoutes(review));
  app.route(
    '/',
    sourcesRoutes({
      db: deps.db,
      now: deps.now,
      timezone: deps.timezone,
      github: deps.github,
      chatgpt: deps.chatgpt,
      claude: deps.claude,
    }),
  );
  app.route(
    '/',
    accountRoutes({ github: deps.github, chatgpt: deps.chatgpt, claude: deps.claude }),
  );
  app.route(
    '/',
    hqRoutes({ now: deps.now, hq: deps.hq, exactPrompts: () => exactPrompts(deps.claudeHooks) }),
  );
  app.route(
    '/',
    hqHooksRoutes({ hooks: deps.claudeHooks, ingest: deps.remote ? undefined : deps.hookIngest }),
  );
  app.route('/', refreshRoutes({ db: deps.db, runner: deps.runner }));
  // First-launch Setup (M10): discovery only looks, Finish starts the first run on the same runner as Refresh.
  app.route(
    '/',
    setupRoutes({
      db: deps.db,
      runner: deps.runner,
      now: deps.now,
      timezone: deps.timezone,
      local: deps.setup?.local,
      paseo: deps.setup?.paseo,
      codexOnPath: deps.setup?.codexOnPath,
      github: deps.github,
      chatgpt: deps.chatgpt,
      logger: deps.logger,
    }),
  );

  app.all('/api/*', apiNotFound);
  if (deps.staticDir) {
    app.get('*', staticHandler(deps.staticDir, { previewLabel: deps.previewLabel }));
  }
  app.notFound(apiNotFound);
  return app;
}

/** The `METHOD /openapi/path` of every API route the app serves (guards and the catch-all are not routes). */
export function servedRoutes(app: Hono<HttpEnv>): string[] {
  const keys = new Set<string>();
  for (const route of app.routes) {
    if (route.method === 'ALL' || !route.path.startsWith('/api/') || route.path === '/api/*')
      continue;
    keys.add(`${route.method} ${toOpenApiPath(route.path)}`);
  }
  return [...keys].sort();
}
