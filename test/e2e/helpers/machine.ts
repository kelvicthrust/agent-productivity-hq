import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Hono } from 'hono';
import {
  createDiscoveryStep,
  createLocalAdapters,
} from '../../../src/server/collectors/discovery.ts';
import { createRunner, type Runner } from '../../../src/server/collectors/runner.ts';
import type { SourceAdapter } from '../../../src/server/collectors/types.ts';
import { migrate } from '../../../src/server/db/migrate.ts';
import { openDatabase, type Db } from '../../../src/server/db/open.ts';
import { setMetaIfMissing } from '../../../src/server/db/queries/meta.ts';
import { completeSetup } from '../../../src/server/db/queries/setup.ts';
import { createApp } from '../../../src/server/http/app.ts';
import type { HttpEnv } from '../../../src/server/http/errors.ts';
import { createLogger } from '../../../src/server/lib/logger.ts';
import { runRetention } from '../../../src/server/services/retention.ts';
import { FIXED_NOW, FIXED_TIMEZONE } from '../../fixtures/seed.ts';
import { ORIGIN, serveBuild } from './virtualOrigin.ts';
import { WORLD_PORT, answerApi } from './world.ts';

// A browser spec on a MACHINE rather than on the seeded world: a temp HOME holding copies of the INVENTED fixture logs where
// Claude Code and Codex keep their history, the two REAL local adapters and discovery pointed at it, the real runner and the real
// app over an empty database. Nothing reads this computer's folders: the home and the (empty) environment are passed in, the way
// `pnpm start` passes the real ones. The fixture logs are DRAFT-documented-shape, so what is shown is what the importer made of
// invented files, not a finding from a real session (E1 and E2 are not claimed).

const FIXTURES = join(import.meta.dirname, '../../fixtures');

// The folder a machine's home gets is one long word. Sources shows where each provider was found, in mono, as a path with no spaces. A
// browser can break a path after a slash or a hyphen, so only a long run of letters in one folder name cannot be broken, and that is
// the case that overflowed a phone-width window: the same spec failed on a computer whose temp folder is `/var/folders/<long name>/T`
// and passed on one whose temp folder is short. Naming the home this way makes the location wider than 320px wherever the spec
// runs, whatever `TMPDIR` is (105 letters and 6 more of random suffix: far wider than a phone).
const LONG_HOME_PREFIX =
  'crewmachinehomeinonefolderwhosenamehasnobreakpointsandsoisfarwiderthanaphonescreenwhereverthetempfolderis';

/** A temp HOME with the fixtures where each provider keeps its files, or an empty one. */
export function makeHome(options: { empty?: boolean } = {}): string {
  const home = mkdtempSync(join(tmpdir(), LONG_HOME_PREFIX));
  if (options.empty) return home;
  cpSync(join(FIXTURES, 'claude/projects'), join(home, '.claude/projects'), { recursive: true });
  cpSync(join(FIXTURES, 'claude/config-b/projects'), join(home, '.config/claude/projects'), {
    recursive: true,
  });
  cpSync(join(FIXTURES, 'codex/home'), join(home, '.codex'), { recursive: true });
  return home;
}

/** How many transcripts or rollouts are below `path` (what the importer will say it is reading). */
function countFiles(path: string): number {
  if (!statSafe(path)) return 0;
  let total = 0;
  const entries = readdirSync(path, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (entry.isDirectory()) total += countFiles(join(path, entry.name));
    else if (
      /\.jsonl(\.zst)?$/.test(entry.name) &&
      !/\.(orphaned|superseded)/.test(entry.name) &&
      // a rollout kept as both `.jsonl` and `.jsonl.zst` is read once: the plain file wins
      !(entry.name.endsWith('.zst') && names.has(entry.name.slice(0, -4)))
    )
      total += 1;
  }
  return total;
}

export interface Machine {
  app: Hono<HttpEnv>;
  db: Db;
  home: string;
  runner: Runner;
  /** Log lines at warn or error level. */
  logs: string[];
  /** Starts the run `pnpm start` starts when it is listening (the timer's, not a button's). */
  startFirstRun(): void;
  /** Lets a held import carry on (see `hold`). */
  release(): void;
  /** Runs `body` with these folders unreadable (chmod 000), and always puts the permissions back. */
  deny<T>(folders: readonly string[], body: () => Promise<T>): Promise<T>;
  close(): void;
}

