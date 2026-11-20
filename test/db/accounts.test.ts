import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  applyCodexThreadNames,
  cleanThreadName,
  localTokensBetween,
  markChatgptConnected,
  markChatgptDisconnected,
  readAccountSnapshot,
  readRecentClaudeCwds,
  readChatgptConnection,
  readDailyTokens,
  readDailyTokenSpan,
  replaceDailyTokens,
  replaceRateLimits,
  setLifetimeTokens,
  THREAD_NAME_MAX,
} from '../../src/server/db/queries/accounts.ts';
import { joinPaseoSessions, upsertPaseoAgents } from '../../src/server/db/queries/paseo.ts';
import { upsertSession, type SessionUpsert } from '../../src/server/db/queries/usage.ts';
import { memoryDb } from '../server/helpers.ts';

// The SQL half of the account reports and of Codex thread names (G9_3, G9_4, G9_7; P-33 to P-38). The app-server client and the
// status-line collector are tested where they live; here the rules of what is stored are pinned: an account figure sits in its
// own tables and reaches no total, a percent window keeps its unit and its reset, null buckets clear the sum, the local tokens
// beside an account figure are read and never combined, a thread name is the provider's own and replaces a Paseo name, and
// nothing but a cleaned name is ever stored from a thread.

const T0 = Date.parse('2026-11-03T12:00:00Z');
const NOW = Date.parse('2026-11-04T17:42:00Z');

function session(
  db: DatabaseSync,
  provider: 'codex' | 'claude',
  id: string,
  extra: Partial<SessionUpsert> = {},
): number {
  return upsertSession(db, {
    provider,
    providerSessionId: id,
    kind: 'root',
    startedAt: T0,
    startedBasis: 'source_start',
    firstEventAt: T0,
    lastEventAt: T0,
    ...extra,
  });
}

