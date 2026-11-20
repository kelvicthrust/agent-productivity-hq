import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ErrorEnvelope } from '../../src/shared/contracts/errors.ts';
import { OverviewResponse } from '../../src/shared/contracts/overview.ts';
import { RecordsResponse } from '../../src/shared/contracts/prs.ts';
import { SeriesResponse } from '../../src/shared/contracts/series.ts';
import { ModelsResponse } from '../../src/shared/contracts/usage.ts';
import { HOST, call, memoryDb, testApp } from './helpers.ts';
import {
  addEvent,
  addMergedPr,
  addRepo,
  addSession,
  addSource,
  at,
  connectAs,
} from './metrics/helpers.ts';

// The review routes as the product serves them: through createApp, behind the Host guard and the headers, with the same clock and
// report timezone the other routes use. test/server/metrics tests the service and each route alone; this file is the wiring. It
// checks what a person relies on when the filters change: the scope each filter reaches (P-12, P-37), the account-wide block, and
// that day, week and month give the same totals for the same days (P-11).
//
// The world: Wednesday 2026-11-04 in Los Angeles. Two tracked repos, one session per provider in each, and events on every day
// of the last five weeks. Four merged PRs, one of them by someone else.

const ATLAS = 'kelvin/atlas-api';
const DOTS = 'kelvin/dotfiles';

function world(): { db: DatabaseSync; app: ReturnType<typeof testApp>['app'] } {
  const db = memoryDb();
  addRepo(db, ATLAS);
  addRepo(db, DOTS);
  addSource(db, 'codex', { oldest: at('2025-12-01') });
  addSource(db, 'claude', { oldest: at('2025-12-01') });
  connectAs(db, 'kelvin');

  const sessions: { id: number; repo: string; provider: 'codex' | 'claude' }[] = [
    { id: 1, repo: ATLAS, provider: 'codex' },
    { id: 2, repo: ATLAS, provider: 'claude' },
    { id: 3, repo: DOTS, provider: 'codex' },
    { id: 4, repo: DOTS, provider: 'claude' },
  ];
  for (const s of sessions) addSession(db, { ...s, startedAt: at('2026-09-28') });
  // Every day from Sep 28 to Nov 4, with a different size per session, so a mix-up between sessions, repos or providers shows.
  let day = new Date('2026-09-28T12:00:00Z');
  const end = new Date('2026-11-04T12:00:00Z');
  for (let n = 1; day <= end; n += 1) {
    const date = day.toISOString().slice(0, 10);
    for (const s of sessions) {
      addEvent(db, { session: s.id, at: at(date, '09:30'), input: 100 * s.id + n, output: n });
    }
    // an event right after local midnight, the edge a UTC day would put in the wrong bucket
    addEvent(db, { session: 1, at: at(date, '00:00'), input: 7 });
    day = new Date(day.getTime() + 86_400_000);
  }

  addMergedPr(db, ATLAS, 1, at('2026-10-27', '11:00'), 'kelvin');
  addMergedPr(db, ATLAS, 2, at('2026-11-03', '23:59'), 'kelvin');
  addMergedPr(db, DOTS, 3, at('2026-11-04', '00:00'), 'kelvin');
  addMergedPr(db, DOTS, 4, at('2026-11-04', '08:00'), 'someone-else');
  return { db, app: testApp({ db }).app };
}

async function getJson<T>(
  app: ReturnType<typeof testApp>['app'],
  path: string,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  const res = await call(app, path, { headers: HOST });
  const body: unknown = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return schema.parse(body);
}

const RANGE = 'start=2026-10-05&end=2026-11-04';

