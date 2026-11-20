import { describe, expect, it } from 'vitest';
import {
  NOW,
  addEvent,
  addMergedPr,
  addRepo,
  addSession,
  addSource,
  at,
  connectAs,
  get,
  memoryDb,
  metricsApp,
  series,
} from './helpers.ts';

// GET /api/series: buckets in the report timezone (America/Los_Angeles; the clock is Wednesday 2026-11-04 12:00 there), one
// event set for every granularity, coverage deciding between a real 0 and an uncovered null (P-05, P-10, P-11).

const REPO = 'kelvin/atlas-api';

/** A database with one active repo, both sources found from 2026-01-01, and one Codex and one Claude session in that repo. */
function world() {
  const db = memoryDb();
  addRepo(db, REPO);
  addSource(db, 'codex');
  addSource(db, 'claude');
  const codex = addSession(db, {
    id: 1,
    provider: 'codex',
    repo: REPO,
    startedAt: at('2026-01-05'),
  });
  const claude = addSession(db, {
    id: 2,
    provider: 'claude',
    repo: REPO,
    startedAt: at('2026-01-05'),
  });
  return { db, codex, claude };
}

describe('GET /api/series buckets', () => {
  it('has one bucket per day, a covered zero for a quiet day and nothing drawn for days still to come', async () => {
    const { db, codex, claude } = world();
    addEvent(db, { session: codex, at: at('2026-11-02', '10:00'), input: 100, output: 20 });
    addEvent(db, {
      session: claude,
      at: at('2026-11-02', '11:00'),
      input: 10,
      cacheWrite: 5,
      cacheRead: 30,
      output: 5,
    });
    addEvent(db, { session: codex, at: at('2026-11-04', '09:00'), input: 7 });
    addMergedPr(db, REPO, 1, at('2026-11-02', '12:00'));
    connectAs(db, 'kelvin');

    const { buckets, scope, unavailableText } = await series(
      metricsApp(db),
      '?start=2026-11-02&end=2026-11-08',
    );

    expect(scope).toMatchObject({
      gran: 'day',
      provider: 'all',
      author: 'mine',
      timezone: 'America/Los_Angeles',
    });
    expect(buckets.map((b) => b.start)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
    expect(buckets[0]).toMatchObject({
      label: 'Mon, Nov 2, 2026',
      short: 'Mon 2',
      prs: 1,
      delivery: 'ok',
      tokens: { codex: 120, claude: 50 },
      usage: { codex: 'ok', claude: 'ok', rail: 'ok' },
    });
    expect(buckets[1]).toMatchObject({ prs: 0, tokens: { codex: 0, claude: 0 } });
    expect(buckets[2]).toMatchObject({ prs: 0, tokens: { codex: 7, claude: 0 } });
    for (const future of buckets.slice(3)) {
      expect(future).toMatchObject({
        prs: null,
        delivery: 'future',
        tokens: { codex: null, claude: null },
        usage: { codex: 'future', claude: 'future', rail: 'future' },
      });
    }
    expect(unavailableText).toBeNull();
  });

  it('clips week and month buckets to the range and says so', async () => {
    const { db } = world();
    const app = metricsApp(db);
    const weeks = await series(app, '?start=2026-10-07&end=2026-10-20&gran=week');
    expect(weeks.buckets.map((b) => [b.start, b.end, b.partOfRange])).toEqual([
      ['2026-10-07', '2026-10-11', true],
      ['2026-10-12', '2026-10-18', false],
      ['2026-10-19', '2026-10-20', true],
    ]);
    const months = await series(app, '?start=2026-09-20&end=2026-11-04&gran=month');
    expect(months.buckets.map((b) => [b.start, b.end, b.partOfRange, b.short])).toEqual([
      ['2026-09-20', '2026-09-30', true, 'Sep'],
      ['2026-10-01', '2026-10-31', false, 'Oct'],
      ['2026-11-01', '2026-11-04', true, 'Nov'],
    ]);
  });

  it('picks the granularity from the range length when gran is not given', async () => {
    const { db } = world();
    const app = metricsApp(db);
    expect((await series(app, '?start=2026-09-21&end=2026-11-04')).scope.gran).toBe('day'); // 45 days
    expect((await series(app, '?start=2026-09-20&end=2026-11-04')).scope.gran).toBe('week'); // 46 days
    expect((await series(app, '?start=2025-11-04&end=2026-11-04')).scope.gran).toBe('month');
  });
});

describe('GET /api/series in the report timezone', () => {
  it('puts 23:59 and 00:00 local in different days and keeps both days of a 25-hour fall-back day together', async () => {
    const { db, codex } = world();
    // Los Angeles fell back on Sunday 2026-11-01: that local day is 25 hours long.
    addEvent(db, { session: codex, at: at('2026-10-31', '23:59'), input: 1 });
    addEvent(db, { session: codex, at: at('2026-11-01', '00:00'), input: 10 });
    addEvent(db, { session: codex, at: at('2026-11-01', '12:00'), input: 100 });
    addEvent(db, { session: codex, at: at('2026-11-01', '23:59'), input: 1000 });
    addEvent(db, { session: codex, at: at('2026-11-02', '00:00'), input: 10000 });

    const { buckets } = await series(
      metricsApp(db),
      '?start=2026-10-31&end=2026-11-02&provider=codex',
    );
    expect(buckets.map((b) => b.tokens.codex)).toEqual([1, 1110, 10000]);
  });

  it('puts events on both sides of the 23-hour spring-forward day in the right days', async () => {
    const { db, codex } = world();
    // Los Angeles sprang forward on Sunday 2026-03-08: 02:00 became 03:00.
    addEvent(db, { session: codex, at: at('2026-03-07', '23:59'), input: 1 });
    addEvent(db, { session: codex, at: at('2026-03-08', '00:00'), input: 10 });
    addEvent(db, { session: codex, at: at('2026-03-08', '23:59'), input: 100 });
    addEvent(db, { session: codex, at: at('2026-03-09', '00:00'), input: 1000 });

    const app = metricsApp(db);
    const days = await series(app, '?start=2026-03-07&end=2026-03-09&provider=codex');
    expect(days.buckets.map((b) => b.tokens.codex)).toEqual([1, 110, 1000]);
    const weeks = await series(app, '?start=2026-03-07&end=2026-03-09&gran=week&provider=codex');
    expect(weeks.buckets.map((b) => [b.start, b.tokens.codex])).toEqual([
      ['2026-03-07', 111],
      ['2026-03-09', 1000],
    ]);
  });

  it('places a merge by the day it happened in the report timezone', async () => {
    const { db } = world();
    addMergedPr(db, REPO, 1, at('2026-10-20', '23:59'));
    addMergedPr(db, REPO, 2, at('2026-10-21', '00:00'));
    connectAs(db, 'kelvin');
    const { buckets } = await series(metricsApp(db), '?start=2026-10-20&end=2026-10-21');
    expect(buckets.map((b) => b.prs)).toEqual([1, 1]);
  });
});

describe('GET /api/series coverage', () => {
  it('marks history before a source began unavailable, the bucket that straddles it partial, and never zero', async () => {
    const db = memoryDb();
    addRepo(db, REPO);
    addSource(db, 'codex', { oldest: at('2026-10-20') });
    const codex = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: REPO,
      startedAt: at('2026-10-20'),
    });
    addEvent(db, { session: codex, at: at('2026-10-21'), input: 5 });
    const app = metricsApp(db);

    const days = await series(app, '?start=2026-10-18&end=2026-10-21&provider=codex');
    expect(days.buckets.map((b) => [b.tokens.codex, b.usage.codex, b.usage.rail])).toEqual([
      [null, 'unavailable', 'unavailable'],
      [null, 'unavailable', 'unavailable'],
      [0, 'ok', 'ok'],
      [5, 'ok', 'ok'],
    ]);
    expect(days.unavailableText).toBe('History unavailable before Oct 20, 2026');

    const weeks = await series(app, '?start=2026-10-12&end=2026-10-25&gran=week&provider=codex');
    expect(weeks.buckets.map((b) => [b.tokens.codex, b.usage.codex])).toEqual([
      [null, 'unavailable'],
      [5, 'partial'],
    ]);
  });

  it('says none for a provider that was never found, and the rail follows the providers in scope', async () => {
    const db = memoryDb();
    addRepo(db, REPO);
    addSource(db, 'codex');
    const codex = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: REPO,
      startedAt: at('2026-10-01'),
    });
    addEvent(db, { session: codex, at: at('2026-11-03'), input: 9 });
    const app = metricsApp(db);

    const both = await series(app, '?start=2026-11-03&end=2026-11-03');
    expect(both.buckets[0]).toMatchObject({
      tokens: { codex: 9, claude: null },
      usage: { codex: 'ok', claude: 'none', rail: 'partial' },
    });
    const claudeOnly = await series(app, '?start=2026-11-03&end=2026-11-03&provider=claude');
    expect(claudeOnly.buckets[0]).toMatchObject({
      tokens: { claude: null },
      usage: { claude: 'none', rail: 'unavailable' },
    });
    expect(claudeOnly.buckets[0]!.tokens).not.toHaveProperty('codex');
    expect(claudeOnly.unavailableText).toBe('No local records on this machine');
  });

  it('keeps cached totals but marks the days after a failed refresh stale', async () => {
    const db = memoryDb();
    addRepo(db, REPO);
    addSource(db, 'codex', { result: 'failed', success: at('2026-11-02', '10:00') });
    const codex = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: REPO,
      startedAt: at('2026-10-01'),
    });
    addEvent(db, { session: codex, at: at('2026-11-02', '09:00'), input: 3 });
    const { buckets } = await series(
      metricsApp(db),
      '?start=2026-11-02&end=2026-11-04&provider=codex',
    );
    expect(buckets.map((b) => [b.tokens.codex, b.usage.codex])).toEqual([
      [3, 'ok'],
      [0, 'stale'],
      [0, 'stale'],
    ]);
  });

  it('prefers the last good day the adapter recorded over the day of the last success', async () => {
    const db = memoryDb();
    addRepo(db, REPO);
    addSource(db, 'codex', {
      result: 'failed',
      success: at('2026-11-04', '08:00'),
      extra: { staleAfter: '2026-11-02' },
    });
    const { buckets } = await series(
      metricsApp(db),
      '?start=2026-11-02&end=2026-11-03&provider=codex',
    );
    expect(buckets.map((b) => b.usage.codex)).toEqual(['ok', 'stale']);
  });
});

