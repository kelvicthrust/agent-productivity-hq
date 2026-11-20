import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../../src/server/collectors/claude/index.ts';
import { createCodexAdapter } from '../../src/server/collectors/codex/index.ts';
import type { AdapterContext } from '../../src/server/collectors/types.ts';
import { memoryDb, memoryLogger } from '../server/helpers.ts';

// The two adapters together, the way the runner uses them: one database, both in the same stage and at the same time. They share
// the ingest base (events, file rows, sessions), so this is where a collision between them would show: on provider, dedupe key,
// file path or session id. The totals are compared with the fixture oracles, which are ccusage's output over INVENTED data
// (DRAFT-documented-shape): this shows the adapters agree with the E1 and E2 scripts' expectations, not with real files.

const FIXTURES = join(import.meta.dirname, '../fixtures');
const T0 = Date.parse('2026-11-05T12:00:00Z');

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

const claudeOracle = JSON.parse(
  readFileSync(join(FIXTURES, 'claude/oracle.json'), 'utf8'),
) as ClaudeOracle;
const codexOracle = JSON.parse(
  readFileSync(join(FIXTURES, 'codex/oracle.json'), 'utf8'),
) as CodexOracle;

function setup() {
  const db = memoryDb();
  const logs = memoryLogger('debug');
  const context = (): AdapterContext => ({
    db,
    now: () => T0,
    logger: logs.logger,
    progress: () => {},
  });
  const claude = createClaudeAdapter({ configDirs: () => [join(FIXTURES, 'claude')] });
  const codex = createCodexAdapter({ homes: () => [join(FIXTURES, 'codex/home')] });
  return { db, logs, context, claude, codex };
}

type Sums = Record<string, number>;
const sessionSums = (db: ReturnType<typeof memoryDb>, provider: string): Map<string, Sums> => {
  const rows = db
    .prepare(
      `SELECT s.provider_session_id AS id, SUM(e.input_tokens) AS input, SUM(e.cached_input_tokens) AS cached,
         SUM(e.cache_write_tokens) AS write, SUM(e.cache_read_tokens) AS read, SUM(e.output_tokens) AS output,
         SUM(e.reasoning_tokens) AS reasoning, SUM(e.provider_total) AS total
       FROM session s JOIN usage_event e ON e.session_id = s.id WHERE s.provider = ? GROUP BY s.id`,
    )
    .all(provider) as unknown as ({ id: string } & Sums)[];
  return new Map(rows.map(({ id, ...sums }) => [id, sums]));
};

describe('Claude Code and Codex on one database', () => {
  it('both import at the same time and agree with their oracles to the token', async () => {
    const { db, context, claude, codex } = setup();
    const [a, b] = await Promise.all([claude.refresh(context()), codex.refresh(context())]);
    expect(a).toMatchObject({ result: 'succeeded', status: 'ok', unreadable: 0 });
    expect(b).toMatchObject({ result: 'succeeded', status: 'ok', unreadable: 0 });

    // Claude: ccusage folds a subagent's usage into its parent session, so a session is the root plus the children by location.
    const claudeSums = sessionSums(db, 'claude');
    for (const oracle of claudeOracle.sessions) {
      const own = [...claudeSums].filter(
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

    // Codex: one session per rollout. ccusage reports input without its cached part; the app stores input with it and the
    // provider total as input + output (the owner-confirmed rule), so the same figures meet under that rule.
    const codexSums = sessionSums(db, 'codex');
    for (const oracle of codexOracle.sessions) {
      const id = oracle.sessionFile.slice(-36);
      const row = codexSums.get(id);
      expect(row, id).toBeDefined();
      expect(row?.['input'], `${id} input`).toBe(oracle.inputTokens + oracle.cacheReadTokens);
      expect(row?.['cached'], `${id} cached`).toBe(oracle.cacheReadTokens);
      expect(row?.['output'], `${id} output`).toBe(oracle.outputTokens);
      expect(row?.['reasoning'], `${id} reasoning`).toBe(oracle.reasoningOutputTokens);
      expect(row?.['total'], `${id} total`).toBe(oracle.totalTokens);
    }
  });

  it('a second refresh finds nothing new, changes no total, and keeps the providers apart', async () => {
    const { db, context, claude, codex } = setup();
    await Promise.all([claude.refresh(context()), codex.refresh(context())]);
    const before = db
      .prepare('SELECT COUNT(*) AS n, SUM(provider_total) AS t FROM usage_event')
      .get();
    const files = db
      .prepare('SELECT source_id, COUNT(*) AS n FROM source_file GROUP BY source_id')
      .all();
    const [a, b] = await Promise.all([claude.refresh(context()), codex.refresh(context())]);
    expect(a).toMatchObject({ result: 'succeeded', imported: 0, duplicatesSkipped: 0 });
    expect(b).toMatchObject({ result: 'succeeded', imported: 0, duplicatesSkipped: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n, SUM(provider_total) AS t FROM usage_event').get(),
    ).toEqual(before);
    expect(files).toEqual([
      { source_id: 'claude', n: 4 },
      { source_id: 'codex', n: 3 },
    ]);
    // A source file belongs to one source; an event points at a file of its own provider.
    const crossed = db
      .prepare(
        `SELECT COUNT(*) AS n FROM usage_event e JOIN source_file f ON f.id = e.source_file_id WHERE f.source_id <> e.provider`,
      )
      .get();
    expect(crossed).toEqual({ n: 0 });
  });

  it('stores no prompt, reply, tool text or token from the transcripts, in the database or the logs', async () => {
    const { db, logs, context, claude, codex } = setup();
    await Promise.all([claude.refresh(context()), codex.refresh(context())]);
    await Promise.all([claude.refresh(context()), codex.refresh(context())]);
    // cwd, branch and title are the session metadata the schema keeps; the other sentinel kinds are text the adapters must never keep.
    const FORBIDDEN =
      /SENTINEL_(PROMPT|REPLY|TOOL|RESULT|INSTR|PREVIEW|GARBAGE|BROKEN|QUEUE|CURSOR|ROLE|NICK|TOKEN)/;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as unknown as { name: string }[];
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM ${name}`).all();
      expect(JSON.stringify(rows), name).not.toMatch(FORBIDDEN);
    }
    expect(JSON.stringify(logs.entries)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(logs.entries)).not.toMatch(/SENTINEL/);
  });
});
