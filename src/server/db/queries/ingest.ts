import type { StatementSync } from 'node:sqlite';
import { prefersClaudeUsage } from '../../../shared/domain/claude-usage-rank.ts';
import { inTransaction, type Db } from '../open.ts';
import type { UsageProvider } from './usage.ts';

// What the Codex and Claude Code adapters write while they import (TECH › Persistence, Normalization). All SQL stays inside
// src/server/db: the adapters call these functions and never see a statement.
//
// Two kinds of rows:
//   usage_event   one per (provider, dedupe_key). `upsertUsageEvent` says whether the event was new, replaced or already known,
//                 so an adapter can report "imported" and "duplicatesSkipped" without a second query.
//   source_file   one per file an adapter has looked at: size, mtime, a hash of the first 4 KiB, how far it has been read and
//                 how many of its lines could not be read. A refresh that finds nothing changed reads no file at all.
// Sessions go through `upsertSession` (queries/usage.ts); this module adds nothing to that.

export interface UsageEventInput {
  provider: UsageProvider;
  dedupeKey: string;
  sessionId: number;
  /** Epoch ms, UTC. */
  occurredAt: number;
  model: string;
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  /** The provider's own total (Codex: input + output; Claude: the four categories added). Never recomputed by a reader. */
  providerTotal: number;
  sourceFileId?: number | null;
  /**
   * What `survivor` mode needs to pick between two copies of one event (Claude Code: a resumed or copied transcript holds the
   * same message twice). `sidechain` is whether this copy is a sidechain's, `path` the file it was read from.
   */
  copy?: { sidechain: boolean; hasSpeed: boolean; path: string };
}

/**
 * What happened to an event.
 *   inserted  no event had this dedupe key
 *   replaced  one had, with different figures, and `replace` mode overwrote it (Claude: the last line for a key wins), or this
 *             copy is earlier than the one another session holds and takes the event over
 *   skipped   one had; nothing changed (Codex: the first one stays; Claude: the same figures again, or a later copy of a
 *             message another session already owns)
 */
export type EventWrite = 'inserted' | 'replaced' | 'skipped';

/**
 * How an adapter treats a key it has already stored:
 *   keep      leave the stored event alone (Codex: the first copy stays)
 *   replace   the earliest copy owns the event, and a later line of the same copy takes over the figures
 *   survivor  ccusage's rule for one message held twice: a main-thread copy beats a sidechain one, then the larger total, then the
 *             copy whose file sorts first; the same file again never replaces (the first line stays). Needs `copy` on the event.
 */
export type EventMode = 'keep' | 'replace' | 'survivor' | 'replace-owned';

interface EventRow {
  id: number;
  source_file_id: number | null;
  session_id: number;
  occurred_at: number;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  provider_total: number;
  claude_sidechain: number | null;
  claude_has_speed: number | null;
}

export interface EventWriter {
  write(event: UsageEventInput, mode: EventMode): EventWrite;
}

const FIGURES = [
  'session_id',
  'occurred_at',
  'model',
  'input_tokens',
  'cached_input_tokens',
  'cache_write_tokens',
  'cache_read_tokens',
  'output_tokens',
  'reasoning_tokens',
  'provider_total',
] as const;

/**
 * A writer with its statements prepared once, for an import that writes thousands of events. It is cheap to make and holds no
 * state beyond the statements, so make one per file or per attempt. Call it inside the transaction that commits the file.
 */
