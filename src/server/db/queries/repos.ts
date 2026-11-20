import { inTransaction, type Db } from '../open.ts';

// Repos: the list (GET /api/repos) and, since M6, the writes behind adding, stopping and re-adding a repo and behind the PR
// sync. The canonical id of a repo is its lowercased `owner/name`; `github_node_id` is stored too, so a renamed repository
// that is added under its new name is found again by its node id and keeps its rows (data-and-sources › Adding a repo).

export interface RepoRow {
  id: string;
  displayName: string;
  githubNodeId: string | null;
  trackingState: 'active' | 'stopped';
  accessState: 'ok' | 'inaccessible' | 'unknown';
  accessError: string | null;
  backfillComplete: boolean;
  lastSyncSuccessAt: number | null;
  stoppedAt: number | null;
  /** Merged PRs stored for this repo at or after `sinceMs`. */
  mergedSince: number;
}

interface RawRepo {
  id: string;
  display_name: string;
  github_node_id: string | null;
  tracking_state: 'active' | 'stopped';
  access_state: 'ok' | 'inaccessible' | 'unknown';
  access_error: string | null;
  backfill_complete: number;
  last_sync_success_at: number | null;
  stopped_at: number | null;
  merged: number;
}

export function listRepoRows(db: Db, sinceMs: number): RepoRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.display_name, r.github_node_id, r.tracking_state, r.access_state, r.access_error, r.backfill_complete,
              r.last_sync_success_at, r.stopped_at,
              (SELECT COUNT(*) FROM pull_request p WHERE p.repo_id = r.id AND p.merged_at >= ?) AS merged
         FROM repo r
        ORDER BY r.display_name COLLATE NOCASE, r.id`,
    )
    .all(sinceMs) as unknown as RawRepo[];
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    githubNodeId: row.github_node_id,
    trackingState: row.tracking_state,
    accessState: row.access_state,
    accessError: row.access_error,
    backfillComplete: row.backfill_complete === 1,
    lastSyncSuccessAt: row.last_sync_success_at,
    stoppedAt: row.stopped_at,
    mergedSince: row.merged,
  }));
}

// ---- M6: writes ----

/** One repo row as the services need it. */
export interface RepoRecord {
  id: string;
  slug: string;
  nodeId: string | null;
  displayName: string;
  trackingState: 'active' | 'stopped';
  accessState: 'ok' | 'inaccessible' | 'unknown';
  accessError: string | null;
  addedAt: number;
  stoppedAt: number | null;
  backfillComplete: boolean;
  lastSyncStartedAt: number | null;
  lastSyncSuccessAt: number | null;
  completeStartedAt: number | null;
}

interface RawRecord {
  id: string;
  github_slug: string | null;
  github_node_id: string | null;
  display_name: string;
  tracking_state: 'active' | 'stopped';
  access_state: 'ok' | 'inaccessible' | 'unknown';
  access_error: string | null;
  added_at: number;
  stopped_at: number | null;
  backfill_complete: number;
  last_sync_started_at: number | null;
  last_sync_success_at: number | null;
  github_complete_started_at: number | null;
}

const COLUMNS = `id, github_slug, github_node_id, display_name, tracking_state, access_state, access_error, added_at, stopped_at,
  backfill_complete, last_sync_started_at, last_sync_success_at, github_complete_started_at`;

const toRecord = (row: RawRecord): RepoRecord => ({
  id: row.id,
  slug: row.github_slug ?? row.id,
  nodeId: row.github_node_id,
  displayName: row.display_name,
  trackingState: row.tracking_state,
  accessState: row.access_state,
  accessError: row.access_error,
  addedAt: row.added_at,
  stoppedAt: row.stopped_at,
  backfillComplete: row.backfill_complete === 1,
  lastSyncStartedAt: row.last_sync_started_at,
  lastSyncSuccessAt: row.last_sync_success_at,
  completeStartedAt: row.github_complete_started_at,
});

export function getRepo(db: Db, id: string): RepoRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM repo WHERE id = ?`).get(id) as
    RawRecord | undefined;
  return row ? toRecord(row) : null;
}

