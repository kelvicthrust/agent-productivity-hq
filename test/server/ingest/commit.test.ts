import { describe, expect, it } from 'vitest';
import {
  ImportTally,
  commitFile,
  finishReport,
  markFile,
} from '../../../src/server/collectors/ingest/index.ts';
import {
  createEventWriter,
  findSessionId,
  getSourceFile,
  putSourceFile,
} from '../../../src/server/db/queries/ingest.ts';
import { upsertSession } from '../../../src/server/db/queries/usage.ts';
import { memoryDb } from '../helpers.ts';

// Committing a file in one transaction, and turning what an import counted into the report the runner records.

const T0 = Date.parse('2026-11-04T17:00:00Z');
const file = { path: '/h/.claude/projects/p/a.jsonl', size: 100, mtimeMs: T0 };

const commit = (over: Partial<Parameters<typeof commitFile>[1]> = {}) => ({
  sourceId: 'claude',
  file,
  headHash: 'h',
  from: 0,
  endOffset: 100,
  tracked: null,
  unreadableLines: 0,
  now: T0,
  ...over,
});

describe('commitFile', () => {
  it('stores what the file contributed and the offset together, and points events at the file', () => {
    const db = memoryDb();
    commitFile(db, commit(), (fileId) => {
      const sessionId = upsertSession(db, {
        provider: 'claude',
        providerSessionId: 's1',
        kind: 'root',
        startedAt: T0,
        startedBasis: 'source_start',
      });
      createEventWriter(db).write(
        {
          provider: 'claude',
          dedupeKey: 'm:r',
          sessionId,
          occurredAt: T0,
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          providerTotal: 2,
          sourceFileId: fileId,
        },
        'replace',
      );
    });
    expect(getSourceFile(db, file.path)).toMatchObject({
      readOffset: 100,
      state: 'ok',
      unreadableLines: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_event').get()).toEqual({ n: 1 });
    expect(findSessionId(db, 'claude', 's1')).not.toBeNull();
    expect(findSessionId(db, 'claude', 'nope')).toBeNull();
  });

  it('rolls everything back, offset included, when the write fails', () => {
    const db = memoryDb();
    expect(() =>
      commitFile(db, commit(), () => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
    expect(getSourceFile(db, file.path)).toBeNull(); // not read yet: the next refresh starts from the same place
  });

  it('adds unreadable lines to the stored count on an append and replaces it on a re-read', () => {
    const db = memoryDb();
    commitFile(db, commit({ unreadableLines: 2 }), () => {});
    const tracked = getSourceFile(db, file.path)!;
    expect(tracked).toMatchObject({ state: 'partial', unreadableLines: 2 });
    commitFile(db, commit({ from: 100, endOffset: 150, tracked, unreadableLines: 1 }), () => {});
    expect(getSourceFile(db, file.path)).toMatchObject({ unreadableLines: 3, readOffset: 150 });
    commitFile(
      db,
      commit({ from: 0, tracked: getSourceFile(db, file.path), unreadableLines: 0 }),
      () => {},
    );
    expect(getSourceFile(db, file.path)).toMatchObject({ state: 'ok', unreadableLines: 0 });
  });
});

describe('markFile', () => {
  it('records a file that could not be read without touching what it had imported', () => {
    const db = memoryDb();
    commitFile(db, commit({ headHash: 'h1' }), () => {});
    const tracked = getSourceFile(db, file.path)!;
    markFile(db, {
      sourceId: 'claude',
      file: { ...file, size: 120 },
      state: 'unreadable',
      now: T0 + 1,
      tracked,
    });
    expect(getSourceFile(db, file.path)).toMatchObject({
      state: 'unreadable',
      size: 120,
      headHash: 'h1',
      readOffset: 100,
    });
  });
});

describe('finishReport', () => {
  const base = (db: ReturnType<typeof memoryDb>, tally = new ImportTally()) => ({
    source: 'claude' as const,
    db,
    tally,
    location: '/h/.claude',
    inaccessible: 0,
    adapterVersion: 'claude-1',
  });

  it('is succeeded with the oldest event and the counts when everything was read', () => {
    const db = memoryDb();
    const sessionId = upsertSession(db, {
      provider: 'claude',
      providerSessionId: 's',
      kind: 'root',
      startedAt: T0,
      startedBasis: 'first_event',
    });
    const writer = createEventWriter(db);
    const tally = new ImportTally();
    tally.newSessions = 1;
    for (const key of ['a', 'b', 'a']) {
      tally.addEvent(
        writer.write(
          {
            provider: 'claude',
            dedupeKey: key,
            sessionId,
            occurredAt: key === 'a' ? T0 : T0 + 5,
            model: 'm',
            inputTokens: 1,
            outputTokens: 1,
            providerTotal: 2,
            copy: { sidechain: false, hasSpeed: false, path: '/fixture.jsonl' },
          },
          'keep',
        ),
      );
    }
    expect(finishReport(base(db, tally))).toMatchObject({
      result: 'succeeded',
      status: 'ok',
      imported: 1,
      duplicatesSkipped: 1,
      unreadable: 0,
      oldestEventAt: T0,
      location: '/h/.claude',
      adapterVersion: 'claude-1',
      message: null,
    });
  });

  it('is partial when lines, files or folders could not be read, and keeps saying so on a refresh that read nothing', () => {
    const db = memoryDb();
    putSourceFile(db, {
      sourceId: 'claude',
      path: '/a',
      size: 1,
      mtimeMs: 1,
      headHash: 'h',
      readOffset: 1,
      state: 'partial',
      unreadableLines: 3,
      lastReadAt: 1,
    });
    putSourceFile(db, {
      sourceId: 'claude',
      path: '/b',
      size: 1,
      mtimeMs: 1,
      headHash: '',
      readOffset: 0,
      state: 'unreadable',
      unreadableLines: 0,
      lastReadAt: 1,
    });
    putSourceFile(db, {
      sourceId: 'claude',
      path: '/c.zst',
      size: 1,
      mtimeMs: 1,
      headHash: '',
      readOffset: 0,
      state: 'unsupported',
      unreadableLines: 0,
      lastReadAt: 1,
    });
    const report = finishReport({ ...base(db), inaccessible: 1 });
    expect(report).toMatchObject({
      result: 'partial',
      status: 'partial',
      unreadable: 5,
      unsupported: 1,
    });
    expect((report as { message: string }).message).toContain('5 records couldn’t be read');
    expect((report as { message: string }).message).not.toMatch(/\/[a-z]/);
  });
});
