import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Hono } from 'hono';
import { createChatgptAdapter } from '../../../src/server/collectors/chatgpt/collector.ts';
import { createGithubAdapter } from '../../../src/server/collectors/github/sync.ts';
import { createRunner } from '../../../src/server/collectors/runner.ts';
import { migrate } from '../../../src/server/db/migrate.ts';
import { replaceRateLimits } from '../../../src/server/db/queries/accounts.ts';
import { completeSetup, readSetupState } from '../../../src/server/db/queries/setup.ts';
import { openDatabase, type Db } from '../../../src/server/db/open.ts';
import { createApp } from '../../../src/server/http/app.ts';
import type { HttpEnv } from '../../../src/server/http/errors.ts';
import { createClaudeCapture } from '../../../src/server/integrations/claudeCapture/index.ts';
import {
  claudePlanProfile,
  type CredentialResult,
} from '../../../src/server/integrations/claudePlan/credentials.ts';
import { createLogger } from '../../../src/server/lib/logger.ts';
import type { Sleep } from '../../../src/server/lib/sleep.ts';
import { createChatgptAccounts } from '../../../src/server/services/accounts.ts';
import { createGithubAccounts } from '../../../src/server/services/accounts-github.ts';
import { createClaudeAccounts } from '../../../src/server/services/claude-account.ts';
import { createPaseoQuotaService } from '../../../src/server/services/paseo-quota.ts';
import { loadScenario, scriptedAppServer, withMethods } from '../../collectors/chatgpt/scripted.ts';
import type { FakeGithub, MemoryKeyring } from '../../fixtures/github/scripted-github.ts';
import { createScriptedGithub } from '../../fixtures/github/world.ts';
import { FIXED_NOW, FIXED_TIMEZONE, seedDatabase, type Scale } from '../../fixtures/seed.ts';
import {
  createScriptedHq,
  rosterFor,
  type HqScenario,
  type ScriptedHq,
} from '../../fixtures/hq/scripted.ts';
import {
  createScriptedHooks,
  type ScriptedHooks,
  type ScriptedHooksScenario,
} from '../../fixtures/hq/scriptedHooks.ts';
import type { Scenario } from '../../fixtures/world/write.ts';
import { makeSetupHome, type SetupHome, type SetupHomeOptions } from './homes.ts';
import { ORIGIN, serveBuild } from './virtualOrigin.ts';

// A browser spec that runs through the REAL API and database. `createWorld` makes a temporary SQLite database, seeds the
// synthetic world into it (the M2 seed: fixed clock, America/Los_Angeles) and builds the product's own Hono app over it.
// `serveWorld` then serves the production build and answers http://crew.test/api/** through `app.request`, with the Host
// and CSRF headers the guards expect. There is still no socket and no port, so it works where a process may not listen.
// A spec that needs a particular response (a failing Retry, say) registers its own page.route after this one: the route
// registered last wins.

/** The port the app believes it listens on; only its Host allowlist uses it. */
export const WORLD_PORT = 4317;

export interface WorldOptions {
  scale?: Scale;
  scenario?: Scenario;
  /** False starts with `gh` signed out, so the one-time GitHub App setup is what Sources shows. Default: signed in. */
  ghSignedIn?: boolean;
  /**
   * A brand-new install: the world is the empty one (no repos, no sessions, nothing connected) AND setup has not been finished, so
   * the shell sends the first load to /setup. Default false: every other world, the empty scenario included, has finished setup
   * (finishing with nothing found is allowed, P-40), so a spec about an empty screen still lands on that screen.
   */
  firstLaunch?: boolean;
  /**
   * The HQ roster behind GET /api/hq (test/fixtures/hq): `office` is four sessions and eight agents, `empty` has every feed live and
   * nobody running, `paseo-down` has Paseo not running and one transcript-seen agent. Unset: no live feeder, so every feed is
   * unavailable, as in the product today.
   */
  hq?: HqScenario;
  /**
   * The Claude Code hooks switch behind GET and PUT /api/hq/claude-hooks and `exactPrompts` (test/fixtures/hq/scriptedHooks.ts): a
   * scripted one that only flips in memory, starting in this state. Unset: no Claude Code integration, so the switch is unavailable.
   */
  hooks?: ScriptedHooksScenario;
  paseoUsage?: unknown;
}