describe('GET /api/series delivery', () => {
  it('is none, with a null count, when no repo is tracked', async () => {
    const db = memoryDb();
    addSource(db, 'codex');
    const { buckets } = await series(metricsApp(db), '?start=2026-11-02&end=2026-11-03');
    expect(buckets.map((b) => [b.delivery, b.prs])).toEqual([
      ['none', null],
      ['none', null],
    ]);
  });

  it('says syncing, and counts what is stored so far, while a repo is on its first backfill', async () => {
    const db = memoryDb();
    addRepo(db, REPO, { backfill: false });
    addMergedPr(db, REPO, 1, at('2026-11-02'));
    connectAs(db, 'kelvin');
    const { buckets } = await series(metricsApp(db), '?start=2026-11-02&end=2026-11-03');
    expect(buckets.map((b) => [b.delivery, b.prs])).toEqual([
      ['syncing', 1],
      ['syncing', 0],
    ]);
  });

  it('leaves out stopped and inaccessible repos, which are not tracked and reachable', async () => {
    const db = memoryDb();
    addRepo(db, 'kelvin/stopped', { tracking: 'stopped' });
    addRepo(db, 'kelvin/gone', { access: 'inaccessible' });
    addMergedPr(db, 'kelvin/stopped', 1, at('2026-11-02'));
    addMergedPr(db, 'kelvin/gone', 1, at('2026-11-02'));
    connectAs(db, 'kelvin');
    const { buckets } = await series(metricsApp(db), '?start=2026-11-02&end=2026-11-02');
    expect(buckets[0]).toMatchObject({ delivery: 'none', prs: null });
  });
});

