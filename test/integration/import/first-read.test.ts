import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { history, makeHome, sessionSums, startMachine } from './helpers.ts';

// A first full import must not get slower with every file it has already read. The browser measurement of the first import
// (`pnpm bench:browser`, test/bench/BROWSER-RESULTS.md) showed the event loop stalling for 140 to 300 ms at a time, and the stalls
// grew as events were stored: for every NEW Codex rollout the importer asked for "the events this file brought in before" with
// `WHERE source_file_id = ?`, and `usage_event` has no index on that column, so each rollout scanned the whole table. A rollout the
// importer has never seen has no such events, so it does not ask; one it has seen and that changed still does, because that is how
// events a file no longer holds are removed (a rollout is always read whole).

// The statement that looks up what one file brought in before (src/server/db/queries/ingest.ts › retainFileEvents).
const LOOKUP = /FROM usage_event WHERE source_file_id = \?/;

/** Every SQL text the database is asked to prepare from now on. */
function watch(db: DatabaseSync): string[] {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  Object.assign(db, {
    prepare: (sql: string) => {
      seen.push(sql);
      return prepare(sql);
    },
  });
  return seen;
}

const ROLLOUT =
  '.codex/sessions/2026/10/12/rollout-2026-10-12T09-00-00-aaaaaaaa-1111-4111-8111-00000000000a.jsonl';
const SESSION = 'aaaaaaaa-1111-4111-8111-00000000000a';

describe('the first read of a Codex rollout', () => {
  it('does not look through the stored events for what the file brought in before', async () => {
    const m = startMachine({ home: makeHome() });
    const seen = watch(m.db);
    const run = await m.refresh(['codex']);
    expect(run.state).toBe('succeeded');
    expect(history(m.db).events['n'] as number, 'something was imported').toBeGreaterThan(0);
    expect(seen.filter((sql) => LOOKUP.test(sql))).toEqual([]);
    m.close();
  });

  it('still does for a rollout it has read before and that changed', async () => {
    const m = startMachine({ home: makeHome() });
    await m.refresh(['codex']);
    const before = sessionSums(m.db, 'codex').get(SESSION)!['total']!;

    // One more token_count line with larger running totals, as Codex writes it.
    const rollout = join(m.home, ROLLOUT);
    appendFileSync(
      rollout,
      JSON.stringify({
        timestamp: '2026-10-12T09:30:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1_000_000,
              cached_input_tokens: 0,
              output_tokens: 1_000_000,
              reasoning_output_tokens: 0,
              total_tokens: 2_000_000,
            },
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 50,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120,
            },
          },
        },
      }) + '\n',
    );
    m.tick(15 * 60_000);
    const seen = watch(m.db);
    const run = await m.refresh(['codex']);
    expect(run.state).toBe('succeeded');
    // The changed rollout and its dependent child are reconciled. The unrelated archive is skipped.
    expect(seen.filter((sql) => LOOKUP.test(sql))).toHaveLength(2);
    expect(sessionSums(m.db, 'codex').get(SESSION)!['total']!).toBeGreaterThan(before);
    m.close();
  });
});
