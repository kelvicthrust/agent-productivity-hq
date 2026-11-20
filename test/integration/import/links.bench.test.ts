import { describe, expect, it } from 'vitest';
import {
  replaceComputedLinks,
  type LinkBasisStored,
  type LinkClassStored,
} from '../../../src/server/db/queries/links.ts';
import { buildPrs } from '../../../src/server/services/delivery.ts';
import { recomputeLinks } from '../../../src/server/services/links.ts';
import { seedDatabase } from '../../fixtures/seed.ts';
import { memoryDb } from '../../server/helpers.ts';

// TECH › Performance, on the year world (150,000 usage events, 6,000 sessions, 2,000 merged PRs across 6 repos):
//   - "Incremental refresh with no new data: ≤ 3 s". The link recompute runs at the end of EVERY refresh, new data or not, so it has
//     to fit inside that budget on its own, and it must not get slower when run again over the same data;
//   - the Delivery list now reads each PR's effective class, so a 12-month Delivery page is timed too.

const RECOMPUTE_BUDGET_MS = 3000;
const DELIVERY_BUDGET_MS = 1000;
const ROUNDS = 5;

const median = (samples: number[]): number =>
  [...samples].sort((a, b) => a - b)[samples.length >> 1]!;

describe('the link engine on the year world', () => {
  const db = memoryDb();
  const summary = seedDatabase(db, { scale: 'year' });
  expect(summary.counts['events']).toBe(150_000);
  expect(summary.counts['sessions']).toBe(6_000);
  const ctx = { nowMs: Date.parse('2026-11-04T20:00:00Z'), timezone: 'America/Los_Angeles' };

  it(`recomputes every link in at most ${RECOMPUTE_BUDGET_MS} ms, again and again over the same data`, () => {
    const samples: number[] = [];
    let last = recomputeLinks(db, ctx.nowMs);
    for (let round = 0; round < ROUNDS; round++) {
      const started = performance.now();
      last = recomputeLinks(db, ctx.nowMs);
      samples.push(performance.now() - started);
    }
    console.log(
      `recomputeLinks: ${last.prs} PRs x ${last.sessions} sessions -> ${last.evidence} evidence + ${last.suggested} suggested; ` +
        `median ${median(samples).toFixed(0)} ms, max ${Math.max(...samples).toFixed(0)} ms (budget ${RECOMPUTE_BUDGET_MS} ms)`,
    );
    expect(last.prs).toBeGreaterThanOrEqual(2000);
    expect(last.sessions).toBe(6000);
    expect(Math.max(...samples)).toBeLessThan(RECOMPUTE_BUDGET_MS);
    // the same data gives the same links: a second recompute changes nothing
    const rows = () =>
      db
        .prepare('SELECT pr_node_id, session_id, class, basis FROM pr_session_link ORDER BY 1, 2')
        .all();
    const once = rows();
    recomputeLinks(db, ctx.nowMs);
    expect(rows()).toEqual(once);
  });

  it('writes the computed table in one transaction without slowing down as the table grows', () => {
    const rows = db
      .prepare('SELECT pr_node_id, session_id, class, basis FROM pr_session_link')
      .all() as {
      pr_node_id: string;
      session_id: number;
      class: LinkClassStored;
      basis: LinkBasisStored;
    }[];
    const started = performance.now();
    replaceComputedLinks(
      db,
      rows.map((r) => ({
        prNodeId: r.pr_node_id,
        sessionId: r.session_id,
        class: r.class,
        basis: r.basis,
      })),
      ctx.nowMs,
    );
    const elapsed = performance.now() - started;
    console.log(`replaceComputedLinks: ${rows.length} rows in ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(RECOMPUTE_BUDGET_MS);
  });

  it(`serves a 12-month Delivery list, every tab, in at most ${DELIVERY_BUDGET_MS} ms`, () => {
    const query = { start: '2025-11-04', end: '2026-11-04', author: 'all' };
    const lines: string[] = [];
    for (const linkClass of ['all', 'evidence', 'owner', 'suggested', 'unlinked']) {
      const samples: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const started = performance.now();
        const page = buildPrs(db, { ...query, linkClass }, ctx);
        samples.push(performance.now() - started);
        expect(page.items?.length).toBeGreaterThan(0);
      }
      lines.push(
        `${linkClass.padEnd(9)} median ${median(samples).toFixed(0)} ms, max ${Math.max(...samples).toFixed(0)} ms`,
      );
      expect(Math.max(...samples), linkClass).toBeLessThan(DELIVERY_BUDGET_MS);
    }
    console.log(`Delivery list, 12 months:\n  ${lines.join('\n  ')}`);
  });
});