export function getRepoByNodeId(db: Db, nodeId: string): RepoRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM repo WHERE github_node_id = ?`).get(nodeId) as
    RawRecord | undefined;
  return row ? toRecord(row) : null;
}

interface SlugClaim {
  repo_id: string;
  conflicted_at: number | null;
}

function slugClaim(db: Db, slug: string): SlugClaim | undefined {
  return db
    .prepare('SELECT repo_id, conflicted_at FROM github_repo_slug WHERE slug = ?')
    .get(slug) as SlugClaim | undefined;
}

export function getRepoBySlug(db: Db, slug: string): RepoRecord | null {
  const claim = slugClaim(db, slug);
  return getRepo(db, claim?.conflicted_at === null ? claim.repo_id : slug);
}

export function readRepoAliases(db: Db): ReadonlyMap<string, string> {
  const rows = db
    .prepare('SELECT slug, repo_id FROM github_repo_slug WHERE conflicted_at IS NULL')
    .all() as {
    slug: string;
    repo_id: string;
  }[];
  return new Map(rows.map((row) => [row.slug, row.repo_id]));
}

export function readRepoRefClaims(db: Db): ReadonlyMap<string, SlugClaim> {
  const rows = db
    .prepare('SELECT slug, repo_id, conflicted_at FROM github_repo_slug')
    .all() as unknown as (SlugClaim & { slug: string })[];
  return new Map(rows.map((row) => [row.slug, row]));
}

/** A local remote names a repo by slug. A conflicted slug cannot establish a new association. */
export function resolveSessionRepoId(db: Db, slug: string): string | null {
  const claim = slugClaim(db, slug);
  return claim ? (claim.conflicted_at === null ? claim.repo_id : null) : slug;
}

/** Every repo being tracked, in the order the sync takes them. An inaccessible repo stays in the list so it is checked again. */
export function listActiveRepos(db: Db): RepoRecord[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM repo WHERE tracking_state = 'active' ORDER BY id`)
    .all() as unknown as RawRecord[];
  return rows.map(toRecord);
}

export interface TrackRepoInput {
  /** Lowercased `owner/name`. */
  id: string;
  /** The repository's node id from GitHub, when the access check returned one. */
  nodeId: string | null;
  /** The name as GitHub spells it (`full_name`). */
  displayName: string;
  now: number;
}

export type TrackRepoResult = {
  outcome: 'added' | 'reactivated' | 'already_tracked' | 'identity_conflict';
  repo: RepoRecord;
  attributionChanged: boolean;
};

/** Claims a GitHub-provided name inside the caller's transaction, after checking the stable identities on both sides. */
export function recordRepoIdentity(
  db: Db,
  repo: RepoRecord,
  identity: { id: string; nodeId: string | null; displayName: string },
  now: number,
): { matches: boolean; attributionChanged: boolean } {
  if (
    repo.nodeId === identity.nodeId &&
    repo.slug === identity.id &&
    repo.displayName === identity.displayName
  ) {
    return { matches: true, attributionChanged: false };
  }
  const claim = slugClaim(db, identity.id);
  const slugOwner = getRepo(db, claim?.repo_id ?? identity.id);
  const nodeOwner = identity.nodeId === null ? null : getRepoByNodeId(db, identity.nodeId);
  if (slugOwner?.nodeId && identity.nodeId && slugOwner.nodeId !== identity.nodeId) {
    const changed = db
      .prepare(
        `INSERT INTO github_repo_slug (slug, repo_id, conflicted_at) VALUES (?, ?, ?)
      ON CONFLICT (slug) DO UPDATE SET conflicted_at = excluded.conflicted_at
      WHERE github_repo_slug.conflicted_at IS NULL`,
      )
      .run(identity.id, slugOwner.id, now);
    return { matches: false, attributionChanged: changed.changes > 0 };
  }
  if (
    (slugOwner && slugOwner.id !== repo.id) ||
    (nodeOwner && nodeOwner.id !== repo.id) ||
    (repo.nodeId !== null && identity.nodeId !== repo.nodeId) ||
    (identity.id !== repo.slug && repo.nodeId === null)
  )
    return { matches: false, attributionChanged: false };

  const renamed = identity.id !== repo.slug;
  if (identity.id !== repo.id) {
    db.prepare('INSERT OR IGNORE INTO github_repo_slug (slug, repo_id) VALUES (?, ?)').run(
      identity.id,
      repo.id,
    );
    if (renamed && (claim === undefined || claim.conflicted_at === null)) {
      db.prepare('UPDATE session SET repo_id = ? WHERE repo_id = ?').run(repo.id, identity.id);
    }
  }
  if (renamed) {
    db.prepare(
      "UPDATE pull_request SET url = 'https://github.com/' || ? || '/pull/' || number WHERE repo_id = ?",
    ).run(identity.displayName, repo.id);
  }
  db.prepare(
    'UPDATE repo SET github_slug = ?, github_node_id = ?, display_name = ? WHERE id = ?',
  ).run(identity.id, identity.nodeId, identity.displayName, repo.id);
  return { matches: true, attributionChanged: renamed };
}

