import { inTransaction, type Db } from '../open.ts';
import type { SessionKind, UsageProvider } from './usage.ts';

// Paseo enrichment, the SQL half (data-and-sources › Paseo enrichment). Paseo adds no usage events: it names sessions and says
// which agent started which. The collector (collectors/paseo) lists the daemon's agents and calls `upsertPaseoAgents`; the join
// below then matches stored agents to stored sessions. The join reads only what is stored, so the run can repeat it when the
// daemon is off and the last snapshot still enriches the tree.
//
// What the join may do, and never does:
//   - match on the provider's own session id within the SAME provider (`paseo_agent.provider_session_id = session.provider_session_id`),
//     never on a title, a folder or a time;
//   - name a session from Paseo's title only when the provider recorded no title of its own;
//   - give a session a Paseo parent only when it has no native parent, and only when the parent agent maps to a session;
//   - when the parent agent maps to no session, mark the relationship UNKNOWN. It never invents an edge (P-23);
//   - write no usage event and change no token total (P-22).

export type PaseoProvider = UsageProvider | 'other';

export interface PaseoAgentInput {
  /** Paseo's own agent id. */
  id: string;
  /** The agent's title, or null. Stored as a name only when it is a real name. */
  title: string | null;
  /** The provider the agent runs. Only `codex` and `claude` can map to a stored session. */
  provider: PaseoProvider;
  /** `runtimeInfo.sessionId`: the provider's own session id, or null while the agent has not started one. */
  providerSessionId: string | null;
  /** The parent agent's id (the `paseo.parent-agent-id` label), or null. */
  parentAgentId: string | null;
  workspaceId: string | null;
  /** The workspace's name when the daemon gives one. */
  workspaceLabel: string | null;
  cwd: string | null;
  background: boolean;
  /** Epoch ms the agent was archived, or null. */
  archivedAt: number | null;
}

/**
 * Stores one snapshot of the daemon's agents, in one transaction. An agent seen again keeps its `first_seen_at` and takes the new
 * values and `last_seen_at`; an agent that is no longer listed keeps its row (the daemon is a live directory, not a ledger, so the
 * app accumulates what it has seen). Returns how many agents were new.
 */
export function upsertPaseoAgents(
  db: Db,
  agents: readonly PaseoAgentInput[],
  now: number,
): { inserted: number; updated: number } {
  let inserted = 0;
  let updated = 0;
  inTransaction(db, () => {
    const exists = db.prepare('SELECT 1 AS present FROM paseo_agent WHERE id = ?');
    const upsert = db.prepare(
      `INSERT INTO paseo_agent (id, title, provider, provider_session_id, parent_agent_id, workspace_id, workspace_label, cwd,
         background, archived_at, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, provider = excluded.provider,
         provider_session_id = excluded.provider_session_id, parent_agent_id = excluded.parent_agent_id,
         workspace_id = excluded.workspace_id, workspace_label = excluded.workspace_label, cwd = excluded.cwd,
         background = excluded.background, archived_at = excluded.archived_at, last_seen_at = excluded.last_seen_at`,
    );
    for (const agent of agents) {
      if (exists.get(agent.id) === undefined) inserted += 1;
      else updated += 1;
      upsert.run(
        agent.id,
        agent.title,
        agent.provider,
        agent.providerSessionId,
        agent.parentAgentId,
        agent.workspaceId,
        agent.workspaceLabel,
        agent.cwd,
        agent.background ? 1 : 0,
        agent.archivedAt,
        now,
        now,
      );
    }
  });
  return { inserted, updated };
}

interface AgentRow {
  id: string;
  title: string | null;
  provider: PaseoProvider;
  provider_session_id: string | null;
  parent_agent_id: string | null;
  workspace_label: string | null;
  archived_at: number | null;
  last_seen_at: number;
}

interface SessionRow {
  id: number;
  provider: UsageProvider;
  provider_session_id: string;
  kind: SessionKind;
  parent_session_id: number | null;
  parent_basis: 'native' | 'paseo' | null;
  native_kind: string | null;
  recorded_name: string | null;
  name_source: string | null;
  paseo_agent_id: string | null;
  workspace_label: string | null;
}

export interface PaseoJoinResult {
  /** Sessions that now carry an agent. */
  mapped: number;
  /** Sessions whose name came from this join (new or changed). */
  named: number;
  /** Sessions that now have a Paseo parent. */
  parented: number;
  /** Sessions whose Paseo parent maps to no session: their relationship is Unknown. */
  parentUnmapped: number;
}

/** True when `a` is the better agent for a session than `b`: a live one over an archived one, then the more recently listed, then the lower id. */
function isBetter(a: AgentRow, b: AgentRow): boolean {
  if ((a.archived_at === null) !== (b.archived_at === null)) return a.archived_at === null;
  if (a.last_seen_at !== b.last_seen_at) return a.last_seen_at > b.last_seen_at;
  return a.id < b.id;
}

/** One agent per (provider, session id). */
function pickAgents(agents: readonly AgentRow[]): Map<string, AgentRow> {
  const best = new Map<string, AgentRow>();
  for (const agent of agents) {
    if (agent.provider_session_id === null || agent.provider === 'other') continue;
    const key = `${agent.provider}\u0000${agent.provider_session_id}`;
    const current = best.get(key);
    if (current === undefined || isBetter(agent, current)) best.set(key, agent);
  }
  return best;
}

/**
 * Applies the stored agents to the stored sessions, in one transaction. Idempotent: running it again changes nothing. Only the
 * Paseo columns of `session` (paseo_agent_id, workspace_label, the name when Paseo gave it, and a Paseo-recorded parent or unknown
 * relationship) are written, never a token, an event or a native parent.
 */
