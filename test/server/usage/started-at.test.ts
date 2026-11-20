import { describe, expect, it } from 'vitest';
import { upsertSession, type SessionUpsert } from '../../../src/server/db/queries/usage.ts';
import { runRetention } from '../../../src/server/services/retention.ts';
import { NOW, TZ, addEvent, addSession, at, memoryDb, roots, usageApp } from './helpers.ts';

// data-and-sources › Session start time: `started_at` is set once, only ever moves earlier, and is never recomputed from
// retained usage events, so the 366-day pruning cannot make a long-lived session look as if it started later.

const base: SessionUpsert = {
  provider: 'claude',
  providerSessionId: 'abc12345-aaaa-bbbb-cccc-000000000001',
  kind: 'root',
  startedAt: at('2026-10-20', '09:00'),
  startedBasis: 'source_start',
};

const row = (db: ReturnType<typeof memoryDb>, id: number) =>
  db.prepare('SELECT * FROM session WHERE id = ?').get(id) as Record<
    string,
    number | string | null
  >;

describe('upsertSession › started_at', () => {
  it('sets started_at and its basis when the session is first created', () => {
    const db = memoryDb();
    const id = upsertSession(db, base);
    expect(row(db, id)).toMatchObject({
      started_at: base.startedAt,
      started_basis: 'source_start',
    });
  });

  it('keeps the original start when a later read reports a later time (a resumed session)', () => {
    const db = memoryDb();
    const id = upsertSession(db, base);
    const again = upsertSession(db, { ...base, startedAt: at('2026-11-03', '16:00') });
    expect(again).toBe(id);
    expect(row(db, id)).toMatchObject({
      started_at: base.startedAt,
      started_basis: 'source_start',
    });
  });

  it('moves started_at earlier when an older line turns up, and takes that time’s basis', () => {
    const db = memoryDb();
    const id = upsertSession(db, { ...base, startedBasis: 'first_event' });
    const earlier = at('2026-10-19', '23:58');
    upsertSession(db, { ...base, startedAt: earlier, startedBasis: 'source_start' });
    expect(row(db, id)).toMatchObject({ started_at: earlier, started_basis: 'source_start' });
    // and an even older time that is only a first usage event is still the earliest, so it wins with its own basis
    const earliest = at('2026-10-19', '23:00');
    upsertSession(db, { ...base, startedAt: earliest, startedBasis: 'first_event' });
    expect(row(db, id)).toMatchObject({ started_at: earliest, started_basis: 'first_event' });
  });

  it('upgrades the basis to source_start on an equal time, and never downgrades it', () => {
    const db = memoryDb();
    const id = upsertSession(db, { ...base, startedBasis: 'first_event' });
    upsertSession(db, base);
    expect(row(db, id)).toMatchObject({
      started_at: base.startedAt,
      started_basis: 'source_start',
    });
    upsertSession(db, { ...base, startedBasis: 'first_event' });
    expect(row(db, id)).toMatchObject({
      started_at: base.startedAt,
      started_basis: 'source_start',
    });
  });

  it('does not let a later source_start time replace an earlier first-event time', () => {
    const db = memoryDb();
    const id = upsertSession(db, { ...base, startedBasis: 'first_event' });
    upsertSession(db, {
      ...base,
      startedAt: base.startedAt + 90_000,
      startedBasis: 'source_start',
    });
    expect(row(db, id)).toMatchObject({ started_at: base.startedAt, started_basis: 'first_event' });
  });

  it('is one row per (provider, provider session id); the same id under the other provider is a different session', () => {
    const db = memoryDb();
    const a = upsertSession(db, base);
    const b = upsertSession(db, { ...base, provider: 'codex' });
    upsertSession(db, base);
    expect(a).not.toBe(b);
    expect(db.prepare('SELECT COUNT(*) AS n FROM session').get()).toEqual({ n: 2 });
  });
});

