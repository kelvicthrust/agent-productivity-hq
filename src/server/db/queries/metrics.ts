import type { Db } from '../open.ts';
import type { GroupSessionRow, UsageFilter, UsageProvider } from './usage.ts';

// SQL for the review surfaces (services/metrics.ts): the series, the Overview KPIs, the records of one bucket and the model
// shares. Everything reads stored rows at request time; nothing here writes, adds a table or changes a link.
//
// Every period is `[fromMs, toMs)` in UTC epoch milliseconds. The service turns report-timezone dates into those bounds
// (`utcBounds`), so a 23-, 24- or 25-hour DST day is bucketed correctly here without this module knowing a timezone.
// Merged PRs are read through ./prs.ts (one place for the active-repo and author rules); the usage-group totals through ./usage.ts.

type Param = string | number | null;

/** `ue` is usage_event; `s` is session and is joined only when something needs it (the repo filter, or a session column). */
function eventScope(
  filter: Pick<UsageFilter, 'providers' | 'repos'>,
  joinedSession: boolean,
): { join: string; conditions: string[]; params: Param[] } {
  const conditions: string[] = [];
  const params: Param[] = [];
  if (filter.providers.length === 1) {
    conditions.push('ue.provider = ?');
    params.push(filter.providers[0]!);
  }
  const needsSession = joinedSession || filter.repos.length > 0;
  if (filter.repos.length > 0) {
    conditions.push('s.repo_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(filter.repos));
  }
  return {
    join: needsSession ? 'JOIN session s ON s.id = ue.session_id' : '',
    conditions,
    params,
  };
}

// ---- GET /api/series -------------------------------------------------------------------------------------------------

export interface BucketBounds {
  /** The bucket's position in the series (`PeriodBucket.index`). */
  index: number;
  fromMs: number;
  toMs: number;
}

/**
 * Provider token totals per bucket, from ONE event set: the buckets are joined to `usage_event` on their UTC bounds, so the same
 * events feed day, week and month buckets and their totals agree wherever the buckets cover the same days (P-11). A bucket
 * with no event has no row; the service decides whether that is a covered zero or an uncovered null.
 *
 * `CROSS JOIN ... INDEXED BY usage_event_time` pins the plan: the buckets drive, and each one is a range search on the time index.
 * Left to itself, SQLite starts from the `(provider, dedupe_key)` index whenever a provider filter is set and re-scans every
 * bucket for every event, which took seconds on a year of 366 daily buckets (bench: test/server/metrics).
 */
export function readBucketTokens(
  db: Db,
  buckets: readonly BucketBounds[],
  filter: Pick<UsageFilter, 'providers' | 'repos'>,
): Map<number, Partial<Record<UsageProvider, number>>> {
  const out = new Map<number, Partial<Record<UsageProvider, number>>>();
  if (buckets.length === 0) return out;
  const scope = eventScope(filter, false);
  const where = scope.conditions.length > 0 ? `WHERE ${scope.conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `WITH b(i, s, e) AS (
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)
       )
       SELECT b.i AS i, ue.provider AS provider, SUM(ue.provider_total) AS tokens
         FROM b CROSS JOIN usage_event ue INDEXED BY usage_event_time ON ue.occurred_at >= b.s AND ue.occurred_at < b.e
         ${scope.join}
         ${where}
        GROUP BY b.i, ue.provider`,
    )
    .all(
      JSON.stringify(buckets.map((bucket) => [bucket.index, bucket.fromMs, bucket.toMs])),
      ...scope.params,
    ) as unknown as { i: number; provider: UsageProvider; tokens: number }[];
  for (const row of rows) {
    const entry = out.get(row.i) ?? {};
    entry[row.provider] = row.tokens;
    out.set(row.i, entry);
  }
  return out;
}

// ---- GET /api/overview -----------------------------------------------------------------------------------------------

/**
 * How a session relates to the others, for the Overview KPIs (TECH › KPI definitions):
 *  - `root`: kind root;
 *  - `native` / `paseo`: kind child WITH a known parent, split by who recorded the parent (`parent_basis` / `native_kind`);
 *  - `unknown`: kind unknown (the parent was not recorded);
 *  - `orphan`: a child whose parent edge is missing. It is neither a root nor a counted child.
 */
export type Relationship = 'root' | 'native' | 'paseo' | 'unknown' | 'orphan';

export interface RangeFact {
  provider: UsageProvider;
  relationship: Relationship;
  /** Distinct sessions with at least one event in range. A resumed root counts once however many events it has. */
  sessions: number;
  /** Sum of `provider_total`: one provider, never mixed with the other. */
  tokens: number;
  events: number;
}

const RELATIONSHIP_SQL = `CASE s.kind
  WHEN 'root' THEN 'root'
  WHEN 'unknown' THEN 'unknown'
  ELSE CASE WHEN s.parent_session_id IS NULL THEN 'orphan'
            WHEN s.parent_basis = 'paseo' OR s.native_kind = 'paseo' THEN 'paseo'
            ELSE 'native' END
END`;

/**
 * One scan of the events in scope, grouped by provider and relationship. Each session has exactly one provider and one
 * relationship, so the group counts add up to the distinct-session counts, and the token sums add up to the provider totals.
 */
export function readRangeFacts(db: Db, filter: UsageFilter): RangeFact[] {
  const scope = eventScope(filter, true);
  const conditions = ['ue.occurred_at >= ?', 'ue.occurred_at < ?', ...scope.conditions];
  const rows = db
    .prepare(
      `SELECT ue.provider AS provider, ${RELATIONSHIP_SQL} AS relationship,
              COUNT(DISTINCT ue.session_id) AS sessions, SUM(ue.provider_total) AS tokens, COUNT(*) AS events
         FROM usage_event ue ${scope.join}
        WHERE ${conditions.join(' AND ')}
        GROUP BY ue.provider, relationship`,
    )
    .all(filter.fromMs, filter.toMs, ...scope.params) as unknown as {
    provider: UsageProvider;
    relationship: Relationship;
    sessions: number;
    tokens: number;
    events: number;
  }[];
  return rows.map((row) => ({
    provider: row.provider,
    relationship: row.relationship,
    sessions: row.sessions,
    tokens: row.tokens,
    events: row.events,
  }));
}

/**
 * The providers of up to `limit` sessions of one relationship that have an event in range, newest start first (the id breaks
 * ties). The Overview draws one small buddy per session from this list.
 */
export function readCrewProviders(
  db: Db,
  filter: UsageFilter,
  relationship: 'root' | 'child',
  limit: number,
): UsageProvider[] {
  const conditions = [
    relationship === 'root'
      ? "s.kind = 'root'"
      : "s.kind = 'child' AND s.parent_session_id IS NOT NULL",
    `EXISTS (SELECT 1 FROM usage_event ue WHERE ue.session_id = s.id AND ue.occurred_at >= ? AND ue.occurred_at < ?)`,
  ];
  const params: Param[] = [filter.fromMs, filter.toMs];
  if (filter.providers.length === 1) {
    conditions.push('s.provider = ?');
    params.push(filter.providers[0]!);
  }
  if (filter.repos.length > 0) {
    conditions.push('s.repo_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(filter.repos));
  }
  const rows = db
    .prepare(
      `SELECT s.provider AS provider FROM session s WHERE ${conditions.join(' AND ')}
        ORDER BY s.started_at DESC, s.id DESC LIMIT ?`,
    )
    .all(...params, limit) as unknown as { provider: UsageProvider }[];
  return rows.map((row) => row.provider);
}

// ---- links of merged PRs ---------------------------------------------------------------------------------------------

export interface PrLinkPair {
  prNodeId: string;
  sessionId: number;
  provider: UsageProvider;
  /** The class stored in pr_session_link, or null when the link exists only as an owner confirmation. */
  computed: 'evidence' | 'suggested' | null;
  /** The owner's decision for this pair, if any. The class rules are applied by the service (`effectiveLinkClass`). */
  decision: 'confirmed' | 'rejected' | 'dismissed' | null;
}

/**
 * Every (PR, session) pair that could count as a link for these PRs: the computed links, plus pairs the owner confirmed by hand
 * that have no computed link. With no link engine yet (M8) the table is empty, so every PR is unlinked.
 */
export function readPrLinkPairs(db: Db, prNodeIds: readonly string[]): PrLinkPair[] {
  if (prNodeIds.length === 0) return [];
  const rows = db
    .prepare(
      `WITH ids(id) AS (SELECT value FROM json_each(?)),
            pairs(pr_node_id, session_id, computed) AS (
              SELECT l.pr_node_id, l.session_id, l.class FROM pr_session_link l
               WHERE l.pr_node_id IN (SELECT id FROM ids)
              UNION ALL
              SELECT d.pr_node_id, d.session_id, NULL FROM owner_link_decision d
               WHERE d.decision = 'confirmed' AND d.pr_node_id IN (SELECT id FROM ids)
                 AND NOT EXISTS (SELECT 1 FROM pr_session_link l
                                  WHERE l.pr_node_id = d.pr_node_id AND l.session_id = d.session_id)
            )
       SELECT p.pr_node_id, p.session_id, s.provider, p.computed, d.decision
         FROM pairs p
         JOIN session s ON s.id = p.session_id
         LEFT JOIN owner_link_decision d ON d.pr_node_id = p.pr_node_id AND d.session_id = p.session_id`,
    )
    .all(JSON.stringify(prNodeIds)) as unknown as {
    pr_node_id: string;
    session_id: number;
    provider: UsageProvider;
    computed: 'evidence' | 'suggested' | null;
    decision: 'confirmed' | 'rejected' | 'dismissed' | null;
  }[];
  return rows.map((row) => ({
    prNodeId: row.pr_node_id,
    sessionId: row.session_id,
    provider: row.provider,
    computed: row.computed,
    decision: row.decision,
  }));
}

// ---- GET /api/records ------------------------------------------------------------------------------------------------

export type RecordSessionRow = Omit<GroupSessionRow, 'rootId'>;

interface RawRecordSession {
  id: number;
  provider: UsageProvider;
  kind: RecordSessionRow['kind'];
  parent_session_id: number | null;
  parent_basis: 'native' | 'paseo' | null;
  native_kind: string | null;
  recorded_name: string | null;
  name_source: string | null;
  provider_session_id: string;
  repo_id: string | null;
  paseo_agent_id: string | null;
  workspace_label: string | null;
  started_at: number;
  started_basis: 'source_start' | 'first_event';
  first_event_at: number | null;
  last_event_at: number | null;
  last_model: string | null;
  tokens: number;
}

/**
 * The sessions with an event in range, largest first (their in-range `provider_total`, the id breaking ties), and how many there
 * are in all. `limit` only cuts the list: the total is the count a person is told about.
 */
export function readRecordSessions(
  db: Db,
  filter: UsageFilter,
  limit: number,
): { rows: RecordSessionRow[]; total: number } {
  const scope = eventScope(filter, true);
  const conditions = ['ue.occurred_at >= ?', 'ue.occurred_at < ?', ...scope.conditions];
  const params: Param[] = [filter.fromMs, filter.toMs, ...scope.params];
  const total = db
    .prepare(
      `SELECT COUNT(DISTINCT ue.session_id) AS n FROM usage_event ue ${scope.join} WHERE ${conditions.join(' AND ')}`,
    )
    .get(...params) as { n: number };
  const rows = db
    .prepare(
      `SELECT s.id, s.provider, s.kind, s.parent_session_id, s.parent_basis, s.native_kind, s.recorded_name, s.name_source,
              s.provider_session_id, s.repo_id, s.paseo_agent_id, s.workspace_label, s.started_at, s.started_basis,
              s.first_event_at, s.last_event_at, s.last_model, SUM(ue.provider_total) AS tokens
         FROM usage_event ue ${scope.join}
        WHERE ${conditions.join(' AND ')}
        GROUP BY s.id
        ORDER BY tokens DESC, s.id
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as RawRecordSession[];
  return {
    total: total.n,
    rows: rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      kind: row.kind,
      parentId: row.parent_session_id,
      parentBasis: row.parent_basis,
      nativeKind: row.native_kind,
      recordedName: row.recorded_name,
      nameSource: row.name_source,
      providerSessionId: row.provider_session_id,
      repoId: row.repo_id,
      paseoAgentId: row.paseo_agent_id,
      workspaceLabel: row.workspace_label,
      startedAt: row.started_at,
      startedBasis: row.started_basis,
      firstEventAt: row.first_event_at,
      lastEventAt: row.last_event_at,
      lastModel: row.last_model,
      tokens: row.tokens,
    })),
  };
}

// ---- GET /api/models -------------------------------------------------------------------------------------------------

export interface ModelTotal {
  provider: UsageProvider;
  model: string;
  /** Distinct sessions with an event for this model in range (a session that used two models counts under both). */
  sessions: number;
  tokens: number;
}

/** Tokens and sessions per provider and model over the events in scope. The service turns them into shares within each provider. */
export function readModelTotals(db: Db, filter: UsageFilter): ModelTotal[] {
  const scope = eventScope(filter, false);
  const conditions = ['ue.occurred_at >= ?', 'ue.occurred_at < ?', ...scope.conditions];
  const rows = db
    .prepare(
      `SELECT ue.provider AS provider, ue.model AS model, COUNT(DISTINCT ue.session_id) AS sessions,
              SUM(ue.provider_total) AS tokens
         FROM usage_event ue ${scope.join}
        WHERE ${conditions.join(' AND ')}
        GROUP BY ue.provider, ue.model`,
    )
    .all(filter.fromMs, filter.toMs, ...scope.params) as unknown as ModelTotal[];
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    sessions: row.sessions,
    tokens: row.tokens,
  }));
}
