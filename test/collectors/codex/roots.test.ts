import { chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVED_ID,
  CHILD_FILE,
  CHILD_ID,
  FIXTURES,
  NOW,
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
  spawnedFrom,
  tempDir,
  totalsOf,
  trackedPaths,
  turnLine,
} from './helpers.ts';

// Which files are read, what a folder or file that cannot be read does, and how a subagent finds its parent. Rollouts come from
// the draft fixture folders (copied, so a test may change them) or are written here with invented ids and counts.

const ARCHIVED_NAME = 'rollout-2026-09-28T20-10-00-cccccccc-3333-4333-8333-00000000000c';
const ROOT_TEXT = (): string => readFileSync(join(FIXTURES, 'home', ROOT_FILE), 'utf8');

/** The nth second after 10:00:00 on the day the generated rollouts are written. */
const at = (n: number): string =>
  new Date(Date.UTC(2026, 9, 20, 10, 0, 0) + n * 1000).toISOString();

describe('which copy of a rollout is read', () => {
  it('reads the plain file and not its .zst twin (same folder, same name)', async () => {
    const home = copyHome();
    const db = memoryDb();
    await refresh(db, [home]);
    expect(trackedPaths(db).filter((path) => path.includes('aaaaaaaa'))).toEqual([
      join(home, ROOT_FILE),
    ]);
  });

  it('reads the compressed twin when the plain file is not there', async () => {
    const home = copyHome();
    rmSync(join(home, ROOT_FILE));
    const db = memoryDb();
    await refresh(db, [home]);
    expect(trackedPaths(db).filter((path) => path.includes('aaaaaaaa'))).toEqual([
      `${join(home, ROOT_FILE)}.zst`,
    ]);
    expect(totalsOf(db, ROOT_ID)?.total).toBe(2900);
  });

  it('prefers sessions/ over archived_sessions/ for the same rollout, whether the archive kept its date folder or not', async () => {
    for (const archivedAt of [
      `archived_sessions/${ARCHIVED_NAME}.jsonl`,
      `archived_sessions/2026/09/28/${ARCHIVED_NAME}.jsonl.zst`,
    ]) {
      const home = copyHome();
      const activePath = put(
        home,
        `sessions/2026/09/28/${ARCHIVED_NAME}.jsonl`,
        ROOT_TEXT().replaceAll(ROOT_ID, ARCHIVED_ID),
      );
      put(home, archivedAt, 'this copy is never read, so nothing here needs to be a rollout\n');
      rmSync(join(home, 'archived_sessions', `${ARCHIVED_NAME}.jsonl.zst`), { force: true });
      const db = memoryDb();
      const { report } = await refresh(db, [home]);
      expect(trackedPaths(db).filter((path) => path.includes('cccccccc'))).toEqual([activePath]);
      expect(report).toMatchObject({ result: 'succeeded', unreadable: 0, unsupported: 0 });
    }
  });

  it('reads the archived copy when sessions/ has none', async () => {
    const db = memoryDb();
    await refresh(db, [join(FIXTURES, 'home')]);
    expect(totalsOf(db, ARCHIVED_ID)).toMatchObject({ events: 2, input: 2100, total: 2450 });
  });

  it('reads two homes, and one file once when a home is listed twice', async () => {
    const first = copyHome();
    const second = copyHome('home-orphan');
    const db = memoryDb();
    const { report, progress } = await refresh(db, [first, second, first]);
    expect(report).toMatchObject({ imported: 4 });
    expect(progress.at(-1)).toEqual({ done: 4, total: 4 });
    expect(trackedPaths(db)).toHaveLength(4);
  });

  it('only reads .jsonl and .jsonl.zst, and anything below sessions/ at any depth', async () => {
    const home = tempDir();
    put(home, 'sessions/notes.txt', 'not a rollout');
    put(
      home,
      'sessions/a/b/c/d/e/f/g/rollout-deep.jsonl',
      lines(
        metaLine(ROOT_ID, '2026-10-20T10:00:00.000Z'),
        snapshotLine('2026-10-20T10:00:05.000Z', [10, 0, 1, 0]),
      ),
    );
    const db = memoryDb();
    await refresh(db, [home]);
    expect(trackedPaths(db)).toEqual([join(home, 'sessions/a/b/c/d/e/f/g/rollout-deep.jsonl')]);
  });
});

