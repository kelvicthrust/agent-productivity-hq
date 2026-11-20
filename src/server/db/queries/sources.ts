import type { LinkRebuildResult } from '../../../shared/contracts/link-health.ts';
import { inTransaction, type Db } from '../open.ts';

// The runner's store (TECH › Refresh run state machine, Runner rule). The runner decides WHEN: which source runs, in what
// order, under which lock. This module decides HOW the database changes, so the two rules that must never drift live in one
// place and are tested once:
//   - a finished source attempt writes `last_attempt_*` and `consecutive_failures` in the SAME transaction;
//   - `consecutive_failures` is 0 after a succeeded or partial attempt and one more after a failed one;
//   - a skipped source (not found, not connected, no adapter) changes nothing: there is no function that records one.
// All SQL stays inside src/server/db (ESLint fences `node:sqlite`).

export type RunState = 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
export type SourceRunState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped';
export type AttemptResult = 'succeeded' | 'partial' | 'failed';

/** One source's entry in a run (the `sources` map of the RefreshRun contract). */
export interface RunSourceEntry {
  state: SourceRunState;
  imported?: number;
  duplicatesSkipped?: number;
  unreadable?: number;
  message?: string | null;
}
export type RunSources = Record<string, RunSourceEntry>;

export interface RunRow {
  id: number;
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  state: RunState;
  sources: RunSources;
  linkRebuild: LinkRebuildResult | null;
}

interface RawRun {
  id: number;
  trigger: string;
  started_at: number;
  finished_at: number | null;
  state: RunState;
  per_source_json: string;
  link_rebuild_result: LinkRebuildResult | null;
}

function parseSources(json: string): RunSources {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as RunSources) : {};
  } catch {
    return {};
  }
}

const toRun = (row: RawRun): RunRow => ({
  id: row.id,
  trigger: row.trigger,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  state: row.state,
  sources: parseSources(row.per_source_json),
  linkRebuild: row.link_rebuild_result,
});

/** Starts a run in state `running`. The caller has already checked there is none (the runner's lock). */
export function createRun(
  db: Db,
  run: { trigger: string; startedAt: number; sources: RunSources; rebuildLinks?: boolean },
): number {
  const result = db
    .prepare(
      "INSERT INTO refresh_run (trigger, started_at, finished_at, state, per_source_json, link_rebuild_result) VALUES (?, ?, NULL, 'running', ?, ?)",
    )
    .run(
      run.trigger,
      run.startedAt,
      JSON.stringify(run.sources),
      run.rebuildLinks ? 'pending' : null,
    );
  return Number(result.lastInsertRowid);
}

export function getRun(db: Db, id: number): RunRow | null {
  const row = db.prepare('SELECT * FROM refresh_run WHERE id = ?').get(id) as RawRun | undefined;
  return row ? toRun(row) : null;
}

/** The most recently started run, or null when there has never been one. */
export function getLatestRun(db: Db): RunRow | null {
  const row = db.prepare('SELECT * FROM refresh_run ORDER BY id DESC LIMIT 1').get() as
    RawRun | undefined;
  return row ? toRun(row) : null;
}

/** The run in state `running`, if any (at most one: the runner holds the lock). */
export function getRunningRun(db: Db): RunRow | null {
  const row = db
    .prepare("SELECT * FROM refresh_run WHERE state = 'running' ORDER BY id DESC LIMIT 1")
    .get() as RawRun | undefined;
  return row ? toRun(row) : null;
}

/** Progress write while a run is going: the per-source map as it stands. */
export function updateRunSources(db: Db, id: number, sources: RunSources): void {
  db.prepare("UPDATE refresh_run SET per_source_json = ? WHERE id = ? AND state = 'running'").run(
    JSON.stringify(sources),
    id,
  );
}

export function finishRun(
  db: Db,
  id: number,
  result: { state: Exclude<RunState, 'running'>; finishedAt: number; sources: RunSources },
): void {
  db.prepare(
    "UPDATE refresh_run SET state = ?, finished_at = ?, per_source_json = ? WHERE id = ? AND state = 'running'",
  ).run(result.state, result.finishedAt, JSON.stringify(result.sources), id);
}

export interface SourceStateRow {
  sourceId: string;
  status: string;
  location: string | null;
  oldestEventAt: number | null;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastAttemptResult: AttemptResult | null;
  consecutiveFailures: number;
  errorCode: string | null;
  errorDetail: string | null;
  unreadableCount: number;
  unsupportedCount: number;
  /** Free-form per-source facts the adapter stores (for example `staleAfter`, a note). */
  extra: Record<string, unknown>;
}

interface RawSource {
  source_id: string;
  status: string;
  location: string | null;
  oldest_event_at: number | null;
  last_success_at: number | null;
  last_attempt_at: number | null;
  last_attempt_result: AttemptResult | null;
  consecutive_failures: number;
  error_code: string | null;
  error_detail: string | null;
  unreadable_count: number;
  unsupported_count: number;
  extra_json: string | null;
}