export function createEventWriter(db: Db): EventWriter {
  const find: StatementSync = db.prepare(
    `SELECT id, source_file_id, claude_sidechain, claude_has_speed, ${FIGURES.join(', ')}
       FROM usage_event WHERE provider = ? AND dedupe_key = ?`,
  );
  const pathOf: StatementSync = db.prepare('SELECT path FROM source_file WHERE id = ?');
  const insert: StatementSync = db.prepare(
    `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, input_tokens, cached_input_tokens,
       cache_write_tokens, cache_read_tokens, output_tokens, reasoning_tokens, provider_total, source_file_id,
       claude_sidechain, claude_has_speed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update: StatementSync = db.prepare(
    `UPDATE usage_event SET session_id = ?, occurred_at = ?, model = ?, input_tokens = ?, cached_input_tokens = ?,
       cache_write_tokens = ?, cache_read_tokens = ?, output_tokens = ?, reasoning_tokens = ?, provider_total = ?,
       source_file_id = COALESCE(?, source_file_id),
       claude_sidechain = COALESCE(?, claude_sidechain),
       claude_has_speed = COALESCE(?, claude_has_speed)
     WHERE id = ?`,
  );
  return {
    write(event, mode) {
      const values = [
        event.sessionId,
        event.occurredAt,
        event.model,
        event.inputTokens,
        event.cachedInputTokens ?? 0,
        event.cacheWriteTokens ?? 0,
        event.cacheReadTokens ?? 0,
        event.outputTokens,
        event.reasoningTokens ?? 0,
        event.providerTotal,
      ] as const;
      const existing = find.get(event.provider, event.dedupeKey) as EventRow | undefined;
      const sidechain = event.copy === undefined ? null : Number(event.copy.sidechain);
      const speed = event.copy === undefined ? null : Number(event.copy.hasSpeed);
      if (!existing) {
        insert.run(
          event.provider,
          event.dedupeKey,
          ...values,
          event.sourceFileId ?? null,
          sidechain,
          speed,
        );
        return 'inserted';
      }
      if (mode === 'keep') return 'skipped';
      if (mode === 'survivor') {
        if (event.copy === undefined) throw new Error('A Claude usage copy must have a rank.');
        if (existing.claude_sidechain === null || existing.claude_has_speed === null) {
          stageLegacyClaudeCandidate(db, existing, { ...event, copy: event.copy });
          return 'skipped';
        }
        const stored =
          existing.source_file_id === null
            ? undefined
            : (pathOf.get(existing.source_file_id) as { path: string } | undefined);
        if (
          !prefersClaudeUsage(
            { ...event.copy, total: event.providerTotal },
            {
              sidechain: Boolean(existing.claude_sidechain),
              total: existing.provider_total,
              hasSpeed: Boolean(existing.claude_has_speed),
              ...(stored ? { path: stored.path } : {}),
            },
          )
        )
          return 'skipped';
        update.run(...values, event.sourceFileId ?? null, sidechain, speed, existing.id);
        return 'replaced';
      }
      if (mode === 'replace-owned' && existing.source_file_id !== event.sourceFileId)
        return 'skipped';
      // The same message held by another session (a resumed session replays its history into a new file): ONE copy counts, and the
      // earliest copy owns it, as in ccusage. A later or equal copy changes nothing, so per-session totals do not depend on which
      // file was read last; an earlier copy takes the event over, with its own figures. Totals across sessions never change.
      if (
        mode === 'replace' &&
        existing.session_id !== event.sessionId &&
        event.occurredAt >= existing.occurred_at
      ) {
        return 'skipped';
      }
      const same = FIGURES.every((name, index) => existing[name] === values[index]);
      if (same) return 'skipped';
      update.run(...values, event.sourceFileId ?? null, sidechain, speed, existing.id);
      return 'replaced';
    },
  };
}

type ClaudeCandidate = UsageEventInput & { copy: NonNullable<UsageEventInput['copy']> };

function stageLegacyClaudeCandidate(db: Db, row: EventRow, event: ClaudeCandidate): void {
  const previous = db
    .prepare(
      'SELECT owner_recovered, candidate_json FROM claude_legacy_candidate WHERE usage_event_id = ?',
    )
    .get(row.id) as { owner_recovered: number; candidate_json: string } | undefined;
  const best = previous ? (JSON.parse(previous.candidate_json) as ClaudeCandidate) : null;
  const candidate =
    best === null ||
    prefersClaudeUsage(
      { ...event.copy, total: event.providerTotal },
      { ...best.copy, total: best.providerTotal },
    )
      ? event
      : best;
  const recovered = row.source_file_id !== null && row.source_file_id === event.sourceFileId;
  db.prepare(
    `INSERT INTO claude_legacy_candidate (usage_event_id, candidate_session_id, owner_recovered, candidate_json)
     VALUES (?, ?, ?, ?) ON CONFLICT (usage_event_id) DO UPDATE SET
       candidate_session_id = excluded.candidate_session_id,
       owner_recovered = excluded.owner_recovered, candidate_json = excluded.candidate_json`,
  ).run(
    row.id,
    candidate.sessionId,
    Number(recovered || Boolean(previous?.owner_recovered)),
    JSON.stringify(candidate),
  );
}

/** Resolve staged ranks after the source has scanned the available transcripts. */
export function finishClaudeReconciliation(db: Db): void {
  inTransaction(db, () => {
    db.exec(`
      UPDATE usage_event AS e
        SET (session_id, occurred_at, model, input_tokens, cache_write_tokens, cache_read_tokens,
             output_tokens, provider_total, source_file_id, claude_sidechain, claude_has_speed) = (
          SELECT json_extract(candidate_json, '$.sessionId'),
                 json_extract(candidate_json, '$.occurredAt'),
                 json_extract(candidate_json, '$.model'),
                 json_extract(candidate_json, '$.inputTokens'),
                 json_extract(candidate_json, '$.cacheWriteTokens'),
                 json_extract(candidate_json, '$.cacheReadTokens'),
                 json_extract(candidate_json, '$.outputTokens'),
                 json_extract(candidate_json, '$.providerTotal'),
                 json_extract(candidate_json, '$.sourceFileId'),
                 json_extract(candidate_json, '$.copy.sidechain'),
                 json_extract(candidate_json, '$.copy.hasSpeed')
            FROM claude_legacy_candidate WHERE usage_event_id = e.id)
        WHERE e.id IN (SELECT usage_event_id FROM claude_legacy_candidate WHERE owner_recovered = 1);
      DELETE FROM claude_legacy_candidate WHERE owner_recovered = 1;
    `);
  });
}

/** One-off convenience for tests and single writes. An import uses `createEventWriter`. */
export function upsertUsageEvent(db: Db, event: UsageEventInput, mode: EventMode): EventWrite {
  return createEventWriter(db).write(event, mode);
}

/** The id of a session already stored for this provider, or null. An adapter asks before `upsertSession` to count new sessions. */
export function findSessionId(
  db: Db,
  provider: UsageProvider,
  providerSessionId: string,
): number | null {
  const row = db
    .prepare('SELECT id FROM session WHERE provider = ? AND provider_session_id = ?')
    .get(provider, providerSessionId) as { id: number } | undefined;
  return row?.id ?? null;
}

/** The oldest imported event of a provider (epoch ms), or null when it has none. Coverage starts here (TECH › Coverage). */
export function oldestEventAt(db: Db, provider: UsageProvider): number | null {
  const row = db
    .prepare('SELECT MIN(occurred_at) AS oldest FROM usage_event WHERE provider = ?')
    .get(provider) as { oldest: number | null };
  return row.oldest;
}

/**
 * Keeps only the events of one file that are in `keep`, and removes the rest. A Codex rollout is always read whole, so the events
 * it holds now are the complete set: whatever it brought in before and no longer holds is gone (an older counting rule's events
 * among them, which is how history imported under another rule is corrected for every file that is still there; events of a log
 * that has since been deleted stay as they were). The ones in `keep` are left alone, so writing them again is a skip, not a change.
 */
export function retainFileEvents(db: Db, fileId: number, keep: ReadonlySet<string>): number {
  const rows = db
    .prepare('SELECT id, dedupe_key FROM usage_event WHERE source_file_id = ?')
    .all(fileId) as unknown as { id: number; dedupe_key: string }[];
  const remove = db.prepare('DELETE FROM usage_event WHERE id = ?');
  let removed = 0;
  for (const row of rows) {
    if (keep.has(row.dedupe_key)) continue;
    remove.run(row.id);
    removed += 1;
  }
  return removed;
}

/** Carry ownership across the active, archived and compressed forms of the same verified rollout. */
export function moveCodexFileEvents(
  db: Db,
  from: number,
  to: number,
  providerSessionId: string,
): void {
  db.prepare(
    `UPDATE usage_event SET source_file_id = ?
      WHERE source_file_id = ? AND provider = 'codex'
        AND session_id = (SELECT id FROM session WHERE provider = 'codex' AND provider_session_id = ?)`,
  ).run(to, from, providerSessionId);
}

export function codexFileOwnsSession(db: Db, fileId: number, providerSessionId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM usage_event e JOIN session s ON s.id = e.session_id
      WHERE e.source_file_id = ? AND s.provider = 'codex' AND s.provider_session_id = ? LIMIT 1`,
      )
      .get(fileId, providerSessionId) !== undefined
  );
}

