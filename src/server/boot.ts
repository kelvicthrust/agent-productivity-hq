import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import { ApiError } from '../shared/contracts/errors.ts';
import { isTimeZone, todayIn } from '../shared/domain/periods.ts';
import {
  claudeConfigDirs,
  codexHomes,
  createDiscoveryStep,
  createLocalAdapters,
  type DiscoveryInput,
} from './collectors/discovery.ts';
import { createClaudeFeed } from './collectors/live/claudeFeed.ts';
import { createCodexFeed } from './collectors/live/codexFeed.ts';
import { checkCodexQuota, createChatgptAdapter } from './collectors/chatgpt/collector.ts';
import { limitsOf as legacyClaudeLimits } from './collectors/claudeAccount/collector.ts';
import type { LaunchAppServer } from './collectors/chatgpt/ports.ts';
import type { GithubDeps } from './collectors/github/ports.ts';
import { createGithubAdapter } from './collectors/github/sync.ts';
import {
  createPaseoAdapter,
  DEFAULT_PASEO_URL,
  type PaseoAdapterOptions,
} from './collectors/paseo/index.ts';
import { createPaseoLiveFeed } from './collectors/paseo/live.ts';
import { openPaseoLiveClient, type PaseoLiveOpen } from './collectors/paseo/open.ts';
import { createRunner, type Runner } from './collectors/runner.ts';
import type { SourceAdapter } from './collectors/types.ts';
import { checkIntegrity, openDatabase, type Db } from './db/open.ts';
import { MigrationError, NewerSchemaError, migrate } from './db/migrate.ts';
import { getMeta, setMeta, setMetaIfMissing } from './db/queries/meta.ts';
import { readChatgptConnection, retainLegacyClaudeSnapshot } from './db/queries/accounts.ts';
import { createClaudeCapture } from './integrations/claudeCapture/index.ts';
import {
  createClaudeHooks,
  newHookToken,
  type ClaudeHooks,
} from './integrations/claudeHooks/index.ts';
import { claudePlanProfile } from './integrations/claudePlan/credentials.ts';
import { readLiveSessionLabels } from './db/queries/hq.ts';
import { joinPaseoSessions } from './db/queries/paseo.ts';
import { isResetSetupPending, readSetupState } from './db/queries/setup.ts';
import { markRunningRunsInterrupted } from './db/queries/runs.ts';
import { createApp, type AppDeps, type SetupMachine } from './http/app.ts';
import type { HttpEnv } from './http/errors.ts';
import { TAILSCALE_LOGIN_HEADER, type TailscaleAccess } from './http/guards.ts';
import { createAlreadyRunningApp, createRecoveryApp, type RecoveryInfo } from './http/recovery.ts';
import { isDiskFull } from './lib/diskFull.ts';
import { acquireInstanceLock, type InstanceLease } from './lib/instance.ts';
import { type ServerConfig, baseUrl } from './lib/config.ts';
import { ensureDir } from './lib/fsModes.ts';
import { abortableSleep, type Sleep } from './lib/sleep.ts';
import { clearLogFiles, createLogger, fileSink, type Logger } from './lib/logger.ts';
import { createChatgptAccounts, type ChatgptAccounts } from './services/accounts.ts';
import { createGithubAccounts } from './services/accounts-github.ts';
import { createClaudeAccounts, type ClaudePlanLimitsPorts } from './services/claude-account.ts';
import { createHookStore, type HookStore } from './services/hq/hookStore.ts';
import { createHqService, type HqService } from './services/hq/service.ts';
import { recomputeLinks } from './services/links.ts';
import { createPaseoQuotaService } from './services/paseo-quota.ts';
import { createResetService } from './services/reset.ts';
import { runRetention } from './services/retention.ts';
import { delayUntilLocalTime, startScheduler, type Scheduler } from './services/scheduler.ts';

// Process lifecycle. Boot order is fixed (TECH › Process lifecycle):
//   migrate -> mark interrupted runs -> retention -> scheduler -> listen
// If the database is corrupt or a migration fails, boot serves the recovery page instead and never touches the file.

export const SHUTDOWN_TIMEOUT_MS = 5000;
/** How often the refresh runs while the server is up (TECH › Refresh run state machine). */
export const REFRESH_INTERVAL_MS = 15 * 60_000;
const DISK_FULL_DETAIL = 'The disk has no room left for the database.';
export const BOOT_STEPS = ['migrate', 'interrupted', 'retention', 'scheduler', 'listen'] as const;

