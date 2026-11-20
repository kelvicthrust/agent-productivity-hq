import { describe, expect, it } from 'vitest';
import { seedDatabase } from '../../fixtures/seed.ts';
import {
  UsageCategoriesResponse,
  UsageGroupsResponse,
  UsageRootsResponse,
} from '../../../src/shared/contracts/usage.ts';
import { PrsResponse } from '../../../src/shared/contracts/prs.ts';
import {
  addEvent,
  addRepo,
  addSession,
  addSource,
  at,
  get,
  memoryDb,
  metricsApp,
  models,
  overview,
  records,
  series,
  type MetricsApp,
} from './helpers.ts';

// The review surfaces and the Usage and Delivery pages describe the same stored rows, so they must agree wherever they overlap:
// coverage and provider totals (Overview ↔ Usage ledgers ↔ series ↔ models), per-repo tokens and roots (Overview ↔ Usage groups),
// a session's identity and link status (records ↔ Usage tree), and merged-PR counts (Overview ↔ series ↔ Delivery). The Usage
// side is the older code, so it is the reference: if these fail, the review surfaces drifted.

const RANGES = [
  '?start=2026-11-02&end=2026-11-08',
  '?start=2026-10-05&end=2026-11-04',
  '?start=2026-02-20&end=2026-04-20', // starts before Claude's history begins (2026-03-15): partial
  '?start=2026-01-10&end=2026-02-10', // before both sources: Codex partial, Claude unavailable
  '?start=2025-11-04&end=2026-11-04',
];
const FILTERS = [
  '',
  '&provider=codex',
  '&provider=claude',
  '&repos=kelvin/atlas-api',
  '&repos=kelvin/atlas-api,kelvin/notes-cli&provider=codex',
];

