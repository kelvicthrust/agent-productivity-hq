import type { Db } from '../open.ts';
import { resolveSessionRepoId } from './repos.ts';

// SQL for the Usage routes (services/usage.ts) and the one write the collectors share: the session upsert, whose
// `started_at` rules live here so no caller can bypass them. Everything is read from stored rows at request time; no
// table is added and nothing here changes a link or an owner decision.

export type UsageProvider = 'codex' | 'claude';
export type SessionKind = 'root' | 'child' | 'unknown';

/** The group keys that are not a repo id. */
export const UNTRACKED_GROUP = '__untracked';
export const UNKNOWN_GROUP = '__unknown';

/** What a Usage request selects: events in `[fromMs, toMs)` (UTC epoch ms), for these providers and, when set, these repos. */
export interface UsageFilter {
  fromMs: number;
  toMs: number;
  providers: readonly UsageProvider[];
  /** Canonical repo ids. Empty means no repo filter. */
  repos: readonly string[];
}

/** A tree group: a tracked repo, the repos that are recorded but not tracked, or sessions with no repo. */
export type GroupSelector =
  { kind: 'repo'; repoId: string } | { kind: 'untracked' } | { kind: 'unknown' };

type Param = string | number | null;

const ACTIVE_REPOS = "SELECT id FROM repo WHERE tracking_state = 'active'";

/** The WHERE conditions shared by every read. `ue` is usage_event and `s` is session. */
function scopeClause(filter: UsageFilter): { conditions: string[]; params: Param[] } {
  const conditions = ['ue.occurred_at >= ?', 'ue.occurred_at < ?'];
  const params: Param[] = [filter.fromMs, filter.toMs];
  if (filter.providers.length === 1) {
    conditions.push('s.provider = ?');
    params.push(filter.providers[0]!);
  }
  if (filter.repos.length > 0) {
    conditions.push('s.repo_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(filter.repos));
  }
  return { conditions, params };
}

function groupClause(group: GroupSelector): { condition: string; params: Param[] } {
  switch (group.kind) {
    case 'repo':
      return { condition: 's.repo_id = ?', params: [group.repoId] };
    case 'unknown':
      return { condition: 's.repo_id IS NULL', params: [] };
    case 'untracked':
      return {
        condition: `s.repo_id IS NOT NULL AND s.repo_id NOT IN (${ACTIVE_REPOS})`,
        params: [],
      };
  }
}

// ---- sources and repos -----------------------------------------------------------------------------------------------

export interface SourceStateRow {
  sourceId: string;
  status: string;
  oldestEventAt: number | null;
  lastSuccessAt: number | null;
  lastAttemptResult: string | null;
  unreadableCount: number;
  unsupportedCount: number;
  /** `source_state.extra_json`, parsed. An unreadable value is an empty object, never an error. */
  extra: Record<string, unknown>;
}

/** The local sources a Usage page reports on: Codex and Claude (they carry usage) and Paseo (it carries names and parents). */
export function readSourceStates(db: Db): SourceStateRow[] {
  const rows = db
    .prepare(
      `SELECT source_id, status, oldest_event_at, last_success_at, last_attempt_result, unreadable_count, unsupported_count, extra_json
         FROM source_state WHERE source_id IN ('codex', 'claude', 'paseo')`,
    )
    .all() as unknown as {
    source_id: string;
    status: string;
    oldest_event_at: number | null;
    last_success_at: number | null;
    last_attempt_result: string | null;
    unreadable_count: number;
    unsupported_count: number;
    extra_json: string | null;
  }[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    status: row.status,
    oldestEventAt: row.oldest_event_at,
    lastSuccessAt: row.last_success_at,
    lastAttemptResult: row.last_attempt_result,
    unreadableCount: row.unreadable_count,
    unsupportedCount: row.unsupported_count,
    extra: parseObject(row.extra_json),
  }));
}