export class AlreadyRunningError extends Error {
  readonly port: number | null;
  readonly lockPath: string;
  constructor(port: number | null, lockPath: string) {
    super(
      port === null
        ? 'Another Agent Productivity HQ process owns this data folder.'
        : `Agent Productivity HQ is already running at ${baseUrl(port)}`,
    );
    this.name = 'AlreadyRunningError';
    this.port = port;
    this.lockPath = lockPath;
  }
}

export class PortInUseError extends Error {
  constructor(port: number) {
    super(
      `Port ${port} is already in use, so Agent Productivity HQ can’t start there.\n` +
        `If it is already running, open ${baseUrl(port)}. Otherwise set AGENT_PRODUCTIVITY_PORT to a free port.`,
    );
    this.name = 'PortInUseError';
  }
}

export class DatabaseRecoveryError extends Error {
  constructor(recovery: RecoveryInfo) {
    super(
      `Agent Productivity HQ could not use its database. ${recovery.detail} Stop the managed service and use local startup to open the recovery page.`,
    );
    this.name = 'DatabaseRecoveryError';
  }
}

/** What `boot` needs from a listening server. The Node `http.Server` fits; tests pass a stand-in. */
export interface ListeningServer {
  address?(): { port: number } | string | null;
  close(callback?: (error?: Error) => void): unknown;
  closeAllConnections?(): void;
  closeIdleConnections?(): void;
}

export type ListenFn = (options: {
  fetch: (request: Request) => Response | Promise<Response>;
  port: number;
  host: string;
}) => Promise<ListeningServer>;

/** Binds the given loopback host and port. Errors (EADDRINUSE, EPERM) reject. */
export const nodeListen: ListenFn = async ({ fetch, port, host }) => {
  const server = createAdaptorServer({ fetch }) as Server;
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListening();
    });
  });
  return server;
};

/** The three GitHub ports (collectors/github/ports.ts), and how the device flow waits (tests make it instant). */
export interface GithubBoot extends GithubDeps {
  sleep?: Sleep;
}

/** How the Codex app-server is reached (collectors/chatgpt/ports.ts), and the waits tests shorten. */
export interface ChatgptBoot {
  /** Starts `codex app-server`: live.ts for real (`pnpm start`), a scripted app-server in tests. */
  launch: LaunchAppServer;
  /** Per-call timeout of the app-server client; ten seconds unless a test shortens it. */
  callTimeoutMs?: number;
  /** How long the owner has to finish the browser sign-in; ten minutes unless a test shortens it. */
  loginWaitMs?: number;
}

/** Claude Code's settings location and the Node the hook runs under (integrations/claudeCapture). Tests give a temporary folder. */
export interface ClaudeBoot {
  /** The environment that selects the Claude Code profile. */
  env: NodeJS.ProcessEnv;
  /** The home folder, for Claude Code's default user-level location when no override is set. */
  home: string;
  /** The Node the wrapper runs; default is the Node running the dashboard. */
  nodePath?: string;
  /** Live or synthetic ports, used only after a protected plan check. */
  planLimits?: ClaudePlanLimitsPorts;
}

