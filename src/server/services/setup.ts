import { access, constants, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { z } from 'zod';
import type {
  RefreshRun,
  SetupDiscoverResponse,
  SourceStatus,
} from '../../shared/contracts/sources.ts';
import type { GithubAccounts } from '../collectors/github/ports.ts';
import {
  checkLocalSources,
  type DiscoveryEnv,
  type DiscoveryInput,
} from '../collectors/discovery.ts';
import { DEFAULT_PASEO_URL, type PaseoAdapterOptions } from '../collectors/paseo/index.ts';
import { openPaseoClient } from '../collectors/paseo/open.ts';
import type { Runner } from '../collectors/runner.ts';
import type { Db } from '../db/open.ts';
import { completeSetup, isResetSetupPending } from '../db/queries/setup.ts';
import {
  getLatestRun,
  getRunningRun,
  getSourceState,
  recordDiscovery,
} from '../db/queries/sources.ts';
import type { Logger } from '../lib/logger.ts';
import type { ChatgptAccounts } from './accounts.ts';
import { finishResetStorage } from './reset.ts';
import { buildSources, getRefreshRun, toRefreshRun } from './sources.ts';

// First-launch Setup on the server (TECH › J1 Set up coverage; local-api › POST /api/setup/discover and /complete).
//
//   discover  LOOKS and says what it saw. It checks the documented default folders and override variables (collectors/discovery.ts),
//             connects to the Paseo daemon without a password and hangs up, and checks the PATH folders for `codex`. It records each
//             source's status and location on its row, as every refresh's discovery step does, and records no attempt. It imports
//             nothing, reads no transcript, starts no program (`codex` is found by looking at files, never by running it) and takes
//             nothing from the client: there is no body, so no path, folder, key, password or token is ever sent to it or asked for.
//   complete  marks setup done with the report timezone (one transaction, db/queries/setup.ts) and starts the first full refresh.
//             Only the first completion starts one. A repeat (a second tab, a double click) changes nothing and answers the run that
//             is going, else the latest finished one, and starts a run only if there has never been one.
//
// Everything this reaches is a port handed in by whoever builds the app: the machine (`local`), Paseo's opener, the PATH check and
// the two account services. `pnpm start` gives the live ones; tests give a temporary home, a scripted daemon and a scripted PATH.

type Discovery = z.infer<typeof SetupDiscoverResponse>;
type Account = NonNullable<Discovery['accounts']>[number];

export interface SetupDeps {
  db: Db;
  /** The refresh runner: Finish starts the first run on it. */
  runner: Runner;
  /** The app clock (epoch ms). */
  now: () => number;
  /** The machine's IANA zone: reports are bucketed in it, and Finish stores it. */
  timezone: string;
  /**
   * This machine, as the Codex and Claude Code adapters see it: the environment (override variables, PATH) and the home folder.
   * Given (`pnpm start`, or a test's temporary home), discovery looks at the documented folders and the PATH. Not given (a process
   * that has no machine of its own: the synthetic preview, a spec), nothing on disk is looked at and the sources are read back as
   * stored, so a visit to Setup never changes a row the process did not look at.
   */
  local?: DiscoveryInput | undefined;
  /**
   * Paseo, the same options the Paseo adapter is given (collectors/paseo). Given, discovery connects to the daemon without a password
   * and says whether it is there. Not given (a process with no Paseo), Paseo is not looked at and is left out of the answer.
   */
  paseo?: PaseoAdapterOptions | undefined;
  /**
   * Whether `codex` is on the PATH, which decides whether ChatGPT can be connected at all (its sign-in is Codex's own). Default:
   * `findOnPath` over the PATH in `local.env`; with no machine and no port, the card is shown as it is stored. A port so a test can
   * say "there is no codex" without touching the machine.
   */
  codexOnPath?: (() => boolean | Promise<boolean>) | undefined;
  /** The GitHub card, as GET /api/sources shows it. Without it the answer has no GitHub entry (as in GET /api/sources). */
  github?: GithubAccounts | undefined;
  /** The ChatGPT card, as GET /api/sources shows it. Without it the answer has no ChatGPT entry. */
  chatgpt?: ChatgptAccounts | undefined;
  logger?: Logger | undefined;
}

export interface SetupService {
  discover(): Promise<Discovery>;
  /** The run the owner lands on: the one just started, or, for a repeat, the one already going or the latest. */
  complete(): RefreshRun;
}

// ---- `codex` on the PATH -----------------------------------------------------------------------------------------------------

/**
 * Whether a program called `name` is an executable file in one of the PATH folders. Only files are looked at: nothing is run, so
 * finding `codex` can never start it (the live launcher, collectors/chatgpt/live.ts, is the one place that starts it). A folder that
 * cannot be read, or an entry that is not a file, is skipped.
 */
export async function findOnPath(name: string, env: DiscoveryEnv): Promise<boolean> {
  const folders = (env['PATH'] ?? '').split(delimiter).filter((folder) => folder !== '');
  for (const folder of new Set(folders)) {
    const candidate = join(folder, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Not here, or not runnable by this user: the next folder.
    }
  }
  return false;
}

// ---- Paseo --------------------------------------------------------------------------------------------------------------------

type PaseoLook = 'ok' | 'notrunning' | 'needspassword';

/** The SDK's authentication error, recognised as the Paseo adapter recognises it ("Password required" / "Incorrect password"). */
const isPasswordError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'DaemonAuthenticationError' || /password/i.test(error.message));

