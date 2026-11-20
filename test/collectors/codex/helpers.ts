import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import {
  createCodexAdapter,
  type CodexAdapterOptions,
} from '../../../src/server/collectors/codex/index.ts';
import type { AdapterReport, ImportProgress } from '../../../src/server/collectors/types.ts';
import { NOW, memoryDb, memoryLogger, tempDir } from '../../server/helpers.ts';

// Shared by the Codex adapter tests. The fixture folders are the draft, invented ones under test/fixtures/codex: nothing here
// reads this machine's own Codex folder, runs `codex` or uses the network.

export { NOW, memoryDb, tempDir };

export const FIXTURES = resolve(import.meta.dirname, '../../fixtures/codex');

export const ROOT_ID = 'aaaaaaaa-1111-4111-8111-00000000000a';
export const CHILD_ID = 'bbbbbbbb-2222-4222-8222-00000000000b';
export const ARCHIVED_ID = 'cccccccc-3333-4333-8333-00000000000c';
export const ORPHAN_ID = 'dddddddd-4444-4444-8444-00000000000d';
export const CORRUPT_ID = 'eeeeeeee-5555-4555-8555-00000000000e';
export const RESET_ID = 'ffffffff-6666-4666-8666-00000000000f';

export const ROOT_FILE =
  'sessions/2026/10/12/rollout-2026-10-12T09-00-00-aaaaaaaa-1111-4111-8111-00000000000a.jsonl';
export const CHILD_FILE =
  'sessions/2026/10/12/rollout-2026-10-12T09-05-00-bbbbbbbb-2222-4222-8222-00000000000b.jsonl';

/** A temporary copy of a fixture folder (a home), so a test may change it. */
export function copyHome(name = 'home'): string {
  const home = join(tempDir(), name);
  cpSync(join(FIXTURES, name), home, { recursive: true });
  return home;
}

/** Writes a file below a home, making its folders. A `.zst` path is written compressed. */
export function put(home: string, relativePath: string, text: string): string {
  const path = join(home, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, relativePath.endsWith('.zst') ? zstdCompressSync(Buffer.from(text)) : text);
  return path;
}

export interface Run {
  report: AdapterReport;
  progress: ImportProgress[];
}

/** One attempt of an adapter on a database, with a fixed clock (override `now` to move it) and the progress it reported. */
export async function refresh(
  db: DatabaseSync,
  homes: string[] | (() => string[]),
  options: Partial<CodexAdapterOptions> = {},
  now = NOW,
): Promise<Run> {
  const adapter = createCodexAdapter({
    homes: typeof homes === 'function' ? homes : () => homes,
    ...options,
  });
  const progress: ImportProgress[] = [];
  const report = await adapter.refresh({
    db,
    now: () => now,
    logger: memoryLogger().logger,
    progress: (p) => progress.push({ ...p }),
  });
  return { report, progress };
}

export interface SessionTotals {
  events: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

/** What the database holds for one Codex session, summed over its events. Null when there is no such session. */
export function totalsOf(db: DatabaseSync, providerSessionId: string): SessionTotals | null {
  const row = db
    .prepare(
      `SELECT COUNT(e.id) AS events, COALESCE(SUM(e.input_tokens), 0) AS input, COALESCE(SUM(e.cached_input_tokens), 0) AS cached,
              COALESCE(SUM(e.output_tokens), 0) AS output, COALESCE(SUM(e.reasoning_tokens), 0) AS reasoning,
              COALESCE(SUM(e.provider_total), 0) AS total
         FROM session s LEFT JOIN usage_event e ON e.session_id = s.id
        WHERE s.provider = 'codex' AND s.provider_session_id = ?
        GROUP BY s.id`,
    )
    .get(providerSessionId) as SessionTotals | undefined;
  return row ?? null;
}

export interface SessionRow {
  id: number;
  kind: string;
  parent_session_id: number | null;
  parent_basis: string | null;
  native_kind: string | null;
  cwd: string | null;
  git_branch: string | null;
  repo_id: string | null;
  started_at: number;
  started_basis: string;
  first_event_at: number | null;
  last_event_at: number | null;
  last_model: string | null;
}

export function sessionRow(db: DatabaseSync, providerSessionId: string): SessionRow | null {
  const row = db
    .prepare("SELECT * FROM session WHERE provider = 'codex' AND provider_session_id = ?")
    .get(providerSessionId) as SessionRow | undefined;
  return row ?? null;
}

export const trackedPaths = (db: DatabaseSync): string[] =>
  (
    db.prepare("SELECT path FROM source_file WHERE source_id = 'codex' ORDER BY path").all() as {
      path: string;
    }[]
  ).map((row) => row.path);

export const fileRow = (db: DatabaseSync, path: string) =>
  db.prepare('SELECT * FROM source_file WHERE path = ?').get(path) as
    | { state: string; unreadable_lines: number; last_read_at: number; read_offset: number }
    | undefined;

// ---- invented rollout lines, for the cases a fixture folder would only get in the way of ------------------------------------

type Counts = [input: number, cached: number, output: number, reasoning: number];

/** A `token_count` line holding a cumulative snapshot (`total_tokens` is input + output, as Codex writes it), and optionally the last request's own usage. */
export function snapshotLine(at: string, total: Counts, last?: Counts): string {
  const usage = ([input, cached, output, reasoning]: Counts) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  });
  return JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: usage(total),
        ...(last ? { last_token_usage: usage(last) } : {}),
      },
      rate_limits: null,
    },
  });
}

/** A `token_usage_record` line: one request's own usage with its response id (a compaction request has one). */
export function recordLine(
  at: string,
  responseId: string,
  [input, cached, output, reasoning]: Counts,
): string {
  return JSON.stringify({
    timestamp: at,
    type: 'token_usage_record',
    payload: {
      response_id: responseId,
      usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
    },
  });
}

/** A `compacted` line naming the response a compaction request had. */
export const compactedLine = (at: string, responseId: string): string =>
  JSON.stringify({
    timestamp: at,
    type: 'compacted',
    payload: { compaction_response_id: responseId },
  });

export function metaLine(
  id: string,
  at: string,
  over: { source?: unknown; cwd?: string; timestamp?: string | null; forkedFrom?: string } = {},
): string {
  const payload: Record<string, unknown> = {
    id,
    cwd: over.cwd ?? '/nowhere/invented',
    source: over.source ?? 'cli',
    ...(over.forkedFrom ? { forked_from_id: over.forkedFrom } : {}),
  };
  if (over.timestamp !== null) payload['timestamp'] = over.timestamp ?? at;
  return JSON.stringify({ timestamp: at, type: 'session_meta', payload });
}

export const turnLine = (at: string, model: string): string =>
  JSON.stringify({ timestamp: at, type: 'turn_context', payload: { model } });

export const spawnedFrom = (parentId?: string): unknown => ({
  subagent: { thread_spawn: { ...(parentId ? { parent_thread_id: parentId } : {}), depth: 1 } },
});

export const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