describe('GET /api/series filters', () => {
  function filtered() {
    const db = memoryDb();
    addRepo(db, 'kelvin/atlas-api');
    addRepo(db, 'kelvin/atlas-web');
    addRepo(db, 'kelvin/untracked', { tracking: 'stopped' });
    addSource(db, 'codex');
    addSource(db, 'claude');
    const day = at('2026-11-03');
    const sessions = [
      addSession(db, { id: 1, provider: 'codex', repo: 'kelvin/atlas-api', startedAt: day }),
      addSession(db, { id: 2, provider: 'codex', repo: 'kelvin/atlas-web', startedAt: day }),
      addSession(db, { id: 3, provider: 'codex', repo: 'kelvin/untracked', startedAt: day }),
      addSession(db, { id: 4, provider: 'codex', repo: null, startedAt: day }),
      addSession(db, { id: 5, provider: 'claude', repo: 'kelvin/atlas-api', startedAt: day }),
    ];
    [1, 10, 100, 1000, 10000].forEach((input, i) =>
      addEvent(db, { session: sessions[i]!, at: day + 1000, input }),
    );
    addMergedPr(db, 'kelvin/atlas-api', 1, day, 'kelvin');
    addMergedPr(db, 'kelvin/atlas-api', 2, day, 'someone-else');
    addMergedPr(db, 'kelvin/atlas-web', 1, day, 'kelvin');
    connectAs(db, 'kelvin');
    return metricsApp(db);
  }
  const one = '?start=2026-11-03&end=2026-11-03';

  it('applies the repo filter to usage and delivery, excluding unknown and untracked sessions', async () => {
    const { buckets, scope } = await series(filtered(), `${one}&repos=kelvin/atlas-api`);
    expect(scope.repos).toEqual(['kelvin/atlas-api']);
    expect(buckets[0]).toMatchObject({ prs: 1, tokens: { codex: 1, claude: 10000 } });
  });

  it('applies the provider filter to usage only', async () => {
    const { buckets } = await series(filtered(), `${one}&provider=claude`);
    expect(buckets[0]!.tokens).toEqual({ claude: 10000 });
    expect(buckets[0]!.usage).toEqual({ claude: 'ok', rail: 'ok' });
    expect(buckets[0]!.prs).toBe(2); // two PRs by kelvin: the provider never changes delivery
  });

  it('applies the author filter to delivery only', async () => {
    const app = filtered();
    expect((await series(app, `${one}&author=all`)).buckets[0]).toMatchObject({
      prs: 3,
      tokens: { codex: 1111, claude: 10000 },
    });
    expect((await series(app, `${one}&author=mine`)).buckets[0]).toMatchObject({
      prs: 2,
      tokens: { codex: 1111, claude: 10000 },
    });
  });

  it('ignores a repo it does not know and says so', async () => {
    const { scope, buckets } = await series(filtered(), `${one}&repos=kelvin/nope`);
    expect(scope.repos).toEqual([]);
    expect(scope.ignoredRepos).toEqual(['kelvin/nope']);
    expect(buckets[0]!.tokens.codex).toBe(1111);
  });
});

describe('GET /api/series errors', () => {
  it('refuses a range outside the lookback or an invalid filter with the error envelope', async () => {
    const app = metricsApp(memoryDb());
    const old = await get(app, '/api/series?start=2025-11-03&end=2025-11-10');
    expect(old.status).toBe(400);
    expect(old.body).toMatchObject({ error: { code: 'invalid_range' } });
    const gran = await get(app, '/api/series?gran=year');
    expect(gran.status).toBe(400);
    expect(gran.body).toMatchObject({
      error: { code: 'invalid_input', details: { fields: { gran: expect.any(String) } } },
    });
    expect((await get(app, '/api/series?start=2026-11-05&end=2026-11-02')).status).toBe(400);
  });

  it('answers with no-store, as every API response does', async () => {
    const res = await get(metricsApp(memoryDb()), '/api/series');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the clock', () => {
  it('follows the injected clock for what is the future', async () => {
    const { db } = world();
    const later = metricsApp(db, { now: () => NOW + 2 * 86_400_000 }); // Friday
    const { buckets } = await series(later, '?start=2026-11-04&end=2026-11-06');
    expect(buckets.map((b) => b.delivery)).toEqual(['ok', 'ok', 'ok']);
  });
});
