import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { listMigrations, migrate } from '../../src/server/db/migrate.ts';
import { openDatabase } from '../../src/server/db/open.ts';
import { ensureDir, modeOf } from '../../src/server/lib/fsModes.ts';
import { dateInZone } from '../../src/shared/domain/periods.ts';
import { tempDir } from '../server/helpers.ts';
import {
  FIXED_NOW,
  FIXED_TIMEZONE,
  SEED_MARKER,
  buildWorld,
  isReplaceable,
  seedDatabase,
  seedFile,
  type SeedOptions,
} from './seed.ts';

const ROOT = join(import.meta.dirname, '../..');
const LA = FIXED_TIMEZONE;

/** A seeded in-memory database. */
function seeded(options: SeedOptions = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  const summary = seedDatabase(db, options);
  return { db, summary };
}

const one = <T>(db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  db.prepare(sql).get(...args) as T;
const all = <T>(db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  db.prepare(sql).all(...args) as T[];
const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  one<{ n: number }>(db, sql, ...args).n;

/** A digest of every row of every table, in a stable order. */
function digest(db: DatabaseSync): string {
  const hash = createHash('sha256');
  const tables = all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  for (const { name } of tables) {
    hash.update(`## ${name}\n`);
    for (const row of db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())
      hash.update(JSON.stringify(row) + '\n');
  }
  return hash.digest('hex');
}

describe('the typical world is the prototype’s world', () => {
  // docs/design/prototype/data.js runs here, in a sandbox with the two helpers it needs. Our port must match it row for row.
  const proto = (() => {
    const U = {
      parse: (s: string) => {
        const p = s.split('-');
        return new Date(Date.UTC(+p[0]!, +p[1]! - 1, +p[2]!));
      },
      addDays(s: string, n: number) {
        const d = U.parse(s);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      },
      dow: (s: string) => U.parse(s).getUTCDay(),
    };
    const window: Record<string, unknown> = { UI: U };
    vm.runInNewContext(readFileSync(join(ROOT, 'docs/design/prototype/data.js'), 'utf8'), {
      window,
    });
    return (
      window['FIXTURE'] as {
        build: (id: string) => {
          sessions: ProtoSession[];
          prs: ProtoPr[];
          accounts: { chatgpt: { report: { total: number; start: string; end: string } } };
        };
      }
    ).build('typical');
  })();
  type ProtoSession = {
    id: string;
    date: string;
    time: string;
    provider: string;
    model: string;
    repo: string | null;
    role: string;
    parent: string | null;
    kind: string;
    paseo: { agent: string; workspace: string } | null;
    ref: string;
    total: number;
    tokens: Record<string, number>;
  };
  type ProtoPr = {
    repo: string;
    number: number;
    title: string;
    date: string;
    time: string;
    author: string;
    mergedBy: string;
    links: { sid: string; cls: string; basis: string }[];
  };
  const world = buildWorld('typical');

  it('has the same sessions, in the same order, with the same tokens', () => {
    expect(world.sessions).toHaveLength(proto.sessions.length);
    world.sessions.forEach((mine, i) => {
      const theirs = proto.sessions[i]!;
      expect({
        key: mine.key,
        date: mine.date,
        time: mine.time,
        provider: mine.provider,
        model: mine.model,
        repo: mine.repo,
        role: mine.role,
        parent: mine.parentKey,
        kind: mine.kind,
        paseo: mine.paseo,
        ref: mine.ref,
        total: mine.tokens.total,
      }).toEqual({
        key: theirs.id,
        date: theirs.date,
        time: theirs.time,
        provider: theirs.provider,
        model: theirs.model,
        repo: theirs.repo,
        role: theirs.role,
        parent: theirs.parent,
        kind: theirs.kind,
        paseo: theirs.paseo,
        ref: theirs.ref,
        total: theirs.total,
      });
      const t = mine.tokens as unknown as Record<string, number>;
      if (mine.provider === 'codex')
        expect([t['input'], t['cachedInput'], t['output'], t['reasoning']]).toEqual([
          theirs.tokens['input'],
          theirs.tokens['cached'],
          theirs.tokens['output'],
          theirs.tokens['reasoning'],
        ]);
      else
        expect([t['inputUncached'], t['cacheWrite'], t['cacheRead'], t['output']]).toEqual([
          theirs.tokens['input'],
          theirs.tokens['cacheWrite'],
          theirs.tokens['cacheRead'],
          theirs.tokens['output'],
        ]);
    });
  });

  it('has the same pull requests, numbers and links', () => {
    expect(world.prs).toHaveLength(proto.prs.length);
    world.prs.forEach((mine, i) => {
      const theirs = proto.prs[i]!;
      expect({
        repo: mine.repo,
        number: mine.number,
        title: mine.title,
        date: mine.date,
        time: mine.time,
        author: mine.author,
        mergedBy: mine.mergedBy,
        links: mine.links.map((l) => [l.sessionKey, l.cls, l.basis]),
      }).toEqual({
        repo: theirs.repo,
        number: theirs.number,
        title: theirs.title,
        date: theirs.date,
        time: theirs.time,
        author: theirs.author,
        mergedBy: theirs.mergedBy,
        links: theirs.links.map((l) => [l.sid, l.cls, l.basis]),
      });
    });
  });

  it('has the same account window total', () => {
    const report = proto.accounts.chatgpt.report;
    expect(world.chatgptWindow).toEqual({
      start: report.start,
      end: report.end,
      total: report.total,
    });
  });
});

describe('typical world in SQLite', () => {
  const { db, summary } = seeded();

  it('reports what it wrote', () => {
    expect(summary).toMatchObject({
      scale: 'typical',
      scenario: 'typical',
      now: '2026-11-04T17:42:00.000Z',
      timezone: LA,
    });
    expect(summary.counts['sessions']).toBe(count(db, 'SELECT COUNT(*) AS n FROM session'));
    expect(summary.counts['events']).toBe(count(db, 'SELECT COUNT(*) AS n FROM usage_event'));
    expect(FIXED_NOW).toBe(Date.parse('2026-11-04T17:42:00Z')); // 9:42 AM in Los Angeles
    expect(dateInZone(FIXED_NOW, LA)).toBe('2026-11-04');
  });

  it('keeps every foreign key', () => {
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('every session’s events add up to its tokens, and provider totals follow the owner rule', () => {
    const world = buildWorld('typical');
    const sums = new Map(
      all<{ session_id: number; total: number; n: number }>(
        db,
        'SELECT session_id, SUM(provider_total) AS total, COUNT(*) AS n FROM usage_event GROUP BY session_id',
      ).map((r) => [r.session_id, r]),
    );
    world.sessions.forEach((s, i) => {
      expect(sums.get(i + 1)?.total, s.key).toBe(s.tokens.total);
      expect(sums.get(i + 1)?.n, s.key).toBe(s.events);
    });
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'codex' AND provider_total <> input_tokens + output_tokens",
      ),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'claude' AND provider_total <> input_tokens + cache_write_tokens + cache_read_tokens + output_tokens",
      ),
    ).toBe(0);
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM usage_event WHERE cached_input_tokens > input_tokens OR reasoning_tokens > output_tokens',
      ),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'claude' AND (cached_input_tokens <> 0 OR reasoning_tokens <> 0)",
      ),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'codex' AND (cache_write_tokens <> 0 OR cache_read_tokens <> 0)",
      ),
    ).toBe(0);
  });

  it('keeps each event on its session’s local day, so day totals match the prototype', () => {
    const world = buildWorld('typical');
    const events = all<{ session_id: number; occurred_at: number }>(
      db,
      'SELECT session_id, occurred_at FROM usage_event',
    );
    for (const e of events)
      expect(dateInZone(e.occurred_at, LA)).toBe(world.sessions[e.session_id - 1]!.date);
  });

  it('shows true zero on Sunday 1 November: covered, with no events and no merges', () => {
    const lo = Date.parse('2026-11-01T07:00:00Z'); // local midnight (PDT)
    const hi = Date.parse('2026-11-02T08:00:00Z'); // the 25-hour day ends at local midnight (PST)
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM usage_event WHERE occurred_at >= ? AND occurred_at < ?',
        lo,
        hi,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM pull_request WHERE merged_at >= ? AND merged_at < ?',
        lo,
        hi,
      ),
    ).toBe(0);
    // The week around it has activity, so the quiet day is a covered zero, not missing history.
    const week = 7 * 86_400_000;
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM usage_event WHERE occurred_at >= ? AND occurred_at < ?',
        lo - week,
        lo,
      ),
    ).toBeGreaterThan(0);
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM usage_event WHERE occurred_at >= ? AND occurred_at < ?',
        hi,
        hi + week,
      ),
    ).toBeGreaterThan(0);
  });

  it('has history that starts when each source starts, and says so', () => {
    const oldest = (provider: string) =>
      one<{ at: number }>(
        db,
        'SELECT MIN(occurred_at) AS at FROM usage_event WHERE provider = ?',
        provider,
      ).at;
    expect(dateInZone(oldest('codex'), LA) >= '2026-02-02').toBe(true);
    expect(dateInZone(oldest('codex'), LA) <= '2026-02-09').toBe(true);
    expect(dateInZone(oldest('claude'), LA) >= '2026-03-14').toBe(true);
    expect(dateInZone(oldest('claude'), LA) <= '2026-03-21').toBe(true);
    for (const [id, provider] of [
      ['codex', 'codex'],
      ['claude', 'claude'],
    ] as const) {
      expect(
        one<{ oldest_event_at: number }>(
          db,
          'SELECT oldest_event_at FROM source_state WHERE source_id = ?',
          id,
        ).oldest_event_at,
      ).toBe(oldest(provider));
    }
    // Delivery history reaches back over the whole lookback, further than local usage.
    expect(
      dateInZone(one<{ at: number }>(db, 'SELECT MIN(merged_at) AS at FROM pull_request').at, LA) <
        '2025-12-01',
    ).toBe(true);
  });

  it('has the states the design shows: partial Paseo, an inaccessible repo, an untracked repo, unknown repo and parentage', () => {
    expect(
      one(
        db,
        "SELECT status, unreadable_count, last_attempt_result FROM source_state WHERE source_id = 'paseo'",
      ),
    ).toEqual({ status: 'partial', unreadable_count: 3, last_attempt_result: 'partial' });
    expect(
      one(
        db,
        "SELECT status, last_attempt_result, consecutive_failures FROM source_state WHERE source_id = 'codex'",
      ),
    ).toEqual({ status: 'ok', last_attempt_result: 'succeeded', consecutive_failures: 0 });
    expect(all(db, 'SELECT id, tracking_state, access_state FROM repo ORDER BY id')).toEqual([
      { id: 'kelvin/archive-private', tracking_state: 'active', access_state: 'inaccessible' },
      { id: 'kelvin/atlas-api', tracking_state: 'active', access_state: 'ok' },
      { id: 'kelvin/atlas-web', tracking_state: 'active', access_state: 'ok' },
      { id: 'kelvin/notes-cli', tracking_state: 'active', access_state: 'ok' },
      { id: 'open-tools/shared-schemas', tracking_state: 'active', access_state: 'ok' },
    ]);
    expect(
      count(db, "SELECT COUNT(*) AS n FROM session WHERE repo_id = 'kelvin/dotfiles'"),
    ).toBeGreaterThan(0); // untracked: no repo row
    expect(count(db, 'SELECT COUNT(*) AS n FROM session WHERE repo_id IS NULL')).toBeGreaterThan(0); // unknown repo
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM session WHERE kind = 'unknown' AND parent_session_id IS NULL",
      ),
    ).toBeGreaterThan(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM session WHERE kind = 'child' AND parent_basis = 'paseo'",
      ),
    ).toBeGreaterThan(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM session WHERE kind = 'child' AND parent_basis = 'native'",
      ),
    ).toBeGreaterThan(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM session WHERE kind = 'child' AND parent_session_id IS NULL",
      ),
    ).toBe(0);
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM session s JOIN session p ON p.id = s.parent_session_id WHERE s.provider <> p.provider',
      ),
    ).toBeGreaterThan(0); // multi-provider Paseo trees
  });

  it('has every link class, evidence with its justification, and owner decisions that never rebuild', () => {
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM pr_session_link WHERE class = 'evidence' AND basis = 'pr_reference'",
      ),
    ).toBeGreaterThan(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM pr_session_link WHERE class = 'evidence' AND basis = 'commit_match'",
      ),
    ).toBeGreaterThan(0);
    expect(
      count(db, "SELECT COUNT(*) AS n FROM pr_session_link WHERE class = 'suggested'"),
    ).toBeGreaterThan(0);
    expect(
      count(db, "SELECT COUNT(*) AS n FROM owner_link_decision WHERE decision = 'confirmed'"),
    ).toBeGreaterThan(0);
    // pr_reference evidence is backed by a recorded PR reference (owner/name#number, as the scan stores it), commit_match by a commit the PR contains
    expect(
      count(
        db,
        `SELECT COUNT(*) AS n FROM pr_session_link l JOIN pull_request p ON p.node_id = l.pr_node_id
      WHERE l.basis = 'pr_reference' AND NOT EXISTS (SELECT 1 FROM session_ref r WHERE r.session_id = l.session_id AND r.kind = 'pr_url' AND r.value = p.repo_id || '#' || p.number)`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) AS n FROM pr_session_link l
      WHERE l.basis = 'commit_match' AND NOT EXISTS (SELECT 1 FROM session_ref r JOIN pr_commit c ON c.sha = r.value AND c.pr_node_id = l.pr_node_id WHERE r.session_id = l.session_id AND r.kind = 'commit')`,
      ),
    ).toBe(0);
  });

  it('has the showcase week the design opens on', () => {
    const pr = (title: string) =>
      one<{ node_id: string; number: number; merged_by_login: string }>(
        db,
        'SELECT node_id, number, merged_by_login FROM pull_request WHERE title = ?',
        title,
      );
    const links = (node: string) =>
      all<{ class: string; basis: string }>(
        db,
        'SELECT class, basis FROM pr_session_link WHERE pr_node_id = ? ORDER BY class, basis',
        node,
      );
    expect(links(pr('Split usage importer into provider adapters').node_id)).toEqual([
      { class: 'evidence', basis: 'commit_match' },
      { class: 'evidence', basis: 'pr_reference' },
      { class: 'suggested', basis: 'same_repo_window' },
    ]);
    expect(pr('Add coverage rail to trends chart').merged_by_login).toBe('priya-s');
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM owner_link_decision WHERE pr_node_id = ?',
        pr('Add coverage rail to trends chart').node_id,
      ),
    ).toBe(1);
    expect(pr('Bump schema validator to 4.2')).toBeTruthy();
    const week = count(
      db,
      'SELECT COUNT(*) AS n FROM pull_request WHERE merged_at >= ? AND merged_at < ?',
      Date.parse('2026-11-02T08:00:00Z'),
      Date.parse('2026-11-05T08:00:00Z'),
    );
    expect(week).toBeGreaterThanOrEqual(7);
    const c1 = all<{ provider: string; kind: string; recorded_name: string }>(
      db,
      `SELECT s.provider, s.kind, s.recorded_name FROM session s WHERE s.parent_session_id = (SELECT id FROM session WHERE provider_session_id LIKE '7f3a%2c91') ORDER BY s.id`,
    );
    expect(c1).toEqual([
      { provider: 'claude', kind: 'child', recorded_name: 'implementer-1' },
      { provider: 'codex', kind: 'child', recorded_name: 'tester-2' },
    ]);
  });

  it('records the session start time with its basis, never later than the first event', () => {
    expect(count(db, 'SELECT COUNT(*) AS n FROM session WHERE started_at > first_event_at')).toBe(
      0,
    );
    expect(count(db, 'SELECT COUNT(DISTINCT started_basis) AS n FROM session')).toBe(2);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM session WHERE started_basis = 'source_start' AND started_at >= first_event_at",
      ),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM session WHERE started_basis = 'first_event' AND started_at <> first_event_at",
      ),
    ).toBe(0);
  });

  it('has the account reports, separate from local usage and never added to it', () => {
    const world = buildWorld('typical');
    expect(
      one<{ n: number }>(
        db,
        "SELECT SUM(tokens) AS n FROM account_daily_tokens WHERE account = 'chatgpt'",
      ).n,
    ).toBe(world.chatgptWindow.total);
    expect(
      count(db, "SELECT COUNT(*) AS n FROM account_daily_tokens WHERE account = 'chatgpt'"),
    ).toBe(30);
    expect(
      one(db, "SELECT unit, value, window_minutes FROM account_snapshot WHERE account = 'claude'"),
    ).toEqual({ unit: 'percent', value: 62, window_minutes: 10080 });
    expect(
      one<{ value: string }>(db, "SELECT value FROM app_meta WHERE key = 'github_login'").value,
    ).toBe('kelvin');
  });

  it('is a marked synthetic database in the report timezone, with setup complete', () => {
    const meta = (key: string) =>
      one<{ value: string }>(db, 'SELECT value FROM app_meta WHERE key = ?', key).value;
    expect(meta('seed_marker')).toBe(SEED_MARKER);
    expect(meta('report_timezone')).toBe(LA);
    expect(meta('seed_now')).toBe('2026-11-04T17:42:00.000Z');
    expect(meta('schema_version')).toBe(String(listMigrations().length));
    expect(count(db, "SELECT COUNT(*) AS n FROM app_meta WHERE key = 'setup_completed_at'")).toBe(
      1,
    );
    expect(one<{ state: string }>(db, 'SELECT state FROM refresh_run WHERE id = 1').state).toBe(
      'partial',
    );
  });
});

describe('the year-scale world (TECH › Performance)', () => {
  const { db } = seeded({ scale: 'year' });

  it('has exactly 150,000 events, 6,000 sessions, 2,000 PRs and 6 repos', () => {
    expect(count(db, 'SELECT COUNT(*) AS n FROM usage_event')).toBe(150_000);
    expect(count(db, 'SELECT COUNT(*) AS n FROM session')).toBe(6_000);
    expect(count(db, 'SELECT COUNT(*) AS n FROM pull_request')).toBe(2_000);
    expect(count(db, 'SELECT COUNT(*) AS n FROM repo')).toBe(6);
  });

  it('keeps the same invariants at scale', () => {
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'codex' AND (provider_total <> input_tokens + output_tokens OR cached_input_tokens > input_tokens OR reasoning_tokens > output_tokens)",
      ),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'claude' AND provider_total <> input_tokens + cache_write_tokens + cache_read_tokens + output_tokens",
      ),
    ).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM session WHERE started_at > first_event_at')).toBe(
      0,
    );
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM session WHERE kind = 'child' AND parent_session_id IS NULL",
      ),
    ).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM session WHERE kind = 'unknown'")).toBeGreaterThan(
      0,
    );
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM usage_event WHERE occurred_at >= ? AND occurred_at < ?',
        Date.parse('2026-11-01T07:00:00Z'),
        Date.parse('2026-11-02T08:00:00Z'),
      ),
    ).toBe(0);
  });

  it('keeps every session on its own local day, even with many events late in the evening', () => {
    const world = buildWorld('year');
    expect(Math.max(...world.sessions.map((s) => s.events))).toBeGreaterThan(60);
    const rows = all<{ id: number; first_event_at: number; last_event_at: number }>(
      db,
      'SELECT id, first_event_at, last_event_at FROM session',
    );
    expect(rows).toHaveLength(6_000);
    for (const row of rows) {
      const date = world.sessions[row.id - 1]!.date;
      expect(dateInZone(row.first_event_at, LA), `session ${row.id} first`).toBe(date);
      expect(dateInZone(row.last_event_at, LA), `session ${row.id} last`).toBe(date);
    }
  });

  it('spreads the work over the year and over every repo', () => {
    expect(
      count(
        db,
        'SELECT COUNT(DISTINCT repo_id) AS n FROM session WHERE repo_id IN (SELECT id FROM repo)',
      ),
    ).toBe(6);
    expect(count(db, 'SELECT COUNT(DISTINCT repo_id) AS n FROM pull_request')).toBe(6);
    expect(
      count(
        db,
        'SELECT COUNT(DISTINCT CAST(occurred_at / 86400000 AS INTEGER)) AS n FROM usage_event',
      ),
    ).toBeGreaterThan(150);
  });
});

describe('determinism', () => {
  it('seeding twice gives the same database, row for row', () => {
    expect(digest(seeded().db)).toBe(digest(seeded().db));
    expect(digest(seeded({ scenario: 'refresh-failed' }).db)).toBe(
      digest(seeded({ scenario: 'refresh-failed' }).db),
    );
  });

  it('does not depend on the machine’s timezone or the process clock', () => {
    const run = (tz: string) => {
      const dir = tempDir();
      const path = join(dir, 'agent-productivity.db');
      const out = spawnSync(process.execPath, ['test/fixtures/seed.ts', '--db', path], {
        cwd: ROOT,
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      });
      expect(out.status, out.stderr).toBe(0);
      const db = new DatabaseSync(path, { readOnly: true });
      const d = digest(db);
      db.close();
      return d;
    };
    expect(run('Asia/Tokyo')).toBe(run('America/New_York'));
  });
});

describe('scenarios (the design’s other states)', () => {
  it('refresh-failed: today’s Codex records are not collected, Codex and the Claude account show failure with cached data', () => {
    const { db } = seeded({ scenario: 'refresh-failed' });
    const lo = Date.parse('2026-11-04T08:00:00Z');
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'codex' AND occurred_at >= ?",
        lo,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM usage_event WHERE provider = 'claude' AND occurred_at >= ?",
        lo,
      ),
    ).toBeGreaterThan(0);
    expect(
      one(
        db,
        "SELECT status, consecutive_failures, last_attempt_result, error_code FROM source_state WHERE source_id = 'codex'",
      ),
    ).toEqual({
      status: 'failed',
      consecutive_failures: 1,
      last_attempt_result: 'failed',
      error_code: 'unrecognized_format',
    });
    expect(
      one<{ extra_json: string }>(
        db,
        "SELECT extra_json FROM source_state WHERE source_id = 'codex'",
      ).extra_json,
    ).toContain('"staleAfter":"2026-11-03"');
    expect(
      one(db, "SELECT status, error_code FROM source_state WHERE source_id = 'claude_account'"),
    ).toEqual({ status: 'failed', error_code: 'reconnect_needed' });
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(count(db, "SELECT COUNT(*) AS n FROM session WHERE kind = 'unknown'")).toBeGreaterThan(
      0,
    );
  });

  it('no-repos: usage loads and there is nothing for delivery', () => {
    const { db } = seeded({ scenario: 'no-repos' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM repo')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM pull_request')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM session')).toBeGreaterThan(1000);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('account-only: no local records at all, sources not found, account reports still there', () => {
    const { db } = seeded({ scenario: 'account-only' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM session')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM usage_event')).toBe(0);
    expect(
      all(
        db,
        "SELECT source_id, status, oldest_event_at FROM source_state WHERE source_id IN ('codex', 'claude', 'paseo') ORDER BY source_id",
      ),
    ).toEqual([
      { source_id: 'claude', status: 'notfound', oldest_event_at: null },
      { source_id: 'codex', status: 'notfound', oldest_event_at: null },
      { source_id: 'paseo', status: 'notfound', oldest_event_at: null },
    ]);
    expect(count(db, 'SELECT COUNT(*) AS n FROM account_daily_tokens')).toBe(30);
    expect(count(db, 'SELECT COUNT(*) AS n FROM pr_session_link')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM pull_request')).toBeGreaterThan(100);
  });

  it('empty: first launch, nothing imported and setup not done', () => {
    const { db } = seeded({ scenario: 'empty' });
    for (const table of [
      'repo',
      'session',
      'usage_event',
      'pull_request',
      'source_state',
      'account_daily_tokens',
      'refresh_run',
    ]) {
      expect(count(db, `SELECT COUNT(*) AS n FROM ${table}`), table).toBe(0);
    }
    expect(count(db, "SELECT COUNT(*) AS n FROM app_meta WHERE key = 'setup_completed_at'")).toBe(
      0,
    );
  });
});

describe('seeding a file', () => {
  it('creates a private database that migrates and reads back', () => {
    const dir = join(tempDir(), 'data');
    const path = join(dir, 'agent-productivity.db');
    const summary = seedFile(path, { scenario: 'refresh-failed' });
    expect(summary.scenario).toBe('refresh-failed');
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(path)).toBe(0o600);
    const db = new DatabaseSync(path, { readOnly: true });
    expect(count(db, 'SELECT COUNT(*) AS n FROM session')).toBe(summary.counts['sessions']);
    db.close();
  });

  it('replaces an earlier seed, and refuses anything else, leaving it untouched', () => {
    const dir = join(tempDir(), 'data');
    const path = join(dir, 'agent-productivity.db');
    seedFile(path, { scenario: 'empty' });
    expect(isReplaceable(path)).toBe(true);
    seedFile(path); // replaces the earlier seed
    const real = join(tempDir(), 'real.db');
    ensureDir(join(real, '..'));
    const db = openDatabase(real);
    migrate(db);
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('github_login', 'someone-real')").run();
    db.close();
    const before = createHash('sha256').update(readFileSync(real)).digest('hex');
    expect(isReplaceable(real)).toBe(false);
    expect(() => seedFile(real)).toThrow(/Refusing to overwrite/);
    expect(createHash('sha256').update(readFileSync(real)).digest('hex')).toBe(before);

    const junk = join(tempDir(), 'junk.db');
    writeFileSync(junk, 'not a database'.repeat(50));
    expect(() => seedFile(junk)).toThrow(/Refusing to overwrite/);
    expect(readFileSync(junk, 'utf8')).toContain('not a database');
  });

  it('the command line needs --db or AGENT_PRODUCTIVITY_DATA_DIR and never picks the real app folder', () => {
    const env = { ...process.env };
    delete env['AGENT_PRODUCTIVITY_DATA_DIR'];
    const bare = spawnSync(process.execPath, ['test/fixtures/seed.ts'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain('never picks the real app data folder');
    const bad = spawnSync(
      process.execPath,
      ['test/fixtures/seed.ts', '--db', join(tempDir(), 'x.db'), '--scale', 'huge'],
      { cwd: ROOT, env, encoding: 'utf8' },
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--scale must be typical or year');
    const dir = tempDir();
    const good = spawnSync(process.execPath, ['test/fixtures/seed.ts'], {
      cwd: ROOT,
      env: { ...env, AGENT_PRODUCTIVITY_DATA_DIR: dir },
      encoding: 'utf8',
    });
    expect(good.status, good.stderr).toBe(0);
    expect(statSync(join(dir, 'agent-productivity.db')).size).toBeGreaterThan(100_000);
  });
});

describe('the seed stays out of the product', () => {
  it('nothing under src imports from test/', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          /from\s+['"][^'"]*(\/test\/|fixtures)/.test(readFileSync(path, 'utf8'))
        )
          offenders.push(path);
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