export interface MachineOptions {
  /** A home you made; default is a fresh one with the fixture logs. */
  home?: string;
  /**
   * Hold each import at the start: the adapter says how many files it will read (the run shows "Importing 0 of N files") and
   * waits until `release()`. A real import of a handful of small files ends in milliseconds, too fast for a page to be looked at
   * while it goes; the holding is the test's, the files and the importer that then runs are the real ones.
   */
  hold?: boolean;
}

export function createMachine(options: MachineOptions = {}): Machine {
  const home = options.home ?? makeHome();
  const dir = mkdtempSync(join(tmpdir(), 'crew-machine-db-'));
  const db = openDatabase(join(dir, 'agent-productivity.db'));
  migrate(db);
  setMetaIfMissing(db, 'install_id', 'machine-spec');
  // A machine spec is about a machine that has finished Setup (a first launch redirects every screen to /setup); this stores the
  // report timezone as well, as Finish does.
  completeSetup(db, { at: FIXED_NOW, timezone: FIXED_TIMEZONE });
  const logs: string[] = [];
  const logger = createLogger({
    sink: (line) => logs.push(line),
    level: 'warn',
    now: () => FIXED_NOW,
  });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const filesIn: Record<string, number> = {
    codex: countFiles(join(home, '.codex')),
    claude: [join(home, '.claude'), join(home, '.config/claude')]
      .filter((path) => statSafe(path))
      .reduce((n, path) => n + countFiles(path), 0),
  };
  const held = (adapter: SourceAdapter): SourceAdapter => ({
    id: adapter.id,
    async refresh(context) {
      context.progress({ done: 0, total: filesIn[adapter.id] ?? 0 });
      await gate;
      return adapter.refresh(context);
    },
  });
  const adapters = createLocalAdapters({ env: {}, home }).map((adapter) =>
    options.hold ? held(adapter) : adapter,
  );
  const runner = createRunner({
    db,
    now: () => FIXED_NOW,
    logger,
    adapters,
    beforeSources: [createDiscoveryStep({ db, env: {}, home, logger })],
    afterSources: [
      {
        name: 'retention',
        run: () => void runRetention(db, { nowMs: FIXED_NOW, timezone: FIXED_TIMEZONE }),
      },
    ],
  });
  const app = createApp({
    db,
    logger,
    runner,
    port: WORLD_PORT,
    now: () => FIXED_NOW,
    timezone: FIXED_TIMEZONE,
    version: '0.0.0-machine',
    staticDir: null,
  });
  return {
    app,
    db,
    home,
    runner,
    logs,
    startFirstRun() {
      runner.start({ trigger: 'scheduler' });
    },
    release: () => open(),
    async deny(folders, body) {
      const modes = folders.map((path) => statSync(path).mode & 0o777);
      try {
        for (const path of folders) chmodSync(path, 0o000);
        return await body();
      } finally {
        folders.forEach((path, index) => chmodSync(path, modes[index]!));
      }
    },
    close() {
      open();
      void runner.idle().finally(() => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      });
    },
  };
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The production build plus the real API over this machine, on the virtual origin. Closed when the page closes. */
export async function openMachine(page: Page, options: MachineOptions = {}): Promise<Machine> {
  const machine = createMachine(options);
  page.once('close', () => machine.close());
  await serveBuild(page, 'dist/client');
  await page.route(`${ORIGIN}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const answer = await answerApi(machine.app, {
      method: request.method(),
      path: url.pathname + url.search,
      headers: request.headers(),
      body: request.postDataBuffer(),
    });
    await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
  });
  return machine;
}

/** What the database holds of usage: how many events and their provider totals. The same before and after a Retry means nothing was counted twice. */
export function usageTotals(db: Db): { events: number; total: number; sessions: number } {
  const events = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(provider_total), 0) AS t FROM usage_event')
    .get() as { n: number; t: number };
  const sessions = db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number };
  return { events: events.n, total: events.t, sessions: sessions.n };
}