export function joinPaseoSessions(db: Db): PaseoJoinResult {
  return inTransaction(db, () => {
    const agents = db
      .prepare(
        `SELECT id, title, provider, provider_session_id, parent_agent_id, workspace_label, archived_at, last_seen_at
           FROM paseo_agent`,
      )
      .all() as unknown as AgentRow[];
    const chosen = pickAgents(agents);

    const sessions = db
      .prepare(
        `SELECT id, provider, provider_session_id, kind, parent_session_id, parent_basis, native_kind, recorded_name,
                name_source, paseo_agent_id, workspace_label
           FROM session`,
      )
      .all() as unknown as SessionRow[];

    // 1. which session each agent is: the same provider's own session id.
    const agentOf = new Map<number, AgentRow>();
    const sessionOfAgent = new Map<string, number>();
    for (const session of sessions) {
      const agent = chosen.get(`${session.provider}\u0000${session.provider_session_id}`);
      if (agent === undefined) continue;
      agentOf.set(session.id, agent);
      sessionOfAgent.set(agent.id, session.id);
    }

    const result: PaseoJoinResult = { mapped: 0, named: 0, parented: 0, parentUnmapped: 0 };
    const setMapping = db.prepare(
      'UPDATE session SET paseo_agent_id = ?, workspace_label = COALESCE(?, workspace_label) WHERE id = ?',
    );
    const setName = db.prepare(
      "UPDATE session SET recorded_name = ?, name_source = 'paseo' WHERE id = ?",
    );
    const setParent = db.prepare(
      "UPDATE session SET kind = 'child', parent_session_id = ?, parent_basis = 'paseo', native_kind = 'paseo' WHERE id = ?",
    );
    const setUnknown = db.prepare(
      "UPDATE session SET kind = 'unknown', native_kind = 'paseo' WHERE id = ?",
    );

    // The parent of each session as the join will leave it, to refuse an edge that would close a loop.
    const parentOf = new Map<number, number | null>(
      sessions.map((session) => [session.id, session.parent_session_id]),
    );
    const reaches = (from: number, target: number): boolean => {
      const seen = new Set<number>();
      for (let at: number | null | undefined = from; at != null && !seen.has(at);) {
        if (at === target) return true;
        seen.add(at);
        at = parentOf.get(at);
      }
      return false;
    };

    for (const session of sessions) {
      const agent = agentOf.get(session.id);
      if (agent === undefined) continue;

      if (
        session.paseo_agent_id !== agent.id ||
        (agent.workspace_label !== null && session.workspace_label !== agent.workspace_label)
      ) {
        setMapping.run(agent.id, agent.workspace_label, session.id);
      }
      result.mapped += 1;

      // 2. the name: Paseo's, only when the provider recorded none (a provider title always wins).
      const title = agent.title?.trim() ?? '';
      if (
        title !== '' &&
        session.name_source !== 'provider_title' &&
        (session.recorded_name !== title || session.name_source !== 'paseo')
      ) {
        setName.run(title, session.id);
        result.named += 1;
      }

      // 3. the parent: only when there is no native one, and only through an agent that maps to a session.
      if (agent.parent_agent_id === null || session.parent_basis === 'native') continue;
      const parentSession = sessionOfAgent.get(agent.parent_agent_id);
      if (
        parentSession !== undefined &&
        parentSession !== session.id &&
        !reaches(parentSession, session.id)
      ) {
        if (session.parent_session_id !== parentSession || session.parent_basis !== 'paseo') {
          setParent.run(parentSession, session.id);
          parentOf.set(session.id, parentSession);
        }
        result.parented += 1;
      } else {
        // The parent is not a session we hold (its agent is unmapped or not listed, or the edge would close a loop): the edge is
        // unknown, never guessed. A session that already has a parent keeps it; only a plain root becomes Unknown.
        if (session.kind === 'root' && session.parent_session_id === null)
          setUnknown.run(session.id);
        result.parentUnmapped += 1;
      }
    }
    return result;
  });
}

export interface PaseoCounts {
  /** Agents ever listed. */
  agents: number;
  /** Agents that map to a stored session. */
  mapped: number;
  /** Agents with no matching session: visible in Sources diagnostics, they add no tokens. */
  unmapped: number;
  /** Agents the daemon lists as archived. */
  archived: number;
  /** Sessions Paseo says have a parent that maps to no session. */
  parentUnmapped: number;
  /** The earliest time any agent was seen (epoch ms): Paseo coverage starts there ("Paseo agent metadata from <date>"). */
  firstSeenAt: number | null;
}

export function readPaseoCounts(db: Db): PaseoCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS agents,
              COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM session s WHERE s.paseo_agent_id = a.id) THEN 1 ELSE 0 END), 0) AS mapped,
              COALESCE(SUM(CASE WHEN a.archived_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS archived,
              MIN(a.first_seen_at) AS first_seen_at
         FROM paseo_agent a`,
    )
    .get() as { agents: number; mapped: number; archived: number; first_seen_at: number | null };
  const parentUnmapped = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM session WHERE kind = 'unknown' AND native_kind = 'paseo' AND parent_session_id IS NULL",
      )
      .get() as { n: number }
  ).n;
  return {
    agents: row.agents,
    mapped: row.mapped,
    unmapped: row.agents - row.mapped,
    archived: row.archived,
    parentUnmapped,
    firstSeenAt: row.first_seen_at,
  };
}
