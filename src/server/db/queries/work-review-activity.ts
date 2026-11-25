import type { Db } from '../open.ts';
import type { SourceFileState } from './ingest.ts';
import type { UsageProvider } from './usage.ts';

export interface ReviewDay {
  date: string;
  start: number;
  end: number;
}

export interface ReviewSessionActivity {
  date: string;
  session_id: number;
  root_id: number | null;
  provider: UsageProvider;
  provider_session_id: string;
  recorded_name: string | null;
  repo_id: string | null;
  started_at: number;
  source_started: number;
  first_at: number;
  last_at: number;
  last_event_id: number;
  events: number;
  total: number;
  file_path: string | null;
  file_size: number | null;
  file_offset: number | null;
  file_head: string | null;
  file_state: SourceFileState | null;
  file_mtime: number | null;
}

/**
 * One row per active session, report day and imported file. Day bounds come from the shared calendar in the report zone.
 * Being a parent or linked to a PR does not put a session in scope. A parent contributes grouping metadata only.
 */
export function readReviewSessionActivity(
  db: Db,
  days: readonly ReviewDay[],
  providers: readonly UsageProvider[],
  repos: readonly string[],
): ReviewSessionActivity[] {
  if (days.length === 0) return [];
  return db
    .prepare(
      `WITH RECURSIVE
        days(date, starts, ends) AS (
          SELECT json_extract(value, '$.date'), json_extract(value, '$.start'), json_extract(value, '$.end')
            FROM json_each(?)
        ),
        activity AS MATERIALIZED (
          SELECT d.date, e.session_id, e.source_file_id, COUNT(*) AS events, TOTAL(e.provider_total) AS total,
                 MIN(e.occurred_at) AS first_at, MAX(e.occurred_at) AS last_at, MAX(e.id) AS last_event_id
            FROM days d
            CROSS JOIN usage_event e INDEXED BY usage_event_time
                ON e.occurred_at >= d.starts AND e.occurred_at < d.ends
            JOIN session s ON s.id = e.session_id AND s.provider = e.provider
           WHERE s.provider IN (SELECT value FROM json_each(?))
             AND (? OR s.repo_id IN (SELECT value FROM json_each(?)))
           GROUP BY d.date, e.session_id, e.source_file_id
        ),
        up(child_id, ancestor_id) AS (
          SELECT DISTINCT s.id, s.parent_session_id
            FROM activity a JOIN session s ON s.id = a.session_id
           WHERE s.kind = 'child' AND s.parent_session_id IS NOT NULL
          UNION
          SELECT up.child_id, s.parent_session_id FROM up JOIN session s ON s.id = up.ancestor_id
           WHERE s.kind <> 'root' AND s.parent_session_id IS NOT NULL
        ),
        roots(child_id, root_id) AS (
          SELECT child_id, ancestor_id FROM up JOIN session s ON s.id = up.ancestor_id WHERE s.kind = 'root'
        )
      SELECT a.date, s.id AS session_id, roots.root_id, s.provider, s.provider_session_id,
             s.recorded_name, s.repo_id, s.started_at, (s.started_basis = 'source_start') AS source_started,
             a.first_at, a.last_at, a.last_event_id, a.events, a.total,
             f.path AS file_path, f.size AS file_size, f.read_offset AS file_offset, f.head_hash AS file_head,
             f.state AS file_state, f.mtime_ms AS file_mtime
        FROM activity a
        JOIN session s ON s.id = a.session_id
        LEFT JOIN roots ON roots.child_id = s.id
        LEFT JOIN source_file f ON f.id = a.source_file_id AND f.source_id = s.provider
       ORDER BY a.date, s.id, a.first_at, a.last_event_id`,
    )
    .all(
      JSON.stringify(days),
      JSON.stringify(providers),
      Number(repos.length === 0),
      JSON.stringify(repos),
    ) as unknown as ReviewSessionActivity[];
}
