import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  createPaseoAdapter,
  type PaseoClientLike,
  type PaseoListEntry,
  type PaseoListOptions,
  type PaseoListResult,
  type PaseoOpen,
} from '../../../src/server/collectors/paseo/index.ts';
import type { AdapterReport } from '../../../src/server/collectors/types.ts';
import { upsertSession } from '../../../src/server/db/queries/usage.ts';
import { NOW, memoryDb, memoryLogger } from '../../server/helpers.ts';

// Shared by the Paseo adapter tests. The daemon is a fake client over the DRAFT, invented fixtures in test/fixtures/paseo: nothing
// here opens a socket, reads a real Paseo or knows a real title, folder or id.

export { NOW, memoryDb };

const FIXTURES = join(import.meta.dirname, '../../fixtures/paseo');

/** The ids in daemon-ok.json: each agent, and the session id it names (`runtimeInfo.sessionId`). */
export const OK = {
  parentAgent: 'a0000000-0000-4000-8000-000000000001',
  parentSession: 'c0de0000-0000-4000-8000-000000000001',
  childAgent: 'a0000000-0000-4000-8000-000000000002',
  childSession: 'c0de0000-0000-4000-8000-000000000002',
  claudeAgent: 'a0000000-0000-4000-8000-000000000003',
  claudeSession: 'ca5e0000-0000-4000-8000-000000000003',
  noSessionAgent: 'a0000000-0000-4000-8000-000000000004',
  archivedAgent: 'a0000000-0000-4000-8000-000000000005',
  archivedSession: 'c0de0000-0000-4000-8000-000000000005',
  archivedAt: Date.parse('2026-11-01T09:00:00Z'),
} as const;

/** The ids in daemon-mismatch.json. Its one Codex agent names a parent that the daemon does not list. */
export const MISMATCH = {
  agent: 'b0000000-0000-4000-8000-000000000001',
  session: 'dead0000-0000-4000-8000-000000000001',
} as const;

interface FixtureFile {
  connect: 'ok' | 'refused' | 'password';
  archivedListing?: 'supported' | 'unsupported';
  agents?: PaseoListEntry[];
  archived?: PaseoListEntry[];
}

export const fixture = (name: 'ok' | 'mismatch' | 'password' | 'down'): FixtureFile =>
  JSON.parse(readFileSync(join(FIXTURES, `daemon-${name}.json`), 'utf8')) as FixtureFile;

/** What the real SDK throws for each way a connect can end (probed against @getpaseo/client 0.15.3). */
export const connectErrors = {
  /** A refused loopback connection: the SDK has no ECONNREFUSED to give, only the socket's close. */
  refused: (): Error => new Error('Transport closed (code 1006)'),
  /** `DaemonAuthenticationError`, thrown by `connect()` when the daemon wants a password. */
  password: (): Error =>
    Object.assign(new Error('Password required'), { name: 'DaemonAuthenticationError' }),
  timeout: (): Error => new Error('Connection timed out'),
};

export interface FakeDaemon {
  open: PaseoOpen;
  /** Every address the adapter opened a client for. */
  opened: string[];
  /** Every `agents.list` request, as the adapter sent it. */
  lists: PaseoListOptions[];
  /** How many times the adapter called `connect()`, and `close()`. */
  connects: number;
  closes: number;
}

/**
 * A client that answers like the fixture: `connect` ends as the file says, and `agents.list` gives its `agents`, plus `archived`
 * when archived agents are asked for and the file says the daemon supports that. One page.
 */
export function daemonFrom(file: FixtureFile): FakeDaemon {
  return daemonWith({
    connect: () => {
      if (file.connect === 'refused') throw connectErrors.refused();
      if (file.connect === 'password') throw connectErrors.password();
    },
    list: (options) => {
      if (options.filter.includeArchived && file.archivedListing === 'unsupported')
        throw new Error('archived listing is not supported');
      const entries = [
        ...(file.agents ?? []),
        ...(options.filter.includeArchived ? (file.archived ?? []) : []),
      ];
      return { entries, pageInfo: { hasMore: false, nextCursor: null } };
    },
  });
}

/** A fake client with its own behaviour for connect and list, counting what the adapter does to it. */
export function daemonWith(behaviour: {
  connect?: () => void | Promise<void>;
  list?: (options: PaseoListOptions) => PaseoListResult | Promise<PaseoListResult>;
  open?: () => void;
}): FakeDaemon {
  const daemon: FakeDaemon = {
    opened: [],
    lists: [],
    connects: 0,
    closes: 0,
    open: (url) => {
      daemon.opened.push(url);
      behaviour.open?.();
      const client: PaseoClientLike = {
        connect: async () => {
          daemon.connects += 1;
          await behaviour.connect?.();
        },
        close: () => {
          daemon.closes += 1;
          return Promise.resolve();
        },
        agents: {
          list: async (options) => {
            daemon.lists.push(structuredClone(options));
            return (
              (await behaviour.list?.(options)) ?? {
                entries: [],
                pageInfo: { hasMore: false, nextCursor: null },
              }
            );
          },
        },
      };
      return client;
    },
  };
  return daemon;
}

export interface Run {
  report: AdapterReport;
  logs: Record<string, unknown>[];
}

/** One attempt of the adapter on a database, with a fixed clock (override `now` to move it). */
export async function refresh(
  db: DatabaseSync,
  open: PaseoOpen,
  options: { url?: string; now?: number } = {},
): Promise<Run> {
  const { logger, entries } = memoryLogger('debug');
  const adapter = createPaseoAdapter({ open, ...(options.url ? { url: options.url } : {}) });
  const report = await adapter.refresh({
    db,
    now: () => options.now ?? NOW,
    logger,
    progress: () => {},
  });
  return { report, logs: entries };
}

/** A session Codex or Claude Code already imported, with one usage event so a total can be checked afterwards. */
export function seedSession(
  db: DatabaseSync,
  provider: 'codex' | 'claude',
  providerSessionId: string,
  extra: Partial<Parameters<typeof upsertSession>[1]> = {},
): number {
  const id = upsertSession(db, {
    provider,
    providerSessionId,
    kind: 'root',
    startedAt: NOW - 86_400_000,
    startedBasis: 'source_start',
    ...extra,
  });
  db.prepare(
    `INSERT OR IGNORE INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total)
     VALUES (?, ?, ?, ?, 'm', 100)`,
  ).run(provider, `${providerSessionId}:e1`, id, NOW - 86_400_000);
  return id;
}

export const sessionRow = (db: DatabaseSync, id: number): Record<string, unknown> =>
  db
    .prepare(
      `SELECT kind, parent_session_id, parent_basis, native_kind, recorded_name, name_source, paseo_agent_id, workspace_label
         FROM session WHERE id = ?`,
    )
    .get(id) as Record<string, unknown>;

/** Every usage event, so a test can show Paseo changed none of them. */
export const usageEvents = (db: DatabaseSync): unknown[] =>
  db.prepare('SELECT * FROM usage_event ORDER BY id').all();

export const sourceRow = (db: DatabaseSync): Record<string, unknown> | undefined =>
  db.prepare("SELECT * FROM source_state WHERE source_id = 'paseo'").get() as
    Record<string, unknown> | undefined;
