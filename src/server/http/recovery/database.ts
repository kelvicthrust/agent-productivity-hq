import { renderRecoveryPage, shellQuote } from './layout.ts';

// The database can't be used: corrupt, a migration failed, a newer version wrote it, or it can't be opened. The same wording as the
// page in ../recovery.ts, on the shared layout. The page only tells the owner how to move the file aside; it never does.

export type DatabaseRecoveryReason = 'corrupt' | 'migration_failed' | 'newer_schema' | 'unreadable';

export interface DatabaseRecoveryInfo {
  reason: DatabaseRecoveryReason;
  dbPath: string;
  /** One short, safe sentence about what failed. */
  detail: string;
  /** The migration file that failed, when one did. */
  migrationFile?: string;
}

const HEADLINE: Record<DatabaseRecoveryReason, string> = {
  corrupt: 'The saved history can’t be read',
  migration_failed: 'The saved history couldn’t be updated',
  newer_schema: 'The saved history is from a newer version',
  unreadable: 'The saved history can’t be opened',
};

export function databaseRecoveryPage(info: DatabaseRecoveryInfo): string {
  const moved = `${info.dbPath}.old`;
  return renderRecoveryPage({
    title: 'Recovery',
    headline: HEADLINE[info.reason],
    lead: 'Agent Productivity HQ started, but it can’t use its database, so it is showing this page instead of your data.',
    notes: [info.detail],
    facts: [
      { label: 'The database file', value: info.dbPath },
      ...(info.migrationFile ? [{ label: 'The step that failed', value: info.migrationFile }] : []),
    ],
    stepsTitle: 'Move it aside and start fresh',
    steps: [
      { text: 'Stop Agent Productivity HQ (press Control-C in the terminal that started it).' },
      {
        text: 'Move the file aside, keeping it in case you want it back. Move any `-wal` and `-shm` files beside it too.',
        command: `mv ${shellQuote(info.dbPath)} ${shellQuote(moved)}`,
      },
      {
        text: 'Start Agent Productivity HQ again. It creates a new database and re-imports history from whatever logs still exist.',
      },
    ],
  });
}
