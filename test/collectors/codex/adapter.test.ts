import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVED_ID,
  CHILD_FILE,
  CHILD_ID,
  CORRUPT_ID,
  FIXTURES,
  NOW,
  ORPHAN_ID,
  RESET_ID,
  ROOT_FILE,
  ROOT_ID,
  copyHome,
  fileRow,
  lines,
  memoryDb,
  metaLine,
  put,
  refresh,
  sessionRow,
  snapshotLine,
  tempDir,
  totalsOf,
  trackedPaths,
  turnLine,
} from './helpers.ts';

// The Codex adapter on the draft fixture folders under test/fixtures/codex. Those files and the oracle JSON beside them are
// INVENTED (the oracle is what ccusage 20.0.48 printed for the invented `home/`); nothing here is a finding about a real
// Codex, and the numbers are the ones in the fixtures' README.

interface Oracle {
  sessions: {
    sessionFile: string;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  }[];
}
const readOracle = (name: string): Oracle =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Oracle;

/** Differences between what the database holds and an oracle, one line each; empty when they agree to the token. */
function reconcile(db: ReturnType<typeof memoryDb>, oracle: Oracle): string[] {
  const differences: string[] = [];
  for (const entry of oracle.sessions) {
    const id = entry.sessionFile.slice(-36);
    const mine = totalsOf(db, id);
    // ccusage reports input without the cached part; Codex's own input includes it.
    const expected = {
      input: entry.inputTokens + entry.cacheReadTokens,
      cached: entry.cacheReadTokens,
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
  return differences;
}

describe('the draft home (a root, a spawned subagent, an archived rollout, a compressed twin)', () => {
  it('reconciles with the oracle to the token, and says what it imported', async () => {
    const db = memoryDb();
    const { report } = await refresh(db, [join(FIXTURES, 'home')]);

    expect(reconcile(db, readOracle('oracle.json'))).toEqual([]);
    expect(report).toMatchObject({
      result: 'succeeded',
      status: 'ok',
      imported: 3,
      duplicatesSkipped: 0,
      unreadable: 0,
      unsupported: 0,
      oldestEventAt: Date.parse('2026-09-28T20:10:15.000Z'),
      adapterVersion: expect.stringContaining('codex'),
    });
    expect(report).toHaveProperty('location', join(FIXTURES, 'home', 'sessions'));
  });

  it('would fail against the report that is one token off, so the reconciliation above says something', async () => {
    const db = memoryDb();
    await refresh(db, [join(FIXTURES, 'home')]);
    expect(reconcile(db, readOracle('oracle-one-token-off.json'))).toEqual([
      `${CHILD_ID.slice(0, 8)} output: 300 != 299`,
      `${CHILD_ID.slice(0, 8)} total: 1700 != 1699`,
    ]);
  });

  it('measures the subagent from its inherited baseline, and links it to its parent', async () => {
    const db = memoryDb();
    await refresh(db, [join(FIXTURES, 'home')]);
    const root = sessionRow(db, ROOT_ID);
    const child = sessionRow(db, CHILD_ID);
    expect(totalsOf(db, CHILD_ID)).toMatchObject({ events: 2, total: 1700 }); // 4600 less the 2900 it inherited
    expect(child).toMatchObject({
      kind: 'child',
      parent_session_id: root?.id,
      parent_basis: 'native',
      native_kind: 'codex_subagent',
    });
    expect(root).toMatchObject({ kind: 'root', parent_session_id: null, native_kind: null });
    expect(sessionRow(db, ARCHIVED_ID)).toMatchObject({ kind: 'root' });
  });

  it('reconciles an unchanged child when its compressed parent arrives and retains the result if it disappears', async () => {
    const db = memoryDb();
    const fresh = memoryDb();
    const home = tempDir();
    const root = join(FIXTURES, 'home');
    put(home, CHILD_FILE, readFileSync(join(root, CHILD_FILE), 'utf8'));
    await refresh(db, [home]);
    const originalChild = sessionRow(db, CHILD_ID)!;
    expect(totalsOf(db, CHILD_ID)?.total).toBe(4600);

    const parentPath = put(home, `${ROOT_FILE}.zst`, readFileSync(join(root, ROOT_FILE), 'utf8'));
    await refresh(db, [home]);
    await refresh(fresh, [home]);
    expect(totalsOf(db, CHILD_ID)).toEqual(totalsOf(fresh, CHILD_ID));
    expect(totalsOf(db, CHILD_ID)?.total).toBe(1700);
    expect(sessionRow(db, CHILD_ID)).toMatchObject({
      id: originalChild.id,
      kind: 'child',
      parent_session_id: sessionRow(db, ROOT_ID)?.id,
      first_event_at: Date.parse('2026-10-12T09:05:30.000Z'),
    });
    const unchanged = await refresh(db, [home]);
    expect(unchanged.progress).toEqual([]);
    rmSync(parentPath);
    await refresh(db, [home]);
    expect(totalsOf(db, CHILD_ID)?.total).toBe(1700);
  });

  it('recomputes an unchanged child after replacing the parent input it used', async () => {
    const home = copyHome();
    const incremental = memoryDb();
    const fresh = memoryDb();
    await refresh(incremental, [home]);
    const parent = readFileSync(join(home, ROOT_FILE), 'utf8');
    put(home, ROOT_FILE, parent.replaceAll('"input_tokens":1200', '"input_tokens": 1201'));
    await refresh(incremental, [home]);
    await refresh(fresh, [home]);
    expect(totalsOf(incremental, CHILD_ID)).toEqual(totalsOf(fresh, CHILD_ID));
    expect(totalsOf(incremental, CHILD_ID)?.total).not.toBe(1700);
  });

  it('reconciles legacy ownership when a rollout was archived before the upgrade', async () => {
    const home = copyHome();
    const db = memoryDb();
    await refresh(db, [home]);
    const child = sessionRow(db, CHILD_ID)!;
    db.exec("UPDATE source_file SET normalization_version = NULL WHERE source_id = 'codex'");
    db.prepare(`UPDATE usage_event SET provider_total = 10000 WHERE session_id = ?`).run(child.id);
    const active = join(home, CHILD_FILE);
    put(home, `archived_sessions/${basename(CHILD_FILE)}.zst`, readFileSync(active, 'utf8'));
    rmSync(active);

    expect((await refresh(db, [home])).report).toMatchObject({ result: 'succeeded' });
    expect(totalsOf(db, CHILD_ID)).toMatchObject({ events: 2, total: 1700 });
    expect(sessionRow(db, CHILD_ID)?.id).toBe(child.id);
  });

  it('gives the session its start from session_meta, and the first own usage and last model beside it', async () => {
    const db = memoryDb();
    await refresh(db, [join(FIXTURES, 'home')]);
    expect(sessionRow(db, ROOT_ID)).toMatchObject({
      started_at: Date.parse('2026-10-12T09:00:00.000Z'),
      started_basis: 'source_start',
      first_event_at: Date.parse('2026-10-12T09:00:06.000Z'),
      last_event_at: Date.parse('2026-10-12T09:00:20.000Z'),
      last_model: 'gpt-5-codex',
    });
    // The child's start is its own session_meta, not the parent's replayed lines that are older than it.
    expect(sessionRow(db, CHILD_ID)).toMatchObject({
      started_at: Date.parse('2026-10-12T09:05:00.000Z'),
      first_event_at: Date.parse('2026-10-12T09:05:30.000Z'),
    });
    expect(sessionRow(db, ARCHIVED_ID)).toMatchObject({ last_model: 'gpt-5' });
  });

  it('stores working directory and branch as metadata, and reads the repository from nothing it was not given', async () => {
    const db = memoryDb();
    await refresh(db, [join(FIXTURES, 'home')]);
    expect(sessionRow(db, ROOT_ID)).toMatchObject({
      cwd: '/fixture/SENTINEL_CWD_a1b2c3/app',
      git_branch: 'SENTINEL_BRANCH_a1b2c3',
      repo_id: null, // an invented, non-GitHub remote and a folder that is not here
    });
  });

  it('reads the plain file and not its compressed twin, and the archived rollout through its decoder', async () => {
    const db = memoryDb();
    await refresh(db, [join(FIXTURES, 'home')]);
    const home = join(FIXTURES, 'home');
    expect(trackedPaths(db)).toEqual([
      join(
        home,
        'archived_sessions/rollout-2026-09-28T20-10-00-cccccccc-3333-4333-8333-00000000000c.jsonl.zst',
      ),
      join(home, ROOT_FILE),
      join(home, CHILD_FILE),
    ]);
  });

  it('reports progress per file: 0 of 3, then up to 3 of 3', async () => {
    const { progress } = await refresh(memoryDb(), [join(FIXTURES, 'home')]);
    expect(progress).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
  });
});

describe('a refresh with nothing new', () => {
  it('stats the files and reads none: no progress, no new rows, the stored read times stay', async () => {
    const home = copyHome();
    const db = memoryDb();
    await refresh(db, [home]);
    const before = trackedPaths(db).map((path) => fileRow(db, path));

    const again = await refresh(db, [home], {}, NOW + 900_000);
    expect(again.progress).toEqual([]);
    expect(again.report).toMatchObject({ result: 'succeeded', imported: 0, duplicatesSkipped: 0 });
    expect(trackedPaths(db).map((path) => fileRow(db, path))).toEqual(before);
    expect(totalsOf(db, ROOT_ID)?.total).toBe(2900);
  });
});

describe('a rollout that grows', () => {
  it('reads it again from the start and adds only the new delta; the events seen again are skipped', async () => {
    const home = copyHome();
    const db = memoryDb();
    await refresh(db, [home]);

    appendFileSync(
      join(home, ROOT_FILE),
      `${snapshotLine('2026-10-12T09:30:00.000Z', [3000, 2000, 500, 100])}\n`,
    );
    const { report, progress } = await refresh(db, [home], {}, NOW + 900_000);

    expect(progress).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
    // 3500 cumulative less the 2900 before it; the root's two earlier events came round again and were skipped.
    expect(totalsOf(db, ROOT_ID)).toMatchObject({
      events: 3,
      input: 3000,
      output: 500,
      total: 3500,
    });
    expect(totalsOf(db, CHILD_ID)?.total).toBe(1700);
    expect(report).toMatchObject({ imported: 0, duplicatesSkipped: 4 });
    expect(sessionRow(db, ROOT_ID)?.last_event_at).toBe(Date.parse('2026-10-12T09:30:00.000Z'));
    expect(fileRow(db, join(home, ROOT_FILE))?.last_read_at).toBe(NOW + 900_000);
  });

  it('adds nothing when the same content is read again (a copy or a retried file)', async () => {
    const home = copyHome();
    const db = memoryDb();
    await refresh(db, [home]);
    const second = copyHome(); // the same rollouts again, as another home would hold them
    const { report } = await refresh(db, [home, second]);
    // A change in the selected parent also rechecks the previously imported child.
    expect(report).toMatchObject({ imported: 0, duplicatesSkipped: second < home ? 8 : 6 });
    expect(reconcile(db, readOracle('oracle.json'))).toEqual([]);
  });
});

describe('a rollout that gets its first usage after a read with none', () => {
  it('keeps the start session_meta gave it, the same as a fresh import (a guard: a Codex rollout is always read from its start)', async () => {
    const id = 'abababab-1111-4111-8111-0000000000ab';
    const file = `sessions/2026/10/20/rollout-2026-10-20T10-00-00-${id}.jsonl`;
    const home = tempDir();
    const path = put(
      home,
      file,
      lines(
        metaLine(id, '2026-10-20T10:00:00.000Z'),
        turnLine('2026-10-20T10:00:01.000Z', 'gpt-x'),
      ),
    );
    const db = memoryDb();
    await refresh(db, [home]);
    expect(sessionRow(db, id)).toBeNull(); // no usage yet, no session

    appendFileSync(path, `${snapshotLine('2026-10-20T13:30:00.000Z', [100, 40, 10, 0])}\n`);
    await refresh(db, [home], {}, NOW + 900_000);
    const stored = sessionRow(db, id);
    expect(stored).toMatchObject({
      started_at: Date.parse('2026-10-20T10:00:00.000Z'),
      started_basis: 'source_start',
    });

    const fresh = memoryDb();
    await refresh(fresh, [home]);
    const once = sessionRow(fresh, id);
    expect([stored?.started_at, stored?.started_basis]).toEqual([
      once?.started_at,
      once?.started_basis,
    ]);
  });
});

describe('a counter that starts over', () => {
  it('[X2] takes the request after the drop as its own last_token_usage, and a second read changes nothing', async () => {
    const db = memoryDb();
    await refresh(db, [join(FIXTURES, 'home-reset')]);
    const once = {
      events: 4,
      input: 2600,
      cached: 1600,
      output: 600,
      reasoning: 130,
      total: 3200,
    };
    expect(totalsOf(db, RESET_ID)).toEqual(once);
    const keys = (
      db.prepare('SELECT dedupe_key FROM usage_event').all() as { dedupe_key: string }[]
    ).map((row) => row.dedupe_key);
    expect(new Set(keys).size).toBe(4); // four events, four keys: the repeated total after the reset is not a copy
    const again = await refresh(db, [join(FIXTURES, 'home-reset')], {}, NOW + 900_000);
    expect(again.report).toMatchObject({ imported: 0 });
    expect(totalsOf(db, RESET_ID)).toEqual(once);
  });
});

describe('a subagent that names no parent', () => {
  it('is kind unknown with no edge, and its usage is still imported', async () => {
    const db = memoryDb();
    const { report } = await refresh(db, [join(FIXTURES, 'home-orphan')]);
    expect(sessionRow(db, ORPHAN_ID)).toMatchObject({
      kind: 'unknown',
      parent_session_id: null,
      parent_basis: null,
      native_kind: 'codex_subagent',
    });
    expect(totalsOf(db, ORPHAN_ID)).toMatchObject({ events: 1, total: 790 });
    expect(report).toMatchObject({ result: 'succeeded', imported: 1 });
  });
});

describe('a rollout with lines that cannot be read', () => {
  it('imports what it can, counts the rest, and says Partial without a word of the lines', async () => {
    const db = memoryDb();
    const { report } = await refresh(db, [join(FIXTURES, 'home-corrupt')]);
    expect(totalsOf(db, CORRUPT_ID)).toMatchObject({ events: 1, total: 560 });
    expect(report).toMatchObject({
      result: 'partial',
      status: 'partial',
      imported: 1,
      unreadable: 2,
    });
    const [path] = trackedPaths(db);
    expect(fileRow(db, path ?? '')).toMatchObject({ state: 'partial', unreadable_lines: 2 });
    expect(JSON.stringify(report)).not.toContain('SENTINEL');
  });

  it('keeps counting them on the next refresh, which reads nothing', async () => {
    const home = copyHome('home-corrupt');
    const db = memoryDb();
    await refresh(db, [home]);
    const { report, progress } = await refresh(db, [home], {}, NOW + 900_000);
    expect(progress).toEqual([]);
    expect(report).toMatchObject({ result: 'partial', unreadable: 2, imported: 0 });
  });
});

describe('what is stored', () => {
  it('holds no prompt, reply, instruction, commit, nickname, role or unreadable line, from any draft home', async () => {
    const db = memoryDb();
    const reports: unknown[] = [];
    for (const name of ['home', 'home-orphan', 'home-corrupt', 'home-reset'])
      reports.push((await refresh(db, [join(FIXTURES, name)])).report);
    const everything = JSON.stringify({
      reports,
      session: db.prepare('SELECT * FROM session').all(),
      event: db.prepare('SELECT * FROM usage_event').all(),
      file: db.prepare('SELECT * FROM source_file').all(),
    });
    const leaked = [...everything.matchAll(/SENTINEL_[A-Za-z0-9_]+/g)].map((m) => m[0]);
    // Only the working directory and branch are metadata TECH keeps (`session.cwd`, `session.git_branch`).
    expect(leaked.filter((word) => !/^SENTINEL_(CWD|BRANCH)_/.test(word))).toEqual([]);
  });
});
