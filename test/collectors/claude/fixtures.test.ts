import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/helpers.ts';
import {
  CONFIG_B,
  FIXTURES,
  eventKeys,
  fileRows,
  sessionById,
  sessionRows,
  setup,
  totalsOf,
} from './helpers.ts';

// The adapter over the draft fixtures in test/fixtures/claude (DRAFT-documented-shape, invented values). The oracle files there
// were produced by ccusage over this same invented data, so agreeing with them shows the adapter counts the way the E1 script
// does; it is not a claim about any real Claude Code file.

const S1 = '11111111-aaaa-4aaa-8aaa-000000000001';
const S1_AGENT = `${S1}:agent-a1b2c3d`;
const S2 = '22222222-bbbb-4bbb-8bbb-000000000002';
const S3 = '33333333-cccc-4ccc-8ccc-000000000003';
const S5 = '55555555-ffff-4fff-8fff-000000000005';
const S5_AGENT = `${S5}:agent-b7c8d9e`;

const at = (iso: string): number => Date.parse(iso);

interface Oracle {
  sessions: {
    sessionId: string;
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
  }[];
}
const oracle = JSON.parse(readFileSync(join(FIXTURES, 'oracle.json'), 'utf8')) as Oracle;

describe('the documented-shape fixtures, one config dir', () => {
  it('imports the three sessions and the subagent, skipping the set-aside copy, and says so in the report', async () => {
    const { db, refresh } = setup(() => [FIXTURES]);
    const report = await refresh();
    expect(report).toMatchObject({
      result: 'succeeded',
      status: 'ok',
      imported: 4, // three roots and one child
      duplicatesSkipped: 1, // session 1's first message, streamed over two lines
      unreadable: 0,
      unsupported: 0,
      location: join(FIXTURES, 'projects'),
      message: null,
    });
    expect(sessionRows(db).map((row) => row.providerSessionId)).toEqual([S1, S1_AGENT, S2, S3]);
    // Four files were read; the `.orphaned-` copy of session 2 never became a file row.
    expect(fileRows(db).map((row) => row.path.slice(FIXTURES.length + 1))).toEqual([
      'projects/-fixture-SENTINEL_CWD_a1b2c3-app/11111111-aaaa-4aaa-8aaa-000000000001.jsonl',
      'projects/-fixture-SENTINEL_CWD_a1b2c3-app/11111111-aaaa-4aaa-8aaa-000000000001/subagents/agent-a1b2c3d.jsonl',
      'projects/-fixture-SENTINEL_CWD_a1b2c3-app/22222222-bbbb-4bbb-8bbb-000000000002.jsonl',
      'projects/-fixture-SENTINEL_CWD_d4e5f6-lib/33333333-cccc-4ccc-8ccc-000000000003.jsonl',
    ]);
  });

  it('reproduces the oracle: a root plus its subagent equals the oracle session, category by category', async () => {
    const { db, refresh } = setup(() => [FIXTURES]);
    await refresh();
    for (const expected of oracle.sessions) {
      const parent = sessionById(db, expected.sessionId);
      const family = [parent, ...sessionRows(db).filter((s) => s.parentSessionId === parent.id)];
      const sum = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };
      for (const session of family) {
        const own = totalsOf(db, session.providerSessionId);
        sum.input += own.input;
        sum.cacheWrite += own.cacheWrite;
        sum.cacheRead += own.cacheRead;
        sum.output += own.output;
        sum.total += own.total;
      }
      expect(sum, expected.sessionId).toEqual({
        input: expected.inputTokens,
        cacheWrite: expected.cacheCreationTokens,
        cacheRead: expected.cacheReadTokens,
        output: expected.outputTokens,
        total: expected.totalTokens,
      });
    }
  });

  it('keeps the subagent as a child session of its parent, with native parentage', async () => {
    const { db, refresh } = setup(() => [FIXTURES]);
    await refresh();
    const parent = sessionById(db, S1);
    expect(parent).toMatchObject({ kind: 'root', parentSessionId: null, nativeKind: null });
    expect(sessionById(db, S1_AGENT)).toMatchObject({
      kind: 'child',
      parentSessionId: parent.id,
      parentBasis: 'native',
      nativeKind: 'claude_subagent',
    });
    // The parent's own total leaves out what the subagent used: each is counted once, in its own session.
    expect(totalsOf(db, S1).total).toBe(11712);
    expect(totalsOf(db, S1_AGENT).total).toBe(4225);
  });

  it('starts each session at the earliest line of any type, and a subagent at its own earliest line', async () => {
    const { db, refresh } = setup(() => [FIXTURES]);
    await refresh();
    // Session 1: the summary line has no timestamp and is ignored, so the first prompt is the start.
    expect(sessionById(db, S1)).toMatchObject({
      startedAt: at('2026-10-12T09:00:00Z'),
      startedBasis: 'source_start',
    });
    // Session 2: a queue-operation line comes before the first prompt, and it is a line like any other.
    expect(sessionById(db, S2)).toMatchObject({
      startedAt: at('2026-10-12T14:29:58Z'),
      startedBasis: 'source_start',
    });
    expect(sessionById(db, S3).startedAt).toBe(at('2026-10-13T08:15:00Z'));
    expect(sessionById(db, S1_AGENT).startedAt).toBe(at('2026-10-12T09:00:07Z'));
    // Start is never later than the first usage.
    for (const session of sessionRows(db)) {
      expect(session.startedAt).toBeLessThanOrEqual(session.firstEventAt!);
    }
  });

  it('stores the recorded title from either title shape, and the working directory, branch and model', async () => {
    const { db, refresh } = setup(() => [FIXTURES]);
    await refresh();
    expect(sessionById(db, S1)).toMatchObject({
      recordedName: 'SENTINEL_TITLE_a1b2c3', // a `summary` line
      nameSource: 'provider_title',
      cwd: '/fixture/SENTINEL_CWD_a1b2c3/app',
      gitBranch: 'SENTINEL_BRANCH_a1b2c3',
      lastModel: 'claude-sonnet-4-5',
    });
    expect(sessionById(db, S2)).toMatchObject({
      recordedName: null,
      nameSource: null,
      lastModel: 'claude-opus-4-1',
    });
    expect(sessionById(db, S3).recordedName).toBe('SENTINEL_TITLE_d4e5f6'); // a `custom-title` line
    // The fixture working directories do not exist here, so there is no repo to find.
    expect(sessionById(db, S1)).toMatchObject({ repoId: null, repoBasis: null });
  });

  it('counts a message streamed over two lines once, however the second line is dated', async () => {
    const { db, refresh } = setup(() => [FIXTURES]);
    await refresh();
    expect(eventKeys(db).filter((key) => key.startsWith('msg_fixture_s1_01'))).toEqual([
      'msg_fixture_s1_01:req_fixture_s1_01',
    ]);
    expect(totalsOf(db).events).toBe(8);
    const dated = db
      .prepare(
        "SELECT occurred_at FROM usage_event WHERE dedupe_key = 'msg_fixture_s1_01:req_fixture_s1_01'",
      )
      .get() as { occurred_at: number };
    // Both lines hold the same usage: the first of equal totals stays, as in the oracle ([A4]), so its time is the event's.
    expect(dated.occurred_at).toBe(at('2026-10-12T09:00:05Z'));
  });

  it('does nothing on the next refresh when no file changed: no read, no progress, no new count', async () => {
    const { db, refresh, progress } = setup(() => [FIXTURES]);
    await refresh();
    const before = fileRows(db);
    const second = await refresh();
    expect(second).toMatchObject({ result: 'succeeded', imported: 0, duplicatesSkipped: 0 });
    expect(progress).toEqual([]);
    expect(fileRows(db)).toEqual(before); // including lastReadAt: nothing was opened
    expect(totalsOf(db).events).toBe(8);
  });

  it('tells the run how many files it will read and after each one', async () => {
    const { refresh, progress } = setup(() => [FIXTURES]);
    await refresh();
    expect(progress).toEqual([
      { done: 0, total: 4 },
      { done: 1, total: 4 },
      { done: 2, total: 4 },
      { done: 3, total: 4 },
      { done: 4, total: 4 },
    ]);
  });
});

