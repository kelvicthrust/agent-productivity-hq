import { describe, expect, it } from 'vitest';
import { rangeBounds } from '../../../src/shared/domain/periods.ts';
import { seedDatabase, type SeedOptions } from '../../fixtures/seed.ts';
import {
  TZ,
  addEvent,
  addRepo,
  addSession,
  addSource,
  at,
  categories,
  get,
  memoryDb,
  usageApp,
} from './helpers.ts';

// GET /api/usage/categories: one ledger per provider. Codex total = input + output (cached input and reasoning are subsets
// of those and are not added again); Claude total = the four separate categories. Providers are never summed.

function seeded(options: SeedOptions = {}) {
  const db = memoryDb();
  seedDatabase(db, options);
  return { db, app: usageApp(db) };
}

describe('ledger arithmetic on the seeded world', () => {
  const { db, app } = seeded();
  const WEEK = { start: '2026-11-02', end: '2026-11-08' };

  /** Independent sums straight from the stored rows. */
  const sums = (provider: string, range = WEEK, repos: string[] = []) => {
    const bounds = rangeBounds(range.start, range.end, TZ);
    const rows = db
      .prepare(
        `SELECT ue.*, s.repo_id AS repo FROM usage_event ue JOIN session s ON s.id = ue.session_id
          WHERE ue.provider = ? AND ue.occurred_at >= ? AND ue.occurred_at < ?`,
      )
      .all(provider, bounds.start, bounds.end) as Record<string, number | string | null>[];
    const kept = rows.filter((r) => repos.length === 0 || repos.includes(String(r['repo'])));
    const sum = (key: string) => kept.reduce((n, r) => n + Number(r[key]), 0);
    return {
      sessions: new Set(kept.map((r) => r['session_id'])).size,
      input: sum('input_tokens'),
      cached: sum('cached_input_tokens'),
      cacheWrite: sum('cache_write_tokens'),
      cacheRead: sum('cache_read_tokens'),
      output: sum('output_tokens'),
      reasoning: sum('reasoning_tokens'),
      total: sum('provider_total'),
    };
  };

  it('Codex: total is input + output, and the cached and reasoning subsets are never added again', async () => {
    const body = await categories(app);
    const want = sums('codex');
    const codex = body.codex!;
    expect(codex).toMatchObject({
      coverage: 'ok',
      sessions: want.sessions,
      input: want.input,
      cachedInput: want.cached,
      output: want.output,
      reasoning: want.reasoning,
      total: want.total,
    });
    expect(codex.total).toBe(codex.input! + codex.output!);
    expect(codex.cachedInput!).toBeLessThanOrEqual(codex.input!);
    expect(codex.reasoning!).toBeLessThanOrEqual(codex.output!);
    // the trap: adding the subsets again would give a different, larger, wrong number
    expect(codex.total).not.toBe(
      codex.input! + codex.cachedInput! + codex.output! + codex.reasoning!,
    );
    expect(codex.cachedInput!).toBeGreaterThan(0);
  });

  it('Claude: total is the sum of its four separate categories', async () => {
    const claude = (await categories(app)).claude!;
    const want = sums('claude');
    expect(claude).toMatchObject({
      coverage: 'ok',
      sessions: want.sessions,
      inputUncached: want.input,
      cacheWrite: want.cacheWrite,
      cacheRead: want.cacheRead,
      output: want.output,
      total: want.total,
    });
    expect(claude.total).toBe(
      claude.inputUncached! + claude.cacheWrite! + claude.cacheRead! + claude.output!,
    );
  });

  it('never returns a combined figure: the two providers are separate objects with no grand total', async () => {
    const body = await categories(app);
    expect(Object.keys(body).sort()).toEqual(['claude', 'codex', 'paseoNote', 'scope']);
    expect(body).not.toHaveProperty('total');
    expect(body.codex).not.toHaveProperty('claude');
    expect(body.codex!.total).not.toBe(body.claude!.total);
  });

  it('returns only the provider the filter selects', async () => {
    const codex = await categories(app, '?provider=codex');
    expect(Object.keys(codex).sort()).toEqual(['codex', 'paseoNote', 'scope']);
    expect(codex.codex?.total).toBe(sums('codex').total);
    const claude = await categories(app, '?provider=claude');
    expect(Object.keys(claude).sort()).toEqual(['claude', 'paseoNote', 'scope']);
    expect(claude.claude?.total).toBe(sums('claude').total);
  });

  it('sums over the requested repos only, and over any range', async () => {
    const repos = ['kelvin/atlas-api', 'kelvin/atlas-web'];
    const range = { start: '2025-11-04', end: '2026-11-04' };
    const body = await categories(
      app,
      `?start=${range.start}&end=${range.end}&repos=${repos.join(',')}`,
    );
    expect(body.codex?.total).toBe(sums('codex', range, repos).total);
    expect(body.claude?.total).toBe(sums('claude', range, repos).total);
    expect(body.codex?.sessions).toBe(sums('codex', range, repos).sessions);
    const everyone = await categories(app, `?start=${range.start}&end=${range.end}`);
    expect(everyone.codex!.total!).toBeGreaterThan(body.codex!.total!);
    expect(body.scope?.repos).toEqual(repos);
  });

  it('answers with the same figures whatever the granularity asked for', async () => {
    const a = await categories(app, '?start=2026-10-06&end=2026-11-04&gran=day');
    const b = await categories(app, '?start=2026-10-06&end=2026-11-04&gran=month');
    expect({ ...a, scope: null }).toEqual({ ...b, scope: null });
  });

  it('echoes the applied scope, including repo ids it ignored', async () => {
    const body = await categories(app, '?repos=kelvin/atlas-api,nobody/nothing&provider=claude');
    expect(body.scope).toMatchObject({
      repos: ['kelvin/atlas-api'],
      ignoredRepos: ['nobody/nothing'],
      provider: 'claude',
      timezone: TZ,
    });
  });
});

