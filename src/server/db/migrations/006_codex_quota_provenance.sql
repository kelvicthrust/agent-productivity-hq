-- Window IDs such as primary and secondary do not identify the metered bucket.
ALTER TABLE account_snapshot ADD COLUMN codex_quota INTEGER NOT NULL DEFAULT 0
  CHECK (codex_quota = 0 OR (codex_quota = 1 AND account = 'chatgpt' AND kind = 'rate_limit'));