export interface BootDeps {
  /** The synthetic preview holds ownership while seeding, then hands it to boot. */
  directoryLease?: InstanceLease;
  /** Clock in epoch ms; default Date.now. The seeded preview and tests pass a fixed one. */
  now?: () => number;
  /** The report timezone; default is this machine's IANA zone. */
  timezone?: string;
  logger?: Logger;
  listen?: ListenFn;
  version?: string;
  /** A managed child must own the data and finish normal startup before reporting readiness. */
  managed?: boolean;
  /** Also bind an ephemeral loopback backend for Tailscale Serve, with its own request guards. */
  remote?: TailscaleAccess;
  /** The built SPA; `null` serves the API only. Default: config.staticDir. */
  staticDir?: string | null;
  previewLabel?: string;
  shutdownTimeoutMs?: number;
  /** Start the recurring tasks (default true). */
  scheduler?: boolean;
  /**
   * The source adapters this process has, when `local` is not given. Scripted adapters are injected here by the preview command
   * and tests; with none, a refresh run skips every source and the timer does not start.
   */
  adapters?: readonly SourceAdapter[];
  /**
   * This machine, for real: the environment and home folder the Codex and Claude Code adapters and discovery look at
   * (`{ env: process.env, home: os.homedir() }` from `pnpm start`). Given, the process builds the two real local adapters, takes
   * a fresh look at their folders before every run, and starts a first run as soon as it is listening, so a first launch imports
   * your history without a click. Never given by the preview command or by tests that must not read this machine; the live
   * `env` is read at every attempt, so a changed override is seen without a restart.
   */
  local?: DiscoveryInput;
  /**
   * GitHub, for real or scripted. Given, boot builds the account service (sign-in, Keychain, device flow) and the GitHub sync,
   * adds the sync to the run as stage 3 and gives the routes what they need to add, re-check and stop repos. `pnpm start` gives it
   * the live ports (lib/net.ts over fetch, the macOS Keychain, `gh` without a shell); the preview command and the tests give it
   * the scripted GitHub and never the network. Not given, GitHub is "not available in this session": no sync, and the repo and
   * account routes answer `github_not_connected`.
   */
  github?: GithubBoot;
  /**
   * Paseo, for real or scripted. Given, the Paseo adapter is stage 2 of every run: it lists the daemon's agents and names and
   * parents the sessions the first stage imported (a daemon that is off or asks for a password is a source state, and the last
   * snapshot still applies). `pnpm start` gives `{}` (the daemon's default address, the real SDK); tests give a fake opener and
   * never a socket; the preview command gives none and runs its scripted Paseo source instead.
   */
  paseo?: PaseoAdapterOptions;
  /** Reads the selected daemon's usage reports for a Paseo-managed HQ. */
  paseoUsage?: () => Promise<unknown>;
  /**
   * The live HQ roster's seams. HQ has a Paseo feed where `paseo` is given (a process whose Paseo source is on): it connects to the same
   * daemon address, on demand, while someone has the HQ page open. `open` makes the live client (the real SDK by default; tests give
   * a fake and open no socket). Where `local` is given it also follows the Claude Code and Codex transcripts being written, in the same
   * folders as the batch adapters. `idleMs` is how long without a request before the feeds are stopped (30 s by default).
   */
  hq?: { open?: PaseoLiveOpen; idleMs?: number; coldWaitMs?: number; transcriptPollMs?: number };
  /**
   * What first-launch Setup's discovery looks at when `local` is not given: the preview and the tests give a temporary, invented
   * machine so Setup can be tried with no real folder; with none, discovery reads back what is stored and looks at nothing. A process
   * that has `local` always looks at it. Never builds an adapter and never starts a run.
   */
  setup?: Pick<SetupMachine, 'local' | 'codexOnPath'>;
  /**
   * ChatGPT through Codex's own sign-in, for real or scripted. Given, the ChatGPT adapter is stage 4 of every run (account-reported
   * usage, kept apart from every local total), Codex session names are applied by it, and the account routes serve Connect, poll
   * and Disconnect. `pnpm start` gives the live launcher (the only code that starts `codex`); the preview command and the tests give
   * a scripted app-server and never start a program or read this machine's sign-in. Not given, the ChatGPT routes say so.
   */
  chatgpt?: ChatgptBoot;
  /** Explicit Claude plan checks and read-only guidance for retiring old status-line installations. */
  claude?: ClaudeBoot;
}

export interface RunningServer {
  /**
   * `recovery`: the database can't be used, so a page says what to do. `already_running`: another copy holds this data folder and
   * this process only points to it (its own port was free), without opening the database.
   */
  mode: 'normal' | 'recovery' | 'already_running';
  url: string;
  recovery: RecoveryInfo | null;
  app: Hono<HttpEnv>;
  db: Db | null;
  remotePort?: number;
  attachRemote?(access: TailscaleAccess): Promise<{ port: number; close(): Promise<void> }>;
  trackManagedOperation?(operation: Promise<void>): void;
  /**
   * Stops accepting, waits at most the shutdown timeout for requests, closes HQ (awaited to its end, before the database is closed),
   * closes the database and releases the lock.
   */
  shutdown(): Promise<void>;
}

export const machineTimeZone = (): string => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isTimeZone(zone) ? zone : 'UTC';
};

export const packageVersion = (): string | null => {
  try {
    const json = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { version?: string };
    return typeof json.version === 'string' && json.version.trim() ? json.version : null;
  } catch {
    return null;
  }
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms).unref());