/** The adapter version a source last finished an attempt with, or null when it never has. */
export function storedAdapterVersion(db: Db, sourceId: string): string | null {
  const row = db
    .prepare('SELECT adapter_version AS version FROM source_state WHERE source_id = ?')
    .get(sourceId) as { version: string | null } | undefined;
  return row?.version ?? null;
}

// ---- tracked files ------------------------------------------------------------------------------------------------------

export type SourceFileState = 'ok' | 'partial' | 'unreadable' | 'unsupported' | 'skipped';

export interface SourceFileRow {
  id: number;
  sourceId: string;
  path: string;
  size: number;
  mtimeMs: number;
  /** sha256 of the first 4 KiB, hex. A different one means the file was replaced, not appended to. */
  headHash: string;
  /** Bytes already read: the end of the last complete line that was committed. */
  readOffset: number;
  state: SourceFileState;
  unreadableLines: number;
  lastReadAt: number | null;
  normalizationVersion: string | null;
  codexParentId: string | null;
  codexParentVersion: string | null;
}

interface RawFile {
  id: number;
  source_id: string;
  path: string;
  size: number;
  mtime_ms: number;
  head_hash: string;
  read_offset: number;
  state: SourceFileState;
  unreadable_lines: number;
  last_read_at: number | null;
  normalization_version: string | null;
  codex_parent_id: string | null;
  codex_parent_version: string | null;
}