export interface World {
  app: Hono<HttpEnv>;
  db: Db;
  /** Log lines the app wrote at warn or error level, so a spec can assert a request did not fail quietly. */
  logs: string[];
  /** Move the app's clock (epoch ms). Starts at the seed's fixed "now". */
  setNow(epochMs: number): void;
  /**
   * The scripted GitHub (test/fixtures/github): gh signed in as the seeded login, the seeded repos, and `kelvin/dotfiles` with
   * three merged PRs that is NOT tracked yet. A spec changes it between steps (`signOutGh()`, `addRepo()`, `device = …`). The
   * account card is computed at most once every 10 seconds of the app's clock, so after a change made behind the app's back move
   * the clock (`setNow`) before expecting the page to show it; anything done through the app's own routes shows at once.
   */
  github: FakeGithub;
  /** The in-memory Keychain: the only place an App token is ever stored. */
  keyring: MemoryKeyring;
  /**
   * The device flow waits for a spec to let it poll (so the code panel can be looked at while it is pending). This lets one poll
   * go; it waits until the flow is waiting.
   */
  stepDeviceFlow(): Promise<void>;
  /** Resolves when the GitHub run an added repo started has finished. */
  githubIdle(): Promise<void>;
  /**
   * The scripted Codex app-server (test/fixtures/appserver): nothing is started and nothing on this machine is read. It starts
   * signed in to ChatGPT with daily buckets and a current weekly limit. The card says Not connected until `read()` (or Connect,
   * which starts one). `useScenario(name)` switches the fixture; `null` is a machine with no `codex`.
   */
  chatgpt: {
    useScenario(name: string | null): void;
    /** Runs a ChatGPT-only read and waits for it to end. */
    read(): Promise<void>;
  };
  /** Synthetic Claude plan usage on the real route, and settings for legacy removal in a temporary config directory. */
  claude: {
    settingsPath: string;
    writeSettings(value: unknown): void;
    settings(): string | null;
    seedLegacyHook(settings: Record<string, unknown>): Promise<void>;
    useCredential(state: CredentialResult['state']): void;
    usePlanResponse(response: () => Response): void;
    planRequests(): number;
    check(): Promise<void>;
  };
  /**
   * Temporary homes for Setup's discovery (test/e2e/helpers/homes.ts): the fixture Claude Code and Codex folders where a spec asks
   * for them (found, absent or denied; at the default place or at an override variable's). Every home is removed, and permissions
   * restored, when the world closes. Discovery is given `home` and `env`; no real folder is read.
   */
  homes: { make(options?: SetupHomeOptions): SetupHome };
  /** The scripted HQ roster when the world was given an `hq` scenario (`set` replaces it between polls); null otherwise. */
  hq: ScriptedHq | null;
  /** The scripted hooks switch when the world was given a `hooks` scenario; null otherwise. */
  hooks: ScriptedHooks | null;
  close(): void;
}

