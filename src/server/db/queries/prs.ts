import { inTransaction, type Db } from '../open.ts';

// Merged pull requests (TECH › GitHub delivery). Only merged PRs are ever stored: `merged_at` is NOT NULL, so a PR closed
// without a merge has no way in (P-19). Author and merger are separate columns (P-20). Everything that reads a period takes
// `[fromMs, toMs)` in epoch milliseconds: the service turns report-timezone dates into UTC bounds (`utcBounds`), so a merge at
// 23:59 local belongs to its day and one at 00:00 to the next, DST days included.
//
// The active views read PRs of repos that are tracked AND reachable: a stopped repo has left them, and an inaccessible one is
// excluded with a notice (TECH › Failure modes); its rows are kept either way.

export interface PullRequestInput {
  /** GitHub's node id: one row per PR, ever (P-15, P-25). */
  nodeId: string;
  /** Canonical (lowercased `owner/name`) id of a repo that already has a row. */
  repoId: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  mergedByLogin: string | null;
  /** Epoch ms the PR was merged. */
  mergedAt: number;
  headRef: string | null;
  baseRef: string | null;
  mergeCommitSha: string | null;
  /** Commit shas read so far (identifiers only). */
  commits: readonly string[];
  /** False when the PR has more commits than were read, so a follow-up page is still owed. */
  commitsComplete: boolean;
  /** Identifies the commit list observed in GraphQL, so matching REST progress can be reused. */
  commitsSignature?: string;
  commitsNextPage?: number;
}

/**
 * Writes one page of PRs in one transaction, so a sync that stops after a page keeps that page. Upsert on the node id:
 * running a sync again, or tracking a repo again, changes rows and never adds a second one. Returns how many were new.
 */
export function upsertPullRequests(
  db: Db,
  prs: readonly PullRequestInput[],
): { inserted: number; updated: number } {
  let inserted = 0;
  let updated = 0;
  const write = () => {
    const exists = db.prepare('SELECT 1 AS present FROM pull_request WHERE node_id = ?');
    const upsert = db.prepare(
      `INSERT INTO pull_request (node_id, repo_id, number, title, url, author_login, merged_by_login, merged_at, head_ref,
         base_ref, merge_commit_sha, commits_complete, commits_signature, commits_next_page)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (node_id) DO UPDATE SET repo_id = excluded.repo_id, number = excluded.number, title = excluded.title,
         url = excluded.url, author_login = excluded.author_login, merged_by_login = excluded.merged_by_login,
         merged_at = excluded.merged_at, head_ref = excluded.head_ref, base_ref = excluded.base_ref,
         merge_commit_sha = excluded.merge_commit_sha,
         commits_complete = CASE WHEN pull_request.commits_signature = excluded.commits_signature
           THEN MAX(pull_request.commits_complete, excluded.commits_complete) ELSE excluded.commits_complete END,
         commits_next_page = CASE WHEN pull_request.commits_signature = excluded.commits_signature
           THEN pull_request.commits_next_page ELSE excluded.commits_next_page END,
         commits_signature = excluded.commits_signature`,
    );
    const addCommit = db.prepare('INSERT OR IGNORE INTO pr_commit (pr_node_id, sha) VALUES (?, ?)');
    for (const pr of prs) {
      const known = exists.get(pr.nodeId) !== undefined;
      upsert.run(
        pr.nodeId,
        pr.repoId,
        pr.number,
        pr.title,
        pr.url,
        pr.authorLogin,
        pr.mergedByLogin,
        pr.mergedAt,
        pr.headRef,
        pr.baseRef,
        pr.mergeCommitSha,
        pr.commitsComplete ? 1 : 0,
        pr.commitsSignature ?? null,
        pr.commitsNextPage ?? 2,
      );
      for (const sha of pr.commits) addCommit.run(pr.nodeId, sha);
      if (known) updated += 1;
      else inserted += 1;
    }
  };
  if (db.isTransaction) write();
  else inTransaction(db, write);
  return { inserted, updated };
}

/** Adds the commits a follow-up page returned for a PR that had more than the first page held. */
export function addPullRequestCommits(
  db: Db,
  nodeId: string,
  shas: readonly string[],
  complete: boolean,
  page = 1,
): void {
  inTransaction(db, () => {
    const add = db.prepare('INSERT OR IGNORE INTO pr_commit (pr_node_id, sha) VALUES (?, ?)');
    for (const sha of shas) add.run(nodeId, sha);
    db.prepare(
      'UPDATE pull_request SET commits_complete = ?, commits_next_page = ? WHERE node_id = ?',
    ).run(complete ? 1 : 0, page + 1, nodeId);
  });
}

/** PRs the sync still owes a follow-up commit page for (more than the first 100 commits). */
export function listPullRequestsWithMoreCommits(
  db: Db,
  repoId: string,
): { nodeId: string; number: number; nextPage: number }[] {
  return (
    db
      .prepare(
        'SELECT node_id, number, commits_next_page FROM pull_request WHERE repo_id = ? AND commits_complete = 0 ORDER BY number',
      )
      .all(repoId) as { node_id: string; number: number; commits_next_page: number }[]
  ).map((row) => ({ nodeId: row.node_id, number: row.number, nextPage: row.commits_next_page }));
}

// ---- reading for the views ----

/** Includes retained rows from repos that are stopped or cannot currently be read. */
export function hasRetainedPullRequests(db: Db): boolean {
  return db.prepare('SELECT 1 FROM pull_request LIMIT 1').get() !== undefined;
}

