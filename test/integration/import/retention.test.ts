import { describe, expect, it } from 'vitest';
import { boot, type ListenFn } from '../../../src/server/boot.ts';
import { ensureDir } from '../../../src/server/lib/fsModes.ts';
import { getSourceState } from '../../../src/server/db/queries/sources.ts';
import {
  readLinkHealth,
  recordComputedLinksSuccess,
} from '../../../src/server/db/queries/link-health.ts';
import { RETENTION_DAYS as FROM_DOMAIN } from '../../../src/shared/domain/coverage.ts';
import { dateInZone } from '../../../src/shared/domain/periods.ts';
import { RETENTION_DAYS, runRetention } from '../../../src/server/services/retention.ts';
import { memoryLogger, tempConfig } from '../../server/helpers.ts';
import { TZ, history, makeHome, sessionSums, startMachine } from './helpers.ts';

// Retention (P-29) on history that came through the real adapters: what is older than today minus 366 days goes (events, then the
// sessions left with none), what is newer stays, and repos, owner decisions on PRs that are still held, and settings are never
// touched. The fixture logs are INVENTED: Codex's archived rollout is from 2026-09-28, everything else from 2026-10-12 or later.

/** 2027-10-02, noon in Los Angeles: today minus 366 days is 2026-10-01, so the September rollout is past the line and October is not. */
const LATER = Date.parse('2027-10-02T19:00:00Z');
const CUTOFF = '2026-10-01';
const ARCHIVED = 'cccccccc-3333-4333-8333-00000000000c';
const fakeListen: ListenFn = async () => ({ close: (callback) => callback?.() });

const oldestDate = (db: Parameters<typeof getSourceState>[0], id: string): string | null => {
  const at = getSourceState(db, id)?.oldestEventAt ?? null;
  return at === null ? null : dateInZone(at, TZ);
};