const nameOf = (db: DatabaseSync, id: number) =>
  db
    .prepare('SELECT recorded_name AS name, name_source AS source FROM session WHERE id = ?')
    .get(id) as {
    name: string | null;
    source: string | null;
  };

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('cleanThreadName', () => {
  it('keeps a plain name, folds line breaks and runs of white space, and trims', () => {
    expect(cleanThreadName('Fix the login redirect')).toBe('Fix the login redirect');
    expect(cleanThreadName('  Fix\n\tthe   login\r\nredirect  ')).toBe('Fix the login redirect');
  });

  it('is null for anything that is not a usable name', () => {
    for (const value of [null, undefined, 42, {}, ['x'], '', '   ', '\n\t', '\u0000\u0007']) {
      expect(cleanThreadName(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('cuts a long name at the limit by code points, never inside a character', () => {
    const long = '𝒜'.repeat(THREAD_NAME_MAX + 40);
    const cut = cleanThreadName(long) as string;
    expect([...cut]).toHaveLength(THREAD_NAME_MAX);
    expect(cut).toBe('𝒜'.repeat(THREAD_NAME_MAX));
  });
});

describe('applyCodexThreadNames', () => {
  it('names the Codex session whose own id is the thread id, as the provider’s title', () => {
    const db = memoryDb();
    const id = session(db, 'codex', 'thread-a');
    expect(
      applyCodexThreadNames(db, [{ threadId: 'thread-a', name: 'Add the billing page' }]),
    ).toEqual({
      named: 1,
      unchanged: 0,
      skipped: 0,
    });
    expect(nameOf(db, id)).toEqual({ name: 'Add the billing page', source: 'provider_title' });
  });

  it('is idempotent: the same names again change nothing', () => {
    const db = memoryDb();
    session(db, 'codex', 'thread-a');
    applyCodexThreadNames(db, [{ threadId: 'thread-a', name: 'Add the billing page' }]);
    expect(
      applyCodexThreadNames(db, [{ threadId: 'thread-a', name: 'Add the billing page' }]),
    ).toEqual({
      named: 0,
      unchanged: 1,
      skipped: 0,
    });
  });

  it('matches only Codex sessions, by id and nothing else', () => {
    const db = memoryDb();
    const claude = session(db, 'claude', 'thread-a');
    const other = session(db, 'codex', 'thread-b', { cwd: '/x/thread-a' });
    const result = applyCodexThreadNames(db, [
      { threadId: 'thread-a', name: 'Someone else’s name' },
    ]);
    expect(result).toEqual({ named: 0, unchanged: 0, skipped: 1 });
    expect(nameOf(db, claude).name).toBeNull();
    expect(nameOf(db, other).name).toBeNull();
  });

  it('skips a thread with no usable name and leaves the session’s own name alone', () => {
    const db = memoryDb();
    const id = session(db, 'codex', 'thread-a', {
      recordedName: 'Recorded earlier',
      nameSource: 'provider_title',
    });
    const result = applyCodexThreadNames(db, [
      { threadId: 'thread-a', name: null },
      { threadId: 'thread-a', name: '   ' },
      { threadId: '', name: 'No id' },
    ]);
    expect(result).toEqual({ named: 0, unchanged: 0, skipped: 3 });
    expect(nameOf(db, id)).toEqual({ name: 'Recorded earlier', source: 'provider_title' });
  });

  it('replaces a renamed thread’s old provider name', () => {
    const db = memoryDb();
    const id = session(db, 'codex', 'thread-a');
    applyCodexThreadNames(db, [{ threadId: 'thread-a', name: 'First title' }]);
    applyCodexThreadNames(db, [{ threadId: 'thread-a', name: 'Second title' }]);
    expect(nameOf(db, id)).toEqual({ name: 'Second title', source: 'provider_title' });
  });

  it('beats a name Paseo gave, and the Paseo join never takes it back', () => {
    const db = memoryDb();
    const id = session(db, 'codex', 'thread-a');
    upsertPaseoAgents(
      db,
      [
        {
          id: 'agent-1',
          title: 'Paseo’s title',
          provider: 'codex',
          providerSessionId: 'thread-a',
          parentAgentId: null,
          workspaceId: null,
          workspaceLabel: null,
          cwd: null,
          background: false,
          archivedAt: null,
        },
      ],
      NOW,
    );
    joinPaseoSessions(db);
    expect(nameOf(db, id)).toEqual({ name: 'Paseo’s title', source: 'paseo' });

    applyCodexThreadNames(db, [{ threadId: 'thread-a', name: 'Codex’s own title' }]);
    expect(nameOf(db, id)).toEqual({ name: 'Codex’s own title', source: 'provider_title' });
    joinPaseoSessions(db);
    expect(nameOf(db, id)).toEqual({ name: 'Codex’s own title', source: 'provider_title' });
  });

  it('stores nothing but the cleaned name: no preview, no event, no token, no parent', () => {
    const db = memoryDb();
    const id = session(db, 'codex', 'thread-a');
    db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total) VALUES ('codex', 'e1', ?, ?, 'm', 100)`,
    ).run(id, T0);
    const before = JSON.stringify(db.prepare('SELECT * FROM session WHERE id = ?').get(id));
    const events = JSON.stringify(db.prepare('SELECT * FROM usage_event').all());
    const extra = {
      threadId: 'thread-a',
      name: 'A title',
      preview: 'SENTINEL_PREVIEW_TEXT',
      email: 'a@b.example',
    };
    applyCodexThreadNames(db, [extra]);
    const after = db.prepare('SELECT * FROM session WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(db.prepare('SELECT * FROM usage_event').all())).toBe(events);
    // only the two name columns moved
    const moved = Object.keys(after).filter(
      (key) =>
        JSON.stringify(after[key]) !==
        JSON.stringify((JSON.parse(before) as Record<string, unknown>)[key]),
    );
    expect(moved.sort()).toEqual(['name_source', 'recorded_name']);
    // the sentinel is in no table at all
    for (const table of [
      'session',
      'usage_event',
      'session_ref',
      'paseo_agent',
      'account_snapshot',
      'app_meta',
    ]) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(
        'SENTINEL_PREVIEW_TEXT',
      );
    }
  });

  it('applies a batch in one transaction: a failure part way leaves every name as it was', () => {
    const db = memoryDb();
    const a = session(db, 'codex', 'thread-a');
    const b = session(db, 'codex', 'thread-b');
    const bad = {
      threadId: 'thread-b',
      get name(): string {
        throw new Error('boom');
      },
    } as unknown as { threadId: string; name: string };
    expect(() => applyCodexThreadNames(db, [{ threadId: 'thread-a', name: 'A' }, bad])).toThrow(
      'boom',
    );
    expect(nameOf(db, a).name).toBeNull();
    expect(nameOf(db, b).name).toBeNull();
  });
});

describe('percent windows', () => {
  const five = {
    limitId: 'five_hour',
    usedPercent: 23.5,
    windowMinutes: 300,
    resetsAt: T0 + 3600_000,
  };
  const seven = {
    limitId: 'seven_day',
    usedPercent: 41.2,
    windowMinutes: 10080,
    resetsAt: T0 + 86400_000,
  };

  it('stores each window with its unit, length and reset, and reads them back shortest window first', () => {
    const db = memoryDb();
    expect(replaceRateLimits(db, 'claude', [seven, five], NOW)).toBe(2);
    const snapshot = readAccountSnapshot(db, 'claude');
    expect(snapshot.rateLimits.map((limit) => limit.limitId)).toEqual(['five_hour', 'seven_day']);
    expect(snapshot.rateLimits[0]).toEqual({ ...five, fetchedAt: NOW });
    expect(snapshot.fetchedAt).toBe(NOW);
    const units = db
      .prepare("SELECT DISTINCT unit FROM account_snapshot WHERE account = 'claude'")
      .all();
    expect(units).toEqual([{ unit: 'percent' }]);
  });

  it('replaces the account’s windows with the newest report: a window no longer reported is removed', () => {
    const db = memoryDb();
    replaceRateLimits(db, 'claude', [five, seven], NOW);
    replaceRateLimits(db, 'claude', [{ ...seven, usedPercent: 50 }], NOW + 60_000);
    const snapshot = readAccountSnapshot(db, 'claude');
    expect(snapshot.rateLimits).toEqual([{ ...seven, usedPercent: 50, fetchedAt: NOW + 60_000 }]);
  });

  it('keeps one account’s windows apart from the other’s', () => {
    const db = memoryDb();
    replaceRateLimits(db, 'claude', [five], NOW);
    replaceRateLimits(
      db,
      'chatgpt',
      [{ limitId: 'primary', usedPercent: 10, windowMinutes: 300, resetsAt: null }],
      NOW,
    );
    replaceRateLimits(db, 'chatgpt', [], NOW + 1);
    expect(readAccountSnapshot(db, 'claude').rateLimits).toHaveLength(1);
    expect(readAccountSnapshot(db, 'chatgpt').rateLimits).toHaveLength(0);
  });

  it('keeps a window whose length or reset is unknown, as null and not as zero', () => {
    const db = memoryDb();
    replaceRateLimits(
      db,
      'chatgpt',
      [{ limitId: 'primary', usedPercent: 7, windowMinutes: null, resetsAt: null }],
      NOW,
    );
    expect(readAccountSnapshot(db, 'chatgpt').rateLimits[0]).toMatchObject({
      windowMinutes: null,
      resetsAt: null,
    });
  });

  it('refuses a malformed window and changes nothing', () => {
    const db = memoryDb();
    replaceRateLimits(db, 'claude', [five], NOW);
    for (const bad of [
      { ...five, limitId: 'has space' },
      { ...five, limitId: '' },
      { ...five, usedPercent: Number.NaN },
      { ...five, usedPercent: -1 },
      { ...five, windowMinutes: 1.5 },
      { ...five, resetsAt: 1.5 },
    ]) {
      expect(
        () => replaceRateLimits(db, 'claude', [seven, bad], NOW + 1),
        JSON.stringify(bad),
      ).toThrow(RangeError);
    }
    expect(readAccountSnapshot(db, 'claude').rateLimits.map((limit) => limit.limitId)).toEqual([
      'five_hour',
    ]);
  });

  it('stores a lifetime figure under its own kind, and null removes it', () => {
    const db = memoryDb();
    setLifetimeTokens(db, 'chatgpt', 1_234_567, NOW);
    expect(readAccountSnapshot(db, 'chatgpt').lifetimeTokens).toEqual({
      value: 1_234_567,
      fetchedAt: NOW,
    });
    expect(readAccountSnapshot(db, 'chatgpt').rateLimits).toEqual([]);
    setLifetimeTokens(db, 'chatgpt', null, NOW + 1);
    expect(readAccountSnapshot(db, 'chatgpt').lifetimeTokens).toBeNull();
    expect(() => setLifetimeTokens(db, 'chatgpt', -1, NOW)).toThrow(RangeError);
    expect(() => setLifetimeTokens(db, 'chatgpt', 1.5, NOW)).toThrow(RangeError);
  });

  it('an account with nothing stored reads as empty', () => {
    expect(readAccountSnapshot(memoryDb(), 'claude')).toEqual({
      lifetimeTokens: null,
      rateLimits: [],
      fetchedAt: null,
    });
  });
});

describe('daily buckets', () => {
  const buckets = [
    { date: '2026-11-01', tokens: 100 },
    { date: '2026-11-02', tokens: 200 },
    { date: '2026-11-03', tokens: 300 },
  ];

  it('stores buckets and reads an inclusive range, oldest first', () => {
    const db = memoryDb();
    replaceDailyTokens(db, 'chatgpt', [buckets[2]!, buckets[0]!, buckets[1]!], NOW);
    expect(readDailyTokens(db, 'chatgpt', '2026-11-02', '2026-11-03')).toEqual([
      { ...buckets[1], fetchedAt: NOW },
      { ...buckets[2], fetchedAt: NOW },
    ]);
    expect(readDailyTokens(db, 'chatgpt', '2026-12-01', '2026-12-31')).toEqual([]);
    expect(readDailyTokenSpan(db, 'chatgpt')).toEqual({
      first: '2026-11-01',
      last: '2026-11-03',
      days: 3,
      fetchedAt: NOW,
    });
  });

  it('adds and corrects the dates it names and removes none, so history outlives the account’s own lookback', () => {
    const db = memoryDb();
    replaceDailyTokens(db, 'chatgpt', buckets, NOW);
    replaceDailyTokens(
      db,
      'chatgpt',
      [
        { date: '2026-11-03', tokens: 350 },
        { date: '2026-11-04', tokens: 400 },
      ],
      NOW + 1,
    );
    expect(readDailyTokens(db, 'chatgpt', '2026-11-01', '2026-11-04').map((b) => b.tokens)).toEqual(
      [100, 200, 350, 400],
    );
  });

  it('null buckets clear the account’s sum: a percent-only report can never sit beside an old token total', () => {
    const db = memoryDb();
    replaceDailyTokens(db, 'chatgpt', buckets, NOW);
    replaceDailyTokens(db, 'claude', [{ date: '2026-11-01', tokens: 5 }], NOW);
    replaceDailyTokens(db, 'chatgpt', null, NOW + 1);
    expect(readDailyTokenSpan(db, 'chatgpt')).toBeNull();
    expect(readDailyTokenSpan(db, 'claude')).not.toBeNull();
  });

  it('refuses a malformed bucket and stores none of the batch', () => {
    const db = memoryDb();
    for (const bad of [
      { date: '2026-13-01', tokens: 1 },
      { date: '11/03/2026', tokens: 1 },
      { date: '2026-11-03', tokens: -1 },
      { date: '2026-11-03', tokens: 1.5 },
    ]) {
      expect(
        () => replaceDailyTokens(db, 'chatgpt', [buckets[0]!, bad], NOW),
        JSON.stringify(bad),
      ).toThrow(RangeError);
    }
    expect(count(db, 'account_daily_tokens')).toBe(0);
  });
});

describe('the local tokens beside an account figure', () => {
  it('sums this machine’s provider totals for one provider over [from, to), and nothing from the account tables', () => {
    const db = memoryDb();
    const a = session(db, 'codex', 'a');
    const b = session(db, 'claude', 'b');
    const insert = db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total) VALUES (?, ?, ?, ?, 'm', ?)`,
    );
    insert.run('codex', 'e1', a, T0, 60);
    insert.run('codex', 'e2', a, T0 + 1000, 15);
    insert.run('codex', 'e3', a, T0 + 5000, 999); // at the end instant: outside
    insert.run('claude', 'e4', b, T0, 5000); // another provider: never mixed in
    replaceDailyTokens(db, 'chatgpt', [{ date: '2026-11-03', tokens: 100 }], NOW);

    expect(localTokensBetween(db, 'codex', T0, T0 + 5000)).toBe(75);
    expect(localTokensBetween(db, 'claude', T0, T0 + 5000)).toBe(5000);
    expect(localTokensBetween(db, 'codex', T0 + 10_000, T0 + 20_000)).toBe(0);
    // the account figure and the local figure stay two figures; nothing here adds them
    expect(readDailyTokens(db, 'chatgpt', '2026-11-03', '2026-11-03')[0]?.tokens).toBe(100);
  });

  it('writing an account report never touches a usage event, a session or a link', () => {
    const db = memoryDb();
    const id = session(db, 'codex', 'a');
    db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total) VALUES ('codex', 'e1', ?, ?, 'm', 60)`,
    ).run(id, T0);
    const watched = [
      'usage_event',
      'session',
      'pr_session_link',
      'owner_link_decision',
      'repo',
      'pull_request',
    ];
    const snapshot = () =>
      JSON.stringify(watched.map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot();
    replaceDailyTokens(db, 'chatgpt', [{ date: '2026-11-03', tokens: 100 }], NOW);
    replaceRateLimits(
      db,
      'chatgpt',
      [{ limitId: 'primary', usedPercent: 40, windowMinutes: 300, resetsAt: NOW }],
      NOW,
    );
    setLifetimeTokens(db, 'chatgpt', 9_999, NOW);
    replaceRateLimits(
      db,
      'claude',
      [{ limitId: 'seven_day', usedPercent: 62, windowMinutes: 10080, resetsAt: NOW }],
      NOW,
    );
    expect(snapshot()).toBe(before);
  });
});

describe('the ChatGPT connection', () => {
  it('starts as nothing the owner did: reading is on and no Connect has finished here', () => {
    expect(readChatgptConnection(memoryDb())).toEqual({ disconnected: false, connectedAt: null });
  });

  it('Connect records when it finished; Disconnect stops reading and forgets that, without touching imported data', () => {
    const db = memoryDb();
    replaceDailyTokens(db, 'chatgpt', [{ date: '2026-11-03', tokens: 100 }], NOW);
    markChatgptConnected(db, NOW);
    expect(readChatgptConnection(db)).toEqual({ disconnected: false, connectedAt: NOW });
    markChatgptDisconnected(db);
    expect(readChatgptConnection(db)).toEqual({ disconnected: true, connectedAt: null });
    expect(count(db, 'account_daily_tokens')).toBe(1);
    markChatgptConnected(db, NOW + 5);
    expect(readChatgptConnection(db)).toEqual({ disconnected: false, connectedAt: NOW + 5 });
  });
});

describe('the folders Claude Code ran in', () => {
  it('lists the distinct folders of Claude sessions active since the cutoff, newest first, and no other provider’s', () => {
    const db = memoryDb();
    const day = 86_400_000;
    session(db, 'claude', 'a', { cwd: '/work/one', lastEventAt: T0 });
    session(db, 'claude', 'b', { cwd: '/work/one', lastEventAt: T0 + day });
    session(db, 'claude', 'c', { cwd: '/work/two', lastEventAt: T0 + 2 * day });
    session(db, 'claude', 'd', { cwd: '/work/old', lastEventAt: T0 - 40 * day });
    session(db, 'claude', 'e', { cwd: null, lastEventAt: T0 + day });
    session(db, 'codex', 'f', { cwd: '/work/codex-only', lastEventAt: T0 + day });
    expect(readRecentClaudeCwds(db, T0 - 30 * day)).toEqual(['/work/two', '/work/one']);
    expect(readRecentClaudeCwds(db, T0 - 30 * day, 1)).toEqual(['/work/two']);
    expect(readRecentClaudeCwds(db, T0 + 10 * day)).toEqual([]);
  });
});
