-- 001_init.sql: the first schema, copied from docs/tech/data-and-sources.md (Persistence). All tables are STRICT; every
-- timestamp is UTC epoch milliseconds. Migrations never drop owner decisions (owner_link_decision) or repo lists (repo).
-- Run by src/server/db/migrate.ts inside one transaction, which also records app_meta.schema_version.
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  -- schema_version, install_id, setup_completed_at, report_timezone, github_login

CREATE TABLE source_state (
  source_id TEXT PRIMARY KEY CHECK (source_id IN ('codex','claude','paseo','github','chatgpt_account','claude_account')),
  status TEXT NOT NULL, location TEXT, oldest_event_at INTEGER, last_success_at INTEGER,
  last_attempt_at INTEGER, last_attempt_result TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,   -- T5: reset to 0 by any succeeded/partial attempt; +1 per failed attempt; drives "failed again"
  error_code TEXT, error_detail TEXT,
  unreadable_count INTEGER NOT NULL DEFAULT 0, unsupported_count INTEGER NOT NULL DEFAULT 0,
  adapter_version TEXT, extra_json TEXT) STRICT;

CREATE TABLE source_file (
  id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, head_hash TEXT NOT NULL,   -- sha256 of first 4 KiB
  read_offset INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,                  -- ok|partial|unreadable|unsupported|skipped
  unreadable_lines INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER) STRICT;

CREATE TABLE session (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL CHECK (provider IN ('codex','claude')),
  provider_session_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('root','child','unknown')),
  parent_session_id INTEGER REFERENCES session(id), parent_basis TEXT CHECK (parent_basis IN ('native','paseo')),
  native_kind TEXT,                         -- e.g. 'claude_subagent','codex_subagent','paseo'
  recorded_name TEXT, name_source TEXT,     -- 'provider_title'|'paseo'
  repo_id TEXT, repo_basis TEXT, cwd TEXT, git_branch TEXT,
  paseo_agent_id TEXT REFERENCES paseo_agent(id), workspace_label TEXT,
  started_at INTEGER NOT NULL,              -- T5: the "Started" time. Set once, only ever moved earlier, never recomputed from pruned events
  started_basis TEXT NOT NULL CHECK (started_basis IN ('source_start','first_event')),
  first_event_at INTEGER, last_event_at INTEGER, last_model TEXT,
  UNIQUE (provider, provider_session_id)) STRICT;

CREATE TABLE usage_event (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES session(id), occurred_at INTEGER NOT NULL,  -- epoch ms UTC
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,          -- codex: includes cached; claude: uncached only
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,   -- codex subset of input
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,    -- claude separate category
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,     -- claude separate category
  output_tokens INTEGER NOT NULL DEFAULT 0,         -- codex: includes reasoning
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,      -- codex subset of output
  provider_total INTEGER NOT NULL,                  -- codex: input+output; claude: input+cache_write+cache_read+output
  source_file_id INTEGER REFERENCES source_file(id),
  UNIQUE (provider, dedupe_key)) STRICT;
CREATE INDEX usage_event_time ON usage_event (occurred_at);
CREATE INDEX usage_event_session ON usage_event (session_id, occurred_at);

CREATE TABLE session_ref (
  session_id INTEGER NOT NULL REFERENCES session(id), kind TEXT NOT NULL CHECK (kind IN ('pr_url','commit','branch')),
  value TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY (session_id, kind, value)) STRICT;
CREATE INDEX session_ref_value ON session_ref (kind, value);

CREATE TABLE paseo_agent (
  id TEXT PRIMARY KEY, title TEXT, provider TEXT, provider_session_id TEXT, parent_agent_id TEXT,
  workspace_id TEXT, workspace_label TEXT, cwd TEXT, background INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL) STRICT;

CREATE TABLE repo (
  id TEXT PRIMARY KEY,                    -- lowercased owner/name (canonical)
  github_node_id TEXT UNIQUE, display_name TEXT NOT NULL,
  tracking_state TEXT NOT NULL CHECK (tracking_state IN ('active','stopped')),
  access_state TEXT NOT NULL CHECK (access_state IN ('ok','inaccessible','unknown')),
  access_error TEXT, added_at INTEGER NOT NULL, stopped_at INTEGER,
  backfill_complete INTEGER NOT NULL DEFAULT 0, last_sync_started_at INTEGER, last_sync_success_at INTEGER) STRICT;

CREATE TABLE pull_request (
  node_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id), number INTEGER NOT NULL,
  title TEXT NOT NULL, url TEXT NOT NULL, author_login TEXT, merged_by_login TEXT,
  merged_at INTEGER NOT NULL, head_ref TEXT, base_ref TEXT, merge_commit_sha TEXT,
  commits_complete INTEGER NOT NULL DEFAULT 1, UNIQUE (repo_id, number)) STRICT;
CREATE INDEX pull_request_merged ON pull_request (merged_at);
CREATE TABLE pr_commit (pr_node_id TEXT NOT NULL REFERENCES pull_request(node_id), sha TEXT NOT NULL, PRIMARY KEY (pr_node_id, sha)) STRICT;

CREATE TABLE pr_session_link (                   -- computed; rebuilt per refresh
  pr_node_id TEXT NOT NULL, session_id INTEGER NOT NULL, class TEXT NOT NULL CHECK (class IN ('evidence','suggested')),
  basis TEXT NOT NULL, computed_at INTEGER NOT NULL, PRIMARY KEY (pr_node_id, session_id)) STRICT;
CREATE TABLE owner_link_decision (               -- owner-authored; never rebuilt
  pr_node_id TEXT NOT NULL, session_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('confirmed','rejected','dismissed')),
  prior_class TEXT, prior_basis TEXT, decided_at INTEGER NOT NULL, PRIMARY KEY (pr_node_id, session_id)) STRICT;

CREATE TABLE account_daily_tokens (account TEXT NOT NULL, date TEXT NOT NULL, tokens INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (account, date)) STRICT;
CREATE TABLE account_snapshot (
  account TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('lifetime_tokens','rate_limit')), limit_id TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL CHECK (unit IN ('tokens','percent')), value REAL, window_minutes INTEGER, resets_at INTEGER,
  fetched_at INTEGER NOT NULL, PRIMARY KEY (account, kind, limit_id)) STRICT;

CREATE TABLE refresh_run (
  id INTEGER PRIMARY KEY, trigger TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('running','succeeded','partial','failed','interrupted')),
  per_source_json TEXT NOT NULL) STRICT;
