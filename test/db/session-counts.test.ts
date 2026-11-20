import { describe, expect, it } from 'vitest';
import {
  readGroupTotals,
  readSessionCounts,
  upsertSession,
} from '../../src/server/db/queries/usage.ts';
import { seedDatabase } from '../fixtures/seed.ts';
import { memoryDb } from '../server/helpers.ts';

// Sources & repos says how many sessions each source holds. It used to add up `readGroupTotals` over all time, which joins every
// stored event, so every poll of that page during a first import cost one pass over everything imported so far (300,000 to 600,000
// events: 200 to 340 ms with the server's event loop held, test/bench/BROWSER-RESULTS.md). `readSessionCounts` reads the sessions
// and asks the events' session index; these tests hold it to the same answer.

const everything = {
  fromMs: 0,
  toMs: Number.MAX_SAFE_INTEGER,
  providers: ['codex', 'claude'] as const,
  repos: [],
};

function viaGroups(db: ReturnType<typeof memoryDb>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of readGroupTotals(db, everything)) {
    counts[row.provider] = (counts[row.provider] ?? 0) + row.sessions;
  }
  return counts;
}

describe('the number of sessions each provider holds', () => {
  it('is what the Usage groups add up to, on the seeded world', () => {
    const db = memoryDb();
    seedDatabase(db, {});
    const expected = viaGroups(db);
    expect(expected['codex']).toBeGreaterThan(0);
    expect(expected['claude']).toBeGreaterThan(0);
    expect(readSessionCounts(db)).toEqual(expected);
  });

  it('counts a session once it has an event and not before', () => {
    const db = memoryDb();
    seedDatabase(db, {});
    const before = readSessionCounts(db);
    const sessionId = upsertSession(db, {
      provider: 'codex',
      providerSessionId: 'counts-probe',
      kind: 'root',
      startedAt: 1_000,
      startedBasis: 'first_event',
    });
    // A session no event points at holds no usage: not counted, and the groups do not count it either.
    expect(readSessionCounts(db)).toEqual(before);
    expect(viaGroups(db)).toEqual(before);

    db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total)
       VALUES ('codex', 'counts-probe-1', ?, 1000, 'gpt-5-codex', 10)`,
    ).run(sessionId);
    expect(readSessionCounts(db)['codex']).toBe((before['codex'] ?? 0) + 1);
    expect(readSessionCounts(db)['claude']).toBe(before['claude']);
    expect(readSessionCounts(db)).toEqual(viaGroups(db));
  });

  it('gives nothing for a database with no sessions', () => {
    expect(readSessionCounts(memoryDb())).toEqual({});
  });
});
