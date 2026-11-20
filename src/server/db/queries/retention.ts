import { type Db, inTransaction } from '../open.ts';

export interface PruneCounts {
  usageEvents: number;
  pullRequests: number;
  sessions: number;
  sessionRefs: number;
  prLinks: number;
  ownerDecisions: number;
}

/**
 * Deletes what is older than `cutoffMs` (UTC epoch ms), in one transaction: usage events by `occurred_at`, merged PRs by
 * `merged_at` with their commits, computed links and owner decisions; then sessions left with no events and no child,
 * with their refs. The attribution triggers mark links stale when pruning removes matching inputs.
 */
export function pruneBefore(db: Db, cutoffMs: number): PruneCounts {
  return inTransaction(db, () => {
    const count = (sql: string, ...args: number[]) => Number(db.prepare(sql).run(...args).changes);

    const usageEvents = count('DELETE FROM usage_event WHERE occurred_at < ?', cutoffMs);

    const oldPrs = '(SELECT node_id FROM pull_request WHERE merged_at < ?)';
    const prLinks = count(`DELETE FROM pr_session_link WHERE pr_node_id IN ${oldPrs}`, cutoffMs);
    const ownerDecisions = count(
      `DELETE FROM owner_link_decision WHERE pr_node_id IN ${oldPrs}`,
      cutoffMs,
    );
    count(`DELETE FROM pr_commit WHERE pr_node_id IN ${oldPrs}`, cutoffMs);
    const pullRequests = count('DELETE FROM pull_request WHERE merged_at < ?', cutoffMs);

    // A session with no events left (and nothing pointing at it as a parent) is an orphan. Chains need a few passes.
    let sessions = 0;
    let sessionRefs = 0;
    for (let pass = 0; pass < 10 && orphanCount(db) > 0; pass++) {
      sessionRefs += count(`DELETE FROM session_ref WHERE session_id IN (${ORPHANS})`);
      sessions += count(`DELETE FROM session WHERE id IN (${ORPHANS})`);
    }

    // Computed links and decisions that point at a session or PR that is gone.
    const stale = count(
      'DELETE FROM pr_session_link WHERE session_id NOT IN (SELECT id FROM session)' +
        ' OR pr_node_id NOT IN (SELECT node_id FROM pull_request)',
    );
    return {
      usageEvents,
      pullRequests,
      sessions,
      sessionRefs,
      prLinks: prLinks + stale,
      ownerDecisions,
    };
  });
}

const ORPHANS =
  'SELECT id FROM session s WHERE NOT EXISTS (SELECT 1 FROM usage_event e WHERE e.session_id = s.id)' +
  ' AND NOT EXISTS (SELECT 1 FROM session c WHERE c.parent_session_id = s.id)' +
  ' AND NOT EXISTS (SELECT 1 FROM owner_link_decision d WHERE d.session_id = s.id)' +
  ' AND NOT EXISTS (SELECT 1 FROM claude_legacy_candidate c WHERE c.candidate_session_id = s.id)';

function orphanCount(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (${ORPHANS})`).get() as { n: number };
  return row.n;
}
