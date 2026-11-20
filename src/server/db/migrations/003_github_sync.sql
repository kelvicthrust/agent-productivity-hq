-- Keep the original local repo id when GitHub changes a repository's name.
ALTER TABLE repo ADD COLUMN github_slug TEXT;
ALTER TABLE repo ADD COLUMN github_complete_started_at INTEGER;

CREATE TABLE github_repo_slug (
  slug TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repo(id),
  -- The first verified conflict disables new associations and bounds historical PR-reference matching.
  conflicted_at INTEGER
) STRICT;
CREATE INDEX github_repo_slug_repo ON github_repo_slug (repo_id);

CREATE TABLE github_sync_pass (
  repo_id TEXT PRIMARY KEY REFERENCES repo(id),
  phase TEXT NOT NULL CHECK (phase IN ('backfill', 'catch_up', 'incremental')),
  started_at INTEGER NOT NULL,
  cutoff_at INTEGER NOT NULL,
  cursor TEXT
) STRICT;

ALTER TABLE pull_request ADD COLUMN commits_signature TEXT;
ALTER TABLE pull_request ADD COLUMN commits_next_page INTEGER NOT NULL DEFAULT 2;