/**
 * Starts tracking a repo whose access has just been confirmed, in one transaction.
 *   added           no row had this id or node id: a new active row, access ok, backfill not complete
 *   already_tracked an active row exists, updating its current name if GitHub verified a rename
 *   reactivated     a stopped row exists: it becomes active again with every stored PR, the access state is reset to ok and the
 *                   backfill is reset, so the next sync reads back to the lookback and fills the gap by upserting on the PR's
 *                   node id (no duplicates, P-18)
 */
export function trackRepo(db: Db, input: TrackRepoInput): TrackRepoResult {
  return inTransaction(db, () => {
    const found =
      (input.nodeId ? getRepoByNodeId(db, input.nodeId) : null) ??
      getRepo(db, slugClaim(db, input.id)?.repo_id ?? input.id);
    if (!found) {
      db.prepare(
        `INSERT INTO repo (id, github_node_id, display_name, tracking_state, access_state, access_error, added_at, stopped_at,
           backfill_complete, last_sync_started_at, last_sync_success_at)
         VALUES (?, ?, ?, 'active', 'ok', NULL, ?, NULL, 0, NULL, NULL)`,
      ).run(input.id, input.nodeId, input.displayName, input.now);
      return {
        outcome: 'added',
        repo: getRepo(db, input.id) as RepoRecord,
        attributionChanged: false,
      };
    }
    const { matches, attributionChanged } = recordRepoIdentity(db, found, input, input.now);
    if (!matches) return { outcome: 'identity_conflict', repo: found, attributionChanged };
    if (found.trackingState === 'active') {
      return {
        outcome: 'already_tracked',
        repo: getRepo(db, found.id) as RepoRecord,
        attributionChanged,
      };
    }
    db.prepare(
      `UPDATE repo SET tracking_state = 'active', stopped_at = NULL, access_state = 'ok', access_error = NULL,
         backfill_complete = 0, last_sync_started_at = NULL, github_complete_started_at = NULL
       WHERE id = ?`,
    ).run(found.id);
    return {
      outcome: 'reactivated',
      repo: getRepo(db, found.id) as RepoRecord,
      attributionChanged,
    };
  });
}

/** Stops tracking: the sync skips it and it leaves the active views; every stored row stays. Idempotent. */
export function stopRepo(
  db: Db,
  id: string,
  now: number,
): 'stopped' | 'already_stopped' | 'not_found' {
  return inTransaction(db, () => {
    const found = getRepoBySlug(db, id);
    if (!found) return 'not_found';
    if (found.trackingState === 'stopped') return 'already_stopped';
    db.prepare("UPDATE repo SET tracking_state = 'stopped', stopped_at = ? WHERE id = ?").run(
      now,
      found.id,
    );
    db.prepare('DELETE FROM github_sync_pass WHERE repo_id = ?').run(found.id);
    return 'stopped';
  });
}

/** Records what the last access check or sync learned about a repo: ok, or inaccessible with the plain sentence to show. */
export function setRepoAccess(
  db: Db,
  id: string,
  access: {
    state: 'ok' | 'inaccessible' | 'unknown';
    error?: string | null;
  },
): void {
  db.prepare('UPDATE repo SET access_state = ?, access_error = ? WHERE id = ?').run(
    access.state,
    access.state === 'ok' ? null : (access.error ?? null),
    id,
  );
}

/** A sync of this repo started: the incremental sync reads back to this moment minus a day next time. */
export function markSyncStarted(db: Db, id: string, now: number): void {
  db.prepare('UPDATE repo SET last_sync_started_at = ? WHERE id = ?').run(now, id);
}

/**
 * A sync of this repo ended. `complete` means it read every page it needed: only then is the repo's backfill complete and its
 * last success moved. A partial sync (rate limit, a failed page) keeps what it wrote and changes neither.
 */
export function markSyncFinished(
  db: Db,
  id: string,
  finished: { now: number; complete: boolean },
): void {
  if (!finished.complete) return;
  db.prepare('UPDATE repo SET backfill_complete = 1, last_sync_success_at = ? WHERE id = ?').run(
    finished.now,
    id,
  );
}