function parseExtra(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const toSource = (row: RawSource): SourceStateRow => ({
  sourceId: row.source_id,
  status: row.status,
  location: row.location,
  oldestEventAt: row.oldest_event_at,
  lastSuccessAt: row.last_success_at,
  lastAttemptAt: row.last_attempt_at,
  lastAttemptResult: row.last_attempt_result,
  consecutiveFailures: row.consecutive_failures,
  errorCode: row.error_code,
  errorDetail: row.error_detail,
  unreadableCount: row.unreadable_count,
  unsupportedCount: row.unsupported_count,
  extra: parseExtra(row.extra_json),
});

export function listSourceStates(db: Db): SourceStateRow[] {
  const rows = db.prepare('SELECT * FROM source_state ORDER BY source_id').all() as unknown;
  return (rows as RawSource[]).map(toSource);
}

export function getSourceState(db: Db, sourceId: string): SourceStateRow | null {
  const row = db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId) as
    RawSource | undefined;
  return row ? toSource(row) : null;
}

export interface AttemptOutcome {
  sourceId: string;
  result: AttemptResult;
  /** When the attempt finished (epoch ms). */
  at: number;
  /** The status the source has after this attempt: ok, partial, failed, notfound, denied, notrunning or needspassword. */
  status: string;
  location?: string | null;
  oldestEventAt?: number | null;
  unreadable?: number;
  unsupported?: number;
  errorCode?: string | null;
  errorDetail?: string | null;
  adapterVersion?: string | null;
}

/**
 * Records a finished attempt for one source, in one transaction: `last_attempt_at` and `last_attempt_result` together
 * with `consecutive_failures` (0 for succeeded or partial, otherwise one more than before). A succeeded or partial attempt
 * also moves `last_success_at`; a failed one leaves it, so "last success" always names the last time data came in.
 * Returns the new `consecutive_failures`. The row is created if the source has none yet.
 */
export function recordAttempt(db: Db, outcome: AttemptOutcome): number {
  return inTransaction(db, () => {
    const before = getSourceState(db, outcome.sourceId);
    const failures = outcome.result === 'failed' ? (before?.consecutiveFailures ?? 0) + 1 : 0;
    const success = outcome.result === 'failed' ? (before?.lastSuccessAt ?? null) : outcome.at;
    db.prepare(
      `INSERT INTO source_state (source_id, status, location, oldest_event_at, last_success_at, last_attempt_at, last_attempt_result,
         consecutive_failures, error_code, error_detail, unreadable_count, unsupported_count, adapter_version, extra_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id) DO UPDATE SET
         status = excluded.status,
         location = COALESCE(excluded.location, source_state.location),
         oldest_event_at = COALESCE(excluded.oldest_event_at, source_state.oldest_event_at),
         last_success_at = excluded.last_success_at,
         last_attempt_at = excluded.last_attempt_at,
         last_attempt_result = excluded.last_attempt_result,
         consecutive_failures = excluded.consecutive_failures,
         error_code = excluded.error_code,
         error_detail = excluded.error_detail,
         unreadable_count = excluded.unreadable_count,
         unsupported_count = excluded.unsupported_count,
         adapter_version = COALESCE(excluded.adapter_version, source_state.adapter_version)`,
    ).run(
      outcome.sourceId,
      outcome.status,
      outcome.location ?? null,
      outcome.oldestEventAt ?? null,
      success,
      outcome.at,
      outcome.result,
      failures,
      outcome.result === 'failed' ? (outcome.errorCode ?? null) : null,
      outcome.result === 'failed' ? (outcome.errorDetail ?? null) : null,
      outcome.unreadable ?? 0,
      outcome.unsupported ?? 0,
      outcome.adapterVersion ?? null,
      '{}',
    );
    return failures;
  });
}

export interface DiscoveryOutcome {
  sourceId: string;
  /** What looking found: ok, partial, notfound or denied. A discovery never says `failed`: that word is for an attempt. */
  status: string;
  location?: string | null;
}

/**
 * Records what discovery found for a source, without recording an attempt (TECH › Discovery). A source that is not on this
 * machine, or that this app is not allowed to read, still needs a row so Sources can say "Not found" or "Access denied"; but
 * nothing was attempted, so `last_attempt_*`, `last_success_at` and `consecutive_failures` are left exactly as they were
 * (a skipped source never counts as a failure). The row is created with no attempt if the source has none yet.
 */
export function recordDiscovery(db: Db, outcome: DiscoveryOutcome): void {
  db.prepare(
    `INSERT INTO source_state (source_id, status, location) VALUES (?, ?, ?)
     ON CONFLICT (source_id) DO UPDATE SET
       status = excluded.status,
       location = COALESCE(excluded.location, source_state.location)`,
  ).run(outcome.sourceId, outcome.status, outcome.location ?? null);
}