export async function boot(config: ServerConfig, deps: BootDeps = {}): Promise<RunningServer> {
  const now = deps.now ?? Date.now;
  const timezone = deps.timezone ?? machineTimeZone();
  const version = deps.version ?? packageVersion() ?? '0.0.0';

  ensureDir(config.dataDir);
  const logger: Logger = deps.logger ?? createLogger({ sink: fileSink(config.logDir), now });
  const step = (name: string, fields: Record<string, unknown> = {}) =>
    logger.info(`boot: ${name}`, { source: 'boot', step: name, ...fields });

  const lock =
    deps.directoryLease ?? acquireInstanceLock(config.lockPath, { port: config.port, now });
  if (!lock.ok) {
    // Another copy holds this data folder. The common case is the same port: that copy is bound to it, so there is nothing to serve
    // and this process says so and exits (TECH › Failure modes). Only when this process's own port is a different one and is free
    // does it serve the already-running page, and it still never opens the database.
    const holder = lock.holder;
    if (deps.managed || deps.remote || holder === null || holder.port === config.port)
      throw new AlreadyRunningError(holder?.port ?? null, config.lockPath);
    const pointer = createAlreadyRunningApp({
      port: config.port,
      info: { url: baseUrl(holder.port), lockPath: config.lockPath, pid: holder.pid },
      logger,
    });
    let pointerServer: ListeningServer;
    try {
      pointerServer = await (deps.listen ?? nodeListen)({
        fetch: pointer.fetch,
        port: config.port,
        host: config.host,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
        throw new AlreadyRunningError(holder.port, config.lockPath);
      throw error;
    }
    step('already_running', { holderPort: holder.port, port: config.port });
    return {
      mode: 'already_running',
      url: baseUrl(config.port),
      recovery: null,
      app: pointer,
      db: null,
      shutdown: async () => {
        await new Promise<void>((done) => pointerServer.close(() => done()));
      },
    };
  }

  let db: Db | null = null;
  let scheduler: Scheduler | null = null;
  let runner: Runner | null = null;
  let firstRun: (() => void) | null = null;
  let recovery: RecoveryInfo | null = null;
  let closing = false;
  let closeAccountFlows: (() => void) | null = null;
  let hq: (HqService & { stop(): Promise<void> }) | null = null;
  let claudeHooks: ClaudeHooks | null = null;
  const hookStore: HookStore = createHookStore({ now });
  const hookToken = newHookToken();
  let acceptsClaudeHookEvents = false;
  let requestChatgptRead: () => void = () => undefined;
  const listeners = new Set<ListeningServer>();

  try {
    const integrity = checkIntegrity(config.dbPath);
    if (!integrity.ok) {
      recovery = {
        reason: 'corrupt',
        dbPath: config.dbPath,
        detail: 'SQLite reports the file is damaged or is not a database.',
      };
      logger.error('database failed its integrity check; serving the recovery page', {
        source: 'boot',
        code: 'db_corrupt',
        reason: integrity.reason,
      });
    } else {
      try {
        db = openDatabase(config.dbPath);
      } catch (error) {
        const full = isDiskFull(error);
        recovery = full
          ? {
              reason: 'disk_full',
              dbPath: config.dbPath,
              dataDir: config.dataDir,
              detail: DISK_FULL_DETAIL,
            }
          : {
              reason: 'unreadable',
              dbPath: config.dbPath,
              detail: 'The file could not be opened.',
            };
        logger.error(
          full
            ? 'the disk is full; serving the not-enough-disk page'
            : 'database could not be opened; serving the recovery page',
          { source: 'boot', code: full ? 'disk_full' : 'db_unreadable', error },
        );
      }
    }

    if (db && !recovery) {
      try {
        const result = migrate(db);
        step('migrate', { from: result.from, to: result.to, applied: result.applied.length });
      } catch (error) {
        const failed = error instanceof MigrationError;
        const full = isDiskFull(error);
        recovery = full
          ? {
              reason: 'disk_full',
              dbPath: config.dbPath,
              dataDir: config.dataDir,
              detail: DISK_FULL_DETAIL,
            }
          : {
              reason:
                error instanceof NewerSchemaError
                  ? 'newer_schema'
                  : failed
                    ? 'migration_failed'
                    : 'unreadable',
              dbPath: config.dbPath,
              detail: failed ? error.message : 'The database could not be prepared.',
              ...(failed && error.file ? { migrationFile: error.file } : {}),
            };
        logger.error(
          full
            ? 'the disk is full; serving the not-enough-disk page'
            : 'migration failed; serving the recovery page',
          { source: 'boot', code: full ? 'disk_full' : 'migration_failed', error },
        );
        db.close();
        db = null;
      }
    }

    let app: Hono<HttpEnv>;
    let appDeps: AppDeps | undefined;
    const remote = deps.remote;
    if (db && !recovery) {
      setMetaIfMissing(db, 'install_id', randomUUID());
      const before = getMeta(db, 'report_timezone');
      setMeta(db, 'report_timezone', timezone);
      if (before && before !== timezone)
        logger.info('report timezone changed', { source: 'boot', from: before, to: timezone });

      const interrupted = markRunningRunsInterrupted(db, now());
      step('interrupted', { runs: interrupted });

      const retention = runRetention(db, { nowMs: now(), timezone });
      step('retention', {
        cutoff: retention.cutoff,
        usageEvents: retention.usageEvents,
        pullRequests: retention.pullRequests,
      });

      const dbForTasks = db;
      /** A process that reads this machine reads nothing until first-launch Setup has been finished (its Finish starts the first run). */
      const waitsForSetup = (): boolean =>
        (deps.local !== undefined && !readSetupState(dbForTasks).complete) ||
        isResetSetupPending(dbForTasks);
      const github = deps.github
        ? createGithubAccounts({
            db,
            net: deps.github.net,
            keyring: deps.github.keyring,
            gh: deps.github.gh,
            now,
            sleep: deps.github.sleep ?? abortableSleep,
            timezone,
          })
        : null;
      const chatgpt: ChatgptAccounts | null = deps.chatgpt
        ? createChatgptAccounts({
            db,
            launch: deps.chatgpt.launch,
            now,
            timezone,
            clientVersion: version,
            ...(deps.chatgpt.callTimeoutMs === undefined
              ? {}
              : { callTimeoutMs: deps.chatgpt.callTimeoutMs }),
            ...(deps.chatgpt.loginWaitMs === undefined
              ? {}
              : { loginWaitMs: deps.chatgpt.loginWaitMs }),
            // A sign-in finished here: read the account now, so the card fills at once instead of at the next timer.
            onConnected: () => requestChatgptRead(),
          })
        : null;
      closeAccountFlows = () => {
        github?.close();
        chatgpt?.close();
      };
      const claudeBoot = deps.claude;
      const capture = claudeBoot
        ? createClaudeCapture({
            dataDir: config.dataDir,
            env: claudeBoot.env,
            home: claudeBoot.home,
            now,
            ...(claudeBoot.nodePath === undefined ? {} : { nodePath: claudeBoot.nodePath }),
          })
        : null;
      if (capture !== null) {
        try {
          capture.retire((snapshot) => {
            if (snapshot.captured_at !== null) {
              retainLegacyClaudeSnapshot(
                dbForTasks,
                legacyClaudeLimits(snapshot),
                snapshot.captured_at * 1000,
              );
            }
          });
        } catch {
          logger.warn('the legacy Claude capture could not be retired', {
            source: 'claude_account',
          });
        }
      }
      const claude =
        capture && claudeBoot
          ? createClaudeAccounts({
              capture,
              db: dbForTasks,
              now,
              profile: () => claudePlanProfile(claudeBoot.env, claudeBoot.home),
              ...(claudeBoot.planLimits ? { planLimits: claudeBoot.planLimits } : {}),
            })
          : null;
      const chatgptBoot = deps.chatgpt;
      const paseoQuota = deps.paseoUsage
        ? createPaseoQuotaService({
            listUsage: deps.paseoUsage,
            now,
            checkCodex: () =>
              chatgptBoot && !readChatgptConnection(dbForTasks).disconnected
                ? checkCodexQuota({ ...chatgptBoot, clientVersion: version }, now)
                : Promise.resolve(null),
            checkClaude: async () => (await claude?.check())?.account.planLimits?.report ?? null,
          })
        : undefined;
      // Claude Code's hooks (the owner's opt-in switch): the installer exists where the Claude Code integration does, and what the hooks
      // report is held in memory beside the roster whether or not anyone has HQ open.
      claudeHooks = claudeBoot
        ? createClaudeHooks({
            dataDir: config.dataDir,
            env: claudeBoot.env,
            home: claudeBoot.home,
            logger,
            now,
            onDeliveryChange: (enabled) => {
              acceptsClaudeHookEvents = enabled;
              if (!enabled) hookStore.clear();
            },
            ...(claudeBoot.nodePath === undefined ? {} : { nodePath: claudeBoot.nodePath }),
          })
        : null;
      // The live HQ roster: Paseo's live listing, polled over one connection, and the Claude Code and Codex transcripts that are being written
      // now, followed in memory. Both start on the first /api/hq request and stop when nobody has asked for `idleMs`. Paseo's feed is built when
      // this process has a Paseo source and the transcript feeds when it reads this machine (`local`, as the batch adapters); the preview and most
      // tests have neither, so /api/hq says "unavailable".
      const localHq = deps.local;
      const transcriptPoll =
        deps.hq?.transcriptPollMs === undefined ? {} : { pollMs: deps.hq.transcriptPollMs };
      hq =
        deps.paseo || localHq
          ? createHqService({
              feeds: {
                ...(deps.paseo
                  ? {
                      paseo: createPaseoLiveFeed({
                        url: deps.paseo.url ?? DEFAULT_PASEO_URL,
                        open: deps.hq?.open ?? openPaseoLiveClient,
                        now,
                        logger,
                      }),
                    }
                  : {}),
                ...(localHq
                  ? {
                      claude: createClaudeFeed({
                        configDirs: () => claudeConfigDirs(localHq),
                        now,
                        logger,
                        ...transcriptPoll,
                      }),
                      codex: createCodexFeed({
                        homes: () => codexHomes(localHq),
                        now,
                        logger,
                        ...transcriptPoll,
                      }),
                    }
                  : {}),
              },
              now,
              logger,
              hooks: hookStore,
              waitsForSetup,
              includePaseoAgentIds: deps.paseoUsage !== undefined,
              labelsOf: (keys) => readLiveSessionLabels(dbForTasks, keys),
              ...(deps.hq?.idleMs === undefined ? {} : { idleMs: deps.hq.idleMs }),
              ...(deps.hq?.coldWaitMs === undefined ? {} : { coldWaitMs: deps.hq.coldWaitMs }),
            })
          : null;
      const adapters: readonly SourceAdapter[] = [
        ...(deps.adapters ?? (deps.local ? createLocalAdapters(deps.local) : [])),
        // Stage 3 of a run. It reads the sign-in through the account service, so Disconnect and Reconnect needed are honoured.
        ...(deps.github && github
          ? [createGithubAdapter({ net: deps.github.net, auth: github.auth, timezone })]
          : []),
        // Stage 2 of a run: names and parentage from Paseo, after Codex and Claude Code have imported their sessions.
        ...(deps.paseo ? [createPaseoAdapter(deps.paseo)] : []),
        // Stage 4 of a run: ChatGPT's account report and the Codex session names, after everything local has been imported.
        ...(deps.chatgpt && !paseoQuota
          ? [
              createChatgptAdapter({
                launch: deps.chatgpt.launch,
                clientVersion: version,
                ...(deps.chatgpt.callTimeoutMs === undefined
                  ? {}
                  : { callTimeoutMs: deps.chatgpt.callTimeoutMs }),
              }),
            ]
          : []),
      ];
      const activeRunner = createRunner({
        db,
        now,
        logger,
        adapters,
        // Before the sources: a fresh look at the local folders (discovery imports nothing and is never an attempt).
        ...(deps.local
          ? {
              beforeSources: [
                createDiscoveryStep({ db, env: deps.local.env, home: deps.local.home, logger }),
              ],
            }
          : {}),
        // After the sources, apply the last Paseo snapshot, prune expired history, then rebuild links on the retained data.
        // The recompute is the real process's: the seeded preview
        // and the browser specs keep the links their showcase world was written with (a recompute would suggest sessions it leaves
        // unlinked on purpose).
        afterSources: [
          ...(deps.paseo
            ? [
                {
                  name: 'paseo join',
                  run: () => {
                    joinPaseoSessions(dbForTasks);
                  },
                },
              ]
            : []),
          {
            name: 'retention',
            run: () => {
              runRetention(dbForTasks, { nowMs: now(), timezone });
            },
          },
          ...(deps.local
            ? [
                {
                  name: 'links' as const,
                  rebuild: (runId: number) => {
                    const links = recomputeLinks(dbForTasks, now(), runId);
                    logger.info('links recomputed', { source: 'links', ...links });
                  },
                },
              ]
            : []),
        ],
      });
      runner = activeRunner;
      const reset = createResetService({
        db,
        runner: activeRunner,
        timezone,
        github: github ?? undefined,
        chatgpt: chatgpt ?? undefined,
        claudeHooks: claudeHooks ?? undefined,
        clearLegacyCapture: () => {
          if (capture) {
            try {
              capture.change({ action: 'verify_remove' });
            } catch {
              throw new ApiError(
                'claude_settings_conflict',
                'Finish removing the legacy Claude Code status line in Accounts, then try resetting again.',
              );
            }
          }
        },
        clearRuntime: async () => {
          await hq?.stop();
          hookStore.clear();
          paseoQuota?.clear();
          if (!deps.logger) clearLogFiles(config.logDir);
        },
      });
      /** A repo became readable: read it now rather than at the next 15-minute run. One that is going now is followed by one more. */
      const requestGithubSync = (): void => {
        if (closing || reset.running() || waitsForSetup()) return;
        const request = { trigger: 'manual', sources: ['github'] } as const;
        if (activeRunner.start(request).started) return;
        void activeRunner.idle().then(() => {
          if (!closing && !reset.running() && !waitsForSetup()) activeRunner.start(request);
        });
      };
      /** A ChatGPT sign-in finished here: read the account now. One that is going now is followed by one more. */
      requestChatgptRead = (): void => {
        if (closing || reset.running() || paseoQuota) return;
        const request = { trigger: 'manual', sources: ['chatgpt_account'] } as const;
        if (activeRunner.start(request).started) return;
        void activeRunner.idle().then(() => {
          if (!closing && !reset.running()) activeRunner.start(request);
        });
      };
      scheduler =
        deps.scheduler === false
          ? null
          : startScheduler({
              now,
              logger,
              tasks: [
                {
                  name: 'retention',
                  nextDelay: (nowMs) => delayUntilLocalTime(nowMs, timezone, 3, 0),
                  run: () => {
                    if (reset.running()) return;
                    const r = runRetention(dbForTasks, { nowMs: now(), timezone });
                    logger.info('retention ran', {
                      source: 'retention',
                      cutoff: r.cutoff,
                      usageEvents: r.usageEvents,
                    });
                  },
                },
                // Without an adapter a run would only write a "nothing to do" row every 15 minutes, so the timer waits for one.
                ...(adapters.length === 0
                  ? []
                  : [
                      {
                        name: 'refresh',
                        nextDelay: () => REFRESH_INTERVAL_MS,
                        run: () => {
                          // Setup's Finish starts the first run on a machine: until it is pressed the timer reads nothing.
                          if (reset.running() || waitsForSetup()) return;
                          // A manual run still going is fine: the timer leaves it be and tries again at the next tick.
                          activeRunner.start({ trigger: 'scheduler' });
                        },
                      },
                    ]),
              ],
            });
      step('scheduler', { started: scheduler !== null });
      // On this machine for real: the first run starts once the server is listening, so the history appears without a click. On a
      // first launch (setup not finished) it is Setup's Finish that starts it, so nothing is read before the owner has chosen.
      if (deps.local && scheduler !== null && adapters.length > 0) {
        firstRun = () => {
          if (waitsForSetup()) return;
          activeRunner.start({ trigger: 'scheduler' });
        };
      }

      appDeps = {
        db,
        logger,
        port: config.port,
        now,
        timezone,
        version,
        runner: activeRunner,
        reset,
        refreshNeedsSetup: () => isResetSetupPending(dbForTasks),
        staticDir: deps.staticDir === undefined ? config.staticDir : deps.staticDir,
        previewLabel: deps.previewLabel,
        github: github ?? undefined,
        chatgpt: chatgpt ?? undefined,
        claude: claude ?? undefined,
        paseoQuota,
        hq: hq ?? undefined,
        claudeHooks: claudeHooks ?? undefined,
        hookIngest: claudeHooks
          ? { store: hookStore, token: hookToken, acceptsEvents: () => acceptsClaudeHookEvents }
          : undefined,
        setup: {
          local: deps.local ?? deps.setup?.local,
          paseo: deps.paseo,
          codexOnPath: deps.setup?.codexOnPath,
        },
        repos:
          deps.github && github
            ? { net: deps.github.net, auth: github.auth, requestSync: requestGithubSync }
            : undefined,
      };
      app = createApp(appDeps);
    } else {
      if (deps.managed || remote) throw new DatabaseRecoveryError(recovery!);
      app = createRecoveryApp({ port: config.port, info: recovery!, logger });
      step('recovery', { reason: recovery!.reason });
    }

    const requests = new Set<Promise<unknown>>();
    function track<T>(request: Promise<T>): Promise<T> {
      requests.add(request);
      return request.finally(() => requests.delete(request));
    }
    let accepting = !(deps.managed || remote);
    const bind = async (target: Hono<HttpEnv>, port: number) => {
      const dispatch = target.fetch;
      const listener = await (deps.listen ?? nodeListen)({
        fetch: async (request) => {
          if (!accepting)
            return new Response('Agent Productivity HQ is starting.', { status: 503 });
          if (closing)
            return new Response('Agent Productivity HQ is shutting down.', { status: 503 });
          return track(Promise.resolve(dispatch(request)));
        },
        port,
        host: config.host,
      });
      listeners.add(listener);
      return listener;
    };
    try {
      await bind(app, config.port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
        throw new PortInUseError(config.port);
      throw error;
    }

    const assertHealth = async (target: Hono<HttpEnv>, headers: Record<string, string>) => {
      if (!(await target.request('/api/health', { headers })).ok) {
        throw new Error(
          'An Agent Productivity HQ listener did not pass its startup health check. Check its local log.',
        );
      }
    };
    const attachRemote = async (access: TailscaleAccess) => {
      if (closing || !appDeps) throw new Error('The Agent Productivity HQ service is unavailable.');
      const remoteApp = createApp({ ...appDeps, remote: access });
      await assertHealth(remoteApp, {
        host: access.host,
        [TAILSCALE_LOGIN_HEADER]: access.ownerLogin,
      });
      if (closing) throw new Error('The Agent Productivity HQ service is unavailable.');
      const listener = await bind(remoteApp, 0);
      let closed: Promise<void> | undefined;
      const close = () =>
        (closed ??= new Promise<void>((done) => {
          listener.close(() => {
            listeners.delete(listener);
            done();
          });
          listener.closeAllConnections?.();
        }));
      const address = listener.address?.();
      if (closing || !address || typeof address === 'string' || !address.port) {
        await close();
        throw new Error(
          'Agent Productivity HQ could not bind a loopback port for Tailscale Serve.',
        );
      }
      return { port: address.port, close };
    };
    if (deps.managed || remote) {
      await assertHealth(app, { host: `${config.host}:${config.port}` });
    }
    const remotePort = remote ? (await attachRemote(remote)).port : undefined;
    accepting = true;
    // The hook script finds this server through the registry, which is written once the server listens and removed at shutdown.
    await claudeHooks?.listening({ port: config.port, token: hookToken });
    step('listen', {
      host: config.host,
      port: config.port,
      mode: recovery ? 'recovery' : 'normal',
      today: todayIn(now(), timezone),
      ...(remotePort === undefined ? {} : { remotePort }),
    });

    firstRun?.();

    const timeoutMs = deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    let stopping: Promise<void> | null = null;
    const shutdown = () =>
      (stopping ??= (async () => {
        logger.info('shutting down', { source: 'boot', step: 'shutdown' });
        closing = true;
        scheduler?.stop();
        const deadline = performance.now() + timeoutMs;
        // HQ's close starts now, so every feed's signal aborts at once. It is awaited to its end below and never raced against a deadline:
        // its cleanup (feed state, roster memo, repo resolver) is not finished until it resolves, and the database must stay open until then.
        const hqClosed = hq?.close();
        // The hook registry goes first, so a hook that runs now finds no server; its events are dropped with the rest.
        const hooksClosed = claudeHooks?.close();
        hookStore.clear();
        const closed = [...listeners].map((listener) => {
          const result = new Promise<void>((done) => listener.close(() => done()));
          listener.closeIdleConnections?.();
          return result;
        });
        // An accepted request may still start a refresh while its body or upstream reply arrives.
        await Promise.race([Promise.allSettled([...closed, ...requests]), sleep(timeoutMs)]);
        for (const listener of listeners) listener.closeAllConnections?.();
        // A drained Connect request may have started a background device or browser sign-in.
        closeAccountFlows?.();
        // Everything HQ holds is released before anything else is closed or returned: the label query reads the database. The close is bounded
        // by abort-aware work (sockets hard-closed, reads budgeted); only a file system call that never answers can delay it.
        await hqClosed;
        await hooksClosed;
        hookStore.clear();
        if (requests.size !== 0) return; // The CLI exits with the lease held while unfinished handlers can write.
        const finished =
          runner === null ||
          (await Promise.race([
            runner.idle().then(() => true),
            sleep(Math.max(0, deadline - performance.now())).then(() => false),
          ]));
        if (!finished) return; // The CLI will exit. Keep ownership while background work can still write.
        db?.close();
        lock.release();
      })());

    return {
      mode: recovery ? 'recovery' : 'normal',
      url: baseUrl(config.port),
      recovery,
      app,
      db,
      ...(remotePort === undefined ? {} : { remotePort }),
      ...(deps.managed
        ? {
            attachRemote,
            trackManagedOperation: (operation: Promise<void>) => {
              void track(operation).catch(() => undefined);
            },
          }
        : {}),
      shutdown,
    };
  } catch (error) {
    logger.error('boot failed', { source: 'boot', code: 'boot_failed', error });
    scheduler?.stop();
    const hqClosed = hq?.close(); // as in shutdown: started now, awaited to its end below, before the database closes
    const hooksClosed = claudeHooks?.close();
    hookStore.clear();
    await Promise.all(
      [...listeners].map((listener) => {
        const closed = new Promise<void>((done) => listener.close(() => done()));
        listener.closeAllConnections?.();
        return closed;
      }),
    );
    closeAccountFlows?.();
    await hqClosed;
    await hooksClosed;
    db?.close();
    lock.release();
    throw error;
  }
}