describe('two config dirs (`~/.claude` and `~/.config/claude`)', () => {
  it('reads both, counts the session both hold once, and takes the last streamed line of a message', async () => {
    const { db, refresh } = setup(() => [FIXTURES, CONFIG_B]);
    const report = await refresh();
    expect(report).toMatchObject({
      result: 'succeeded',
      imported: 6,
      // session 1 (1 streamed line), session 5 (2), and session 2's two messages seen again in the second dir
      duplicatesSkipped: 5,
      unreadable: 0,
    });
    expect(sessionRows(db).map((row) => row.providerSessionId)).toEqual([
      S1,
      S1_AGENT,
      S2,
      S3,
      S5,
      S5_AGENT,
    ]);
    // Session 2 is in the oracle once, whichever dir was read first.
    const expectedS2 = oracle.sessions.find((s) => s.sessionId === S2)!;
    expect(totalsOf(db, S2).total).toBe(expectedS2.totalTokens);
    // Session 5: the streamed message counts its last line (output 143, not 12, 60 or the set-aside copy's 999).
    expect(totalsOf(db, S5)).toEqual({
      events: 2,
      input: 15,
      cacheWrite: 200,
      cacheRead: 6350,
      output: 231,
      total: 6796,
    });
    expect(totalsOf(db, S5_AGENT)).toMatchObject({ events: 2, total: 1788 });
    expect(eventKeys(db)).not.toContain('msg_fixture_s5_00:undefined'); // the zero-token notice is not an event
  });

  it('skips `.jsonl.superseded-*` copies and does not count a zero-token notice as an unreadable line', async () => {
    const { db, refresh } = setup(() => [CONFIG_B]);
    const report = await refresh();
    expect(report).toMatchObject({ result: 'succeeded', unreadable: 0 });
    const paths = fileRows(db).map((row) => row.path);
    expect(paths.some((path) => path.includes('superseded'))).toBe(false);
    expect(paths).toHaveLength(3);
    expect(sessionById(db, S5).recordedName).toBe('SENTINEL_TITLE_b7c8d9'); // a late rename, with no timestamp
    expect(sessionById(db, S5).startedAt).toBe(at('2026-10-15T07:59:50Z')); // the queue-operation line
    expect(sessionById(db, S5_AGENT).startedAt).toBe(at('2026-10-15T08:00:20Z'));
  });
});