const toFile = (row: RawFile): SourceFileRow => ({
  id: row.id,
  sourceId: row.source_id,
  path: row.path,
  size: row.size,
  mtimeMs: row.mtime_ms,
  headHash: row.head_hash,
  readOffset: row.read_offset,
  state: row.state,
  unreadableLines: row.unreadable_lines,
  lastReadAt: row.last_read_at,
  normalizationVersion: row.normalization_version,
  codexParentId: row.codex_parent_id,
  codexParentVersion: row.codex_parent_version,
});

/** Must be committed with this file's usage and offset. */
export function recordNormalization(
  db: Db,
  fileId: number,
  version: string,
  parent?: { id: string; version: string | null },
): void {
  db.prepare(
    'UPDATE source_file SET normalization_version = ?, codex_parent_id = ?, codex_parent_version = ? WHERE id = ?',
  ).run(version, parent?.id ?? null, parent?.version ?? null, fileId);
}

export function rememberCodexParent(db: Db, fileId: number, parentId: string): void {
  db.prepare('UPDATE source_file SET codex_parent_id = ? WHERE id = ?').run(parentId, fileId);
}

export function unreconciledUsage(db: Db, provider: UsageProvider, version: string): number {
  const row = (
    provider === 'claude'
      ? db
          .prepare(
            `SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'claude'
                   AND (claude_sidechain IS NULL OR claude_has_speed IS NULL)`,
          )
          .get()
      : db
          .prepare(
            `SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'codex'
                   AND source_file_id IN (SELECT id FROM source_file
                     WHERE source_id = 'codex' AND normalization_version IS NOT ?)`,
          )
          .get(version)
  ) as { n: number };
  return row.n;
}

/** Replacement can move the first or last owned event inward. The session's start is independent. */
export function refreshCodexSessionBounds(db: Db, sessionId: number): void {
  db.prepare(
    `UPDATE session SET
       (first_event_at, last_event_at) = (SELECT MIN(occurred_at), MAX(occurred_at)
                                          FROM usage_event WHERE session_id = ?),
       last_model = (SELECT model FROM usage_event WHERE session_id = ? AND model <> 'unknown'
                      ORDER BY occurred_at DESC, id DESC LIMIT 1)
      WHERE id = ?`,
  ).run(sessionId, sessionId, sessionId);
}

export function getSourceFile(db: Db, path: string): SourceFileRow | null {
  const row = db.prepare('SELECT * FROM source_file WHERE path = ?').get(path) as
    RawFile | undefined;
  return row ? toFile(row) : null;
}

/** Every file a source has looked at, by path. One query per refresh, so the adapter can tell new from known from gone. */
export function listSourceFiles(db: Db, sourceId: string): SourceFileRow[] {
  const rows = db
    .prepare('SELECT * FROM source_file WHERE source_id = ? ORDER BY path')
    .all(sourceId) as unknown as RawFile[];
  return rows.map(toFile);
}

export interface SourceFileWrite {
  sourceId: string;
  path: string;
  size: number;
  mtimeMs: number;
  headHash: string;
  readOffset: number;
  state: SourceFileState;
  /** The unreadable lines this file has NOW, not the ones found in this read: an incremental read adds to the stored count. */
  unreadableLines: number;
  lastReadAt: number;
}

