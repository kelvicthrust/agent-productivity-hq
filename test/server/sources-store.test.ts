import { describe, expect, it } from 'vitest';
import {
  createRun,
  finishRun,
  getRun,
  getRunningRun,
  getSourceState,
  listSourceStates,
  recordAttempt,
  updateRunSources,
} from '../../src/server/db/queries/sources.ts';
import { seedDatabase } from '../fixtures/seed.ts';
import { memoryDb } from './helpers.ts';

// The runner's store: the two invariants that must not drift (last_attempt_* and consecutive_failures change together,
// and only a failed attempt adds one) live in recordAttempt and are tested here once, against a real schema.

const T0 = Date.parse('2026-11-04T17:00:00Z');
const MIN = 60_000;

describe('refresh runs', () => {
  it('creates a running run, updates its sources while it runs and finishes it once', () => {
    const db = memoryDb();
    const id = createRun(db, {
      trigger: 'manual',
      startedAt: T0,
      sources: { codex: { state: 'queued' }, claude: { state: 'queued' } },
    });
    expect(getRunningRun(db)?.id).toBe(id);
    expect(getRun(db, id)).toMatchObject({ state: 'running', finishedAt: null, trigger: 'manual' });

    updateRunSources(db, id, { codex: { state: 'running' }, claude: { state: 'queued' } });
    expect(getRun(db, id)?.sources['codex']?.state).toBe('running');

    finishRun(db, id, {
      state: 'partial',
      finishedAt: T0 + MIN,
      sources: {
        codex: { state: 'failed', message: 'x' },
        claude: { state: 'succeeded', imported: 3 },
      },
    });
    expect(getRunningRun(db)).toBeNull();
    expect(getRun(db, id)).toMatchObject({ state: 'partial', finishedAt: T0 + MIN });

    // A finished run is not rewritten by a late progress write or a second finish.
    updateRunSources(db, id, { codex: { state: 'running' } });
    finishRun(db, id, { state: 'failed', finishedAt: T0 + 2 * MIN, sources: {} });
    expect(getRun(db, id)).toMatchObject({ state: 'partial', finishedAt: T0 + MIN });
    expect(getRun(db, id)?.sources['claude']).toMatchObject({ state: 'succeeded', imported: 3 });
  });

  it('returns null for an unknown run and survives unreadable stored JSON', () => {
    const db = memoryDb();
    expect(getRun(db, 99)).toBeNull();
    db.prepare(
      "INSERT INTO refresh_run (id, trigger, started_at, state, per_source_json) VALUES (5, 'x', 1, 'running', 'not json')",
    ).run();
    expect(getRun(db, 5)?.sources).toEqual({});
  });
});

describe('recordAttempt', () => {
  const attempt = (at: number, result: 'succeeded' | 'partial' | 'failed') => ({
    sourceId: 'codex',
    result,
    at,
    status: result === 'failed' ? 'failed' : result === 'partial' ? 'partial' : 'ok',
    location: '~/.codex/sessions',
    errorCode: result === 'failed' ? 'unrecognized_format' : null,
    errorDetail: result === 'failed' ? 'Could not read 2 new files.' : null,
  });

  it('adds one per failed attempt and clears the count on a succeeded or a partial one', () => {
    const db = memoryDb();
    expect(recordAttempt(db, attempt(T0, 'failed'))).toBe(1);
    expect(recordAttempt(db, attempt(T0 + MIN, 'failed'))).toBe(2);
    expect(getSourceState(db, 'codex')?.consecutiveFailures).toBe(2);
    expect(recordAttempt(db, attempt(T0 + 2 * MIN, 'partial'))).toBe(0);
    expect(recordAttempt(db, attempt(T0 + 3 * MIN, 'failed'))).toBe(1);
    expect(recordAttempt(db, attempt(T0 + 4 * MIN, 'succeeded'))).toBe(0);
    expect(getSourceState(db, 'codex')?.consecutiveFailures).toBe(0);
  });

  it('writes last_attempt_* with the count, moves last_success_at only when data came in', () => {
    const db = memoryDb();
    recordAttempt(db, attempt(T0, 'succeeded'));
    recordAttempt(db, attempt(T0 + MIN, 'failed'));
    const failed = getSourceState(db, 'codex')!;
    expect(failed).toMatchObject({
      status: 'failed',
      lastAttemptAt: T0 + MIN,
      lastAttemptResult: 'failed',
      lastSuccessAt: T0,
      consecutiveFailures: 1,
      errorCode: 'unrecognized_format',
      location: '~/.codex/sessions',
    });
    recordAttempt(db, attempt(T0 + 2 * MIN, 'partial'));
    const partial = getSourceState(db, 'codex')!;
    expect(partial).toMatchObject({
      lastAttemptResult: 'partial',
      lastSuccessAt: T0 + 2 * MIN,
      consecutiveFailures: 0,
      errorCode: null,
      errorDetail: null,
    });
  });

  it('keeps what an earlier attempt learned when a later one does not know it', () => {
    const db = memoryDb();
    recordAttempt(db, { ...attempt(T0, 'succeeded'), oldestEventAt: T0 - 86_400_000 });
    recordAttempt(db, { sourceId: 'codex', result: 'failed', at: T0 + MIN, status: 'failed' });
    const row = getSourceState(db, 'codex')!;
    expect(row.location).toBe('~/.codex/sessions');
    expect(row.oldestEventAt).toBe(T0 - 86_400_000);
  });

  it('changes both last_attempt_* and the count or neither: a failing write leaves the row as it was', () => {
    const db = memoryDb();
    recordAttempt(db, attempt(T0, 'failed'));
    db.exec(
      "CREATE TRIGGER refuse_third BEFORE UPDATE ON source_state WHEN NEW.consecutive_failures = 2 BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    expect(() => recordAttempt(db, attempt(T0 + MIN, 'failed'))).toThrow(/refused/);
    expect(db.isTransaction).toBe(false);
    expect(getSourceState(db, 'codex')).toMatchObject({
      consecutiveFailures: 1,
      lastAttemptAt: T0,
      lastAttemptResult: 'failed',
    });
  });

  it('continues the count from the seeded refresh-failed world', () => {
    const db = memoryDb();
    seedDatabase(db, { scenario: 'refresh-failed' });
    expect(getSourceState(db, 'codex')?.consecutiveFailures).toBe(1);
    expect(recordAttempt(db, { ...attempt(T0, 'failed') })).toBe(2);
    expect(listSourceStates(db).map((s) => s.sourceId)).toContain('claude');
    // The other sources were not touched.
    expect(getSourceState(db, 'claude')?.consecutiveFailures).toBe(0);
  });
});
