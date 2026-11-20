import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  joinPaseoSessions,
  readPaseoCounts,
  upsertPaseoAgents,
  type PaseoAgentInput,
} from '../../src/server/db/queries/paseo.ts';
import { upsertSession, type SessionUpsert } from '../../src/server/db/queries/usage.ts';
import { memoryDb } from '../server/helpers.ts';

// The SQL half of Paseo enrichment (G8_5, P-22, P-23): the join matches an agent to a session by the provider's own session id in
// the same provider and nothing else, names a session only when the provider gave it no title, parents it only through an agent
// that maps to a session, marks an unmapped parent Unknown instead of inventing an edge, and adds no token. The collector's own
// behaviour (the daemon, its states) is tested in test/collectors/paseo.

const T0 = Date.parse('2026-11-03T12:00:00Z');

const agent = (id: string, extra: Partial<PaseoAgentInput> = {}): PaseoAgentInput => ({
  id,
  title: null,
  provider: 'claude',
  providerSessionId: null,
  parentAgentId: null,
  workspaceId: null,
  workspaceLabel: null,
  cwd: null,
  background: false,
  archivedAt: null,
  ...extra,
});

function session(
  db: DatabaseSync,
  provider: 'codex' | 'claude',
  id: string,
  extra: Partial<SessionUpsert> = {},
): number {
  const sessionId = upsertSession(db, {
    provider,
    providerSessionId: id,
    kind: 'root',
    startedAt: T0,
    startedBasis: 'source_start',
    firstEventAt: T0,
    lastEventAt: T0,
    ...extra,
  });
  db.prepare(
    `INSERT OR IGNORE INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total) VALUES (?, ?, ?, ?, 'm', 100)`,
  ).run(provider, `${id}:e1`, sessionId, T0);
  return sessionId;
}

const row = (db: DatabaseSync, id: number) =>
  db
    .prepare(
      `SELECT kind, parent_session_id, parent_basis, native_kind, recorded_name, name_source, paseo_agent_id, workspace_label FROM session WHERE id = ?`,
    )
    .get(id) as Record<string, unknown>;

const snapshot = (db: DatabaseSync) => ({
  sessions: db.prepare('SELECT * FROM session ORDER BY id').all(),
  events: db.prepare('SELECT * FROM usage_event ORDER BY id').all(),
});

describe('upsertPaseoAgents', () => {
  it('stores a snapshot, keeps first_seen_at when an agent is seen again, and keeps an agent the daemon no longer lists', () => {
    const db = memoryDb();
    expect(upsertPaseoAgents(db, [agent('a1', { title: 'One' }), agent('a2')], 1000)).toEqual({
      inserted: 2,
      updated: 0,
    });
    expect(
      upsertPaseoAgents(db, [agent('a1', { title: 'One, renamed', archivedAt: 5 })], 2000),
    ).toEqual({ inserted: 0, updated: 1 });
    expect(
      db
        .prepare(
          'SELECT id, title, archived_at, first_seen_at, last_seen_at FROM paseo_agent ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'a1', title: 'One, renamed', archived_at: 5, first_seen_at: 1000, last_seen_at: 2000 },
      { id: 'a2', title: null, archived_at: null, first_seen_at: 1000, last_seen_at: 1000 },
    ]);
  });
});

