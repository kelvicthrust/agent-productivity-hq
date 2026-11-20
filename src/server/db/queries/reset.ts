import { randomUUID } from 'node:crypto';
import { inTransaction, type Db } from '../open.ts';
import { CHATGPT_DISCONNECTED, GITHUB_APP_DISCONNECTED } from './accounts.ts';
import { setMeta } from './meta.ts';
import { SETUP_RESET_PENDING } from './setup.ts';

export function clearAppData(db: Db, timezone: string): void {
  // Overwrite deleted content in SQLite pages.
  db.exec('PRAGMA secure_delete = ON');
  inTransaction(db, () => {
    db.exec(`
      DELETE FROM owner_link_decision;
      DELETE FROM pr_session_link;
      DELETE FROM pr_commit;
      DELETE FROM pull_request;
      DELETE FROM github_repo_slug;
      DELETE FROM github_sync_pass;
      DELETE FROM repo;
      DELETE FROM session_ref;
      DELETE FROM usage_event;
      DELETE FROM claude_legacy_candidate;
      DELETE FROM session;
      DELETE FROM source_file;
      DELETE FROM paseo_agent;
      DELETE FROM source_state;
      DELETE FROM account_daily_tokens;
      DELETE FROM account_snapshot;
      DELETE FROM chatgpt_report_read;
      DELETE FROM refresh_run;
      DELETE FROM app_meta WHERE key <> 'schema_version';
    `);
    setMeta(db, 'install_id', randomUUID());
    setMeta(db, 'report_timezone', timezone);
    setMeta(db, SETUP_RESET_PENDING, '1');
    setMeta(db, 'github_gh_disconnected', '1');
    setMeta(db, GITHUB_APP_DISCONNECTED, '1');
    setMeta(db, CHATGPT_DISCONNECTED, '1');
  });
}

/** An external SQLite reader can keep old WAL frames alive until it releases its transaction. */
export function checkpointResetData(db: Db): boolean {
  return db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.['busy'] === 0;
}