const json = async <T>(
  app: MetricsApp,
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T> => {
  const { status, body } = await get(app, path);
  expect(status, JSON.stringify(body)).toBe(200);
  return schema.parse(body);
};

describe('the seeded typical world', () => {
  const db = memoryDb();
  seedDatabase(db, { scale: 'typical' });
  const app = metricsApp(db);

  for (const range of RANGES) {
    for (const filter of FILTERS) {
      const query = `${range}${filter}&author=all`;

      it(`gives the same coverage and provider totals as Usage, the series and the models ${query}`, async () => {
        const [ov, cats, sr, md] = await Promise.all([
          overview(app, query),
          json(app, `/api/usage/categories${query}`, UsageCategoriesResponse),
          series(app, `${query}&gran=week`),
          models(app, query),
        ]);
        for (const provider of ['codex', 'claude'] as const) {
          const kpi = ov.kpis.localTokens?.[provider];
          const ledger = cats[provider];
          expect(kpi?.coverage, `${provider} coverage`).toBe(ledger?.coverage);
          if (kpi === undefined || ledger === undefined) continue;
          const figures = !['none', 'unavailable', 'future'].includes(kpi.coverage);
          expect(kpi.value, `${provider} total`).toBe(figures ? (ledger.total ?? null) : null);
          expect(kpi.coveredFrom, `${provider} coveredFrom`).toBe(
            kpi.coverage === 'partial' ? ledger.coveredFrom : null,
          );
          // the series covers the same dates, so its buckets add up to the KPI where the KPI has a figure
          const fromSeries = sr.buckets.reduce((sum, b) => sum + (b.tokens[provider] ?? 0), 0);
          expect(fromSeries, `${provider} series`).toBe(figures ? kpi.value : 0);
          // and the models' shares add up to the same total
          const modelTokens = (md[provider]?.rows ?? []).reduce(
            (sum, row) => sum + (row.tokens ?? 0),
            0,
          );
          expect(modelTokens, `${provider} models`).toBe(figures ? kpi.value : 0);
          expect(md[provider]?.coverage).toBe(kpi.coverage);
        }
      });

      it(`gives the same per-repo tokens and roots as the Usage groups ${query}`, async () => {
        const [ov, groups] = await Promise.all([
          overview(app, query),
          json(app, `/api/usage/groups${query}`, UsageGroupsResponse),
        ]);
        const byKey = new Map(groups.groups?.map((g) => [g.key, g]));
        const rows = ov.repoRows.filter((row) => row.group === 'tracked');
        for (const row of rows) {
          const group = byKey.get(row.repo ?? '');
          if (group === undefined) {
            // Usage lists an inaccessible repo only when it has sessions; the Overview always lists it (flagged inaccessible, with no PR figures)
            expect(row.accessState, `${row.repo} has no usage group`).toBe('inaccessible');
            expect(row.rootSessions).toBe(0);
            expect([row.mergedPrs, row.linkedPrs]).toEqual([null, null]);
            continue;
          }
          expect(row.rootSessions, `${row.repo} roots`).toBe(group?.roots);
          for (const provider of ['codex', 'claude'] as const) {
            const cell = row.tokens?.[provider];
            if (cell === undefined) continue; // not in scope
            // a provider with no covered dates has no figure; otherwise the group's number is the cell's
            if (cell !== null)
              expect(cell, `${row.repo} ${provider}`).toBe(group?.tokens?.[provider]);
          }
        }
        for (const [group, key] of [
          ['untracked', '__untracked'],
          ['unknown', '__unknown'],
        ] as const) {
          const row = ov.repoRows.find((r) => r.group === group);
          expect(row !== undefined, `${group} row`).toBe(byKey.has(key));
          if (row) expect(row.rootSessions).toBe(byKey.get(key)?.roots);
        }
      });

      it(`counts the same merged PRs in the Overview, the series and Delivery ${query}`, async () => {
        const [ov, sr, prs] = await Promise.all([
          overview(app, query),
          series(app, `${query}&gran=month`),
          json(app, `/api/prs${query}&limit=1`, PrsResponse),
        ]);
        expect(ov.kpis.mergedPrs?.value).toBe(prs.counts?.all);
        expect(ov.periodMergedCount).toBe(prs.counts?.all);
        expect(sr.buckets.reduce((sum, b) => sum + (b.prs ?? 0), 0)).toBe(prs.counts?.all);
      });
    }
  }

  it('gives a session in the records exactly the identity and links the Usage tree gives it', async () => {
    const week = '?start=2026-10-26&end=2026-11-04&author=all';
    const groups = await json(app, `/api/usage/groups${week}`, UsageGroupsResponse);
    let compared = 0;
    for (const group of groups.groups ?? []) {
      const roots = await json(
        app,
        `/api/usage/groups/${encodeURIComponent(group.key!)}/roots${week}&limit=100`,
        UsageRootsResponse,
      );
      const tree = [
        ...(roots.roots ?? []),
        ...(roots.orphans ?? []),
        ...(roots.unknownRelationship ?? []),
      ];
      const rec = await records(app, `${week}&limit=100`);
      const byId = new Map(rec.sessions?.map((s) => [s.id, s]));
      for (const expected of tree) {
        // The tree adds a root's children and `childCount`; a record is the session itself.
        const session: Record<string, unknown> = { ...expected };
        delete session['children'];
        delete session['childCount'];
        const actual = byId.get(expected.id);
        if (!actual) continue; // the records list is cut at the limit; compare what it holds
        expect(actual).toEqual(session);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });
});

describe('coverage states, one by one', () => {
  /** The Overview's KPI coverage, `coveredFrom` and note, against the Usage ledger for the same scope. */
  async function agree(setup: (db: ReturnType<typeof memoryDb>) => void, query: string) {
    const db = memoryDb();
    addRepo(db, 'kelvin/atlas-api');
    setup(db);
    const app = metricsApp(db);
    const ov = await overview(app, query);
    const cats = await json(app, `/api/usage/categories${query}`, UsageCategoriesResponse);
    return { ov, cats };
  }

  it.each([
    ['ok', (db: ReturnType<typeof memoryDb>) => addSource(db, 'codex'), 'ok'],
    [
      'partial',
      (db: ReturnType<typeof memoryDb>) => addSource(db, 'codex', { oldest: at('2026-11-03') }),
      'partial',
    ],
    [
      'unavailable',
      (db: ReturnType<typeof memoryDb>) => addSource(db, 'codex', { oldest: at('2026-11-20') }),
      'unavailable',
    ],
    [
      'stale',
      (db: ReturnType<typeof memoryDb>) =>
        addSource(db, 'codex', { result: 'failed', success: at('2026-11-02', '18:00') }),
      'stale',
    ],
    ['none', () => {}, 'none'],
  ] as const)('%s', async (_name, setup, coverage) => {
    const { ov, cats } = await agree(setup, '?start=2026-11-02&end=2026-11-08&provider=codex');
    expect(ov.kpis.localTokens?.codex?.coverage).toBe(coverage);
    expect(cats.codex?.coverage).toBe(coverage);
  });

  it('future', async () => {
    const { ov, cats } = await agree(
      (db) => addSource(db, 'codex'),
      '?start=2026-11-05&end=2026-11-08&provider=codex',
    );
    expect(ov.kpis.localTokens?.codex?.coverage).toBe('future');
    expect(cats.codex?.coverage).toBe('future');
  });

  it('takes the last good day from the adapter, as Usage does', async () => {
    const setup = (db: ReturnType<typeof memoryDb>) => {
      addSource(db, 'codex', {
        result: 'failed',
        success: at('2026-11-04'),
        extra: { staleAfter: '2026-11-03' },
      });
      const session = addSession(db, {
        id: 1,
        provider: 'codex',
        repo: 'kelvin/atlas-api',
        startedAt: at('2026-11-02'),
      });
      addEvent(db, { session, at: at('2026-11-02'), input: 5 });
    };
    const { ov, cats } = await agree(setup, '?start=2026-11-04&end=2026-11-08&provider=codex');
    expect(ov.kpis.localTokens?.codex?.coverage).toBe('stale');
    expect(cats.codex?.coverage).toBe('stale');
  });
});
