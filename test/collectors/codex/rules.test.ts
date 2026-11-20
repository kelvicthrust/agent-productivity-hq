import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTER_VERSION } from '../../../src/server/collectors/codex/index.ts';
import { ownEvents } from '../../../src/server/collectors/codex/replay.ts';
import { RolloutParser, type ParsedRollout } from '../../../src/server/collectors/codex/rollout.ts';
import {
  FIXTURES,
  NOW,
  copyHome,
  memoryDb,
  metaLine,
  recordLine,
  compactedLine,
  refresh,
  sessionRow,
  snapshotLine,
  spawnedFrom,
  totalsOf,
  turnLine,
} from './helpers.ts';

// The counting rules of ccusage (docs/implementation/ccusage-rules.md, ids [X1] to [X7]) on the `home-rules` fixture: seven invented
// rollouts (a root with compactions, a fork, a spawned child, two forks whose parent is missing, a rollout holding copies, one whose
// last_token_usage is not the change in its totals) whose
// oracle, `oracle-rules.json`, is the REAL ccusage 20.0.48 run on this very folder:
//   CODEX_HOME=test/fixtures/codex/home-rules ccusage codex session --json --offline
// Nothing here runs ccusage: the file is its saved answer. What it proves is that the importer and ccusage agree on invented rollouts,
// not that they agree on the owner's own history (that is `pnpm reconcile` on their machine).

const P = 'a0a0a0a0-1111-4111-8111-0000000000c1';
const C1 = 'a1a1a1a1-2222-4222-8222-0000000000c2';
const C2 = 'a2a2a2a2-3333-4333-8333-0000000000c3';
const C3 = 'a3a3a3a3-4444-4444-8444-0000000000c4';
const C4 = 'a4a4a4a4-5555-4555-8555-0000000000c5';
const Q = 'a5a5a5a5-6666-4666-8666-0000000000c6';
const X = 'a6a6a6a6-7777-4777-8777-0000000000c7';

