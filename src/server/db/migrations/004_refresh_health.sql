ALTER TABLE refresh_run ADD COLUMN link_rebuild_result TEXT
  CHECK (link_rebuild_result IN ('pending','succeeded','failed','interrupted'));

-- Existing rows prove a prior computation, but pre-upgrade runs did not track rebuild failures.
INSERT INTO app_meta (key, value)
SELECT 'links_last_rebuilt_at', CAST(MAX(computed_at) AS TEXT) FROM pr_session_link HAVING COUNT(*) > 0;
INSERT INTO app_meta (key, value) VALUES ('links_dirty', '1');

CREATE TABLE chatgpt_report_read (
  component TEXT PRIMARY KEY CHECK (component IN ('tokens','limits')),
  result TEXT NOT NULL CHECK (result IN ('succeeded','failed')),
  attempted_at INTEGER NOT NULL,
  last_succeeded_at INTEGER
) STRICT;
