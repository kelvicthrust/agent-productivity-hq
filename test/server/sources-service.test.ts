import { describe, expect, it } from 'vitest';
import { recordAttempt } from '../../src/server/db/queries/sources.ts';
import { CLAUDE_RETENTION_NOTE, buildSources } from '../../src/server/services/sources.ts';
import { TZ, memoryDb } from './helpers.ts';

// G4_9: Sources shows Claude Code's 30-day retention note. The note is about the source, so the server supplies it
// whatever the source's status, and only for Claude Code. An adapter that knows better can still replace it.

const AT = Date.parse('2026-11-04T17:00:00Z');

const attempt = (
  db: ReturnType<typeof memoryDb>,
  sourceId: 'codex' | 'claude' | 'paseo',
  result: 'succeeded' | 'failed' | 'partial',
  status: string,
) => recordAttempt(db, { sourceId, result, status, at: AT, location: '~/somewhere' });

const noteOf = (db: ReturnType<typeof memoryDb>, id: string) =>
  buildSources(db, { timezone: TZ }).sources?.find((s) => s.id === id)?.retentionNote;

describe('source records retained in Crew', () => {
  it('distinguishes collection attempts from the records still on disk', () => {
    const db = memoryDb();
    const retained = () =>
      Object.fromEntries(
        (buildSources(db, { timezone: TZ }).sources ?? []).map((s) => [s.id, s.hasRetainedData]),
      );
    attempt(db, 'codex', 'succeeded', 'ok');
    attempt(db, 'claude', 'failed', 'failed');
    attempt(db, 'paseo', 'succeeded', 'ok');
    recordAttempt(db, { sourceId: 'github', result: 'failed', status: 'failed', at: AT });
    expect(retained()).toEqual({ codex: false, claude: false, paseo: false, github: false });

    db.exec(`
      INSERT INTO session (id, provider, provider_session_id, kind, started_at, started_basis)
      VALUES (1, 'codex', 'with-records', 'root', ${AT}, 'source_start'),
             (2, 'claude', 'empty', 'root', ${AT}, 'source_start');
      INSERT INTO usage_event (provider, session_id, occurred_at, dedupe_key, model, input_tokens, provider_total)
      VALUES ('codex', 1, ${AT}, 'first-event', 'test-model', 1, 1);
      INSERT INTO paseo_agent (id, provider, first_seen_at, last_seen_at)
      VALUES ('agent', 'codex', ${AT}, ${AT});
      INSERT INTO repo (id, display_name, tracking_state, access_state, added_at)
      VALUES ('team/project', 'team/project', 'active', 'inaccessible', ${AT});
      INSERT INTO pull_request (node_id, repo_id, number, title, url, merged_at)
      VALUES ('PR-test', 'team/project', 1, 'A merge', 'https://github.com/team/project/pull/1', ${AT});
    `);
    expect(retained()).toEqual({ codex: true, claude: false, paseo: true, github: true });

    db.exec('DELETE FROM usage_event; DELETE FROM paseo_agent; DELETE FROM pull_request;');
    expect(retained()).toEqual({ codex: false, claude: false, paseo: false, github: false });
  });
});

describe('the Claude Code retention note', () => {
  it('says what Claude Code does with transcripts, in the words the API documents', () => {
    expect(CLAUDE_RETENTION_NOTE).toBe(
      'Claude Code keeps transcripts for 30 days unless you change cleanupPeriodDays.',
    );
  });

  it.each([
    ['found', 'succeeded', 'ok'],
    ['not found', 'succeeded', 'notfound'],
    ['failing', 'failed', 'failed'],
    ['partly read', 'partial', 'partial'],
  ] as const)('is on the Claude row when the source is %s', (_name, result, status) => {
    const db = memoryDb();
    attempt(db, 'claude', result, status);
    expect(noteOf(db, 'claude')).toBe(CLAUDE_RETENTION_NOTE);
  });

  it('is not on the other sources', () => {
    const db = memoryDb();
    attempt(db, 'codex', 'succeeded', 'ok');
    attempt(db, 'paseo', 'succeeded', 'ok');
    expect(noteOf(db, 'codex')).toBeNull();
    expect(noteOf(db, 'paseo')).toBeNull();
  });

  it('gives way to a note the adapter stored for itself', () => {
    const db = memoryDb();
    attempt(db, 'claude', 'succeeded', 'ok');
    db.prepare("UPDATE source_state SET extra_json = ? WHERE source_id = 'claude'").run(
      JSON.stringify({
        retentionNote: 'Claude Code keeps transcripts for 90 days on this machine.',
      }),
    );
    expect(noteOf(db, 'claude')).toBe('Claude Code keeps transcripts for 90 days on this machine.');
  });
});

// G5_8: coverage starts at the real oldest imported date, but never before what retention keeps. The first import records its oldest
// date before retention prunes, so a Codex folder two years deep must not claim a start that is no longer held (P-29).
describe('History from, for a source that started before the retention horizon', () => {
  const NOW = Date.parse('2026-11-04T20:00:00Z'); // Wed 4 Nov 2026, noon in Los Angeles
  const historyFrom = (db: ReturnType<typeof memoryDb>) =>
    buildSources(db, { timezone: TZ, now: () => NOW }).sources?.find((s) => s.id === 'codex')
      ?.oldestDate;

  it('is the oldest imported date when it is inside the 366 days', () => {
    const db = memoryDb();
    recordAttempt(db, {
      sourceId: 'codex',
      result: 'succeeded',
      status: 'ok',
      at: NOW,
      oldestEventAt: Date.parse('2026-02-03T18:00:00Z'),
    });
    expect(historyFrom(db)).toBe('2026-02-03');
  });

  it('is today minus 366 days when the stored date is older', () => {
    const db = memoryDb();
    recordAttempt(db, {
      sourceId: 'codex',
      result: 'succeeded',
      status: 'ok',
      at: NOW,
      oldestEventAt: Date.parse('2024-06-01T18:00:00Z'),
    });
    expect(historyFrom(db)).toBe('2025-11-03');
  });
});
