import { inTransaction, type Db } from '../open.ts';
import { getMeta, setMeta } from './meta.ts';
import { upsertPullRequests, type PullRequestInput } from './prs.ts';
import {
  getRepo,
  markSyncFinished,
  markSyncStarted,
  recordRepoIdentity,
  setRepoAccess,
  type RepoRecord,
} from './repos.ts';

export interface GithubPass {
  phase: 'backfill' | 'catch_up' | 'incremental';
  startedAt: number;
  cutoffAt: number;
  cursor: string | null;
}

export function beginGithubPass(
  db: Db,
  repo: RepoRecord,
  now: number,
  cutoffAt: number,
): GithubPass {
  return inTransaction(db, () => {
    setMeta(db, 'github_last_repo', repo.id);
    const saved = db
      .prepare(
        'SELECT phase, started_at AS startedAt, cutoff_at AS cutoffAt, cursor FROM github_sync_pass WHERE repo_id = ?',
      )
      .get(repo.id) as GithubPass | undefined;
    if (saved) return saved;
    const phase = repo.backfillComplete ? 'incremental' : 'backfill';
    db.prepare(
      'INSERT INTO github_sync_pass (repo_id, phase, started_at, cutoff_at, cursor) VALUES (?, ?, ?, ?, NULL)',
    ).run(repo.id, phase, now, cutoffAt);
    markSyncStarted(db, repo.id, now);
    return { phase, startedAt: now, cutoffAt, cursor: null };
  });
}

export function clearGithubCursor(db: Db, repoId: string, pass: GithubPass): boolean {
  const reset = db
    .prepare(
      'UPDATE github_sync_pass SET cursor = NULL WHERE repo_id = ? AND phase = ? AND started_at = ? AND cursor IS ?',
    )
    .run(repoId, pass.phase, pass.startedAt, pass.cursor);
  return reset.changes === 1;
}

/** Persists the response and its checkpoint together. A stop during the request removes the pass. */
export function saveGithubPage(
  db: Db,
  repoId: string,
  page: {
    identity: { id: string; nodeId: string; displayName: string };
    prs: readonly PullRequestInput[];
    pass: GithubPass;
    next: GithubPass | null;
    finishedAt: number;
    limitedUntil: number | null;
  },
): { inserted: number; updated: number } | 'stopped' | 'identity_conflict' {
  return inTransaction(db, () => {
    if (page.limitedUntil !== null) setGithubCooldown(db, page.limitedUntil);
    const repo = getRepo(db, repoId);
    const current = db
      .prepare(
        'SELECT 1 FROM github_sync_pass WHERE repo_id = ? AND phase = ? AND started_at = ? AND cursor IS ?',
      )
      .get(repoId, page.pass.phase, page.pass.startedAt, page.pass.cursor);
    if (!repo || repo.trackingState !== 'active' || !current) return 'stopped';
    if (!recordRepoIdentity(db, repo, page.identity, page.finishedAt).matches) {
      return 'identity_conflict';
    }
    if (repo.accessState !== 'ok') setRepoAccess(db, repoId, { state: 'ok' });
    const written = upsertPullRequests(db, page.prs);
    if (page.next) {
      db.prepare(
        'UPDATE github_sync_pass SET phase = ?, cutoff_at = ?, cursor = ? WHERE repo_id = ?',
      ).run(page.next.phase, page.next.cutoffAt, page.next.cursor, repoId);
    } else {
      db.prepare('DELETE FROM github_sync_pass WHERE repo_id = ?').run(repoId);
      db.prepare('UPDATE repo SET github_complete_started_at = ? WHERE id = ?').run(
        page.pass.startedAt,
        repoId,
      );
      markSyncFinished(db, repoId, { now: page.finishedAt, complete: true });
    }
    return written;
  });
}

export function setGithubCooldown(db: Db, until: number): void {
  setMeta(db, 'github_cooldown_until', String(until));
}

export function githubCooldown(db: Db): number {
  return Number(getMeta(db, 'github_cooldown_until') ?? 0);
}

export function rotateGithubRepos(db: Db, sorted: RepoRecord[]): RepoRecord[] {
  const last = getMeta(db, 'github_last_repo');
  if (last === null) return sorted;
  const next = sorted.findIndex((repo) => repo.id > last);
  return next > 0 ? [...sorted.slice(next), ...sorted.slice(0, next)] : sorted;
}
