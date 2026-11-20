// First-launch Setup's scripted machine, shared by test/e2e/setup.spec.ts and scripts/capture-fidelity.ts (M10: A35, goals G10_1 and G10_2).
//
// What is real and what is scripted. The setup routes are the real ones (`setupRoutes`), mounted over the world's database and
// answering before the world's own routes (a route registered on the page later wins, as recovery.spec.ts does). Discovery looks at a
// TEMPORARY home with copies of the invented fixture folders (`world.homes`): nothing reads this computer's folders, and nothing here
// reads a variable of the process. Paseo is a scripted daemon (a fake client, no socket) and `codex` on the PATH is a scripted answer; no
// program is started. The first refresh run is the real runner over scripted adapters that wait until a caller lets them finish.

import type { Page } from '@playwright/test';
import { Hono } from 'hono';
import type { PaseoOpen } from '../../../src/server/collectors/paseo/index.ts';
import { createRunner, type Runner } from '../../../src/server/collectors/runner.ts';
import { correlation, errorHandler, type HttpEnv } from '../../../src/server/http/errors.ts';
import { csrfGuard, hostGuard, securityHeaders } from '../../../src/server/http/guards.ts';
import { setupRoutes } from '../../../src/server/http/routes/setup.ts';
import { createLogger } from '../../../src/server/lib/logger.ts';
import { createChatgptAccounts } from '../../../src/server/services/accounts.ts';
import { createGithubAccounts } from '../../../src/server/services/accounts-github.ts';
import { loadScenario, scriptedAppServer } from '../../collectors/chatgpt/scripted.ts';
import { createScriptedGithub } from '../../fixtures/github/world.ts';
import {
  gate,
  holds,
  scriptedAdapter,
  succeeds,
  type Gate,
} from '../../fixtures/scripted-adapters/scripted.ts';
import { FIXED_NOW, FIXED_TIMEZONE } from '../../fixtures/seed.ts';
import type { SetupHome, SetupHomeOptions } from './homes.ts';
import { ORIGIN } from './virtualOrigin.ts';
import { WORLD_PORT, answerApi, type World } from './world.ts';

export type PaseoState = 'running' | 'down' | 'password' | 'absent';

export interface Machine {
  /** The temporary home discovery looks at. Default: both providers found at their usual folders. */
  home?: SetupHome;
  homeOptions?: SetupHomeOptions;
  /** Paseo's daemon. `absent` is a process with no Paseo integration at all. Default: running. */
  paseo?: PaseoState;
  /** Whether `codex` is on the PATH. Default: it is. */
  codexOnPath?: boolean;
  /** Whether `gh` is signed in, for the account card discovery reads. Default: signed in. */
  ghSignedIn?: boolean;
  /** False lets the first run finish by itself. Default: it waits for `held.release()`. */
  hold?: boolean;
}

export interface Mounted {
  home: SetupHome;
  runner: Runner;
  /** Opens the first run's adapters. */
  held: Gate;
  /** The API as the browser reaches it, for a spec that asks a question the page does not. */
  api: Hono<HttpEnv>;
  calls: {
    paseoConnects: number;
    paseoLists: number;
    codexChecks: number;
    /** How many times anything started the Codex app-server (`codex app-server`). Setup must never. */
    readonly appServerLaunches: number;
    /** Every request the page sent to /api/setup/*, as `METHOD path`. */
    setup: string[];
  };
}

/** A fake Paseo client: it connects or refuses as the state says, and says whether anything listed agents. */
function daemon(state: Exclude<PaseoState, 'absent'>, calls: Mounted['calls']): PaseoOpen {
  return () => ({
    connect: async () => {
      calls.paseoConnects += 1;
      if (state === 'down') throw new Error('Transport closed (code 1006)');
      if (state === 'password') {
        throw Object.assign(new Error('Password required'), { name: 'DaemonAuthenticationError' });
      }
    },
    close: async () => undefined,
    agents: {
      list: async () => {
        calls.paseoLists += 1;
        throw new Error('Discovery must not list agents.');
      },
    },
  });
}

/**
 * Mounts the real setup routes for the page (after the world's own routes, so they answer first) over the world's database, with the
 * machine the spec describes.
 */
export async function mountSetup(
  page: Page,
  world: World,
  machine: Machine = {},
): Promise<Mounted> {
  const home = machine.home ?? world.homes.make(machine.homeOptions);
  const logs: string[] = [];
  const logger = createLogger({
    sink: (line) => logs.push(line),
    level: 'warn',
    now: () => FIXED_NOW,
  });
  const held = gate();
  const adapters =
    machine.hold === false
      ? [scriptedAdapter('codex', [succeeds()]), scriptedAdapter('claude', [succeeds()])]
      : [
          scriptedAdapter('codex', [holds(held, succeeds({ imported: 0 }))]),
          scriptedAdapter('claude', [holds(held, succeeds({ imported: 0 }))]),
        ];
  const runner = createRunner({ db: world.db, now: () => FIXED_NOW, logger, adapters });
  const server = scriptedAppServer(loadScenario('chatgpt-with-threads'));
  const calls: Mounted['calls'] & { paseoConnects: number } = {
    paseoConnects: 0,
    paseoLists: 0,
    codexChecks: 0,
    get appServerLaunches() {
      return server.launches();
    },
    setup: [],
  };
  // The account cards discovery answers, over the same database (they read stored rows) and scripted GitHub and Codex: no network, no
  // Keychain, no `gh`, no `codex` program.
  const scripted = createScriptedGithub(world.db, {
    now: () => FIXED_NOW,
    ...(machine.ghSignedIn === undefined ? {} : { signedIn: machine.ghSignedIn }),
  });
  const github = createGithubAccounts({
    db: world.db,
    ...scripted.boot,
    now: () => FIXED_NOW,
    sleep: () => Promise.resolve(),
  });
  const chatgpt = createChatgptAccounts({
    db: world.db,
    launch: server.launch,
    now: () => FIXED_NOW,
    timezone: FIXED_TIMEZONE,
  });

  const paseo = machine.paseo ?? 'running';
  const api = new Hono<HttpEnv>();
  api.use('*', correlation());
  api.use('*', securityHeaders());
  api.use('*', hostGuard(WORLD_PORT, logger));
  api.use('*', csrfGuard(logger));
  api.onError(errorHandler(logger));
  api.route(
    '/',
    setupRoutes({
      db: world.db,
      runner,
      now: () => FIXED_NOW,
      timezone: FIXED_TIMEZONE,
      local: { env: home.env, home: home.home },
      paseo: paseo === 'absent' ? undefined : { open: daemon(paseo, calls) },
      codexOnPath: () => {
        calls.codexChecks += 1;
        return machine.codexOnPath ?? true;
      },
      github,
      chatgpt,
      logger,
    }),
  );
  await page.route(
    (url) => url.origin === ORIGIN && url.pathname.startsWith('/api/setup/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      calls.setup.push(`${request.method()} ${url.pathname}`);
      const answer = await answerApi(api, {
        method: request.method(),
        path: url.pathname + url.search,
        headers: request.headers(),
        body: request.postDataBuffer(),
      });
      await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
    },
  );
  return { home, runner, held, api, calls };
}
