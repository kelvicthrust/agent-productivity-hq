import type { Db } from '../open.ts';
import { getMeta } from './meta.ts';

export interface BootstrapRows {
  setupComplete: boolean;
  githubLogin: string | null;
  greetingName: string | null;
  /** Sources and accounts that need attention, then tracked repos GitHub no longer grants access to. */
  attention: {
    kind: 'source' | 'account' | 'repo';
    id: string;
    status: string;
    displayName: string;
  }[];
}

const ACCOUNT_SOURCES = new Set(['github', 'chatgpt_account', 'claude_account']);

export function readBootstrapRows(db: Db): BootstrapRows {
  const sources = db
    .prepare(
      "SELECT source_id, status FROM source_state WHERE status IN ('failed', 'denied', 'needspassword')" +
        " ORDER BY source_id IN ('github', 'chatgpt_account', 'claude_account'), source_id",
    )
    .all() as { source_id: string; status: string }[];
  const repos = db
    .prepare(
      "SELECT id, display_name FROM repo WHERE tracking_state = 'active' AND access_state = 'inaccessible' ORDER BY id",
    )
    .all() as { id: string; display_name: string }[];

  return {
    setupComplete: getMeta(db, 'setup_completed_at') !== null,
    githubLogin: getMeta(db, 'github_login'),
    greetingName: getMeta(db, 'github_name'),
    attention: [
      ...sources.map((s) => ({
        kind: (ACCOUNT_SOURCES.has(s.source_id) ? 'account' : 'source') as 'source' | 'account',
        id: s.source_id,
        status: s.status,
        displayName: s.source_id,
      })),
      ...repos.map((r) => ({
        kind: 'repo' as const,
        id: r.id,
        status: 'inaccessible',
        displayName: r.display_name,
      })),
    ],
  };
}
