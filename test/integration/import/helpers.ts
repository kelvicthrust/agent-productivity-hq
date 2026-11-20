import { chmodSync, cpSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { expect } from 'vitest';
import {
  createDiscoveryStep,
  createLocalAdapters,
} from '../../../src/server/collectors/discovery.ts';
import { createRunner, type Runner } from '../../../src/server/collectors/runner.ts';
import type { SourceAdapter } from '../../../src/server/collectors/types.ts';
import { migrate } from '../../../src/server/db/migrate.ts';
import { openDatabase } from '../../../src/server/db/open.ts';
import { getRun, type RunRow } from '../../../src/server/db/queries/sources.ts';
import { usageRoutes } from '../../../src/server/http/routes/usage.ts';
import { recomputeLinks } from '../../../src/server/services/links.ts';
import { runRetention } from '../../../src/server/services/retention.ts';
import { memoryDb, memoryLogger, tempDir } from '../../server/helpers.ts';

// A machine for the import tests: a temp HOME holding copies of the fixture folders where Claude Code and Codex keep their
// history, and a runner wired the way boot wires it (discovery before the sources, retention after). Nothing here reads this
// computer's real folders or its environment: the home and the environment are passed in.
//
// The fixture logs are INVENTED (DRAFT-documented-shape): the oracle files agree with them, not with a real session, and no
// E1 or E2 run is claimed. Every test works on temp copies, so it may write, delete and change permissions.

export const FIXTURES = join(import.meta.dirname, '../../fixtures');
export const T0 = Date.parse('2026-11-05T12:00:00Z');
export const TZ = 'America/Los_Angeles';

/** Whether `chmod 000` keeps this user out: root reads anything, so the permission tests skip there. */
export const CAN_DENY = process.getuid?.() !== 0;

/**
 * A temp HOME with the fixtures where each provider keeps its files:
 *   ~/.claude/projects          the fixture config dir (sessions 1 to 3, a subagent, an orphaned copy to skip)
 *   ~/.config/claude/projects   `config-b` (session 5 and its subagent, a copy of session 2, a superseded copy to skip)
 *   ~/.codex                    the fixture Codex home (`sessions/` and `archived_sessions/`)
 */
export function makeHome(): string {
  const home = tempDir();
  cpSync(join(FIXTURES, 'claude/projects'), join(home, '.claude/projects'), { recursive: true });
  cpSync(join(FIXTURES, 'claude/config-b/projects'), join(home, '.config/claude/projects'), {
    recursive: true,
  });
  cpSync(join(FIXTURES, 'codex/home'), join(home, '.codex'), { recursive: true });
  return home;
}

/** Runs `body` with every path unreadable (chmod 000), and always puts the permissions back so the temp folder can be removed. */
export async function withoutAccess<T>(
  paths: readonly string[],
  body: () => Promise<T>,
): Promise<T> {
  const modes = paths.map((path) => statSync(path).mode & 0o777);
  try {
    for (const path of paths) chmodSync(path, 0o000);
    return await body();
  } finally {
    paths.forEach((path, index) => chmodSync(path, modes[index]!));
  }
}

export interface Machine {
  home: string;
  env: Record<string, string | undefined>;
  db: DatabaseSync;
  logs: ReturnType<typeof memoryLogger>;
  runner: Runner;
  /** Starts a run as the Refresh or Retry button does, waits for it to end and returns the stored run. */
  refresh(sources?: readonly ('codex' | 'claude')[]): Promise<RunRow>;
  /** Moves the app's clock on. */
  tick(ms: number): void;
  close(): void;
}

export interface MachineOptions {
  home: string;
  env?: Record<string, string | undefined>;
  /** A database file: the same path again is a restart. Default: in memory. */
  dbPath?: string;
  /** The app's clock. Default: a clock that starts at T0 and only moves with `tick`. */
  now?: () => number;
  /** Wraps the adapters, to watch what they are told (progress, say). */
  wrap?: (adapters: SourceAdapter[]) => SourceAdapter[];
  /** Run the link recompute after the sources, as the real process does (boot gives it to a process that has `local`). */
  links?: boolean;
}

export function startMachine(options: MachineOptions): Machine {
  const { home } = options;
  const env = options.env ?? {};
  let clock = T0;
  const now = options.now ?? (() => clock);
  let db: DatabaseSync;
  if (options.dbPath) {
    db = openDatabase(options.dbPath);
    migrate(db);
  } else {
    db = memoryDb();
  }
  const logs = memoryLogger('debug');
  const adapters = createLocalAdapters({ env, home });
  const runner = createRunner({
    db,
    now,
    logger: logs.logger,
    adapters: options.wrap ? options.wrap(adapters) : adapters,
    beforeSources: [createDiscoveryStep({ db, env, home, logger: logs.logger })],
    afterSources: [
      ...(options.links
        ? [{ name: 'links' as const, rebuild: (id: number) => void recomputeLinks(db, now(), id) }]
        : []),
      { name: 'retention', run: () => void runRetention(db, { nowMs: now(), timezone: TZ }) },
    ],
  });
  return {
    home,
    env,
    db,
    logs,
    runner,
    async refresh(sources) {
      const started = runner.start({ trigger: 'manual', ...(sources ? { sources } : {}) });
      if (!started.started) throw new Error('a run was already going');
      await runner.idle();
      return getRun(db, started.run.id) as RunRow;
    },
    tick: (ms) => {
      clock += ms;
    },
    close: () => db.close(),
  };
}

// ---- reading back what was imported -------------------------------------------------------------------------------------

type Sums = Record<string, number>;

/** Per-session token sums of one provider, by the provider's own session id. */
export function sessionSums(db: DatabaseSync, provider: string): Map<string, Sums> {
  const rows = db
    .prepare(
      `SELECT s.provider_session_id AS id, SUM(e.input_tokens) AS input, SUM(e.cached_input_tokens) AS cached,
         SUM(e.cache_write_tokens) AS write, SUM(e.cache_read_tokens) AS read, SUM(e.output_tokens) AS output,
         SUM(e.reasoning_tokens) AS reasoning, SUM(e.provider_total) AS total
       FROM session s JOIN usage_event e ON e.session_id = s.id WHERE s.provider = ? GROUP BY s.id`,
    )
    .all(provider) as unknown as ({ id: string } & Sums)[];
  return new Map(rows.map(({ id, ...sums }) => [id, sums]));
}

interface ClaudeOracle {
  sessions: {
    sessionId: string;
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
  }[];
}
interface CodexOracle {
  sessions: {
    sessionFile: string;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  }[];
}

/**
 * The stored totals equal the fixture oracles, to the token (ccusage's output over the INVENTED fixture data). A Claude session
 * is its root plus its subagents (ccusage folds a subagent into its parent); Codex input includes its cached part.
 */
export function expectOraclesMatch(db: DatabaseSync): void {
  const claudeOracle = JSON.parse(
    readFileSync(join(FIXTURES, 'claude/oracle.json'), 'utf8'),
  ) as ClaudeOracle;
  const codexOracle = JSON.parse(
    readFileSync(join(FIXTURES, 'codex/oracle.json'), 'utf8'),
  ) as CodexOracle;
  const claude = sessionSums(db, 'claude');
  for (const oracle of claudeOracle.sessions) {
    const own = [...claude].filter(
      ([id]) => id === oracle.sessionId || id.startsWith(`${oracle.sessionId}:`),
    );
    const sum = (key: string) => own.reduce((n, [, row]) => n + (row[key] ?? 0), 0);
    expect(own.length, oracle.sessionId).toBeGreaterThan(0);
    expect(sum('input'), `${oracle.sessionId} input`).toBe(oracle.inputTokens);
    expect(sum('write'), `${oracle.sessionId} cache write`).toBe(oracle.cacheCreationTokens);
    expect(sum('read'), `${oracle.sessionId} cache read`).toBe(oracle.cacheReadTokens);
    expect(sum('output'), `${oracle.sessionId} output`).toBe(oracle.outputTokens);
    expect(sum('total'), `${oracle.sessionId} total`).toBe(oracle.totalTokens);
  }
  const codex = sessionSums(db, 'codex');
  for (const oracle of codexOracle.sessions) {
    const id = oracle.sessionFile.slice(-36);
    const row = codex.get(id);
    expect(row, id).toBeDefined();
    expect(row?.['input'], `${id} input`).toBe(oracle.inputTokens + oracle.cacheReadTokens);
    expect(row?.['cached'], `${id} cached`).toBe(oracle.cacheReadTokens);
    expect(row?.['output'], `${id} output`).toBe(oracle.outputTokens);
    expect(row?.['reasoning'], `${id} reasoning`).toBe(oracle.reasoningOutputTokens);
    expect(row?.['total'], `${id} total`).toBe(oracle.totalTokens);
  }
}

/** What a history is made of, for "nothing changed" checks: event and session rows and what they add up to. */
export function history(db: DatabaseSync) {
  const one = (sql: string) => db.prepare(sql).get() as Record<string, number | null>;
  return {
    events: one(
      'SELECT COUNT(*) AS n, SUM(provider_total) AS total, MIN(occurred_at) AS oldest FROM usage_event',
    ),
    byProvider: db
      .prepare(
        'SELECT provider, COUNT(*) AS n, SUM(provider_total) AS total FROM usage_event GROUP BY provider ORDER BY provider',
      )
      .all(),
    sessions: db
      .prepare(
        'SELECT provider, provider_session_id, started_at, parent_session_id FROM session ORDER BY provider, provider_session_id',
      )
      .all(),
    files: db
      .prepare(
        'SELECT source_id, path, size, mtime_ms, read_offset, state, last_read_at FROM source_file ORDER BY path',
      )
      .all(),
  };
}

/** Everything every table holds, as one string, for the "nothing the transcripts said is kept" scan. */
export function everythingStored(db: DatabaseSync): Record<string, string> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [name, JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())]),
  );
}

/** Prompt, reply, tool, token and garbage text the fixtures plant. cwd, branch and title are the metadata the schema does keep. */
export const FORBIDDEN =
  /SENTINEL_(PROMPT|REPLY|TOOL|RESULT|INSTR|PREVIEW|GARBAGE|BROKEN|QUEUE|CURSOR|ROLE|NICK|TOKEN)/;

/** GET /api/usage/categories as the server would answer it at `nowMs`, for the coverage each provider gets over a range. */
export async function usageAt(
  db: DatabaseSync,
  nowMs: number,
  query: string,
): Promise<Partial<Record<'codex' | 'claude', { coverage: string; coveredFrom?: string | null }>>> {
  const app = new Hono();
  app.route('/', usageRoutes({ db, now: () => nowMs, timezone: TZ }));
  const response = await app.request(`http://127.0.0.1/api/usage/categories${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Awaited<ReturnType<typeof usageAt>>;
}
