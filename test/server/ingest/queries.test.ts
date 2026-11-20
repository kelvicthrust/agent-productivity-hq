import { describe, expect, it } from 'vitest';
import {
  createEventWriter,
  getSourceFile,
  listSourceFiles,
  oldestEventAt,
  putSourceFile,
  readSessionFigures,
  unreadableTotals,
  upsertUsageEvent,
  type UsageEventInput,
} from '../../../src/server/db/queries/ingest.ts';
import {
  getSourceState,
  recordAttempt,
  recordDiscovery,
} from '../../../src/server/db/queries/sources.ts';
import { upsertSession } from '../../../src/server/db/queries/usage.ts';
import { memoryDb } from '../helpers.ts';

// The ingest queries every adapter leans on: one event per (provider, dedupe key) with the two write modes, the tracked-file
// rows, and the figures Sources shows from them.

const T0 = Date.parse('2026-11-04T17:00:00Z');

function sessionOf(db: ReturnType<typeof memoryDb>, provider: 'codex' | 'claude' = 'claude') {
  return upsertSession(db, {
    provider,
    providerSessionId: 's1',
    kind: 'root',
    startedAt: T0,
    startedBasis: 'source_start',
  });
}

const event = (sessionId: number, over: Partial<UsageEventInput> = {}): UsageEventInput => ({
  provider: 'claude',
  dedupeKey: 'msg_1:req_1',
  sessionId,
  occurredAt: T0,
  model: 'claude-opus-test',
  inputTokens: 10,
  cacheWriteTokens: 2,
  cacheReadTokens: 3,
  outputTokens: 5,
  providerTotal: 20,
  ...over,
});

const rows = (db: ReturnType<typeof memoryDb>) =>
  db.prepare('SELECT * FROM usage_event ORDER BY id').all() as unknown as Record<
    string,
    number | string | null
  >[];

