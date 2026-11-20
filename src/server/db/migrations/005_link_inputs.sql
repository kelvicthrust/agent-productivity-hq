-- Rebuild once on upgrade, then invalidate only when stored attribution inputs change.
UPDATE app_meta SET value = '1' WHERE key = 'links_dirty';

CREATE TRIGGER links_dirty_session_insert AFTER INSERT ON session
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_session_update AFTER UPDATE OF id, repo_id, git_branch, started_at, last_event_at ON session
WHEN NEW.id IS NOT OLD.id
  OR NEW.repo_id IS NOT OLD.repo_id
  OR NEW.git_branch IS NOT OLD.git_branch
  OR COALESCE(NEW.last_event_at, NEW.started_at) IS NOT COALESCE(OLD.last_event_at, OLD.started_at)
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_session_delete AFTER DELETE ON session
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_pull_request_insert AFTER INSERT ON pull_request
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_pull_request_update AFTER UPDATE OF node_id, repo_id, number, merged_at, head_ref, merge_commit_sha ON pull_request
WHEN NEW.node_id IS NOT OLD.node_id
  OR NEW.repo_id IS NOT OLD.repo_id
  OR NEW.number IS NOT OLD.number
  OR NEW.merged_at IS NOT OLD.merged_at
  OR NEW.head_ref IS NOT OLD.head_ref
  OR NEW.merge_commit_sha IS NOT OLD.merge_commit_sha
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_pull_request_delete AFTER DELETE ON pull_request
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_pr_commit_insert AFTER INSERT ON pr_commit
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_pr_commit_update AFTER UPDATE OF pr_node_id, sha ON pr_commit
WHEN NEW.pr_node_id IS NOT OLD.pr_node_id
  OR NEW.sha IS NOT OLD.sha
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_pr_commit_delete AFTER DELETE ON pr_commit
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_session_ref_insert AFTER INSERT ON session_ref
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_session_ref_update AFTER UPDATE OF session_id, kind, value, observed_at ON session_ref
WHEN NEW.session_id IS NOT OLD.session_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.value IS NOT OLD.value
  OR (NEW.kind = 'pr_url' AND NEW.observed_at IS NOT OLD.observed_at)
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_session_ref_delete AFTER DELETE ON session_ref
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_github_repo_slug_insert AFTER INSERT ON github_repo_slug
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_github_repo_slug_update AFTER UPDATE OF slug, repo_id, conflicted_at ON github_repo_slug
WHEN NEW.slug IS NOT OLD.slug
  OR NEW.repo_id IS NOT OLD.repo_id
  OR NEW.conflicted_at IS NOT OLD.conflicted_at
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;

CREATE TRIGGER links_dirty_github_repo_slug_delete AFTER DELETE ON github_repo_slug
BEGIN
  UPDATE app_meta SET value = '1' WHERE key = 'links_dirty' AND value <> '1';
END;