function parseObject(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface RepoStateRow {
  id: string;
  displayName: string;
  trackingState: 'active' | 'stopped';
  accessState: 'ok' | 'inaccessible' | 'unknown';
  backfillComplete: boolean;
}

/** Every repo this machine knows, ordered by display name then id. */
export function readRepoStates(db: Db): RepoStateRow[] {
  const rows = db
    .prepare(
      'SELECT id, display_name, tracking_state, access_state, backfill_complete FROM repo ORDER BY display_name COLLATE NOCASE, id',
    )
    .all() as unknown as {
    id: string;
    display_name: string;
    tracking_state: 'active' | 'stopped';
    access_state: 'ok' | 'inaccessible' | 'unknown';
    backfill_complete: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    trackingState: row.tracking_state,
    accessState: row.access_state,
    backfillComplete: row.backfill_complete === 1,
  }));
}

// ---- ledgers and group totals ----------------------------------------------------------------------------------------

export interface LedgerRow {
  provider: UsageProvider;
  sessions: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  /** Sum of the stored `provider_total`. */
  providerTotal: number;
}

/** Per-provider category sums over the events in scope. A provider with no event in scope has no row. */
export function readLedgers(db: Db, filter: UsageFilter): LedgerRow[] {
  const { conditions, params } = scopeClause(filter);
  const rows = db
    .prepare(
      `SELECT s.provider AS provider, COUNT(DISTINCT ue.session_id) AS sessions,
              SUM(ue.input_tokens) AS input, SUM(ue.cached_input_tokens) AS cached_input,
              SUM(ue.cache_write_tokens) AS cache_write, SUM(ue.cache_read_tokens) AS cache_read,
              SUM(ue.output_tokens) AS output, SUM(ue.reasoning_tokens) AS reasoning,
              SUM(ue.provider_total) AS provider_total
         FROM usage_event ue JOIN session s ON s.id = ue.session_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY s.provider`,
    )
    .all(...params) as unknown as {
    provider: UsageProvider;
    sessions: number;
    input: number;
    cached_input: number;
    cache_write: number;
    cache_read: number;
    output: number;
    reasoning: number;
    provider_total: number;
  }[];
  return rows.map((row) => ({
    provider: row.provider,
    sessions: row.sessions,
    input: row.input,
    cachedInput: row.cached_input,
    cacheWrite: row.cache_write,
    cacheRead: row.cache_read,
    output: row.output,
    reasoning: row.reasoning,
    providerTotal: row.provider_total,
  }));
}

export interface GroupTotalRow {
  /** A tracked repo id, UNTRACKED_GROUP or UNKNOWN_GROUP. */
  group: string;
  provider: UsageProvider;
  /** Distinct sessions with at least one event in scope (roots, children and unknown relationships). */
  sessions: number;
  /** The kind = 'root' subset of `sessions`. */
  roots: number;
  /** Sum of `provider_total`: one provider, never mixed with the other. */
  tokens: number;
}

/**
 * Sessions, roots and tokens per group and provider, from the same events as every other Usage figure. A session belongs
 * to its repo's group when that repo is an active tracked repo, to the untracked group when a repo is recorded but not
 * tracked, and to the unknown group when no repo is recorded.
 */
export function readGroupTotals(db: Db, filter: UsageFilter): GroupTotalRow[] {
  const { conditions, params } = scopeClause(filter);
  const rows = db
    .prepare(
      `SELECT CASE WHEN s.repo_id IS NULL THEN '${UNKNOWN_GROUP}'
                   WHEN s.repo_id IN (${ACTIVE_REPOS}) THEN s.repo_id
                   ELSE '${UNTRACKED_GROUP}' END AS grp,
              s.provider AS provider,
              COUNT(DISTINCT s.id) AS sessions,
              COUNT(DISTINCT CASE WHEN s.kind = 'root' THEN s.id END) AS roots,
              SUM(ue.provider_total) AS tokens
         FROM usage_event ue JOIN session s ON s.id = ue.session_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY grp, s.provider`,
    )
    .all(...params) as unknown as {
    grp: string;
    provider: UsageProvider;
    sessions: number;
    roots: number;
    tokens: number;
  }[];
  return rows.map((row) => ({
    group: row.grp,
    provider: row.provider,
    sessions: row.sessions,
    roots: row.roots,
    tokens: row.tokens,
  }));
}

