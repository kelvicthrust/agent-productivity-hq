import type { Db } from '../open.ts';

// HQ's one read of the database: the name and repo already stored for sessions the live transcript feeds have found. Read-only (a
// SELECT and nothing else), and it reads only the columns named here; the transcript's own text is never a source of a name.

export type LiveSessionProvider = 'claude' | 'codex';

export interface LiveSessionKey {
  provider: LiveSessionProvider;
  sessionId: string;
}

export interface LiveSessionLabel {
  /** The recorded name (`session.recorded_name`), whoever recorded it: the provider's own title or Paseo's. */
  title: string | null;
  /** `owner/name`, as stored. */
  repo: string | null;
  workspace: string | null;
}

/** The map key for a session. */
export const liveSessionKey = (provider: LiveSessionProvider, sessionId: string): string =>
  `${provider}:${sessionId}`;

// SQLite allows at least 999 variables in a statement; the feeds follow at most 48 files each, so one query per provider is far under it.
const CHUNK = 200;

interface Row {
  provider: LiveSessionProvider;
  provider_session_id: string;
  recorded_name: string | null;
  repo_id: string | null;
  workspace_label: string | null;
}

/**
 * The stored label of each session in `keys` that has been imported; a session that has not been is absent from the result (its title is
 * null and its repo comes from its working directory). Keyed by `liveSessionKey`.
 */
export function readLiveSessionLabels(
  db: Db,
  keys: readonly LiveSessionKey[],
): Map<string, LiveSessionLabel> {
  const labels = new Map<string, LiveSessionLabel>();
  for (const provider of ['claude', 'codex'] as const) {
    const ids = [
      ...new Set(keys.filter((key) => key.provider === provider).map((key) => key.sessionId)),
    ];
    for (let at = 0; at < ids.length; at += CHUNK) {
      const chunk = ids.slice(at, at + CHUNK);
      const rows = db
        .prepare(
          `SELECT provider, provider_session_id, recorded_name, repo_id, workspace_label FROM session
           WHERE provider = ? AND provider_session_id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .all(provider, ...chunk) as unknown as Row[];
      for (const row of rows) {
        labels.set(liveSessionKey(row.provider, row.provider_session_id), {
          title: row.recorded_name,
          repo: row.repo_id,
          workspace: row.workspace_label,
        });
      }
    }
  }
  return labels;
}
