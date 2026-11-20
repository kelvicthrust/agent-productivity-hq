import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { PrsResponse } from '../../src/shared/contracts/prs.ts';
import { FIXED_NOW, FIXED_TIMEZONE, seedFile } from '../fixtures/seed.ts';
import { tempDir } from '../server/helpers.ts';
import { get, metricsApp } from '../server/metrics/helpers.ts';
import { p95 } from './table.ts';

const RANGES = [
  { name: 'This week', start: '2026-11-02', end: '2026-11-08' },
  { name: 'Last 12 months', start: '2025-11-04', end: '2026-11-04' },
];
const SEARCH = 'Fix'; // Matches evidence-linked titles in both synthetic periods.
const CASES = [
  { name: 'All', linkClass: 'all', search: '' },
  { name: 'Evidence', linkClass: 'evidence', search: '' },
  { name: 'Evidence + search', linkClass: 'evidence', search: SEARCH },
] as const;
const PAGE_SIZE = 50;
const WARMUP = 5;
const SAMPLES = 30;

// Run with `pnpm bench test/bench/delivery.bench.test.ts --silent=false`. The timed request includes
// Hono, SQLite, response serialization and JSON decoding, with no socket or browser. Report timings without a gate.
it('reports warm Delivery first-page reads against the disk-backed synthetic year', async () => {
  const dbPath = join(tempDir(), 'agent-productivity.db');
  const { counts } = seedFile(dbPath, { scale: 'year' });
  expect(counts).toMatchObject({ pullRequests: 2_000, repos: 6, events: 150_000, sessions: 6_000 });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const app = metricsApp(db, { now: () => FIXED_NOW, timezone: FIXED_TIMEZONE });
    const results = [];
    for (const { name: period, start, end } of RANGES) {
      for (const { name: filter, linkClass, search } of CASES) {
        const params = new URLSearchParams({ start, end, author: 'all', limit: String(PAGE_SIZE) });
        if (linkClass !== 'all') params.set('linkClass', linkClass);
        if (search) params.set('q', search);
        const path = `/api/prs?${params}`;

        for (let i = 0; i < WARMUP; i++) {
          expect((await get(app, path)).status, path).toBe(200);
        }

        const samples: number[] = [];
        const pages: unknown[] = [];
        for (let i = 0; i < SAMPLES; i++) {
          const started = performance.now();
          const response = await get(app, path);
          samples.push(performance.now() - started);
          expect(response.status, path).toBe(200);
          pages.push(response.body);
        }

        const first = PrsResponse.parse(pages[0]);
        const returned = first.items?.length ?? 0;
        expect(returned, path).toBeGreaterThan(0);
        expect(returned, path).toBeLessThanOrEqual(PAGE_SIZE);
        for (const page of pages.slice(1)) expect(page, path).toEqual(pages[0]);

        // The tab count ignores search. Walk the filtered pages outside the measured samples for
        // the actual match count in that case.
        const tabCount = first.counts?.[linkClass];
        expect(tabCount, path).toBeGreaterThanOrEqual(returned);
        let matched = tabCount;
        if (search) {
          matched = returned;
          let cursor = first.nextCursor;
          const seen = new Set<string>();
          while (cursor) {
            expect(seen.has(cursor), path).toBe(false);
            seen.add(cursor);
            params.set('cursor', cursor);
            const response = await get(app, `/api/prs?${params}`);
            expect(response.status, path).toBe(200);
            const page = PrsResponse.parse(response.body);
            matched += page.items?.length ?? 0;
            cursor = page.nextCursor;
          }
          expect(matched, path).toBeLessThan(tabCount ?? 0);
        }

        results.push({
          period,
          filter,
          samples: samples.length,
          p95Ms: p95(samples).toFixed(2),
          returned,
          matched,
        });
      }
    }
    console.info(`Delivery GET /api/prs, ${WARMUP} warmups per case, author=all, q=${SEARCH}`);
    console.table(results);
  } finally {
    db.close();
  }
});