/**
 * Sessions with at least one stored event, per provider: what Sources & repos says each source holds. It reads the sessions and
 * asks the events' own session index whether each has one, so it costs the number of sessions. `readGroupTotals` over all time gives
 * the same count by joining every event, which costs the number of events: on a first import that page polls every second or two,
 * and at 300,000 to 600,000 events each poll stalled the server for 200 to 340 ms (test/bench/BROWSER-RESULTS.md).
 */
export function readSessionCounts(db: Db): Partial<Record<UsageProvider, number>> {
  const rows = db
    .prepare(
      `SELECT s.provider AS provider, COUNT(*) AS sessions
         FROM session s
        WHERE EXISTS (SELECT 1 FROM usage_event ue WHERE ue.session_id = s.id)
        GROUP BY s.provider`,
    )
    .all() as unknown as { provider: UsageProvider; sessions: number }[];
  return Object.fromEntries(rows.map((row) => [row.provider, row.sessions]));
}

// ---- the sessions of one group ---------------------------------------------------------------------------------------

export interface GroupSessionRow {
  id: number;
  provider: UsageProvider;
  kind: SessionKind;
  parentId: number | null;
  parentBasis: 'native' | 'paseo' | null;
  nativeKind: string | null;
  recordedName: string | null;
  nameSource: string | null;
  providerSessionId: string;
  repoId: string | null;
  paseoAgentId: string | null;
  workspaceLabel: string | null;
  startedAt: number;
  startedBasis: 'source_start' | 'first_event';
  firstEventAt: number | null;
  lastEventAt: number | null;
  lastModel: string | null;
  /** provider_total within the requested scope. */
  tokens: number;
  /**
   * For a child: the nearest ancestor that is a root, found by walking `parent_session_id` through any sessions in
   * between (a subagent of a subagent belongs to the same root). null when the chain reaches no root.
   */
  rootId: number | null;
}