export function createWorld(options: WorldOptions = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'crew-world-'));
  const db = openDatabase(join(dir, 'agent-productivity.db'));
  migrate(db);
  seedDatabase(db, options.firstLaunch ? { ...options, scenario: 'empty' } : options);
  // Every world but a first launch has finished setup. The empty scenario is the seed's "nothing there yet" (it leaves setup
  // open); a spec about an empty screen means a finished setup with nothing found, so the world finishes it, as Finish would.
  if (!options.firstLaunch && !readSetupState(db).complete) {
    completeSetup(db, { at: FIXED_NOW, timezone: FIXED_TIMEZONE });
  }
  const homes: SetupHome[] = [];
  const logs: string[] = [];
  const logger = createLogger({
    sink: (line) => logs.push(line),
    level: 'warn',
    now: () => FIXED_NOW,
  });
  let now = FIXED_NOW;
  const scripted = createScriptedGithub(db, {
    now: () => now,
    ...(options.ghSignedIn === undefined ? {} : { signedIn: options.ghSignedIn }),
  });
  // A device flow waits here until `stepDeviceFlow()` lets it poll, so its "waiting for you" state can be looked at.
  const sleepers: (() => void)[] = [];
  // A sign-in that is cancelled stops waiting at once and leaves the queue, so `stepDeviceFlow()` always lets the sign-in that is
  // still running go, never one that has already ended.
  const sleep: Sleep = (_ms, signal) =>
    new Promise<void>((resolve) => {
      const release = () => {
        const at = sleepers.indexOf(release);
        if (at >= 0) sleepers.splice(at, 1);
        resolve();
      };
      sleepers.push(release);
      signal?.addEventListener('abort', release, { once: true });
    });
  const accounts = createGithubAccounts({ db, ...scripted.boot, now: () => now, sleep });
  // Adding a repo starts a GitHub-only run, as the product does. The default runner below stays empty, so Refresh in the
  // usage specs never reaches the scripted GitHub or changes the seeded repos.
  const githubRunner = createRunner({
    db,
    now: () => now,
    logger,
    adapters: [
      createGithubAdapter({
        net: scripted.boot.net,
        auth: accounts.auth,
        timezone: FIXED_TIMEZONE,
      }),
    ],
  });
  // ChatGPT through the scripted app-server, and a runner of its own so Connect (and `world.chatgpt.read()`) can read the account
  // without the default runner below, which stays empty so the usage specs never reach it.
  const chatgptWithThreads = withMethods(loadScenario('chatgpt-with-threads'), {
    'account/rateLimits/read': {
      result: {
        rateLimits: {
          limitId: 'codex',
          primary: {
            usedPercent: 23,
            windowDurationMins: 300,
            resetsAt: (FIXED_NOW + 3_600_000) / 1000,
          },
          secondary: {
            usedPercent: 41,
            windowDurationMins: 10_080,
            resetsAt: (FIXED_NOW + 2 * 86_400_000) / 1000,
          },
        },
      },
    },
  });
  let appServer = scriptedAppServer(chatgptWithThreads);
  const launch = () => appServer.launch();
  const chatgptRunner = createRunner({
    db,
    now: () => now,
    logger,
    adapters: [createChatgptAdapter({ launch })],
  });
  const chatgpt = createChatgptAccounts({
    db,
    launch,
    now: () => now,
    timezone: FIXED_TIMEZONE,
    onConnected: () => {
      chatgptRunner.start({ trigger: 'manual', sources: ['chatgpt_account'] });
    },
  });
  // Claude plan usage over temp folders (the config folder's name has a space, as a real one may).
  const configDir = join(dir, 'claude config');
  const dataDir = join(dir, 'claude data');
  mkdirSync(configDir, { recursive: true });
  const capture = createClaudeCapture({
    dataDir,
    env: { CLAUDE_CONFIG_DIR: configDir },
    home: dir,
    now: () => now,
  });
  // The shared seed includes an older limit. Start each browser world with no plan check or retained snapshot.
  replaceRateLimits(db, 'claude', [], now);
  let credential: CredentialResult['state'] = 'ok';
  let requests = 0;
  let planResponse = () =>
    Response.json({
      five_hour: { utilization: 23, resets_at: new Date(now + 3_600_000).toISOString() },
      seven_day: { utilization: 62, resets_at: new Date(now + 86_400_000).toISOString() },
    });
  const claude = createClaudeAccounts({
    capture,
    db,
    now: () => now,
    profile: () => claudePlanProfile({ CLAUDE_CONFIG_DIR: configDir }, dir),
    planLimits: {
      readCredential: async () =>
        credential === 'ok'
          ? { state: credential, accessToken: 'synthetic-oauth-token' }
          : { state: credential },
      net: async () => {
        requests += 1;
        return planResponse();
      },
    },
  });
  const hq = options.hq ? createScriptedHq(rosterFor(options.hq, now)) : null;
  const hooks = options.hooks ? createScriptedHooks(options.hooks) : null;
  const paseoQuota =
    options.paseoUsage === undefined
      ? undefined
      : createPaseoQuotaService({
          listUsage: async () => options.paseoUsage,
          checkCodex: async () => null,
          checkClaude: async () => (await claude.check()).account.planLimits?.report ?? null,
          now: () => now,
        });
  const writeClaudeSettings = (value: unknown) => {
    writeFileSync(capture.settingsPath, `${JSON.stringify(value, null, 2)}\n`);
  };
  const app = createApp({
    db,
    logger,
    // No adapters: a spec that needs a run builds its own runner over `world.db` with scripted ones.
    runner: createRunner({ db, now: () => now, logger, adapters: [] }),
    port: WORLD_PORT,
    now: () => now,
    timezone: FIXED_TIMEZONE,
    version: '0.0.0-world',
    staticDir: null,
    github: accounts,
    chatgpt,
    claude,
    paseoQuota,
    ...(hq ? { hq } : {}),
    ...(hooks ? { claudeHooks: hooks } : {}),
    repos: {
      net: scripted.boot.net,
      auth: accounts.auth,
      requestSync: () => {
        if (readSetupState(db).complete)
          githubRunner.start({ trigger: 'manual', sources: ['github'] });
      },
    },
  });
  return {
    app,
    db,
    logs,
    setNow: (epochMs) => {
      now = epochMs;
    },
    github: scripted.github,
    keyring: scripted.keyring,
    stepDeviceFlow: async () => {
      for (let wait = 0; sleepers.length === 0 && wait < 200; wait += 1) {
        await new Promise((done) => setTimeout(done, 10));
      }
      sleepers.shift()?.();
    },
    githubIdle: () => githubRunner.idle(),
    chatgpt: {
      useScenario: (name) => {
        const scenario =
          name === null
            ? null
            : name === 'chatgpt-with-threads'
              ? chatgptWithThreads
              : loadScenario(name);
        appServer = scriptedAppServer(scenario);
      },
      read: async () => {
        const started = chatgptRunner.start({ trigger: 'manual', sources: ['chatgpt_account'] });
        if (!started.started) await chatgptRunner.idle();
        await chatgptRunner.idle();
      },
    },
    claude: {
      settingsPath: capture.settingsPath,
      writeSettings: writeClaudeSettings,
      seedLegacyHook: async (settings) => {
        writeClaudeSettings(settings);
        const preview = await capture.preview('install');
        capture.change({ action: 'prepare_install', confirm: preview.previewDigest });
        writeClaudeSettings({ ...settings, statusLine: preview.next });
        capture.change({ action: 'verify_install' });
        capture.retire();
      },
      useCredential: (state) => {
        credential = state;
      },
      usePlanResponse: (response) => {
        planResponse = response;
      },
      planRequests: () => requests,
      check: async () => {
        const result = await answerApi(app, {
          method: 'POST',
          path: '/api/accounts/claude/plan-limits/check',
          headers: { 'x-agent-productivity-request': '1', 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
        if (result.status !== 200) throw new Error(`Claude check failed (${result.status})`);
      },
      settings: () => {
        try {
          return readFileSync(capture.settingsPath, 'utf8');
        } catch {
          return null;
        }
      },
    },
    homes: {
      make: (homeOptions) => {
        const made = makeSetupHome(homeOptions);
        homes.push(made);
        return made;
      },
    },
    hq,
    hooks,
    close: () => {
      for (const home of homes.splice(0)) home.close();
      void hq?.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ApiCall {
  method: string;
  /** Path and query, for example `/api/usage/groups?provider=codex`. */
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array | null | undefined;
}
export interface ApiAnswer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// Headers a browser adds that mean nothing to the app, or that the Host guard would otherwise see.
const DROPPED = new Set(['host', 'origin', 'referer', 'connection', 'content-length']);

/** Sends one request to the app the way the guards expect it (Host is the loopback address), and returns the answer. */
export async function answerApi(app: Hono<HttpEnv>, call: ApiCall): Promise<ApiAnswer> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(call.headers)) {
    if (!DROPPED.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set('host', `127.0.0.1:${WORLD_PORT}`);
  const init: RequestInit = { method: call.method, headers };
  if (call.body && call.method !== 'GET' && call.method !== 'HEAD')
    init.body = new Uint8Array(call.body);
  const response = await app.request(`http://127.0.0.1:${WORLD_PORT}${call.path}`, init);
  const answered = Object.fromEntries(response.headers);
  delete answered['content-length'];
  return {
    status: response.status,
    headers: answered,
    body: Buffer.from(await response.arrayBuffer()),
  };
}

/** The production build plus the real API, on the virtual origin. */
export async function serveWorld(page: Page, world: World, build = 'dist/client'): Promise<void> {
  await serveBuild(page, build);
  await page.route(`${ORIGIN}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const answer = await answerApi(world.app, {
      method: request.method(),
      path: url.pathname + url.search,
      headers: request.headers(),
      body: request.postDataBuffer(),
    });
    await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
  });
}

/**
 * For a spec that does not use the `world` fixture (a helper that opens pages for many tests): creates a world, serves it
 * on `page` and closes it when the page closes.
 */
export async function openWorld(page: Page, options: WorldOptions = {}): Promise<World> {
  const world = createWorld(options);
  page.once('close', () => world.close());
  await serveWorld(page, world);
  return world;
}