describe('joinPaseoSessions', () => {
  it('matches on the provider’s own session id within the same provider, never across providers', () => {
    const db = memoryDb();
    const claude = session(db, 'claude', 'shared-id');
    const codex = session(db, 'codex', 'shared-id');
    upsertPaseoAgents(
      db,
      [agent('ag', { provider: 'codex', providerSessionId: 'shared-id', workspaceLabel: 'app' })],
      1,
    );
    const result = joinPaseoSessions(db);
    expect(result.mapped).toBe(1);
    expect(row(db, codex)).toMatchObject({ paseo_agent_id: 'ag', workspace_label: 'app' });
    expect(row(db, claude)).toMatchObject({ paseo_agent_id: null, workspace_label: null });
  });

  it('leaves an agent with no matching session unmapped: it adds no session, no event and no token', () => {
    const db = memoryDb();
    session(db, 'claude', 's1');
    const before = snapshot(db);
    upsertPaseoAgents(
      db,
      [
        agent('lost', { providerSessionId: 'not-on-disk' }),
        agent('nosession'),
        agent('other', { provider: 'other', providerSessionId: 's1' }),
      ],
      1,
    );
    expect(joinPaseoSessions(db).mapped).toBe(0);
    expect(snapshot(db)).toEqual(before);
    expect(readPaseoCounts(db)).toMatchObject({ agents: 3, mapped: 0, unmapped: 3 });
  });

  it('names a session from Paseo only when the provider recorded no title, and follows a rename of its own name', () => {
    const db = memoryDb();
    const plain = session(db, 'claude', 'plain');
    const titled = session(db, 'claude', 'titled', {
      recordedName: 'Provider title',
      nameSource: 'provider_title',
    });
    upsertPaseoAgents(
      db,
      [
        agent('p', { providerSessionId: 'plain', title: 'Paseo name' }),
        agent('t', { providerSessionId: 'titled', title: 'Paseo name for titled' }),
      ],
      1,
    );
    expect(joinPaseoSessions(db).named).toBe(1);
    expect(row(db, plain)).toMatchObject({ recorded_name: 'Paseo name', name_source: 'paseo' });
    expect(row(db, titled)).toMatchObject({
      recorded_name: 'Provider title',
      name_source: 'provider_title',
    });
    upsertPaseoAgents(
      db,
      [agent('p', { providerSessionId: 'plain', title: 'Renamed in Paseo' })],
      2,
    );
    joinPaseoSessions(db);
    expect(row(db, plain)).toMatchObject({
      recorded_name: 'Renamed in Paseo',
      name_source: 'paseo',
    });
    // a blank title names nothing and does not erase a name
    upsertPaseoAgents(db, [agent('p', { providerSessionId: 'plain', title: '   ' })], 3);
    joinPaseoSessions(db);
    expect(row(db, plain)).toMatchObject({ recorded_name: 'Renamed in Paseo' });
  });

  it('gives a session a Paseo parent only through an agent that maps to a session', () => {
    const db = memoryDb();
    const parent = session(db, 'claude', 'parent');
    const child = session(db, 'codex', 'child');
    upsertPaseoAgents(
      db,
      [
        agent('pa', { providerSessionId: 'parent' }),
        agent('ca', { provider: 'codex', providerSessionId: 'child', parentAgentId: 'pa' }),
      ],
      1,
    );
    expect(joinPaseoSessions(db).parented).toBe(1);
    expect(row(db, child)).toMatchObject({
      kind: 'child',
      parent_session_id: parent,
      parent_basis: 'paseo',
      native_kind: 'paseo',
    });
    expect(row(db, parent)).toMatchObject({ kind: 'root', parent_session_id: null });
  });

  it('marks the relationship Unknown, with no edge, when the parent agent maps to no session or is not listed', () => {
    const db = memoryDb();
    const orphan = session(db, 'claude', 'orphan');
    const other = session(db, 'claude', 'other');
    upsertPaseoAgents(
      db,
      [
        agent('unmappedParent', { providerSessionId: 'not-on-disk' }),
        agent('o', { providerSessionId: 'orphan', parentAgentId: 'unmappedParent' }),
        agent('x', { providerSessionId: 'other', parentAgentId: 'never-listed' }),
      ],
      1,
    );
    expect(joinPaseoSessions(db).parentUnmapped).toBe(2);
    for (const id of [orphan, other])
      expect(row(db, id)).toMatchObject({
        kind: 'unknown',
        parent_session_id: null,
        parent_basis: null,
      });
    expect(readPaseoCounts(db).parentUnmapped).toBe(2);
  });

  it('never overrides a native parent, and never closes a loop', () => {
    const db = memoryDb();
    const root = session(db, 'claude', 'root');
    const native = session(db, 'claude', 'native', {
      kind: 'child',
      parentSessionId: root,
      parentBasis: 'native',
      nativeKind: 'claude_subagent',
    });
    session(db, 'claude', 'other');
    const a = session(db, 'claude', 'a');
    const b = session(db, 'claude', 'b');
    upsertPaseoAgents(
      db,
      [
        agent('r', { providerSessionId: 'root' }),
        agent('o', { providerSessionId: 'other' }),
        agent('n', { providerSessionId: 'native', parentAgentId: 'o' }), // Paseo says the parent is `other`; the transcript says `root`
        agent('a', { providerSessionId: 'a', parentAgentId: 'b' }),
        agent('b', { providerSessionId: 'b', parentAgentId: 'a' }), // a loop
      ],
      1,
    );
    joinPaseoSessions(db);
    expect(row(db, native)).toMatchObject({
      kind: 'child',
      parent_session_id: root,
      parent_basis: 'native',
      native_kind: 'claude_subagent',
    });
    // following parents from a or b ends: the join never records an edge that closes the loop
    for (const start of [a, b]) {
      const seen = new Set<number>();
      let at: number | null = start;
      while (at !== null) {
        expect(seen.has(at), `a loop through session ${at}`).toBe(false);
        seen.add(at);
        at = row(db, at).parent_session_id as number | null;
      }
    }
  });

  it('is idempotent and changes no event, no token and no session id', () => {
    const db = memoryDb();
    session(db, 'claude', 'parent');
    session(db, 'codex', 'child');
    session(db, 'claude', 'plain');
    upsertPaseoAgents(
      db,
      [
        agent('pa', { providerSessionId: 'parent', title: 'Lead', workspaceLabel: 'app' }),
        agent('ca', {
          provider: 'codex',
          providerSessionId: 'child',
          parentAgentId: 'pa',
          title: 'Worker',
        }),
        agent('ua', { providerSessionId: 'plain', parentAgentId: 'ghost' }),
      ],
      1,
    );
    const events = db.prepare('SELECT * FROM usage_event ORDER BY id').all();
    const first = joinPaseoSessions(db);
    const afterFirst = db.prepare('SELECT * FROM session ORDER BY id').all();
    const second = joinPaseoSessions(db);
    expect(db.prepare('SELECT * FROM session ORDER BY id').all()).toEqual(afterFirst);
    expect(db.prepare('SELECT * FROM usage_event ORDER BY id').all()).toEqual(events);
    expect(second.mapped).toBe(first.mapped);
    expect(db.prepare('SELECT SUM(provider_total) AS t FROM usage_event').get()).toEqual({
      t: 300,
    });
  });

  it('prefers a live agent over an archived one for the same session, then the more recently listed', () => {
    const db = memoryDb();
    const s = session(db, 'claude', 's');
    upsertPaseoAgents(
      db,
      [agent('old', { providerSessionId: 's', title: 'Archived name', archivedAt: 5 })],
      1,
    );
    upsertPaseoAgents(db, [agent('live', { providerSessionId: 's', title: 'Live name' })], 2);
    joinPaseoSessions(db);
    expect(row(db, s)).toMatchObject({ paseo_agent_id: 'live', recorded_name: 'Live name' });
  });

  it('survives a later import of the transcript: a root read does not undo what Paseo recorded', () => {
    const db = memoryDb();
    const parent = session(db, 'claude', 'parent');
    const child = session(db, 'claude', 'child');
    upsertPaseoAgents(
      db,
      [
        agent('pa', { providerSessionId: 'parent' }),
        agent('ca', { providerSessionId: 'child', parentAgentId: 'pa', title: 'Worker' }),
      ],
      1,
    );
    joinPaseoSessions(db);
    // the Claude adapter reads the child's transcript again, with no idea of Paseo
    upsertSession(db, {
      provider: 'claude',
      providerSessionId: 'child',
      kind: 'root',
      startedAt: T0,
      startedBasis: 'source_start',
      lastEventAt: T0 + 1,
    });
    expect(row(db, child)).toMatchObject({
      kind: 'child',
      parent_session_id: parent,
      parent_basis: 'paseo',
      recorded_name: 'Worker',
    });
    // while a native subagent read still wins over Paseo
    upsertSession(db, {
      provider: 'claude',
      providerSessionId: 'child',
      kind: 'child',
      parentSessionId: parent,
      parentBasis: 'native',
      nativeKind: 'claude_subagent',
      startedAt: T0,
      startedBasis: 'source_start',
    });
    expect(row(db, child)).toMatchObject({
      kind: 'child',
      parent_basis: 'native',
      native_kind: 'claude_subagent',
    });
  });
});

describe('readPaseoCounts', () => {
  it('counts agents, mapped, unmapped and archived, and says when the first snapshot was taken', () => {
    const db = memoryDb();
    expect(readPaseoCounts(db)).toEqual({
      agents: 0,
      mapped: 0,
      unmapped: 0,
      archived: 0,
      parentUnmapped: 0,
      firstSeenAt: null,
    });
    session(db, 'claude', 's1');
    upsertPaseoAgents(
      db,
      [
        agent('a', { providerSessionId: 's1' }),
        agent('b', { providerSessionId: 'x', archivedAt: 9 }),
      ],
      700,
    );
    upsertPaseoAgents(db, [agent('c')], 800);
    joinPaseoSessions(db);
    expect(readPaseoCounts(db)).toEqual({
      agents: 3,
      mapped: 1,
      unmapped: 2,
      archived: 1,
      parentUnmapped: 0,
      firstSeenAt: 700,
    });
  });
});
