import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createClaudeAdapter } from '../../../src/server/collectors/claude/index.ts';
import type { AdapterReport, ImportProgress } from '../../../src/server/collectors/types.ts';
import { memoryDb, memoryLogger } from '../../server/helpers.ts';

// Shared by the Claude adapter tests. The transcripts here are invented, built a line at a time with SENTINEL_ text where a real
// one would hold a prompt or a reply, so a test can prove none of it reaches a report or a log. The oracle files in
// test/fixtures/claude come from invented data too: nothing here is a finding from a real E1 run.

export const FIXTURES = join(import.meta.dirname, '../../fixtures/claude');
/** A second config dir, as `~/.config/claude` is beside `~/.claude`. */
export const CONFIG_B = join(FIXTURES, 'config-b');
export const T0 = Date.parse('2026-11-04T17:00:00Z');

export function setup(configDirs: () => string[]) {
  const db = memoryDb();
  const logs = memoryLogger('debug');
  const progress: ImportProgress[] = [];
  const adapter = createClaudeAdapter({ configDirs });
  let clock = T0;
  /** One attempt, a minute after the last one on the app's (fixed) clock. */
  const refresh = async (): Promise<AdapterReport> => {
    progress.length = 0;
    clock += 60_000;
    return adapter.refresh({
      db,
      now: () => clock,
      logger: logs.logger,
      progress: (value) => progress.push({ ...value }),
    });
  };
  return { db, refresh, progress, logs, adapter };
}

export interface Message {
  id: string;
  /** Defaults to `req_<id>`; null leaves the field out. */
  req?: string | null;
  at: string;
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
  model?: string;
  cwd?: string;
}

/** One assistant line with usage. Categories default to 1 / 0 / 0 / 1 so a message is never empty. */
export function assistantLine(message: Message): string {
  const line: Record<string, unknown> = {
    type: 'assistant',
    timestamp: message.at,
    cwd: message.cwd ?? '/fixture/SENTINEL_CWD_test/app',
    gitBranch: 'SENTINEL_BRANCH_test',
    message: {
      id: message.id,
      role: 'assistant',
      model: message.model ?? 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'SENTINEL_REPLY_test' }],
      usage: {
        input_tokens: message.input ?? 1,
        cache_creation_input_tokens: message.cacheWrite ?? 0,
        cache_read_input_tokens: message.cacheRead ?? 0,
        output_tokens: message.output ?? 1,
      },
    },
  };
  if (message.req !== null) line.requestId = message.req ?? `req_${message.id}`;
  return JSON.stringify(line);
}

export const userLine = (at: string): string =>
  JSON.stringify({
    type: 'user',
    timestamp: at,
    cwd: '/fixture/SENTINEL_CWD_test/app',
    message: { role: 'user', content: 'SENTINEL_PROMPT_test' },
  });

/** Writes `lines` (each ended by a newline) to `<configDir>/projects/<relative>` and returns the path. */
export function putTranscript(configDir: string, relative: string, lines: readonly string[]) {
  const path = join(configDir, 'projects', relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
  return path;
}

export const appendLines = (path: string, lines: readonly string[]): void =>
  appendFileSync(path, lines.map((line) => `${line}\n`).join(''));

// ---- what the database holds -------------------------------------------------------------------------------------------------

export interface SessionRow {
  id: number;
  providerSessionId: string;
  kind: string;
  parentSessionId: number | null;
  parentBasis: string | null;
  nativeKind: string | null;
  recordedName: string | null;
  nameSource: string | null;
  repoId: string | null;
  repoBasis: string | null;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: number;
  startedBasis: string;
  firstEventAt: number | null;
  lastEventAt: number | null;
  lastModel: string | null;
}

export function sessionRows(db: DatabaseSync): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT id, provider_session_id, kind, parent_session_id, parent_basis, native_kind, recorded_name, name_source, repo_id,
              repo_basis, cwd, git_branch, started_at, started_basis, first_event_at, last_event_at, last_model
         FROM session WHERE provider = 'claude' ORDER BY provider_session_id`,
    )
    .all() as Record<string, string | number | null>[];
  return rows.map((row) => ({
    id: row.id as number,
    providerSessionId: row.provider_session_id as string,
    kind: row.kind as string,
    parentSessionId: row.parent_session_id as number | null,
    parentBasis: row.parent_basis as string | null,
    nativeKind: row.native_kind as string | null,
    recordedName: row.recorded_name as string | null,
    nameSource: row.name_source as string | null,
    repoId: row.repo_id as string | null,
    repoBasis: row.repo_basis as string | null,
    cwd: row.cwd as string | null,
    gitBranch: row.git_branch as string | null,
    startedAt: row.started_at as number,
    startedBasis: row.started_basis as string,
    firstEventAt: row.first_event_at as number | null,
    lastEventAt: row.last_event_at as number | null,
    lastModel: row.last_model as string | null,
  }));
}

export const sessionById = (db: DatabaseSync, providerSessionId: string): SessionRow => {
  const row = sessionRows(db).find((item) => item.providerSessionId === providerSessionId);
  if (!row) throw new Error(`no session ${providerSessionId}`);
  return row;
};

export interface Totals {
  events: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
}

/** The four categories and the stored provider total, summed over the events of one session (or of all of them). */
export function totalsOf(db: DatabaseSync, providerSessionId?: string): Totals {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS events, COALESCE(SUM(ue.input_tokens), 0) AS input, COALESCE(SUM(ue.cache_write_tokens), 0) AS cache_write,
              COALESCE(SUM(ue.cache_read_tokens), 0) AS cache_read, COALESCE(SUM(ue.output_tokens), 0) AS output,
              COALESCE(SUM(ue.provider_total), 0) AS total
         FROM usage_event ue JOIN session s ON s.id = ue.session_id
        WHERE ue.provider = 'claude' AND (? IS NULL OR s.provider_session_id = ?)`,
    )
    .get(providerSessionId ?? null, providerSessionId ?? null) as Record<string, number>;
  return {
    events: row.events!,
    input: row.input!,
    cacheWrite: row.cache_write!,
    cacheRead: row.cache_read!,
    output: row.output!,
    total: row.total!,
  };
}

export const eventKeys = (db: DatabaseSync): string[] =>
  (
    db
      .prepare("SELECT dedupe_key FROM usage_event WHERE provider = 'claude' ORDER BY dedupe_key")
      .all() as { dedupe_key: string }[]
  ).map((row) => row.dedupe_key);

export interface FileRow {
  path: string;
  size: number;
  readOffset: number;
  state: string;
  unreadableLines: number;
  lastReadAt: number | null;
}

export const fileRows = (db: DatabaseSync): FileRow[] =>
  (
    db
      .prepare(
        "SELECT path, size, read_offset, state, unreadable_lines, last_read_at FROM source_file WHERE source_id = 'claude' ORDER BY path",
      )
      .all() as Record<string, string | number | null>[]
  ).map((row) => ({
    path: row.path as string,
    size: row.size as number,
    readOffset: row.read_offset as number,
    state: row.state as string,
    unreadableLines: row.unreadable_lines as number,
    lastReadAt: row.last_read_at as number | null,
  }));