describe('the review routes through createApp', () => {
  it('serves all four behind the guards, with the API headers', async () => {
    const { app } = world();
    for (const path of [
      `/api/overview?${RANGE}`,
      `/api/series?${RANGE}&gran=week`,
      `/api/records?start=2026-11-02&end=2026-11-04`,
      `/api/models?${RANGE}`,
    ]) {
      const res = await call(app, path, { headers: HOST });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(res.headers.get('content-type'), path).toContain('application/json');

      // The Host guard runs before them: a name that is not this machine's is refused, not answered.
      const rebinding = await call(app, path, { headers: { host: 'evil.example:4317' } });
      expect(rebinding.status, path).toBe(421);
    }
  });

  it('answers a bad range or a bad page size with the error envelope', async () => {
    const { app } = world();
    for (const path of [
      '/api/overview?start=2026-11-05&end=2026-11-01',
      '/api/series?start=2024-01-01&end=2026-11-04',
      '/api/records?start=2026-11-02&end=2027-03-01',
      '/api/models?start=2026-11-02&end=2027-03-01',
    ]) {
      const res = await call(app, path, { headers: HOST });
      expect(res.status, path).toBe(400);
      expect(ErrorEnvelope.parse(await res.json()).error.code, path).toBe('invalid_range');
    }
    for (const limit of ['0', '101', 'ten']) {
      const res = await call(app, `/api/records?start=2026-11-02&end=2026-11-04&limit=${limit}`, {
        headers: HOST,
      });
      expect(res.status, limit).toBe(400);
      const error = ErrorEnvelope.parse(await res.json()).error;
      expect(error.code, limit).toBe('invalid_input');
      expect(error.details?.['fields'], limit).toHaveProperty('limit');
    }
  });

  // "Open in Delivery" and "Open in Usage" carry a bucket's dates to those pages (G7_6, lib/recordsDrawer bucketDrillUrl). The drill moves
  // a date only where the API refuses it, and this is where that is measured instead of assumed: today is Wed Nov 4, so the API
  // takes an end up to the end of the month (Nov 30), and refuses one after it, or a start before the 12-month lookback.
  describe('the ranges the drawer opens Delivery and Usage on', () => {
    const DESTINATIONS = ['/api/prs', '/api/usage/categories', '/api/usage/groups'] as const;
    const TAKEN: [string, string, string][] = [
      ['a week that runs to Sunday', '2026-11-02', '2026-11-08'],
      ['the current month', '2026-11-01', '2026-11-30'],
      ['a day that has not happened yet', '2026-11-06', '2026-11-06'],
      ['a week after today, inside the month', '2026-11-09', '2026-11-15'],
      ['the first day of the lookback', '2025-11-04', '2025-11-04'],
    ];

    for (const [name, start, end] of TAKEN) {
      it(`take ${name} (${start} to ${end}) on every destination read`, async () => {
        const { app } = world();
        for (const route of DESTINATIONS) {
          const res = await call(app, `${route}?start=${start}&end=${end}&author=all`, {
            headers: HOST,
          });
          expect(res.status, `${route} ${start}..${end}`).toBe(200);
        }
      });
    }

    it('refuse the ranges the drill moves: an end after the month, a start before the lookback', async () => {
      const { app } = world();
      for (const route of DESTINATIONS) {
        for (const range of [
          'start=2026-11-30&end=2026-12-01',
          'start=2025-11-03&end=2025-11-09',
        ]) {
          const res = await call(app, `${route}?${range}&author=all`, { headers: HOST });
          expect(res.status, `${route} ${range}`).toBe(400);
        }
      }
    });
  });

  describe('what each filter reaches', () => {
    it('the repo filter narrows usage and delivery together', async () => {
      const { app } = world();
      const all = await getJson(app, `/api/overview?${RANGE}&author=all`, OverviewResponse);
      const atlas = await getJson(
        app,
        `/api/overview?${RANGE}&author=all&repos=${ATLAS}`,
        OverviewResponse,
      );
      expect(all.kpis.mergedPrs?.value).toBe(4);
      expect(atlas.kpis.mergedPrs?.value).toBe(2); // delivery follows the repo
      const allCodex = all.kpis.localTokens?.codex?.value ?? 0;
      const atlasCodex = atlas.kpis.localTokens?.codex?.value ?? 0;
      expect(atlasCodex).toBeGreaterThan(0); // usage follows the repo too
      expect(atlasCodex).toBeLessThan(allCodex);
      expect(atlas.repoRows.map((row) => row.repo)).toEqual([ATLAS]);
      expect(atlas.recentPrs.map((pr) => pr.repo)).toEqual([ATLAS, ATLAS]);

      const series = await getJson(
        app,
        `/api/series?${RANGE}&gran=month&author=all`,
        SeriesResponse,
      );
      const atlasSeries = await getJson(
        app,
        `/api/series?${RANGE}&gran=month&author=all&repos=${ATLAS}`,
        SeriesResponse,
      );
      const sum = (
        s: typeof series,
        pick: (b: (typeof series)['buckets'][number]) => number | null | undefined,
      ) => s.buckets.reduce((total, bucket) => total + (pick(bucket) ?? 0), 0);
      expect(sum(atlasSeries, (b) => b.prs)).toBe(2);
      expect(sum(series, (b) => b.prs)).toBe(4);
      expect(sum(atlasSeries, (b) => b.tokens.codex)).toBeLessThan(
        sum(series, (b) => b.tokens.codex),
      );
    });

    it('the provider filter narrows usage only', async () => {
      const { app } = world();
      const both = await getJson(app, `/api/overview?${RANGE}&author=all`, OverviewResponse);
      const codex = await getJson(
        app,
        `/api/overview?${RANGE}&author=all&provider=codex`,
        OverviewResponse,
      );
      expect(Object.keys(codex.kpis.localTokens ?? {})).toEqual(['codex']);
      expect(codex.kpis.localTokens?.codex).toEqual(both.kpis.localTokens?.codex);
      // delivery does not know about providers
      expect(codex.kpis.mergedPrs).toEqual(both.kpis.mergedPrs);
      expect(codex.recentPrs).toEqual(both.recentPrs);
      expect(codex.periodMergedCount).toBe(both.periodMergedCount);

      const models = await getJson(app, `/api/models?${RANGE}&provider=claude`, ModelsResponse);
      expect(Object.keys(models)).toEqual(['claude']);
    });

    it('the author filter narrows delivery only', async () => {
      const { app } = world();
      const mine = await getJson(app, `/api/overview?${RANGE}`, OverviewResponse);
      const everyone = await getJson(app, `/api/overview?${RANGE}&author=all`, OverviewResponse);
      expect(mine.kpis.mergedPrs?.value).toBe(3);
      expect(everyone.kpis.mergedPrs?.value).toBe(4);
      // usage does not know about authors: the same tokens, sessions and models either way
      expect(mine.kpis.localTokens).toEqual(everyone.kpis.localTokens);
      expect(mine.kpis.rootSessions).toEqual(everyone.kpis.rootSessions);
      expect(await getJson(app, `/api/models?${RANGE}&author=all`, ModelsResponse)).toEqual(
        await getJson(app, `/api/models?${RANGE}`, ModelsResponse),
      );
      const seriesMine = await getJson(app, `/api/series?${RANGE}&gran=week`, SeriesResponse);
      const seriesAll = await getJson(
        app,
        `/api/series?${RANGE}&gran=week&author=all`,
        SeriesResponse,
      );
      expect(seriesMine.buckets.map((b) => b.tokens)).toEqual(
        seriesAll.buckets.map((b) => b.tokens),
      );
      expect(seriesMine.buckets.map((b) => b.prs)).not.toEqual(seriesAll.buckets.map((b) => b.prs));
    });

    it('the account block and the coverage strip are account-wide: no repo or provider filter reaches them', async () => {
      const { app } = world();
      const plain = await getJson(app, `/api/overview?${RANGE}`, OverviewResponse);
      const filtered = await getJson(
        app,
        `/api/overview?${RANGE}&repos=${ATLAS}&provider=claude`,
        OverviewResponse,
      );
      expect(filtered.accounts).toEqual(plain.accounts);
      expect(filtered.coverage).toEqual(plain.coverage);
      expect(filtered.coverage.github).toEqual({ tracked: 2, inaccessible: 0 });
      expect(filtered.coverage.accounts?.map((a) => [a.id, a.status])).toEqual([
        ['chatgpt', 'notconnected'],
        ['claude', 'notconnected'],
      ]);
      // ...while the figures beside it did change
      expect(filtered.kpis.localTokens).not.toEqual(plain.kpis.localTokens);
    });
  });

  describe('day, week and month give the same totals for the same days (P-11)', () => {
    const FILTERS = ['', `&repos=${ATLAS}`, '&provider=codex', `&repos=${DOTS}&provider=claude`];

    it.each(FILTERS)('with the filters "%s", and they equal the Overview', async (filter) => {
      const { app } = world();
      const query = `${RANGE}&author=all${filter}`;
      const overview = await getJson(app, `/api/overview?${query}`, OverviewResponse);
      const totals = async (gran: 'day' | 'week' | 'month') => {
        const series = await getJson(app, `/api/series?${query}&gran=${gran}`, SeriesResponse);
        const sum = (pick: (b: (typeof series)['buckets'][number]) => number | null | undefined) =>
          series.buckets.reduce((total, bucket) => total + (pick(bucket) ?? 0), 0);
        return {
          prs: sum((b) => b.prs),
          codex: sum((b) => b.tokens.codex),
          claude: sum((b) => b.tokens.claude),
        };
      };
      const day = await totals('day');
      expect(await totals('week')).toEqual(day);
      expect(await totals('month')).toEqual(day);

      expect(day.prs).toBe(overview.kpis.mergedPrs?.value);
      expect(day.codex).toBe(overview.kpis.localTokens?.codex?.value ?? 0);
      expect(day.claude).toBe(overview.kpis.localTokens?.claude?.value ?? 0);
    });

    it("a bucket's records say what the bucket drew", async () => {
      const { app } = world();
      const series = await getJson(
        app,
        `/api/series?${RANGE}&gran=week&author=all`,
        SeriesResponse,
      );
      for (const bucket of series.buckets) {
        const records = await getJson(
          app,
          `/api/records?start=${bucket.start}&end=${bucket.end}&author=all&limit=100`,
          RecordsResponse,
        );
        expect(records.prTotal, bucket.label).toBe(bucket.prs);
        for (const provider of ['codex', 'claude'] as const) {
          const tokens = (records.sessions ?? [])
            .filter((session) => session.provider === provider)
            .reduce((total, session) => total + session.tokens, 0);
          expect(tokens, `${bucket.label} ${provider}`).toBe(bucket.tokens[provider]);
        }
      }
    });
  });

  it('a page size cuts the lists and never the totals', async () => {
    const { app } = world();
    const records = await getJson(
      app,
      '/api/records?start=2026-10-05&end=2026-11-04&author=all&limit=2',
      RecordsResponse,
    );
    expect(records.prs).toHaveLength(2);
    expect(records.prTotal).toBe(4);
    expect(records.sessions).toHaveLength(2);
    expect(records.sessionTotal).toBe(4);
  });
});
