import { describe, expect, it } from 'vitest';
import { seedDatabase } from '../../fixtures/seed.ts';
import { get, memoryDb, metricsApp, type MetricsApp } from './helpers.ts';

// TECH › Performance, measured on the year world: 150,000 usage events, 6,000 sessions and 2,000 merged PRs across 6 repos.
//   - "Overview interactive after navigation: ≤ 1.0 s p95 for /api/overview + /api/series"  (the two requests, one after the other)
//   - "Filter change → updated chart: ≤ 300 ms p95 server time"                              (/api/series alone)
// Each sample goes through the HTTP app, so it covers routing, the queries, the coverage rules and the JSON, as the browser waits
// for them. The widest range (12 months) is the slowest case; shorter ranges and every filter are timed too.

const OVERVIEW_BUDGET_MS = 1000;
const SERIES_BUDGET_MS = 300;

const RANGES = [
  { name: '12 months, by month', query: 'start=2025-11-04&end=2026-11-04&gran=month' },
  { name: '12 months, by week', query: 'start=2025-11-04&end=2026-11-04&gran=week' },
  { name: '12 months, by day', query: 'start=2025-11-04&end=2026-11-04&gran=day' },
  { name: 'last 90 days', query: 'start=2026-08-07&end=2026-11-04' },
  { name: 'this week', query: 'start=2026-11-02&end=2026-11-08' },
];
const FILTERS = [
  { name: 'all', query: '&author=all' },
  { name: 'mine, codex', query: '&provider=codex' },
  { name: 'one repo, claude', query: '&repos=kelvin/atlas-api&provider=claude' },
];
const ROUNDS = 3;

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
};
const median = (samples: number[]): number =>
  [...samples].sort((a, b) => a - b)[samples.length >> 1]!;
const line = (name: string, timings: number[]): string =>
  `${name.padEnd(34)} n=${String(timings.length).padStart(3)}  median ${median(timings).toFixed(1).padStart(6)} ms  p95 ${p95(timings).toFixed(1).padStart(6)} ms  max ${Math.max(
    ...timings,
  )
    .toFixed(1)
    .padStart(6)} ms`;

async function timed(app: MetricsApp, path: string): Promise<number> {
  const started = performance.now();
  const res = await get(app, path);
  const elapsed = performance.now() - started;
  expect(res.status, path).toBe(200);
  return elapsed;
}

describe('review surfaces on the year world', () => {
  const db = memoryDb();
  const counts = seedDatabase(db, { scale: 'year' }).counts;
  expect(counts['events']).toBe(150_000);
  expect(counts['sessions']).toBe(6_000);
  const app = metricsApp(db);

  it(`serves /api/overview + /api/series in at most ${OVERVIEW_BUDGET_MS} ms (p95)`, async () => {
    const samples: number[] = [];
    const rows: string[] = [];
    for (const range of RANGES) {
      for (const filter of FILTERS) {
        const timings: number[] = [];
        for (let round = 0; round < ROUNDS; round++) {
          const query = `${range.query}${filter.query}`;
          const overview = await timed(app, `/api/overview?${query}`);
          const chart = await timed(app, `/api/series?${query}`);
          timings.push(overview + chart);
        }
        samples.push(...timings);
        rows.push(line(`${range.name} · ${filter.name}`, timings));
      }
    }
    console.info(
      `Overview + series, year world (budget ${OVERVIEW_BUDGET_MS} ms, p95 over ${samples.length})\n  ${rows.join('\n  ')}`,
    );
    expect(p95(samples)).toBeLessThanOrEqual(OVERVIEW_BUDGET_MS);
  }, 120_000);

  it(`serves /api/series alone in at most ${SERIES_BUDGET_MS} ms (p95), the filter-change case`, async () => {
    const samples: number[] = [];
    const rows: string[] = [];
    for (const range of RANGES) {
      const timings: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        for (const filter of FILTERS) {
          timings.push(await timed(app, `/api/series?${range.query}${filter.query}`));
        }
      }
      samples.push(...timings);
      rows.push(line(range.name, timings));
    }
    console.info(
      `Series alone, year world (budget ${SERIES_BUDGET_MS} ms, p95 over ${samples.length})\n  ${rows.join('\n  ')}`,
    );
    expect(p95(samples)).toBeLessThanOrEqual(SERIES_BUDGET_MS);
  }, 120_000);

  it('serves records and models for the widest bucket quickly too', async () => {
    const records = [
      await timed(app, '/api/records?start=2025-11-04&end=2026-11-04&limit=100&author=all'),
    ];
    const modelTimings = [await timed(app, '/api/models?start=2025-11-04&end=2026-11-04')];
    console.info(
      `Records (12-month bucket, limit 100) ${records[0]!.toFixed(1)} ms; models (12 months) ${modelTimings[0]!.toFixed(1)} ms`,
    );
    expect(records[0]!).toBeLessThanOrEqual(SERIES_BUDGET_MS);
    expect(modelTimings[0]!).toBeLessThanOrEqual(SERIES_BUDGET_MS);
  }, 120_000);
});