describe('coverage', () => {
  it('says ok with the oldest imported date for a range the source fully covers', async () => {
    const { app } = seeded();
    const body = await categories(app);
    expect(body.codex).toMatchObject({ coverage: 'ok', coveredFrom: '2026-02-02' });
    expect(body.claude).toMatchObject({ coverage: 'ok', coveredFrom: '2026-03-15' });
  });

  it('says partial when the range straddles the oldest date, and still gives the figures', async () => {
    const { app } = seeded();
    const body = await categories(app, '?start=2026-01-15&end=2026-02-20');
    expect(body.codex).toMatchObject({ coverage: 'partial', coveredFrom: '2026-02-02' });
    expect(body.codex?.total).toBeGreaterThan(0);
    expect(body.claude).toMatchObject({ coverage: 'unavailable' });
  });

  it('says unavailable before the oldest date and leaves the figures out, so no zero is drawn for missing history', async () => {
    const { app } = seeded();
    const body = await categories(app, '?start=2025-11-05&end=2025-12-31');
    expect(body.codex).toEqual({ coverage: 'unavailable', coveredFrom: '2026-02-02' });
    expect(body.claude).toEqual({ coverage: 'unavailable', coveredFrom: '2026-03-15' });
  });

  it('never starts coverage before what retention keeps, even when the first import stored an older date (P-29)', async () => {
    // The first import records its oldest date before retention prunes, so a source two years deep stores a date that is already gone.
    const db = memoryDb();
    addSource(db, 'codex', { oldest: at('2024-06-01') });
    const app = usageApp(db);
    const body = await categories(app, '?start=2025-11-05&end=2025-11-20');
    // Today is Nov 4 2026: retention keeps back to Nov 3 2025, so Nov 5 2025 is covered and the head says where coverage starts.
    expect(body.codex).toMatchObject({ coverage: 'ok', coveredFrom: '2025-11-03' });
    // (The API's own lookback starts one day later, Nov 4 2025, so a range before the line cannot be asked for.)
  });

  it('says future for dates that have not happened, with no figures', async () => {
    const { app } = seeded();
    const body = await categories(app, '?start=2026-11-05&end=2026-11-08');
    expect(body.codex).toEqual({ coverage: 'future', coveredFrom: '2026-02-02' });
    expect(body.claude?.coverage).toBe('future');
  });

  it('says stale after a failed refresh for a range that reaches past the last collected day, and keeps the cached figures', async () => {
    const { app } = seeded({ scenario: 'refresh-failed' });
    const body = await categories(app);
    expect(body.codex).toMatchObject({ coverage: 'stale', coveredFrom: '2026-02-02' });
    expect(body.codex?.total).toBeGreaterThan(0);
    expect(body.claude?.coverage).toBe('ok');
    // dates up to the last collected day are still fully covered
    expect((await categories(app, '?start=2026-10-01&end=2026-11-03')).codex?.coverage).toBe('ok');
  });

  it('says none, with no oldest date and no figures, when the source was never found', async () => {
    for (const scenario of ['account-only', 'empty'] as const) {
      const { app } = seeded({ scenario });
      const body = await categories(app);
      expect(body.codex).toEqual({ coverage: 'none', coveredFrom: null });
      expect(body.claude).toEqual({ coverage: 'none', coveredFrom: null });
      expect(body.paseoNote).toBeNull();
    }
  });

  it('gives a true zero (figures of 0) for a covered range with no activity', async () => {
    const db = memoryDb();
    addSource(db, 'codex', { oldest: at('2026-01-01') });
    addSource(db, 'claude', { oldest: at('2026-01-01') });
    const body = await categories(usageApp(db));
    expect(body.codex).toEqual({
      coverage: 'ok',
      coveredFrom: '2026-01-01',
      sessions: 0,
      input: 0,
      cachedInput: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    });
    expect(body.claude).toMatchObject({ coverage: 'ok', sessions: 0, total: 0 });
  });

  it('reads the oldest date in the report timezone, not in UTC', async () => {
    const db = memoryDb();
    // 02:00 UTC on 3 Nov is 19:00 on 2 Nov in Los Angeles
    addSource(db, 'codex', { oldest: Date.parse('2026-11-03T02:00:00Z') });
    addSource(db, 'claude', { oldest: Date.parse('2026-11-03T09:00:00Z') });
    const body = await categories(usageApp(db), '?start=2026-11-02&end=2026-11-04');
    expect(body.codex).toMatchObject({ coveredFrom: '2026-11-02', coverage: 'ok' });
    expect(body.claude).toMatchObject({ coveredFrom: '2026-11-03', coverage: 'partial' });
  });

  it('derives the last collected day from the last success when a failed refresh stored none', async () => {
    const db = memoryDb();
    addSource(db, 'codex', {
      status: 'failed',
      result: 'failed',
      success: at('2026-11-02', '18:00'),
    });
    const body = await categories(usageApp(db), '?provider=codex&start=2026-11-01&end=2026-11-04');
    expect(body.codex?.coverage).toBe('stale');
    expect(
      (await categories(usageApp(db), '?provider=codex&start=2026-11-01&end=2026-11-02')).codex
        ?.coverage,
    ).toBe('ok');
  });
});

