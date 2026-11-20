import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_ADAPTER_VERSION } from '../../../src/server/collectors/claude/index.ts';
import { readSessionFigures } from '../../../src/server/db/queries/ingest.ts';
import { appSessions, parseClaudeReport } from '../../../scripts/lib/reconcile.ts';
import { FIXTURES, appendLines, assistantLine, putTranscript, setup, totalsOf } from './helpers.ts';
import { tempDir } from '../../server/helpers.ts';

// The counting rules of ccusage (docs/implementation/ccusage-rules.md, ids [A1] to [A7]) on the `config-rules` fixture: five invented
// transcripts (an original session, a subagent, two resumed copies, one holding another session's lines) whose oracle,
// `oracle-rules.json`, is the REAL ccusage 20.0.48 run on this very folder:
//   CLAUDE_CONFIG_DIR=test/fixtures/claude/config-rules ccusage claude session --json --offline
// Nothing here runs ccusage: the file is its saved answer. It proves that the importer and ccusage agree on invented transcripts, not
// that they agree on the owner's own history (that is `pnpm reconcile` on their machine).

const CONFIG = join(FIXTURES, 'config-rules');
const S0 = '00000000-aaaa-4aaa-8aaa-0000000000d0';
const S1 = '11111111-aaaa-4aaa-8aaa-0000000000d1';
const S2 = '22222222-bbbb-4bbb-8bbb-0000000000d2';
const S3 = '33333333-cccc-4ccc-8ccc-0000000000d3';

const oracle = parseClaudeReport(
  JSON.parse(readFileSync(join(FIXTURES, 'oracle-rules.json'), 'utf8')) as unknown,
);

/** What the database holds per ccusage session (a root with its subagents, by location). */
function app(db: ReturnType<typeof setup>['db']) {
  return new Map(
    appSessions('claude', readSessionFigures(db, 'claude')).map((s) => [s.key, s.figures]),
  );
}

describe('the rules config against the real ccusage', () => {
  it('[A1] [A2] [A3] [A4] [A6] [A7] matches the oracle to the token in every category for all four sessions', async () => {
    const { db, refresh } = setup(() => [CONFIG]);
    const report = await refresh();
    expect(report).toMatchObject({ result: 'succeeded', unreadable: 0 });
    expect(oracle).toHaveLength(4);
    const mine = app(db);
    const differences: string[] = [];
    for (const entry of oracle ?? []) {
      const got = mine.get(entry.key);
      for (const [key, value] of Object.entries(entry.figures)) {
        if (got?.[key] !== value)
          differences.push(
            `${entry.key.slice(0, 8)} ${key}: ${got?.[key] ?? 'missing'} != ${value}`,
          );
      }
    }
    expect(differences).toEqual([]);
    expect(mine.size).toBe(4);
  });
});