export interface PrFilter {
  /** Merged at or after this instant (epoch ms). */
  fromMs: number;
  /** Merged before this instant. */
  toMs: number;
  /** Canonical repo ids. Empty means every tracked, reachable repo. */
  repos: readonly string[];
  /**
   * `mine` keeps PRs whose AUTHOR is this login (compared without case); with no login known nothing is mine.
   * `all` keeps every merge. The merger never decides.
   */
  author: { mode: 'mine'; login: string | null } | { mode: 'all' };
  /** Matches the title, `owner/name`, `#number` and `owner/name#number`, ignoring case. */
  search?: string | undefined;
}

export interface PrCursor {
  mergedAt: number;
  nodeId: string;
}

export interface PrRow {
  nodeId: string;
  repoId: string;
  repoDisplayName: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  mergedByLogin: string | null;
  mergedAt: number;
}

interface RawPr {
  node_id: string;
  repo_id: string;
  display_name: string;
  number: number;
  title: string;
  url: string;
  author_login: string | null;
  merged_by_login: string | null;
  merged_at: number;
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The WHERE clause and its arguments shared by the list, the count and the merge times. */
function where(
  filter: PrFilter,
  extra?: { after?: PrCursor },
): { sql: string; args: (string | number)[] } {
  const parts = [
    "r.tracking_state = 'active'",
    "r.access_state <> 'inaccessible'",
    'p.merged_at >= ?',
    'p.merged_at < ?',
  ];
  const args: (string | number)[] = [filter.fromMs, filter.toMs];
  if (filter.repos.length > 0) {
    parts.push(`p.repo_id IN (
      SELECT COALESCE(a.repo_id, f.value) FROM json_each(?) f
      LEFT JOIN github_repo_slug a ON a.slug = f.value AND a.conflicted_at IS NULL
    )`);
    args.push(JSON.stringify(filter.repos));
  }
  if (filter.author.mode === 'mine') {
    if (filter.author.login === null) parts.push('0 = 1');
    else {
      parts.push('lower(p.author_login) = lower(?)');
      args.push(filter.author.login);
    }
  }
  const search = filter.search?.trim();
  if (search) {
    parts.push(
      `(lower(p.title || ' ' || p.repo_id || ' #' || p.number || ' ' || p.repo_id || '#' || p.number) LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM github_repo_slug a WHERE a.repo_id = p.repo_id AND a.conflicted_at IS NULL
                    AND lower(a.slug || ' ' || a.slug || '#' || p.number) LIKE ? ESCAPE '\\'))`,
    );
    const pattern = `%${escapeLike(search.toLowerCase())}%`;
    args.push(pattern, pattern);
  }
  if (extra?.after) {
    parts.push('(p.merged_at < ? OR (p.merged_at = ? AND p.node_id < ?))');
    args.push(extra.after.mergedAt, extra.after.mergedAt, extra.after.nodeId);
  }
  return { sql: parts.join(' AND '), args };
}

const FROM = 'FROM pull_request p JOIN repo r ON r.id = p.repo_id';

/** Newest merge first; ties by node id, so a cursor never skips or repeats a row. Asks for `limit + 1` so the caller can see a next page. */
export function listPullRequests(
  db: Db,
  filter: PrFilter,
  page: { limit: number; after?: PrCursor },
): PrRow[] {
  const { sql, args } = where(filter, page.after ? { after: page.after } : {});
  const rows = db
    .prepare(
      `SELECT p.node_id, p.repo_id, r.display_name, p.number, p.title, p.url, p.author_login, p.merged_by_login, p.merged_at
         ${FROM} WHERE ${sql} ORDER BY p.merged_at DESC, p.node_id DESC LIMIT ?`,
    )
    .all(...args, page.limit + 1) as unknown as RawPr[];
  return rows.map((row) => ({
    nodeId: row.node_id,
    repoId: row.repo_id,
    repoDisplayName: row.display_name,
    number: row.number,
    title: row.title,
    url: row.url,
    authorLogin: row.author_login,
    mergedByLogin: row.merged_by_login,
    mergedAt: row.merged_at,
  }));
}

/** How many PRs the filter keeps, ignoring any page. */
export function countPullRequests(db: Db, filter: PrFilter): number {
  const { sql, args } = where(filter);
  const row = db.prepare(`SELECT COUNT(*) AS n ${FROM} WHERE ${sql}`).get(...args) as { n: number };
  return row.n;
}

/** The merge instants the filter keeps, for the year grid: the service puts each in its report-timezone day. */
export function listMergeTimes(db: Db, filter: Omit<PrFilter, 'search'>): number[] {
  const { sql, args } = where(filter);
  return (
    db.prepare(`SELECT p.merged_at ${FROM} WHERE ${sql} ORDER BY p.merged_at`).all(...args) as {
      merged_at: number;
    }[]
  ).map((row) => row.merged_at);
}

/** Active repos GitHub no longer grants (named in a notice, their PRs excluded). */
export function listInaccessibleActiveRepos(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT id FROM repo WHERE tracking_state = 'active' AND access_state = 'inaccessible' ORDER BY id",
      )
      .all() as { id: string }[]
  ).map((row) => row.id);
}

/** True while an active, reachable repo is still on its first (or a restarted) backfill, so the year and the table say "syncing". */
export function anyRepoBackfilling(db: Db): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM repo WHERE tracking_state = 'active' AND access_state <> 'inaccessible' AND backfill_complete = 0",
    )
    .get() as { n: number };
  return row.n > 0;
}

/** Tracked, reachable repos: with none, delivery is `none` rather than a covered zero. */
export function countTrackedReachableRepos(db: Db): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM repo WHERE tracking_state = 'active' AND access_state <> 'inaccessible'",
    )
    .get() as { n: number };
  return row.n;
}