interface OracleSession {
  sessionFile: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
const oracle = (
  JSON.parse(readFileSync(join(FIXTURES, 'oracle-rules.json'), 'utf8')) as {
    sessions: OracleSession[];
  }
).sessions;

/** The categories the database holds for one session, as ccusage reports them (input without its cached and cache-write parts). */
function categories(db: ReturnType<typeof memoryDb>, id: string) {
  const row = db
    .prepare(
      `SELECT COUNT(e.id) AS events, COALESCE(SUM(e.input_tokens), 0) AS input, COALESCE(SUM(e.cached_input_tokens), 0) AS cached,
              COALESCE(SUM(e.cache_write_tokens), 0) AS cache_write, COALESCE(SUM(e.output_tokens), 0) AS output,
              COALESCE(SUM(e.reasoning_tokens), 0) AS reasoning, COALESCE(SUM(e.provider_total), 0) AS total
         FROM session s JOIN usage_event e ON e.session_id = s.id
        WHERE s.provider = 'codex' AND s.provider_session_id = ? GROUP BY s.id`,
    )
    .get(id) as
    | {
        events: number;
        input: number;
        cached: number;
        cache_write: number;
        output: number;
        reasoning: number;
        total: number;
      }
    | undefined;
  return row ?? null;
}

async function importRules() {
  const db = memoryDb();
  const run = await refresh(db, [join(FIXTURES, 'home-rules')]);
  return { db, run };
}

describe('the rules home against the real ccusage', () => {
  it('[X1] [X2] [X4] [X5] [X6] [X7] matches the oracle to the token in every category for all seven sessions', async () => {
    const { db, run } = await importRules();
    expect(run.report).toMatchObject({ result: 'succeeded', imported: 7, unreadable: 0 });
    const differences: string[] = [];
    for (const entry of oracle) {
      const id = entry.sessionFile.slice(-36);
      const mine = categories(db, id);
      const expected = {
        input: entry.inputTokens + entry.cacheReadTokens + entry.cacheCreationTokens,
        cached: entry.cacheReadTokens,
        cache_write: entry.cacheCreationTokens,
        output: entry.outputTokens,
        reasoning: entry.reasoningOutputTokens,
        total: entry.totalTokens,
      };
      for (const [key, value] of Object.entries(expected)) {
        const got = mine?.[key as keyof typeof expected];
        if (got !== value)
          differences.push(`${id.slice(0, 8)} ${key}: ${got ?? 'missing'} != ${value}`);
      }
    }
    expect(differences).toEqual([]);
    expect(oracle).toHaveLength(7);
  });
});

describe('one rule at a time', () => {
  it('[X4] counts a compaction request a compacted line names, once, and not one nobody names or one a count already carried', async () => {
    const { db } = await importRules();
    // P: five counts (3600 + 700 + ... ) and ONE compaction request: resp_c1_compact (5000 in + 300 out). resp_c1_plain has no
    // compacted line; resp_c1_local was carried by the advancing count that followed it, so it is in the count and not again.
    expect(categories(db, P)).toMatchObject({ events: 6, total: 9630, cache_write: 100 });
    const compaction = db
      .prepare(
        "SELECT dedupe_key AS key FROM usage_event WHERE dedupe_key LIKE 'r:%' ORDER BY dedupe_key",
      )
      .all() as { key: string }[];
    expect(compaction.map((row) => row.key)).toEqual(['r:resp_c1_compact', 'r:resp_c1_own']);
  });

  it('[X5] skips what a fork copied from its parent, compactions included, and counts what it spent itself', async () => {
    const { db } = await importRules();
    // C1 replays all five of P's counts and P's three compaction records, then spends one count and one compaction of its own.
    expect(categories(db, C1)).toMatchObject({ events: 2, total: 3750 });
    expect(categories(db, P)?.events).toBe(6); // the copies did not move P's events or double its compaction
  });

  it('[X5] skips a spawned child’s replay as far as it goes, and links it to its parent', async () => {
    const { db } = await importRules();
    // C2 replays only the first three of P's five counts, then its own: the first count that differs ends the replay.
    expect(categories(db, C2)).toMatchObject({ events: 1, total: 430 });
    expect(sessionRow(db, C2)).toMatchObject({
      kind: 'child',
      parent_session_id: sessionRow(db, P)?.id,
      parent_basis: 'native',
    });
  });

  it('[X6] skips a burst written at once when the parent is missing, and counts two real turns far apart', async () => {
    const { db } = await importRules();
    expect(categories(db, C3)).toMatchObject({ events: 1, total: 110 }); // two events 350 ms apart at the start: skipped
    expect(categories(db, C4)).toMatchObject({ events: 2, total: 550 }); // 25 seconds apart: its own
  });

  it('[X7] keeps a copy of the same events in each session that holds it, as the oracle’s session report does', async () => {
    const { db } = await importRules();
    expect(categories(db, Q)).toMatchObject({ events: 3, total: 2235 }); // two copies of P's first events, and one of its own
    expect(totalsOf(db, P)?.total).toBe(9630);
  });

  it('[X2] counts the request’s own usage when the running total moved by something else, drops a repeated total, and counts a reset', async () => {
    const { db } = await importRules();
    // 1100 (first count) + 790 (its last_token_usage; the totals only moved by 460) + 360 (after the total dropped); the third
    // count repeats the second's total, so it adds nothing.
    expect(categories(db, X)).toMatchObject({ events: 3, total: 2250 });
  });

  it('[X5] stays the same when the same rollouts are read again, or after the parent changes elsewhere', async () => {
    const { db } = await importRules();
    const before = db
      .prepare('SELECT COUNT(*) AS n, SUM(provider_total) AS t FROM usage_event')
      .get();
    const again = await refresh(db, [join(FIXTURES, 'home-rules')], {}, NOW + 900_000);
    expect(again.report).toMatchObject({ result: 'succeeded', imported: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n, SUM(provider_total) AS t FROM usage_event').get(),
    ).toEqual(before);
  });
});

describe('the replay filter on its own', () => {
  const parse = (...rows: string[]): ParsedRollout => {
    const parser = new RolloutParser();
    for (const row of rows) parser.push(row);
    return parser.finish();
  };
  const T = (s: number, ms = 0): string =>
    `2026-10-20T10:00:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`;
  const PARENT = '99999999-aaaa-4aaa-8aaa-000000000009';
  const CHILD = '11111111-aaaa-4aaa-8aaa-000000000001';
  const parent = parse(
    metaLine(PARENT, T(0)),
    snapshotLine(T(5), [100, 0, 10, 0], [100, 0, 10, 0]),
    snapshotLine(T(10), [300, 0, 30, 0], [200, 0, 20, 0]),
    snapshotLine(T(40), [600, 0, 60, 0], [300, 0, 30, 0]), // after the fork: never replayed
  );

  it('[X5] compares only the parent’s events up to the fork instant, so what it did later cannot mask the child’s own', () => {
    // The child forked at 20 s, replays two events, then spends exactly what the parent spent at 40 s: that is the child's own.
    const child = parse(
      metaLine(CHILD, T(20), { forkedFrom: PARENT }),
      snapshotLine(T(20, 1), [100, 0, 10, 0], [100, 0, 10, 0]),
      snapshotLine(T(20, 2), [300, 0, 30, 0], [200, 0, 20, 0]),
      snapshotLine(T(30), [600, 0, 60, 0], [300, 0, 30, 0]),
    );
    expect(ownEvents(child, parent).map((e) => e.providerTotal)).toEqual([330]);
  });

  it('[X5] counts everything from the first event that differs, even if a later one matches again', () => {
    const child = parse(
      metaLine(CHILD, T(50), { forkedFrom: PARENT }),
      snapshotLine(T(50, 1), [100, 0, 10, 0], [100, 0, 10, 0]),
      snapshotLine(T(50, 2), [150, 0, 15, 0], [50, 0, 5, 0]), // not the parent's second event: the replay is over
      snapshotLine(T(50, 3), [350, 0, 35, 0], [200, 0, 20, 0]), // equal to it, but too late to be replay
    );
    expect(ownEvents(child, parent).map((e) => e.providerTotal)).toEqual([55, 220]);
  });

  it('[X5] treats a parent that is not there as an empty replay, and a rollout that is not a fork as its own', () => {
    const lone = parse(
      metaLine(CHILD, T(50), { source: spawnedFrom(PARENT) }),
      snapshotLine(T(55), [100, 0, 10, 0], [100, 0, 10, 0]),
    );
    expect(ownEvents(lone, null).map((e) => e.providerTotal)).toEqual([110]);
    const root = parse(
      metaLine(CHILD, T(50)),
      snapshotLine(T(55), [100, 0, 10, 0], [100, 0, 10, 0]),
    );
    expect(ownEvents(root, parent).map((e) => e.providerTotal)).toEqual([110]);
  });

  it('[X6] needs both a dense pair and a start at the fork, and ends the burst at the first pause', () => {
    const burst = (...usage: [string, [number, number, number, number]][]): ParsedRollout =>
      parse(
        metaLine(CHILD, T(50), { forkedFrom: PARENT }),
        ...usage.map(([at, counts]) => snapshotLine(at, counts, counts)),
      );
    const dense = burst(
      [T(50, 100), [10, 0, 1, 0]],
      [T(50, 900), [20, 0, 2, 0]],
      [T(51, 800), [30, 0, 3, 0]], // 900 ms after the last skipped: still the burst
      [T(53, 0), [40, 0, 4, 0]], // a 1.2 s pause: its own
    );
    expect(ownEvents(dense, null).map((e) => e.providerTotal)).toEqual([44]);
    // a first line 2 s after the start is not "at the fork": two quick requests that late are real
    const late = burst([T(52, 0), [10, 0, 1, 0]], [T(52, 500), [20, 0, 2, 0]]);
    expect(ownEvents(late, null).map((e) => e.providerTotal)).toEqual([11, 22]);
    // one event alone cannot be a burst
    expect(ownEvents(burst([T(50, 100), [10, 0, 1, 0]]), null).map((e) => e.providerTotal)).toEqual(
      [11],
    );
  });

  it('[X4] counts a record a compacted line names even when the line comes first, and cancels one a count carried', () => {
    const named = parse(
      metaLine(CHILD, T(0)),
      compactedLine(T(4), 'resp_early'),
      recordLine(T(5), 'resp_early', [900, 800, 70, 0]),
    );
    expect(named.events.map((e) => [e.responseId, e.providerTotal])).toEqual([['resp_early', 970]]);
    const carried = parse(
      metaLine(CHILD, T(0)),
      recordLine(T(5), 'resp_x', [900, 800, 70, 0]),
      snapshotLine(T(6), [900, 800, 70, 0], [900, 800, 70, 0]), // advanced, and it is that request
      compactedLine(T(7), 'resp_x'),
    );
    expect(carried.events.map((e) => [e.responseId, e.providerTotal])).toEqual([[null, 970]]);
    const ignored = parse(metaLine(CHILD, T(0)), recordLine(T(5), 'resp_none', [900, 800, 70, 0]));
    expect(ignored.events).toEqual([]);
    expect(turnLine(T(1), 'm')).toContain('turn_context'); // the helper the other tests share
  });
});

describe('history imported under an older counting rule', () => {
  it('replaces the events of every file still there, keeps those of a log that was deleted, and reads nothing twice after that', async () => {
    const home = copyHome('home-rules');
    const db = memoryDb();
    await refresh(db, [home]);
    const good = db
      .prepare('SELECT COUNT(*) AS n, SUM(provider_total) AS t FROM usage_event')
      .get();

    // What an older version left: its adapter version, an event under its old key, and a wrong figure on a real one.
    // (the runner writes this row after an attempt; the adapter alone does not, so the test writes what the runner would have)
    db.prepare(
      "INSERT INTO source_state (source_id, status, adapter_version) VALUES ('codex', 'ok', 'codex-rollout/1')",
    ).run();
    const session = sessionRow(db, C4);
    db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, input_tokens, output_tokens, provider_total, source_file_id)
       SELECT 'codex', 'old:key:1', ?, 1, 'm', 7, 7, 14, (SELECT source_file_id FROM usage_event WHERE session_id = ? LIMIT 1)`,
    ).run(session!.id, session!.id);
    expect(totalsOf(db, C4)?.total).toBe(550 + 14);

    // Another log is deleted from the machine: its history stays.
    rmSync(
      join(
        home,
        'sessions/2026/10/21/rollout-2026-10-21T09-30-00-a5a5a5a5-6666-4666-8666-0000000000c6.jsonl',
      ),
    );
    const migrated = await refresh(db, [home], {}, NOW + 900_000);
    expect(migrated.report).toMatchObject({ result: 'succeeded' });
    expect(totalsOf(db, C4)?.total).toBe(550); // the old-key event is gone with the rule that made it
    expect(totalsOf(db, Q)?.total).toBe(2235); // its log is gone, its events are not
    expect(
      db.prepare('SELECT COUNT(*) AS n, SUM(provider_total) AS t FROM usage_event').get(),
    ).toEqual(good);

    // The runner stores the version the attempt finished with; with that current, nothing is read again.
    db.prepare("UPDATE source_state SET adapter_version = ? WHERE source_id = 'codex'").run(
      ADAPTER_VERSION,
    );
    const quiet = await refresh(db, [home], {}, NOW + 1_800_000);
    expect(quiet.progress).toEqual([]);
  });
});
