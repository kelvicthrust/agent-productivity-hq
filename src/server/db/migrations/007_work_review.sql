-- Only derived notes, report text, evidence labels and metadata fingerprints are retained.
CREATE TABLE work_review_note (
  unit_key TEXT PRIMARY KEY,
  evidence_hash TEXT NOT NULL,
  source_hash TEXT,
  day_start INTEGER NOT NULL,
  notes_json TEXT NOT NULL,
  partial INTEGER NOT NULL
) STRICT;
CREATE TABLE work_review_version (
  scope_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  period_start INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  review_json TEXT NOT NULL,
  PRIMARY KEY (scope_key, version)
) STRICT;