describe('upsertSession › the rest of the row', () => {
  it('only widens the event window: first_event_at earlier, last_event_at later, null keeps the stored value', () => {
    const db = memoryDb();
    const id = upsertSession(db, { ...base, firstEventAt: 5_000, lastEventAt: 9_000 });
    upsertSession(db, { ...base, firstEventAt: 7_000, lastEventAt: 8_000 });
    expect(row(db, id)).toMatchObject({ first_event_at: 5_000, last_event_at: 9_000 });
    upsertSession(db, { ...base, firstEventAt: 4_000, lastEventAt: 12_000 });
    expect(row(db, id)).toMatchObject({ first_event_at: 4_000, last_event_at: 12_000 });
    upsertSession(db, base);
    expect(row(db, id)).toMatchObject({ first_event_at: 4_000, last_event_at: 12_000 });
  });

  it('takes an event window from a read that has the first one', () => {
    const db = memoryDb();
    const id = upsertSession(db, base);
    upsertSession(db, { ...base, firstEventAt: 3_000, lastEventAt: 6_000 });
    expect(row(db, id)).toMatchObject({ first_event_at: 3_000, last_event_at: 6_000 });
  });

  it('never forgets what is known: repo, name, relationship and workspace survive a read that lacks them', () => {
    const db = memoryDb();
    const parent = upsertSession(db, { ...base, providerSessionId: 'parent-0001-aaaaaaaa' });
    const id = upsertSession(db, {
      ...base,
      kind: 'child',
      parentSessionId: parent,
      parentBasis: 'paseo',
      repoId: 'acme/api',
      repoBasis: 'git_remote',
      recordedName: 'implementer-1',
      nameSource: 'paseo',
      workspaceLabel: 'api · wt-1',
      lastModel: 'claude-sonnet-5-5',
    });
    upsertSession(db, { ...base, kind: 'unknown' });
    expect(row(db, id)).toMatchObject({
      kind: 'child',
      parent_session_id: parent,
      parent_basis: 'paseo',
      repo_id: 'acme/api',
      repo_basis: 'git_remote',
      recorded_name: 'implementer-1',
      name_source: 'paseo',
      workspace_label: 'api · wt-1',
      last_model: 'claude-sonnet-5-5',
    });
  });

  it('lets a later read resolve what was unknown', () => {
    const db = memoryDb();
    const parent = upsertSession(db, { ...base, providerSessionId: 'parent-0002-aaaaaaaa' });
    const id = upsertSession(db, { ...base, kind: 'unknown' });
    upsertSession(db, { ...base, kind: 'child', parentSessionId: parent, parentBasis: 'native' });
    upsertSession(db, { ...base, kind: 'unknown', repoId: 'acme/web', repoBasis: 'git_remote' });
    upsertSession(db, {
      ...base,
      kind: 'unknown',
      recordedName: 'Fix the parser',
      nameSource: 'provider_title',
    });
    expect(row(db, id)).toMatchObject({
      kind: 'child',
      parent_session_id: parent,
      repo_id: 'acme/web',
      recorded_name: 'Fix the parser',
      name_source: 'provider_title',
    });
  });
});

describe('started_at and retention', () => {
  it('is not moved when old usage events are pruned, nor by a later upsert made from what is left', () => {
    const db = memoryDb();
    const longAgo = at('2025-09-01', '08:00'); // 429 days before the test clock: older than the 366-day cut
    const id = upsertSession(db, {
      ...base,
      startedAt: longAgo,
      startedBasis: 'source_start',
      firstEventAt: longAgo + 60_000,
      lastEventAt: at('2026-11-03', '10:00'),
    });
    addEvent(db, { session: id, at: longAgo + 60_000, input: 500 });
    addEvent(db, { session: id, at: at('2026-11-03', '10:00'), input: 700 });

    const pruned = runRetention(db, { nowMs: NOW, timezone: TZ });
    expect(pruned.usageEvents).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_event').get()).toEqual({ n: 1 });

    expect(row(db, id)).toMatchObject({
      started_at: longAgo,
      started_basis: 'source_start',
      first_event_at: longAgo + 60_000,
    });

    // The retained events now begin at 2026-11-03. Feeding that back as a start must not move it later.
    upsertSession(db, {
      ...base,
      startedAt: at('2026-11-03', '10:00'),
      startedBasis: 'first_event',
    });
    expect(row(db, id)).toMatchObject({ started_at: longAgo, started_basis: 'source_start' });
  });

  it('is what the API shows as Started: the stored time, not the first event inside the requested dates', async () => {
    const db = memoryDb();
    const started = at('2026-09-15', '09:00');
    const id = addSession(db, {
      id: 1,
      repo: null,
      startedAt: started,
      startedBasis: 'source_start',
    });
    addEvent(db, { session: id, at: at('2026-09-15', '09:01'), input: 10 });
    addEvent(db, { session: id, at: at('2026-11-03', '14:00'), input: 20 });
    const body = await roots(usageApp(db), '__unknown', '?start=2026-11-02&end=2026-11-04');
    const session = body.roots?.[0];
    expect(session).toMatchObject({
      tokens: 20,
      startedAt: new Date(started).toISOString(),
      startedBasis: 'source_start',
      firstEventAt: new Date(at('2026-09-15', '09:01')).toISOString(),
      lastEventAt: new Date(at('2026-11-03', '14:00')).toISOString(),
    });
  });
});