/**
 * Connects to the daemon with no password and hangs up: that is the whole look. It lists no agent and stores none (the first
 * refresh does that). A password is asked for and never answered. Anything else that stops the connection (nothing listening, a
 * daemon that does not answer in time) reads as "not running": discovery has no word for a failed attempt, and the attempt that
 * follows records what really happened. The SDK's own message is never kept, because it can carry an agent id.
 */
async function lookAtPaseo(options: PaseoAdapterOptions): Promise<PaseoLook> {
  const open = options.open ?? openPaseoClient;
  let client: Awaited<ReturnType<typeof open>> | undefined;
  try {
    client = await open(options.url ?? DEFAULT_PASEO_URL);
    await client.connect();
    return 'ok';
  } catch (error) {
    return isPasswordError(error) ? 'needspassword' : 'notrunning';
  } finally {
    try {
      await client?.close();
    } catch {
      // Hanging up on a socket that is already gone says nothing worth keeping.
    }
  }
}

/**
 * What the Paseo row says after a look, by the rule discovery uses for the folders (collectors/discovery.ts › recordDiscoveries):
 * "not running" and "needs a password" are what the machine says now, so they are always written; "found" is written only while
 * nothing has attempted Paseo, because after an attempt the row's own word is the attempt's and a look must not overwrite it.
 */
function recordPaseo(db: Db, look: PaseoLook, url: string): void {
  const attempted = (getSourceState(db, 'paseo')?.lastAttemptAt ?? null) !== null;
  if (look === 'ok' && attempted) return;
  recordDiscovery(db, { sourceId: 'paseo', status: look, location: url });
}

// ---- the first run ------------------------------------------------------------------------------------------------------------

export function createSetupService(deps: SetupDeps): SetupService {
  const { db, runner } = deps;

  /** The first full refresh: a new run, or the one that is already going (boot's first run, the 15-minute timer). */
  function firstRun(): RefreshRun {
    const started = runner.start({ trigger: 'setup' });
    if (started.started) return toRefreshRun(started.run);
    const going = getRefreshRun(db, started.runId);
    if (going) return going;
    // The run vanished between the runner's answer and this read: only the database breaking does that.
    throw new Error('The refresh run that was going could not be read.');
  }

  async function chatgptCard(): Promise<Account | null> {
    if (!deps.chatgpt) return null;
    const card = deps.chatgpt.status();
    if (card.status === 'connecting') return card;
    const env = deps.local?.env;
    const look = deps.codexOnPath ?? (env ? () => findOnPath('codex', env) : null);
    // No machine and no port: nothing says whether Codex is installed, so the card is shown as stored.
    if (look === null) return card;
    const found = await look();
    // ChatGPT's sign-in is Codex's own, so with no `codex` there is nothing to connect, whatever an earlier read stored. Said here
    // because no read has happened yet on a first launch, and the card (stored rows only) would otherwise offer a Connect that
    // cannot work. The words are the ones the card uses after a read that found no Codex.
    return found
      ? card
      : {
          id: 'chatgpt',
          name: card.name,
          status: 'unavailable',
          statusText: 'Unavailable: Codex CLI not found',
          via: null,
          reason: 'codex_not_found',
        };
  }

  return {
    async discover() {
      if (deps.local) await checkLocalSources(db, deps.local, deps.logger);
      if (deps.paseo) {
        const look = await lookAtPaseo(deps.paseo);
        recordPaseo(db, look, deps.paseo.url ?? DEFAULT_PASEO_URL);
        deps.logger?.debug('discovery', { source: 'paseo', status: look });
      }
      // The sources are read back as GET /api/sources shows them, so Setup and Sources never describe one source in two ways. A
      // source nothing has looked at has no row and is not claimed.
      const wanted = new Set<SourceStatus['id']>([
        'codex',
        'claude',
        ...(deps.paseo ? (['paseo'] as const) : []),
      ]);
      const sources = (
        buildSources(db, { timezone: deps.timezone, now: deps.now }).sources ?? []
      ).filter((source) => wanted.has(source.id));
      const accounts: Account[] = [];
      if (deps.github) accounts.push(await deps.github.status());
      const chatgpt = await chatgptCard();
      if (chatgpt) accounts.push(chatgpt);
      return { sources, accounts };
    },

    complete() {
      if (isResetSetupPending(db)) finishResetStorage(db);
      const { firstTime } = completeSetup(db, { at: deps.now(), timezone: deps.timezone });
      if (firstTime) return firstRun();
      // A repeat starts no second run: the one going, else the latest. Only a setup that has never had a run starts one.
      const going = getRunningRun(db);
      if (going) return toRefreshRun(going);
      const latest = getLatestRun(db);
      return latest === null ? firstRun() : toRefreshRun(latest);
    },
  };
}
