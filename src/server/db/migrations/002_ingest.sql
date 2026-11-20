ALTER TABLE source_file ADD COLUMN normalization_version TEXT;
ALTER TABLE source_file ADD COLUMN codex_parent_id TEXT;
ALTER TABLE source_file ADD COLUMN codex_parent_version TEXT;
ALTER TABLE usage_event ADD COLUMN claude_sidechain INTEGER CHECK (claude_sidechain IN (0, 1));
ALTER TABLE usage_event ADD COLUMN claude_has_speed INTEGER CHECK (claude_has_speed IN (0, 1));

CREATE INDEX usage_event_source_file ON usage_event (source_file_id);
CREATE INDEX claude_usage_unranked ON usage_event (id)
  WHERE provider = 'claude' AND (claude_sidechain IS NULL OR claude_has_speed IS NULL);

CREATE TABLE claude_legacy_candidate (
  usage_event_id INTEGER PRIMARY KEY REFERENCES usage_event(id) ON DELETE CASCADE,
  candidate_session_id INTEGER NOT NULL REFERENCES session(id),
  owner_recovered INTEGER NOT NULL CHECK (owner_recovered IN (0, 1)),
  candidate_json TEXT NOT NULL
) STRICT;
CREATE INDEX claude_candidate_session ON claude_legacy_candidate (candidate_session_id);