describe('which events fall in the dates', () => {
  it('counts events by local calendar day: 23:59 belongs to its day and 00:00 to the next', async () => {
    const db = memoryDb();
    addSource(db, 'codex', { oldest: at('2026-01-01') });
    const id = addSession(db, { id: 1, startedAt: at('2026-11-02') });
    addEvent(db, { session: id, at: at('2026-11-02', '23:59'), input: 1 });
    addEvent(db, { session: id, at: at('2026-11-03', '00:00'), input: 10 });
    addEvent(db, { session: id, at: at('2026-11-03', '23:59'), input: 100 });
    const app = usageApp(db);
    const day = async (d: string) =>
      (await categories(app, `?provider=codex&start=${d}&end=${d}`)).codex?.total;
    expect(await day('2026-11-02')).toBe(1);
    expect(await day('2026-11-03')).toBe(110);
  });

  it('treats the 25-hour day when daylight saving ends as one day', async () => {
    const db = memoryDb();
    addSource(db, 'codex', { oldest: at('2026-01-01') });
    const id = addSession(db, { id: 1, startedAt: at('2026-10-31') });
    addEvent(db, { session: id, at: Date.parse('2026-11-01T07:30:00Z'), input: 1 }); // 00:30 PDT
    addEvent(db, { session: id, at: Date.parse('2026-11-01T09:30:00Z'), input: 10 }); // 01:30 PST (the repeated hour)
    addEvent(db, { session: id, at: Date.parse('2026-11-02T07:59:00Z'), input: 100 }); // 23:59 PST
    addEvent(db, { session: id, at: Date.parse('2026-11-02T08:00:00Z'), input: 1_000 }); // 00:00 PST on the 2nd
    const app = usageApp(db);
    const day = async (d: string) =>
      (await categories(app, `?provider=codex&start=${d}&end=${d}`)).codex?.total;
    expect(await day('2026-11-01')).toBe(111);
    expect(await day('2026-11-02')).toBe(1_000);
  });

  it('counts a session once however many events it has, and only sessions with an event in the range', async () => {
    const db = memoryDb();
    addRepo(db, 'acme/api');
    addSource(db, 'codex', { oldest: at('2026-01-01') });
    const a = addSession(db, { id: 1, repo: 'acme/api', startedAt: at('2026-11-02') });
    for (let i = 0; i < 5; i++)
      addEvent(db, { session: a, at: at('2026-11-03', `0${i}:00`), input: 10 });
    const b = addSession(db, { id: 2, repo: 'acme/api', startedAt: at('2026-10-01') });
    addEvent(db, { session: b, at: at('2026-10-01', '09:00'), input: 10 });
    const body = await categories(usageApp(db), '?provider=codex');
    expect(body.codex).toMatchObject({ sessions: 1, input: 50, total: 50 });
  });
});