describe('one rule at a time', () => {
  it('[A4] gives a message two files hold to the file that sorts first, so the resumed copy that sorts earlier owns it', async () => {
    const { db, refresh } = setup(() => [CONFIG]);
    await refresh();
    // msg_d1 is in S0, S1 and S2 with equal totals: S0's path sorts first, wherever the files were read from.
    expect(totalsOf(db, S0).total).toBe(1190);
    expect(totalsOf(db, S2).total).toBe(144 + 410); // its own message and the larger copy of msg_d3
  });

  it('[A4] gives a message to the copy with the larger total, not the earlier or the first read', async () => {
    const { db, refresh } = setup(() => [CONFIG]);
    await refresh();
    const owner = db
      .prepare(
        `SELECT s.provider_session_id AS id, e.provider_total AS total FROM usage_event e JOIN session s ON s.id = e.session_id
          WHERE e.dedupe_key = 'msg_d3:req_d3'`,
      )
      .get() as { id: string; total: number };
    expect(owner).toEqual({ id: S2, total: 410 }); // S1 holds it too, with 380
  });

  it('[A4] keeps the main-thread copy of a message even when the sidechain copy is larger', async () => {
    const { db, refresh } = setup(() => [CONFIG]);
    await refresh();
    const owner = db
      .prepare(
        `SELECT s.provider_session_id AS id, e.provider_total AS total FROM usage_event e JOIN session s ON s.id = e.session_id
          WHERE e.dedupe_key = 'msg_d6:req_d6'`,
      )
      .get() as { id: string; total: number };
    expect(owner).toEqual({ id: S1, total: 30 }); // the subagent's copy (200) is the sidechain's
  });

  it('[A4] is the same whichever order the folders are given in, and a message the folders share is counted once', async () => {
    const dir = tempDir();
    // the same message in two config roots, equal totals, in sessions x0 (root "a") and x1 (root "b")
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    const shared = assistantLine({ id: 'msg_shared', at: '2026-10-20T10:00:05Z', output: 20 });
    putTranscript(a, 'proj/x0.jsonl', [shared]);
    putTranscript(b, 'proj/x1.jsonl', [shared]);
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const { db, refresh } = setup(() => order);
      await refresh();
      expect(totalsOf(db)).toMatchObject({ events: 1, total: 21 });
      expect(totalsOf(db, 'x0').total).toBe(21); // "a/…" sorts before "b/…"
      expect(totalsOf(db, 'x1').total).toBe(0);
    }
  });

  it('[A4] lets a larger copy found later take the message, and a smaller one never does', async () => {
    const dir = tempDir();
    putTranscript(dir, 'proj/x0.jsonl', [
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', output: 20 }),
    ]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();
    const later = putTranscript(dir, 'proj/x1.jsonl', [
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', output: 90 }),
    ]);
    await refresh();
    expect(totalsOf(db, 'x1').total).toBe(91); // larger: it takes the event over
    expect(totalsOf(db, 'x0').total).toBe(0);
    appendLines(later, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:06Z', output: 5 })]);
    await refresh();
    expect(totalsOf(db, 'x1').total).toBe(91);
  });

  it('[A3] counts a usage line with no request id once for an issued message id, and each time for a made-up one', async () => {
    const { db, refresh } = setup(() => [CONFIG]);
    await refresh();
    const keys = (
      db
        .prepare(
          "SELECT dedupe_key AS k FROM usage_event WHERE dedupe_key LIKE 'msg_d5%' OR dedupe_key LIKE 'gw-1%' ORDER BY k",
        )
        .all() as { k: string }[]
    ).map((row) => row.k);
    expect(keys).toHaveLength(3);
    expect(keys.filter((key) => key.startsWith('gw-1'))).toHaveLength(2);
    expect(app(db).get(S1)?.['total']).toBe(692); // the root and its subagent, as the oracle reports one session
  });

  it('[A6] counts the advisor’s own usage as one more event of the same message', async () => {
    const { db, refresh } = setup(() => [CONFIG]);
    await refresh();
    const advisor = db
      .prepare(
        "SELECT model, input_tokens AS i, cache_read_tokens AS r, output_tokens AS o, provider_total AS t FROM usage_event WHERE dedupe_key LIKE 'msg_d4:advisor:%'",
      )
      .all();
    expect(advisor).toEqual([{ model: 'claude-advisor-1', i: 10, r: 100, o: 5, t: 115 }]);
  });

  it('[A7] does not count a line with an empty session id or a version that is not one, and calls neither damage', async () => {
    const { db, refresh } = setup(() => [CONFIG]);
    const report = await refresh();
    expect(report).toMatchObject({ unreadable: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM usage_event WHERE dedupe_key LIKE 'msg_bad%'").get(),
    ).toEqual({ n: 0 });
  });
});

describe('history imported under an older counting rule', () => {
  it('reads every transcript still there again and gives each message to the copy the current rules choose', async () => {
    const { db, refresh } = setup(() => [CONFIG]);
    await refresh();
    const right = db
      .prepare('SELECT COUNT(*) AS n, SUM(provider_total) AS t FROM usage_event')
      .get();

    // What an older version could have left: the message with the file that was read first (S1's), not the one that sorts first.
    const wrong = db
      .prepare(
        `UPDATE usage_event SET session_id = (SELECT id FROM session WHERE provider_session_id = ?),
                                source_file_id = (SELECT id FROM source_file WHERE path LIKE ?)
          WHERE dedupe_key = 'msg_d1:req_d1'`,
      )
      .run(S1, `%${S1}.jsonl`);
    expect(Number(wrong.changes)).toBe(1);
    expect(totalsOf(db, S0).total).toBe(0);
    db.prepare(
      "INSERT INTO source_state (source_id, status, adapter_version) VALUES ('claude', 'ok', 'claude-transcripts-1')",
    ).run();

    const migrated = await refresh();
    expect(migrated).toMatchObject({ result: 'succeeded' });
    expect(totalsOf(db, S0).total).toBe(1190);
    expect(
      db.prepare('SELECT COUNT(*) AS n, SUM(provider_total) AS t FROM usage_event').get(),
    ).toEqual(right);
    void S2;
    void S3;
    void CLAUDE_ADAPTER_VERSION;
  });
});