describe('a .zst the adapter cannot decode', () => {
  it('reports a missing decoder as unsupported, still imports the plain files, and does not retry until the file changes', async () => {
    const home = copyHome();
    const db = memoryDb();
    const { report } = await refresh(db, [home], { zstd: null });
    const archived = join(home, 'archived_sessions', `${ARCHIVED_NAME}.jsonl.zst`);
    expect(fileRow(db, archived)).toMatchObject({ state: 'unsupported' });
    expect(report).toMatchObject({
      result: 'partial',
      status: 'partial',
      unsupported: 1,
      imported: 2,
    });
    expect(totalsOf(db, ARCHIVED_ID)).toBeNull();

    // Even with a decoder now, an unchanged file stays skipped (a format change is what it waits for).
    const again = await refresh(db, [home], {}, NOW + 900_000);
    expect(again.progress).toEqual([]);
    expect(again.report).toMatchObject({ result: 'partial', unsupported: 1 });

    // Touching it is a change: it is read, and the unsupported mark goes.
    utimesSync(archived, new Date(NOW), new Date(NOW + 1000));
    const fixed = await refresh(db, [home], {}, NOW + 1_800_000);
    expect(fixed.report).toMatchObject({ result: 'succeeded', unsupported: 0, imported: 1 });
    expect(totalsOf(db, ARCHIVED_ID)?.total).toBe(2450);
  });

  it('marks a damaged archive unreadable, carries on with the rest, and tries it again next time', async () => {
    const home = copyHome();
    const archived = join(home, 'archived_sessions', `${ARCHIVED_NAME}.jsonl.zst`);
    writeFileSync(archived, 'this is not zstd data');
    const db = memoryDb();
    const { report } = await refresh(db, [home]);
    expect(fileRow(db, archived)).toMatchObject({ state: 'unreadable' });
    expect(report).toMatchObject({ result: 'partial', unreadable: 1, imported: 2 });

    const again = await refresh(db, [home], {}, NOW + 900_000);
    expect(again.progress).toEqual([
      { done: 0, total: 1 },
      { done: 1, total: 1 },
    ]);
    expect(again.report).toMatchObject({ result: 'partial', unreadable: 1 });
  });

  it('imports what decodes of a cut-off archive and reads it again when it changes (Node’s decoder does not report a truncated stream)', async () => {
    const t = (s: number): string => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`;
    const id = '99999999-cccc-4ccc-8ccc-000000000009';
    const rows = [metaLine(id, t(0))];
    // every snapshot has its own time: two events with the same time and figures are one event (the oracle's copy rule)
    for (let i = 1; i <= 3000; i += 1) rows.push(snapshotLine(at(i), [i * 100, 0, i * 10, 0]));
    const home = tempDir();
    const path = put(home, `archived_sessions/rollout-x-${id}.jsonl.zst`, lines(...rows));
    const whole = readFileSync(path);
    writeFileSync(path, whole.subarray(0, Math.floor(whole.length / 2)));
    const db = memoryDb();
    const cut = await refresh(db, [home]);
    const prefix = totalsOf(db, id)?.events ?? 0;
    expect(cut.report.result).not.toBe('failed');
    expect(prefix).toBeGreaterThan(0);
    expect(prefix).toBeLessThan(3000);

    writeFileSync(path, whole); // the archive is finished: a new size, so it is read again from the start
    await refresh(db, [home], {}, NOW + 900_000);
    expect(totalsOf(db, id)).toMatchObject({ events: 3000, total: 330_000 });
  });
});

describe('when Codex is not there, or cannot be read', () => {
  it('skips when no folder exists and nothing was imported (nothing is recorded)', async () => {
    const { report } = await refresh(memoryDb(), [join(tempDir(), 'no-codex')]);
    expect(report.result).toBe('skipped');
    expect(JSON.stringify(report)).not.toContain(tempDir());
  });

  it('skips for no homes at all, and for a home with no rollouts in it', async () => {
    expect((await refresh(memoryDb(), [])).report.result).toBe('skipped');
    const empty = tempDir();
    mkdirSync(join(empty, 'sessions'));
    expect((await refresh(memoryDb(), [empty])).report.result).toBe('skipped');
  });

  it('succeeds with nothing to read when the logs were deleted, and keeps what was imported (P-29)', async () => {
    const home = copyHome();
    const db = memoryDb();
    await refresh(db, [home]);
    rmSync(home, { recursive: true });
    const { report, progress } = await refresh(db, [home], {}, NOW + 900_000);
    expect(progress).toEqual([]);
    expect(report).toMatchObject({ result: 'succeeded', imported: 0 });
    expect(totalsOf(db, ROOT_ID)?.total).toBe(2900);
    expect(report).toHaveProperty('oldestEventAt', Date.parse('2026-09-28T20:10:15.000Z'));
  });

  it('re-reads the homes it is given every time, so a changed override is seen without a restart', async () => {
    const homes: string[] = [];
    const db = memoryDb();
    expect((await refresh(db, () => homes)).report.result).toBe('skipped');
    homes.push(copyHome('home-orphan'));
    expect((await refresh(db, () => homes)).report).toMatchObject({
      result: 'succeeded',
      imported: 1,
    });
  });

  describe('permissions', () => {
    const lock = (path: string): void => chmodSync(path, 0o000);
    const unlock = (path: string): void => chmodSync(path, 0o755);

    it('fails as denied, recording nothing new, when every folder that exists is unreadable', async () => {
      const home = copyHome();
      const db = memoryDb();
      await refresh(db, [home]);
      const folders = ['sessions', 'archived_sessions'].map((name) => join(home, name));
      folders.forEach(lock);
      try {
        const { report } = await refresh(db, [home], {}, NOW + 900_000);
        expect(report).toMatchObject({
          result: 'failed',
          status: 'denied',
          errorCode: 'access_denied',
          location: folders[0],
        });
        expect(JSON.stringify(report)).not.toContain('SENTINEL');
      } finally {
        folders.forEach(unlock);
      }
      expect(totalsOf(db, ROOT_ID)?.total).toBe(2900); // earlier history is untouched
    });

    it('carries on and says partial when one folder is readable and another is not', async () => {
      const home = copyHome();
      const db = memoryDb();
      lock(join(home, 'archived_sessions'));
      try {
        const { report } = await refresh(db, [home]);
        expect(report).toMatchObject({ result: 'partial', unreadable: 1, imported: 2 });
      } finally {
        unlock(join(home, 'archived_sessions'));
      }
    });

    it('marks an unreadable rollout and retries it on the next refresh, when a permission fix changes neither size nor time', async () => {
      const home = copyHome('home-orphan');
      const [file] = [
        join(
          home,
          'sessions/2026/10/14/rollout-2026-10-14T10-00-00-dddddddd-4444-4444-8444-00000000000d.jsonl',
        ),
      ];
      const db = memoryDb();
      lock(file ?? '');
      try {
        const { report } = await refresh(db, [home]);
        expect(report).toMatchObject({ result: 'partial', unreadable: 1, imported: 0 });
        expect(fileRow(db, file ?? '')).toMatchObject({ state: 'unreadable' });
      } finally {
        chmodSync(file ?? '', 0o644);
      }
      const fixed = await refresh(db, [home], {}, NOW + 900_000);
      expect(fixed.report).toMatchObject({ result: 'succeeded', imported: 1, unreadable: 0 });
    });
  });
});

describe('a subagent and its parent', () => {
  it('links to a parent imported in the same attempt even when the parent is read after it', async () => {
    // Archived files sort before sessions/ ones, so the child is first in path order and the parent comes later.
    const home = copyHome();
    const childText = readFileSync(join(home, CHILD_FILE), 'utf8');
    rmSync(join(home, CHILD_FILE));
    put(home, `archived_sessions/rollout-2026-10-12T09-05-00-${CHILD_ID}.jsonl`, childText);
    const db = memoryDb();
    await refresh(db, [home]);
    expect(trackedPaths(db)[0]).toContain('archived_sessions');
    expect(sessionRow(db, CHILD_ID)).toMatchObject({
      kind: 'child',
      parent_session_id: sessionRow(db, ROOT_ID)?.id,
      parent_basis: 'native',
    });
    expect(totalsOf(db, CHILD_ID)?.total).toBe(1700);
  });

  it('links to a parent stored by an earlier attempt', async () => {
    const home = copyHome();
    const childPath = join(home, CHILD_FILE);
    const childText = readFileSync(childPath, 'utf8');
    rmSync(childPath);
    const db = memoryDb();
    await refresh(db, [home]);
    expect(sessionRow(db, CHILD_ID)).toBeNull();
    writeFileSync(childPath, childText);
    await refresh(db, [home], {}, NOW + 900_000);
    expect(sessionRow(db, CHILD_ID)).toMatchObject({
      kind: 'child',
      parent_session_id: sessionRow(db, ROOT_ID)?.id,
    });
  });

  it('is kind unknown, with no edge, when the parent it names was never imported', async () => {
    const home = tempDir();
    put(home, CHILD_FILE, readFileSync(join(FIXTURES, 'home', CHILD_FILE), 'utf8'));
    const db = memoryDb();
    const { report } = await refresh(db, [home]);
    expect(sessionRow(db, CHILD_ID)).toMatchObject({
      kind: 'unknown',
      parent_session_id: null,
      parent_basis: null,
    });
    // With no parent to compare with, nothing can be told from the child's own usage unless it is a one-second burst: the oracle
    // (ccusage 20.0.48, run on this very file) counts all of it too.
    expect(totalsOf(db, CHILD_ID)?.total).toBe(4600);
    expect(report).toMatchObject({ result: 'succeeded', imported: 1 });
  });

  it('never makes an edge to itself or around a cycle, and does not loop', async () => {
    const home = tempDir();
    const a = '12345678-aaaa-4aaa-8aaa-00000000000a';
    const b = '12345678-bbbb-4bbb-8bbb-00000000000b';
    const t = (s: number): string => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`;
    put(
      home,
      `sessions/rollout-x-${a}.jsonl`,
      lines(metaLine(a, t(0), { source: spawnedFrom(b) }), snapshotLine(t(5), [10, 0, 1, 0])),
    );
    put(
      home,
      `sessions/rollout-x-${b}.jsonl`,
      lines(metaLine(b, t(0), { source: spawnedFrom(a) }), snapshotLine(t(5), [20, 0, 2, 0])),
    );
    const db = memoryDb();
    const { report } = await refresh(db, [home]);
    expect(report).toMatchObject({ result: 'succeeded', imported: 2 });
    // `a` is first in path order and asks for `b` first, so `b` is stored while `a` is still being read and finds no parent;
    // `a` then finds `b`. One edge, no loop, and nothing guessed for the end that has no parent yet.
    expect(sessionRow(db, b)).toMatchObject({ kind: 'unknown', parent_session_id: null });
    expect(sessionRow(db, a)).toMatchObject({
      kind: 'child',
      parent_session_id: sessionRow(db, b)?.id,
    });
  });

  it('does not let a later read downgrade a known relationship', async () => {
    const home = copyHome();
    const db = memoryDb();
    await refresh(db, [home]);
    // The child file is rewritten (same content, so only its time changes): it is read again, and the parent is not in this attempt.
    utimesSync(join(home, CHILD_FILE), new Date(NOW), new Date(NOW + 5000));
    await refresh(db, [home], {}, NOW + 900_000);
    expect(sessionRow(db, CHILD_ID)).toMatchObject({ kind: 'child', parent_basis: 'native' });
  });
});