describe('paseoNote', () => {
  it('passes on the stored note when Paseo collection is partial', async () => {
    const { app } = seeded();
    const note = (await categories(app)).paseoNote;
    expect(note).toMatch(/^3 agent records couldn’t be read/);
    expect(note).not.toMatch(/\/|\\|\.jsonl/); // no path or file name
  });

  it('builds one from the unreadable count when none was stored, and says nothing when Paseo is fine', async () => {
    const db = memoryDb();
    addSource(db, 'paseo', { status: 'partial', unreadable: 2 });
    expect((await categories(usageApp(db))).paseoNote).toBe(
      '2 agent records couldn’t be read. Their provider usage is still counted; their agent relationships show as Unknown.',
    );
    const ok = memoryDb();
    addSource(ok, 'paseo', { status: 'ok' });
    expect((await categories(usageApp(ok))).paseoNote).toBeNull();
    expect((await categories(usageApp(memoryDb()))).paseoNote).toBeNull();
  });
});

describe('errors', () => {
  it('answers bad filters with invalid_input and invalid_range, and an unreadable source row with a normal answer', async () => {
    const { app, db } = seeded();
    const bad = await get(app, '/api/usage/categories?gran=hourly');
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { code: string } }).error.code).toBe('invalid_input');
    const range = await get(app, '/api/usage/categories?start=2026-11-08&end=2026-11-02');
    expect(range.status).toBe(400);
    expect((range.body as { error: { code: string } }).error.code).toBe('invalid_range');
    db.prepare("UPDATE source_state SET extra_json = '{not json' WHERE source_id = 'codex'").run();
    expect((await get(app, '/api/usage/categories')).status).toBe(200);
  });
});