/** Creates or updates the tracking row for a file and returns its id (usage events point at it). */
export function putSourceFile(db: Db, file: SourceFileWrite): number {
  const row = db
    .prepare(
      `INSERT INTO source_file (source_id, path, size, mtime_ms, head_hash, read_offset, state, unreadable_lines, last_read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (path) DO UPDATE SET
         source_id = excluded.source_id, size = excluded.size, mtime_ms = excluded.mtime_ms, head_hash = excluded.head_hash,
         read_offset = excluded.read_offset, state = excluded.state, unreadable_lines = excluded.unreadable_lines,
         last_read_at = excluded.last_read_at
       RETURNING id`,
    )
    .get(
      file.sourceId,
      file.path,
      file.size,
      file.mtimeMs,
      file.headHash,
      file.readOffset,
      file.state,
      file.unreadableLines,
      file.lastReadAt,
    ) as { id: number };
  return row.id;
}

/**
 * What a source's tracked files add up to: how many lines and files could not be read. These are the figures Sources shows as
 * "Partial · N unreadable", and they come from the stored rows, so a refresh that reads nothing still reports them.
 */
export function unreadableTotals(
  db: Db,
  sourceId: string,
): { lines: number; files: number; unsupported: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(unreadable_lines), 0) AS lines,
              COALESCE(SUM(CASE WHEN state = 'unreadable' THEN 1 ELSE 0 END), 0) AS files,
              COALESCE(SUM(CASE WHEN state = 'unsupported' THEN 1 ELSE 0 END), 0) AS unsupported
       FROM source_file WHERE source_id = ?`,
    )
    .get(sourceId) as { lines: number; files: number; unsupported: number };
  return row;
}

// ---- figures per session, for comparing with another tool's totals ----------------------------------------------------------

export interface SessionFigures {
  providerSessionId: string;
  kind: 'root' | 'child' | 'unknown';
  /** The parent's provider session id when a parent is stored. */
  parentProviderSessionId: string | null;
  startedAt: number;
  startedBasis: 'source_start' | 'first_event';
  firstEventAt: number | null;
  events: number;
  /** Stored categories, added per session and never converted: Codex input includes cached; Claude input is uncached only. */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  /** The provider's own total (Codex: input + output; Claude: the four categories). */
  total: number;
}

/**
 * Every stored session of a provider with what its events add up to. The reconcile tool (scripts/reconcile-usage.ts) compares
 * these with ccusage's session report; nothing else reads it. Sessions with no events are listed with zeros.
 */
export function readSessionFigures(db: Db, provider: UsageProvider): SessionFigures[] {
  const rows = db
    .prepare(
      `SELECT s.provider_session_id AS id, s.kind AS kind, p.provider_session_id AS parent, s.started_at AS started_at,
              s.started_basis AS basis, s.first_event_at AS first_event_at, COUNT(e.id) AS events,
              COALESCE(SUM(e.input_tokens), 0) AS input, COALESCE(SUM(e.cached_input_tokens), 0) AS cached,
              COALESCE(SUM(e.cache_write_tokens), 0) AS cache_write, COALESCE(SUM(e.cache_read_tokens), 0) AS cache_read,
              COALESCE(SUM(e.output_tokens), 0) AS output, COALESCE(SUM(e.reasoning_tokens), 0) AS reasoning,
              COALESCE(SUM(e.provider_total), 0) AS total
       FROM session s
       LEFT JOIN session p ON p.id = s.parent_session_id
       LEFT JOIN usage_event e ON e.session_id = s.id
       WHERE s.provider = ?
       GROUP BY s.id
       ORDER BY s.provider_session_id`,
    )
    .all(provider) as unknown as {
    id: string;
    kind: SessionFigures['kind'];
    parent: string | null;
    started_at: number;
    basis: SessionFigures['startedBasis'];
    first_event_at: number | null;
    events: number;
    input: number;
    cached: number;
    cache_write: number;
    cache_read: number;
    output: number;
    reasoning: number;
    total: number;
  }[];
  return rows.map((row) => ({
    providerSessionId: row.id,
    kind: row.kind,
    parentProviderSessionId: row.parent,
    startedAt: row.started_at,
    startedBasis: row.basis,
    firstEventAt: row.first_event_at,
    events: row.events,
    input: row.input,
    cachedInput: row.cached,
    cacheWrite: row.cache_write,
    cacheRead: row.cache_read,
    output: row.output,
    reasoning: row.reasoning,
    total: row.total,
  }));
}
