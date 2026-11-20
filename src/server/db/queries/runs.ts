import type { Db } from '../open.ts';

/**
 * Boot step 2: a run still marked `running` belongs to a process that is gone. Mark it `interrupted` and close its
 * source entries, so Retry is offered and no run looks active forever. Returns how many runs were marked.
 */
export function markRunningRunsInterrupted(db: Db, nowMs: number): number {
  const rows = db
    .prepare("SELECT id, per_source_json FROM refresh_run WHERE state = 'running'")
    .all() as {
    id: number;
    per_source_json: string;
  }[];
  const update = db.prepare(
    `UPDATE refresh_run SET state = 'interrupted', finished_at = ?, per_source_json = ?,
       link_rebuild_result = CASE WHEN link_rebuild_result = 'pending' THEN 'interrupted' ELSE link_rebuild_result END
     WHERE id = ?`,
  );
  for (const row of rows) {
    update.run(nowMs, closeSources(row.per_source_json), row.id);
  }
  return rows.length;
}

/** Sources that were queued or running when the process died become `failed` with a plain message. */
function closeSources(json: string): string {
  try {
    const sources = JSON.parse(json) as Record<string, { state?: string; message?: string | null }>;
    for (const entry of Object.values(sources)) {
      if (entry && (entry.state === 'queued' || entry.state === 'running')) {
        entry.state = 'failed';
        entry.message = 'The app stopped before this finished.';
      }
    }
    return JSON.stringify(sources);
  } catch {
    return '{}';
  }
}