describe('start time and models', () => {
  const t = (s: number): string => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`;
  const id = '77777777-aaaa-4aaa-8aaa-000000000007';

  it('falls back to the first usage event when there is no session_meta time at all', async () => {
    const home = tempDir();
    const noTime = JSON.stringify({ type: 'session_meta', payload: { id, source: 'cli' } });
    put(
      home,
      `sessions/rollout-x-${id}.jsonl`,
      lines(
        noTime,
        turnLine(t(1), 'gpt-5'),
        snapshotLine(t(9), [10, 0, 1, 0]),
        snapshotLine(t(4), [20, 0, 2, 0]),
      ),
    );
    const db = memoryDb();
    await refresh(db, [home]);
    expect(sessionRow(db, id)).toMatchObject({
      started_at: Date.parse(t(4)),
      started_basis: 'first_event',
      last_model: 'gpt-5',
    });
  });

  it('never moves a stored start later, however the file changes', async () => {
    const home = tempDir();
    const path = put(
      home,
      `sessions/rollout-x-${id}.jsonl`,
      lines(metaLine(id, t(0)), snapshotLine(t(5), [10, 0, 1, 0])),
    );
    const db = memoryDb();
    await refresh(db, [home]);
    writeFileSync(path, lines(metaLine(id, t(30)), snapshotLine(t(35), [10, 0, 1, 0])));
    await refresh(db, [home], {}, NOW + 900_000);
    expect(sessionRow(db, id)).toMatchObject({
      started_at: Date.parse(t(0)),
      started_basis: 'source_start',
    });
  });

  it('does not store a model of unknown as the session’s last model', async () => {
    const home = tempDir();
    put(
      home,
      `sessions/rollout-x-${id}.jsonl`,
      lines(metaLine(id, t(0)), snapshotLine(t(5), [10, 0, 1, 0])),
    );
    const db = memoryDb();
    await refresh(db, [home]);
    expect(sessionRow(db, id)).toMatchObject({ last_model: null });
    expect(db.prepare('SELECT model FROM usage_event').get()).toEqual({ model: 'unknown' });
  });
});

describe('what a rollout without usage or identity does', () => {
  const t = (s: number): string => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`;
  const id = '88888888-aaaa-4aaa-8aaa-000000000008';

  it('imports no session for a rollout that has no usage yet, and tracks the file as read', async () => {
    const home = tempDir();
    const path = put(
      home,
      `sessions/rollout-x-${id}.jsonl`,
      lines(metaLine(id, t(0)), turnLine(t(1), 'gpt-5')),
    );
    const db = memoryDb();
    const { report } = await refresh(db, [home]);
    expect(sessionRow(db, id)).toBeNull();
    expect(fileRow(db, path)).toMatchObject({ state: 'ok' });
    expect(report).toMatchObject({ result: 'succeeded', imported: 0 });
  });

  it('marks a rollout with usage but no session_meta unsupported', async () => {
    const home = tempDir();
    const path = put(
      home,
      `sessions/rollout-x-${id}.jsonl`,
      lines(snapshotLine(t(5), [10, 0, 1, 0])),
    );
    const db = memoryDb();
    const { report } = await refresh(db, [home]);
    expect(fileRow(db, path)).toMatchObject({ state: 'unsupported' });
    expect(report).toMatchObject({ result: 'partial', unsupported: 1 });
  });

  it('streams a large rollout without holding it: thousands of snapshots, one event each', async () => {
    const home = tempDir();
    const rows = [metaLine(id, t(0))];
    for (let i = 1; i <= 6000; i += 1) rows.push(snapshotLine(at(i), [i * 100, 0, i * 10, 0]));
    put(home, `sessions/rollout-x-${id}.jsonl`, lines(...rows));
    const db = memoryDb();
    await refresh(db, [home]);
    expect(totalsOf(db, id)).toMatchObject({ events: 6000, total: 660_000 });
  });
});
