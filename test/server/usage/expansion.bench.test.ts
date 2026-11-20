import { describe, expect, it } from 'vitest';
import { seedDatabase } from '../../fixtures/seed.ts';
import { get, memoryDb, usageApp } from './helpers.ts';

// TECH › Performance: "Usage tree group expansion ≤ 300 ms for 15 roots (paged roots query)", measured on the year world:
// 150,000 usage events, 6,000 sessions and 2,000 merged PRs across 6 repos. The budget covers what the browser waits for:
// routing, the query, the tree, the links and the JSON, so each sample goes through the HTTP app. The slowest case is the
// widest range (12 months) on the biggest groups; shorter ranges are faster and are timed too.

const BUDGET_MS = 300;
const RANGES = [
  { name: '12 months', query: 'start=2025-11-04&end=2026-11-04' },
  { name: 'last 90 days', query: 'start=2026-08-07&end=2026-11-04' },
  { name: 'this week', query: '' },
];

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
};
const median = (samples: number[]): number =>
  [...samples].sort((a, b) => a - b)[samples.length >> 1]!;

describe('expanding a usage group to 15 roots, year world', () => {
  it(`takes at most ${BUDGET_MS} ms (p95) for every group, range and page`, async () => {
    const db = memoryDb();
    const counts = seedDatabase(db, { scale: 'year' }).counts;
    expect(counts['events']).toBe(150_000);
    expect(counts['sessions']).toBe(6_000);
    const app = usageApp(db);

    const groupList = (
      (await get(app, '/api/usage/groups?start=2025-11-04&end=2026-11-04')).body as {
        groups: { key: string }[];
      }
    ).groups.map((g) => g.key);
    expect(groupList.length).toBe(8); // six repos, Untracked and Unknown

    const samples: number[] = [];
    const rows: string[] = [];
    for (const range of RANGES) {
      const timings: number[] = [];
      for (let round = 0; round < 3; round++) {
        for (const key of groupList) {
          const base = `/api/usage/groups/${encodeURIComponent(key)}/roots?limit=15${range.query ? `&${range.query}` : ''}`;
          const started = performance.now();
          const first = await get(app, base);
          timings.push(performance.now() - started);
          expect(first.status).toBe(200);
          const body = first.body as { roots: unknown[]; nextCursor: string | null };
          if (round === 0 && range.name === '12 months') expect(body.roots).toHaveLength(15);
          if (body.nextCursor) {
            // the next page of 15 is a roots expansion too
            const next = performance.now();
            const second = await get(app, `${base}&cursor=${body.nextCursor}`);
            timings.push(performance.now() - next);
            expect(second.status).toBe(200);
          }
        }
      }
      samples.push(...timings);
      rows.push(
        `${range.name.padEnd(13)} n=${String(timings.length).padStart(3)}  median ${median(timings).toFixed(1).padStart(6)} ms  p95 ${p95(timings).toFixed(1).padStart(6)} ms  max ${Math.max(
          ...timings,
        )
          .toFixed(1)
          .padStart(6)} ms`,
      );
    }

    console.info(
      `Usage group expansion, 15 roots, year world (budget ${BUDGET_MS} ms)\n  ${rows.join('\n  ')}`,
    );
    expect(p95(samples)).toBeLessThanOrEqual(BUDGET_MS);
  }, 120_000);
});