describe('usage events', () => {
  it('inserts an event once and says so', () => {
    const db = memoryDb();
    const id = sessionOf(db);
    expect(upsertUsageEvent(db, event(id), 'keep')).toBe('inserted');
    expect(upsertUsageEvent(db, event(id), 'keep')).toBe('skipped');
    expect(upsertUsageEvent(db, event(id), 'replace')).toBe('skipped'); // same figures: nothing to replace
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({
      input_tokens: 10,
      cache_write_tokens: 2,
      cache_read_tokens: 3,
      output_tokens: 5,
      provider_total: 20,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
    });
  });

  it('keep mode leaves a stored event alone even when the new figures differ', () => {
    const db = memoryDb();
    const id = sessionOf(db);
    upsertUsageEvent(db, event(id), 'keep');
    expect(upsertUsageEvent(db, event(id, { outputTokens: 99, providerTotal: 114 }), 'keep')).toBe(
      'skipped',
    );
    expect(rows(db)[0]).toMatchObject({ output_tokens: 5, provider_total: 20 });
  });

  it('replace mode lets the last line win, and only counts a change', () => {
    const db = memoryDb();
    const id = sessionOf(db);
    upsertUsageEvent(db, event(id, { outputTokens: 1, providerTotal: 16 }), 'replace');
    expect(upsertUsageEvent(db, event(id, { outputTokens: 5 }), 'replace')).toBe('replaced');
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ output_tokens: 5, provider_total: 20 });
  });

  it('gives a message two sessions hold to the earliest copy, whatever order the files were read in', () => {
    const db = memoryDb();
    const first = sessionOf(db);
    const resumed = upsertSession(db, {
      provider: 'claude',
      providerSessionId: 's2',
      kind: 'root',
      startedAt: T0,
      startedBasis: 'source_start',
    });
    const writer = createEventWriter(db);
    // The original session writes the message; the resumed session's file replays it with the same time.
    expect(writer.write(event(first), 'replace')).toBe('inserted');
    expect(writer.write(event(resumed), 'replace')).toBe('skipped');
    expect(
      writer.write(event(resumed, { occurredAt: T0 + 60_000, outputTokens: 9 }), 'replace'),
    ).toBe('skipped');
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ session_id: first, output_tokens: 5 });

    // Read the other way round: the copy that turns up second is the earlier one, so it takes the event over.
    const db2 = memoryDb();
    const a = sessionOf(db2);
    const b = upsertSession(db2, {
      provider: 'claude',
      providerSessionId: 's2',
      kind: 'root',
      startedAt: T0,
      startedBasis: 'source_start',
    });
    const writer2 = createEventWriter(db2);
    writer2.write(event(b, { occurredAt: T0 + 60_000 }), 'replace');
    expect(writer2.write(event(a), 'replace')).toBe('replaced');
    expect(rows(db2)).toHaveLength(1);
    expect(rows(db2)[0]).toMatchObject({ session_id: a, occurred_at: T0 });
  });

  it('never moves a Codex event between sessions: keep mode leaves it where it is', () => {
    const db = memoryDb();
    const first = sessionOf(db, 'codex');
    const other = upsertSession(db, {
      provider: 'codex',
      providerSessionId: 's2',
      kind: 'root',
      startedAt: T0,
      startedBasis: 'source_start',
    });
    const writer = createEventWriter(db);
    writer.write(event(first, { provider: 'codex', dedupeKey: 's:100' }), 'keep');
    expect(
      writer.write(
        event(other, { provider: 'codex', dedupeKey: 's:100', occurredAt: T0 - 1 }),
        'keep',
      ),
    ).toBe('skipped');
    expect(rows(db)[0]).toMatchObject({ session_id: first });
  });

  it('keeps events of two providers apart even with the same key', () => {
    const db = memoryDb();
    const claude = sessionOf(db, 'claude');
    const codex = sessionOf(db, 'codex');
    const writer = createEventWriter(db);
    expect(writer.write(event(claude), 'keep')).toBe('inserted');
    expect(writer.write(event(codex, { provider: 'codex' }), 'keep')).toBe('inserted');
    expect(rows(db)).toHaveLength(2);
  });

  it('reports the oldest imported event per provider', () => {
    const db = memoryDb();
    const id = sessionOf(db);
    expect(oldestEventAt(db, 'claude')).toBeNull();
    upsertUsageEvent(db, event(id, { dedupeKey: 'a', occurredAt: T0 + 5000 }), 'keep');
    upsertUsageEvent(db, event(id, { dedupeKey: 'b', occurredAt: T0 }), 'keep');
    expect(oldestEventAt(db, 'claude')).toBe(T0);
    expect(oldestEventAt(db, 'codex')).toBeNull();
  });
});

describe('tracked files', () => {
  const file = (over: Partial<Parameters<typeof putSourceFile>[1]> = {}) => ({
    sourceId: 'claude',
    path: '/h/.claude/projects/p/a.jsonl',
    size: 100,
    mtimeMs: T0,
    headHash: 'h1',
    readOffset: 100,
    state: 'ok' as const,
    unreadableLines: 0,
    lastReadAt: T0,
    ...over,
  });

  it('creates a row, updates it by path and keeps one row per path', () => {
    const db = memoryDb();
    const id = putSourceFile(db, file());
    expect(getSourceFile(db, file().path)).toMatchObject({ id, size: 100, readOffset: 100 });
    const again = putSourceFile(db, file({ size: 150, readOffset: 150, headHash: 'h2' }));
    expect(again).toBe(id);
    expect(getSourceFile(db, file().path)).toMatchObject({ size: 150, headHash: 'h2' });
    expect(listSourceFiles(db, 'claude')).toHaveLength(1);
    expect(getSourceFile(db, '/nowhere')).toBeNull();
  });

  it('adds up what could not be read from the stored rows', () => {
    const db = memoryDb();
    expect(unreadableTotals(db, 'claude')).toEqual({ lines: 0, files: 0, unsupported: 0 });
    putSourceFile(db, file({ unreadableLines: 2, state: 'partial' }));
    putSourceFile(db, file({ path: '/b.jsonl', state: 'unreadable', unreadableLines: 0 }));
    putSourceFile(db, file({ path: '/c.jsonl.zst', state: 'unsupported' }));
    putSourceFile(db, file({ path: '/other', sourceId: 'codex', unreadableLines: 9 }));
    expect(unreadableTotals(db, 'claude')).toEqual({ lines: 2, files: 1, unsupported: 1 });
  });

  it('points a usage event at the file it came from', () => {
    const db = memoryDb();
    const sessionId = sessionOf(db);
    const fileId = putSourceFile(db, file());
    upsertUsageEvent(db, event(sessionId, { sourceFileId: fileId }), 'keep');
    expect(rows(db)[0]).toMatchObject({ source_file_id: fileId });
  });
});