describe('the corrupt and orphan fixtures', () => {
  it('counts the line that is not JSON and the cut-off line as unreadable, imports the rest, and shows no text', async () => {
    const dir = tempDir();
    cpSync(join(FIXTURES, 'projects-corrupt'), join(dir, 'projects'), { recursive: true });
    const { db, refresh, logs } = setup(() => [dir]);
    const report = await refresh();
    expect(report).toMatchObject({
      result: 'partial',
      status: 'partial',
      imported: 1,
      unreadable: 2,
    });
    expect(report.result === 'partial' && report.message).toBe(
      'Claude Code: 2 records couldn’t be read. The rest was imported.',
    );
    expect(totalsOf(db)).toMatchObject({ events: 1, total: 9 + 300 + 41 });
    const [file] = fileRows(db);
    expect(file).toMatchObject({ state: 'partial', unreadableLines: 2 });
    // Both bad lines end in a newline, so they are complete (just not JSON) and the whole file is read. A last line with no
    // newline is a different case, left for the next read: see refresh.test.ts.
    expect(file!.readOffset).toBe(file!.size);
    // No line text reached the report or a log.
    expect(JSON.stringify([report, logs.entries])).not.toMatch(/SENTINEL/);
  });

  it('keeps a subagent whose parent has no main transcript as a child with no stored parent', async () => {
    const dir = tempDir();
    cpSync(join(FIXTURES, 'projects-orphan'), join(dir, 'projects'), { recursive: true });
    const { db, refresh } = setup(() => [dir]);
    const report = await refresh();
    expect(report).toMatchObject({ result: 'succeeded', imported: 1 });
    expect(sessionRows(db)).toHaveLength(1); // no parent row is made up
    expect(sessionRows(db)[0]).toMatchObject({
      providerSessionId: '99999999-dddd-4ddd-8ddd-000000000009:agent-f6a1b2c',
      kind: 'child',
      parentSessionId: null,
      parentBasis: 'native',
      nativeKind: 'claude_subagent',
      startedAt: at('2026-10-14T10:00:00Z'),
    });
  });
});
