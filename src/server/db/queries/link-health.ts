import type { LinkHealth, LinkRebuildResult } from '../../../shared/contracts/link-health.ts';
import type { Db } from '../open.ts';
import { getMeta, setMeta } from './meta.ts';

const DIRTY = 'links_dirty';
const LAST_SUCCESS = 'links_last_rebuilt_at';

export function readLinkHealth(db: Db): LinkHealth {
  const last = getMeta(db, LAST_SUCCESS);
  if (last === null) return { state: 'unavailable', lastSuccessfulAt: null };
  return {
    state: getMeta(db, DIRTY) === '1' ? 'stale' : 'fresh',
    lastSuccessfulAt: new Date(Number(last)).toISOString(),
  };
}

export function recordLinkRebuildResult(
  db: Db,
  runId: number,
  result: Exclude<LinkRebuildResult, 'pending'> | null,
): void {
  db.prepare(
    "UPDATE refresh_run SET link_rebuild_result = ? WHERE id = ? AND link_rebuild_result = 'pending'",
  ).run(result, runId);
}

/** Called in the same transaction as the replacement links, including a valid empty result. */
export function recordComputedLinksSuccess(db: Db, at: number, runId?: number): void {
  setMeta(db, LAST_SUCCESS, String(at));
  setMeta(db, DIRTY, '0');
  if (runId !== undefined) recordLinkRebuildResult(db, runId, 'succeeded');
}