describe('discovery', () => {
  it('records Not found or Access denied without recording an attempt', () => {
    const db = memoryDb();
    recordDiscovery(db, { sourceId: 'codex', status: 'notfound' });
    expect(getSourceState(db, 'codex')).toMatchObject({
      status: 'notfound',
      lastAttemptAt: null,
      lastAttemptResult: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
    });
  });

  it('leaves the last attempt, the last success and the failure count as they were', () => {
    const db = memoryDb();
    recordAttempt(db, {
      sourceId: 'codex',
      result: 'succeeded',
      at: T0,
      status: 'ok',
      location: '/h/.codex',
    });
    recordAttempt(db, { sourceId: 'codex', result: 'failed', at: T0 + 1, status: 'denied' });
    recordDiscovery(db, { sourceId: 'codex', status: 'denied', location: null });
    expect(getSourceState(db, 'codex')).toMatchObject({
      status: 'denied',
      location: '/h/.codex', // an unknown location does not erase the one stored
      lastAttemptAt: T0 + 1,
      lastAttemptResult: 'failed',
      lastSuccessAt: T0,
      consecutiveFailures: 1,
    });
  });
});

describe('session figures', () => {
  it("adds each session's events by category, keeps parents and starts, and lists a session with no events with zeros", () => {
    const db = memoryDb();
    const root = sessionOf(db, 'claude');
    const child = upsertSession(db, {
      provider: 'claude',
      providerSessionId: 's1:agent-a',
      kind: 'child',
      parentSessionId: root,
      parentBasis: 'native',
      startedAt: T0 + 1000,
      startedBasis: 'first_event',
      firstEventAt: T0 + 2000,
    });
    upsertSession(db, {
      provider: 'claude',
      providerSessionId: 'empty',
      kind: 'root',
      startedAt: T0,
      startedBasis: 'source_start',
    });
    const writer = createEventWriter(db);
    writer.write(event(root, { dedupeKey: 'a' }), 'replace');
    writer.write(
      event(root, {
        dedupeKey: 'b',
        inputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 1,
        providerTotal: 2,
      }),
      'replace',
    );
    writer.write(event(child, { dedupeKey: 'c', providerTotal: 20 }), 'replace');
    const figures = readSessionFigures(db, 'claude');
    expect(figures.map((f) => f.providerSessionId)).toEqual(['empty', 's1', 's1:agent-a']);
    expect(figures.find((f) => f.providerSessionId === 's1')).toMatchObject({
      kind: 'root',
      parentProviderSessionId: null,
      events: 2,
      input: 11,
      cacheWrite: 2,
      cacheRead: 3,
      output: 6,
      total: 22,
    });
    expect(figures.find((f) => f.providerSessionId === 's1:agent-a')).toMatchObject({
      kind: 'child',
      parentProviderSessionId: 's1',
      startedBasis: 'first_event',
      total: 20,
    });
    expect(figures.find((f) => f.providerSessionId === 'empty')).toMatchObject({
      events: 0,
      total: 0,
    });
    expect(readSessionFigures(db, 'codex')).toEqual([]);
  });
});