interface RawGroupSession {
  id: number;
  provider: UsageProvider;
  kind: SessionKind;
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

/** Every session in the group that has at least one event in scope, with its in-scope tokens. */
export function readGroupSessions(
  db: Db,
  filter: UsageFilter,
  group: GroupSelector,
): GroupSessionRow[] {
  const scope = scopeClause(filter);
  const grp = groupClause(group);
  const rows = db
    .prepare(
      `SELECT s.id, s.provider, s.kind, s.parent_session_id, s.parent_basis, s.native_kind, s.recorded_name, s.name_source,
              s.provider_session_id, s.repo_id, s.paseo_agent_id, s.workspace_label, s.started_at, s.started_basis,
              s.first_event_at, s.last_event_at, s.last_model, SUM(ue.provider_total) AS tokens
         FROM usage_event ue JOIN session s ON s.id = ue.session_id
        WHERE ${[...scope.conditions, grp.condition].join(' AND ')}
        GROUP BY s.id`,
    )
    .all(...scope.params, ...grp.params) as unknown as RawGroupSession[];

  const childIds = rows.filter((row) => row.kind === 'child').map((row) => row.id);
  const rootOf = readRootAncestors(db, childIds);
  return rows.map((row) => ({
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
    rootId: rootOf.get(row.id) ?? null,
  }));
}

/**
 * The nearest root ancestor of each session in `childIds`. `UNION` (not `UNION ALL`) drops repeated rows, so a damaged
 * parent cycle ends instead of looping.
 */
function readRootAncestors(db: Db, childIds: readonly number[]): Map<number, number> {
  if (childIds.length === 0) return new Map();
  const rows = db
    .prepare(
      `WITH RECURSIVE up(child_id, anc_id) AS (
         SELECT s.id, s.parent_session_id FROM session s
          WHERE s.id IN (SELECT value FROM json_each(?)) AND s.parent_session_id IS NOT NULL
         UNION
         SELECT up.child_id, p.parent_session_id FROM up JOIN session p ON p.id = up.anc_id
          WHERE p.kind <> 'root' AND p.parent_session_id IS NOT NULL
       )
       SELECT up.child_id AS child_id, up.anc_id AS root_id FROM up JOIN session a ON a.id = up.anc_id WHERE a.kind = 'root'`,
    )
    .all(JSON.stringify(childIds)) as unknown as { child_id: number; root_id: number }[];
  return new Map(rows.map((row) => [row.child_id, row.root_id]));
}

// ---- links -----------------------------------------------------------------------------------------------------------

export interface LinkRow {
  sessionId: number;
  prNodeId: string;
  prRepo: string;
  prNumber: number;
  mergedAt: number;
  /** The computed class stored in pr_session_link, or null when the link exists only as an owner confirmation. */
  computed: 'evidence' | 'suggested' | null;
  /** The owner's decision for this pair, if any. */
  decision: 'confirmed' | 'rejected' | 'dismissed' | null;
}

/**
 * Every (PR, session) pair that could be listed for these sessions: the computed links, plus pairs the owner confirmed by
 * hand that have no computed link. Only PRs of active tracked repos are returned, the same set Delivery counts. The
 * class rules are applied by the service (`effectiveLinkClass`), not here.
 */
export function readLinkRows(db: Db, sessionIds: readonly number[]): LinkRow[] {
  if (sessionIds.length === 0) return [];
  const rows = db
    .prepare(
      `WITH ids(id) AS (SELECT value FROM json_each(?)),
            pairs(session_id, pr_node_id, computed) AS (
              SELECT l.session_id, l.pr_node_id, l.class FROM pr_session_link l
               WHERE l.session_id IN (SELECT id FROM ids)
              UNION ALL
              SELECT d.session_id, d.pr_node_id, NULL FROM owner_link_decision d
               WHERE d.decision = 'confirmed' AND d.session_id IN (SELECT id FROM ids)
                 AND NOT EXISTS (SELECT 1 FROM pr_session_link l
                                  WHERE l.pr_node_id = d.pr_node_id AND l.session_id = d.session_id)
            )
       SELECT p.session_id, p.pr_node_id, p.computed, d.decision, pr.repo_id AS pr_repo, pr.number AS pr_number, pr.merged_at
         FROM pairs p
         JOIN pull_request pr ON pr.node_id = p.pr_node_id
         JOIN repo r ON r.id = pr.repo_id AND r.tracking_state = 'active'
         LEFT JOIN owner_link_decision d ON d.pr_node_id = p.pr_node_id AND d.session_id = p.session_id`,
    )
    .all(JSON.stringify(sessionIds)) as unknown as {
    session_id: number;
    pr_node_id: string;
    computed: 'evidence' | 'suggested' | null;
    decision: 'confirmed' | 'rejected' | 'dismissed' | null;
    pr_repo: string;
    pr_number: number;
    merged_at: number;
  }[];
  return rows.map((row) => ({
    sessionId: row.session_id,
    prNodeId: row.pr_node_id,
    prRepo: row.pr_repo,
    prNumber: row.pr_number,
    mergedAt: row.merged_at,
    computed: row.computed,
    decision: row.decision,
  }));
}

// ---- the session upsert ----------------------------------------------------------------------------------------------

export interface SessionUpsert {
  provider: UsageProvider;
  providerSessionId: string;
  kind: SessionKind;
  parentSessionId?: number | null;
  parentBasis?: 'native' | 'paseo' | null;
  nativeKind?: string | null;
  recordedName?: string | null;
  nameSource?: 'provider_title' | 'paseo' | null;
  repoId?: string | null;
  repoBasis?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  paseoAgentId?: string | null;
  workspaceLabel?: string | null;
  /** The start the source reports, or the earliest usage event time when it reports none (see `startedBasis`). */
  startedAt: number;
  startedBasis: 'source_start' | 'first_event';
  firstEventAt?: number | null;
  lastEventAt?: number | null;
  lastModel?: string | null;
}

/**
 * Inserts a session, or updates the one with the same `(provider, provider_session_id)`, and returns its id.
 *
 * `started_at` (the "Started" label, data-and-sources › Session start time):
 *  - it is set once, on insert;
 *  - a later upsert only moves it **earlier** (an older line turned up). A later or equal time changes nothing, so a resumed
 *    session keeps its original start;
 *  - it is never derived from `usage_event`, so the 366-day pruning of events cannot move it. Nothing in this function reads
 *    that table.
 * `started_basis` describes the value kept: it follows a time that moved earlier, and an equal time is upgraded from
 * `first_event` to `source_start` (the source's own record is the better witness), never the other way round.
 *
 * The rest of the row never loses what is known: a missing value in the new read keeps the stored one (a deleted directory
 * keeps its repo, a read that does not see the Paseo name keeps it), an Unknown relationship never replaces a known
 * root or child, a plain root read never undoes a relationship Paseo recorded (a transcript cannot know its Paseo parent),
 * `first_event_at` only moves earlier and `last_event_at` only later.
 */
export function upsertSession(db: Db, session: SessionUpsert): number {
  const repoId = session.repoId == null ? null : resolveSessionRepoId(db, session.repoId);
  const row = db
    .prepare(
      `INSERT INTO session (provider, provider_session_id, kind, parent_session_id, parent_basis, native_kind, recorded_name,
         name_source, repo_id, repo_basis, cwd, git_branch, paseo_agent_id, workspace_label, started_at, started_basis,
         first_event_at, last_event_at, last_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, provider_session_id) DO UPDATE SET
         started_basis = CASE
           WHEN excluded.started_at < session.started_at THEN excluded.started_basis
           WHEN excluded.started_at = session.started_at AND excluded.started_basis = 'source_start' THEN 'source_start'
           ELSE session.started_basis END,
         started_at = MIN(session.started_at, excluded.started_at),
         first_event_at = MIN(COALESCE(session.first_event_at, excluded.first_event_at), COALESCE(excluded.first_event_at, session.first_event_at)),
         last_event_at = MAX(COALESCE(session.last_event_at, excluded.last_event_at), COALESCE(excluded.last_event_at, session.last_event_at)),
         kind = CASE
           WHEN excluded.kind = 'unknown' THEN session.kind
           WHEN excluded.kind = 'root' AND (session.parent_basis = 'paseo' OR session.native_kind = 'paseo') THEN session.kind
           ELSE excluded.kind END,
         parent_session_id = COALESCE(excluded.parent_session_id, session.parent_session_id),
         parent_basis = COALESCE(excluded.parent_basis, session.parent_basis),
         native_kind = COALESCE(excluded.native_kind, session.native_kind),
         recorded_name = COALESCE(excluded.recorded_name, session.recorded_name),
         name_source = CASE WHEN excluded.recorded_name IS NULL THEN session.name_source ELSE excluded.name_source END,
         repo_id = COALESCE(excluded.repo_id, session.repo_id),
         repo_basis = CASE WHEN excluded.repo_id IS NULL THEN session.repo_basis ELSE excluded.repo_basis END,
         cwd = COALESCE(excluded.cwd, session.cwd),
         git_branch = COALESCE(excluded.git_branch, session.git_branch),
         paseo_agent_id = COALESCE(excluded.paseo_agent_id, session.paseo_agent_id),
         workspace_label = COALESCE(excluded.workspace_label, session.workspace_label),
         last_model = COALESCE(excluded.last_model, session.last_model)
       RETURNING id`,
    )
    .get(
      session.provider,
      session.providerSessionId,
      session.kind,
      session.parentSessionId ?? null,
      session.parentBasis ?? null,
      session.nativeKind ?? null,
      session.recordedName ?? null,
      session.nameSource ?? null,
      repoId,
      session.repoId != null && repoId === null ? null : (session.repoBasis ?? null),
      session.cwd ?? null,
      session.gitBranch ?? null,
      session.paseoAgentId ?? null,
      session.workspaceLabel ?? null,
      session.startedAt,
      session.startedBasis,
      session.firstEventAt ?? null,
      session.lastEventAt ?? null,
      session.lastModel ?? null,
    ) as { id: number };
  return row.id;
}