describe('retention on imported history', () => {
  it('keeps the 366-day number in one place', () => {
    expect(RETENTION_DAYS).toBe(366);
    expect(FROM_DOMAIN).toBe(RETENTION_DAYS);
  });

  it('prunes what is past the line at the end of the run that imported it, and never brings it back', async () => {
    const m = startMachine({ home: makeHome(), now: () => LATER });
    const run = await m.refresh();
    expect(run.state).toBe('succeeded');

    // The September rollout was imported, then pruned with its session; its file row stays so the file is not read again.
    expect(sessionSums(m.db, 'codex').has(ARCHIVED)).toBe(false);
    expect([...sessionSums(m.db, 'codex').keys()].sort()).toEqual([
      'aaaaaaaa-1111-4111-8111-00000000000a',
      'bbbbbbbb-2222-4222-8222-00000000000b',
    ]);
    expect(
      m.db.prepare('SELECT COUNT(*) AS n FROM source_file WHERE path LIKE ?').get('%cccccccc%'),
    ).toEqual({ n: 1 });
    const oldest = m.db.prepare('SELECT MIN(occurred_at) AS t FROM usage_event').get() as {
      t: number;
    };
    expect(dateInZone(oldest.t, TZ) >= CUTOFF).toBe(true);

    // The source row was written before the prune, so on this one run it still names the pruned day. The next attempt corrects it.
    expect(oldestDate(m.db, 'codex')).toBe('2026-09-28');
    const before = history(m.db);
    m.tick(15 * 60_000);
    await m.refresh();
    expect(history(m.db).events).toEqual(before.events);
    expect(history(m.db).sessions).toEqual(before.sessions);
    expect(oldestDate(m.db, 'codex')).toBe('2026-10-12');
  });

  it('prunes at boot, with the date at boot, and keeps the rest of the history', async () => {
    const config = tempConfig();
    ensureDir(config.dataDir); // boot makes it; here the import comes first
    const imported = startMachine({ home: makeHome(), dbPath: config.dbPath }); // imported on 2026-11-05, nothing is old yet
    await imported.refresh();
    expect(sessionSums(imported.db, 'codex').has(ARCHIVED)).toBe(true);
    const kept = (
      imported.db
        .prepare('SELECT COUNT(*) AS n FROM usage_event WHERE occurred_at >= ?')
        .get(Date.parse('2026-10-01T07:00:00Z')) as { n: number }
    ).n;
    imported.close();

    const logs = memoryLogger();
    const server = await boot(config, {
      logger: logs.logger,
      listen: fakeListen,
      now: () => LATER,
      timezone: TZ,
    });
    try {
      const step = logs.entries.find((entry) => entry['step'] === 'retention');
      expect(step).toMatchObject({ cutoff: CUTOFF });
      expect(step?.['usageEvents']).toBeGreaterThan(0);
      expect(sessionSums(server.db!, 'codex').has(ARCHIVED)).toBe(false);
      expect(server.db!.prepare('SELECT COUNT(*) AS n FROM usage_event').get()).toEqual({
        n: kept,
      });
    } finally {
      await server.shutdown();
    }
  });

  it('never prunes repos, settings or decisions on PRs that are held, and takes a decision only with its PR', async () => {
    const m = startMachine({ home: makeHome() }); // imported on 2026-11-05
    await m.refresh();
    const session = (provider_session_id: string) =>
      (
        m.db
          .prepare('SELECT id FROM session WHERE provider_session_id = ?')
          .get(provider_session_id) as { id: number }
      ).id;
    const old = session(ARCHIVED);
    const live = session('aaaaaaaa-1111-4111-8111-00000000000a');
    const line = Date.parse('2026-10-01T07:00:00Z');
    m.db.exec(`
      INSERT INTO repo (id, display_name, tracking_state, access_state, added_at) VALUES
        ('kelvin/active', 'kelvin/active', 'active', 'ok', 1), ('kelvin/stopped', 'kelvin/stopped', 'stopped', 'inaccessible', 1);
      INSERT INTO pull_request (node_id, repo_id, number, title, url, merged_at) VALUES
        ('gone', 'kelvin/stopped', 1, 't', 'https://x.test/1', ${line - 1}),
        ('held', 'kelvin/active', 2, 't', 'https://x.test/2', ${Date.parse('2026-10-20T00:00:00Z')});
      INSERT INTO pr_session_link (pr_node_id, session_id, class, basis, computed_at) VALUES
        ('gone', ${old}, 'evidence', 'x', 1), ('held', ${live}, 'suggested', 'x', 1),
        ('held', ${old}, 'suggested', 'x', 1);
      INSERT INTO owner_link_decision (pr_node_id, session_id, decision, decided_at) VALUES
        ('gone', ${old}, 'confirmed', 1), ('held', ${live}, 'rejected', 1);
    `);
    recordComputedLinksSuccess(m.db, LATER - 1);
    const settings = "SELECT key, value FROM app_meta WHERE key != 'links_dirty' ORDER BY key";
    const meta = m.db.prepare(settings).all();

    const pruned = runRetention(m.db, { nowMs: LATER, timezone: TZ });
    expect(pruned).toMatchObject({
      cutoff: CUTOFF,
      pullRequests: 1,
      ownerDecisions: 1,
      sessions: 1,
    });
    const all = (sql: string) => m.db.prepare(sql).all();
    expect(all('SELECT id FROM repo ORDER BY id')).toEqual([
      { id: 'kelvin/active' },
      { id: 'kelvin/stopped' },
    ]);
    expect(all('SELECT pr_node_id FROM owner_link_decision')).toEqual([{ pr_node_id: 'held' }]);
    expect(all('SELECT pr_node_id FROM pr_session_link')).toEqual([{ pr_node_id: 'held' }]);
    expect(all('SELECT node_id FROM pull_request')).toEqual([{ node_id: 'held' }]);
    expect(all(settings)).toEqual(meta);
    expect(readLinkHealth(m.db)).toEqual({
      state: 'stale',
      lastSuccessfulAt: new Date(LATER - 1).toISOString(),
    });
    expect(all('SELECT id FROM session WHERE id = ' + old)).toEqual([]);
    expect(sessionSums(m.db, 'claude').size).toBe(6); // newer than the line: untouched

    // Run again on the same day: nothing more to take.
    expect(runRetention(m.db, { nowMs: LATER, timezone: TZ })).toMatchObject({
      usageEvents: 0,
      sessions: 0,
      pullRequests: 0,
    });
  });
});
