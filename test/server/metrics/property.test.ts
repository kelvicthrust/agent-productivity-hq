import { describe, expect, it } from 'vitest';
import {
  addDays,
  bucketsFor,
  dateInZone,
  diffDays,
  utcBounds,
} from '../../../src/shared/domain/periods.ts';
import { NOW } from '../helpers.ts';
import {
  addEvent,
  addMergedPr,
  addRepo,
  addSession,
  addSource,
  memoryDb,
  metricsApp,
  series,
} from './helpers.ts';

// P-11 as a property: over generated events, day sum = week sum = month sum, for every provider and repo filter, and all of them
// equal a direct count of the events whose report-timezone date falls in the range. The events include instants exactly on, one
// millisecond before and one after local midnight on every DST day of the lookback, in zones whose day is 23, 24, 25 hours long
// (and 23.5 for Lord Howe). A deterministic generator (a fixed seed per case) keeps a failure reproducible: the seed is in the title.

const ZONES = ['America/Los_Angeles', 'Europe/London', 'Australia/Lord_Howe'] as const;
const SEEDS = 12;
const TODAY_MS = NOW; // 2026-11-04 12:00 in Los Angeles; the other zones are at most a day ahead
const LOOKBACK = '2025-11-04';
const REPOS = ['kelvin/atlas-api', 'kelvin/atlas-web'];

/** mulberry32: a tiny seeded generator, so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

interface Generated {
  db: ReturnType<typeof memoryDb>;
  events: { at: number; provider: 'codex' | 'claude'; repo: string | null; tokens: number }[];
  prs: { at: number; repo: string }[];
}

function generate(seed: number, timezone: string): Generated {
  const r = rng(seed);
  const db = memoryDb();
  for (const repo of REPOS) addRepo(db, repo);
  addSource(db, 'codex', { oldest: Date.parse('2025-11-05T00:00:00Z') });
  addSource(db, 'claude', { oldest: Date.parse('2025-11-05T00:00:00Z') });

  const sessions = Array.from({ length: 10 }, (_, i) => {
    const provider = r.pick(['codex', 'claude'] as const);
    const repo = r.pick([...REPOS, null, 'kelvin/not-tracked']);
    addSession(db, { id: i + 1, provider, repo, startedAt: Date.parse('2025-11-05T00:00:00Z') });
    return { id: i + 1, provider, repo };
  });

  // Instants: spread over the whole lookback, plus the edges of every day whose length is not 24 hours.
  const instants: number[] = [];
  const first = utcBounds(LOOKBACK, timezone).start;
  for (let i = 0; i < 260; i++) instants.push(r.int(first, TODAY_MS));
  const edgeDays: string[] = [];
  for (let d = addDays(LOOKBACK, 1); d <= '2026-11-03'; d = addDays(d, 1)) {
    const { start, end } = utcBounds(d, timezone);
    if (end - start !== 86_400_000) edgeDays.push(d);
  }
  expect(edgeDays.length).toBeGreaterThanOrEqual(2); // every zone here has at least two DST days in the lookback
  for (const d of edgeDays) {
    for (const day of [addDays(d, -1), d, addDays(d, 1)]) {
      const { start, end } = utcBounds(day, timezone);
      instants.push(start - 1, start, start + 1, end - 1);
    }
  }

  const events = instants
    .filter((at) => at >= first && at <= TODAY_MS)
    .map((at) => {
      const session = r.pick(sessions);
      const tokens = r.int(1, 5_000);
      addEvent(db, { session: session.id, at, input: tokens });
      return { at, provider: session.provider, repo: session.repo, tokens };
    });

  const prs = Array.from({ length: 70 }, (_, i) => {
    const repo = r.pick(REPOS);
    const at = r.int(first, TODAY_MS);
    addMergedPr(db, repo, i + 1, at, 'kelvin');
    return { at, repo };
  });
  return { db, events, prs };
}

/** A random range inside the lookback that ends no later than today (2026-11-04). */
function randomRange(r: ReturnType<typeof rng>): { start: string; end: string } {
  const start = addDays(LOOKBACK, r.int(0, 360));
  const end = addDays(start, r.int(0, 100));
  return { start, end: end > '2026-11-04' ? '2026-11-04' : end };
}

const sum = (values: readonly (number | null | undefined)[]): number =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

describe.each(ZONES)('series totals in %s', (timezone) => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`day sum = week sum = month sum = the events in range (seed ${seed})`, async () => {
      const { db, events, prs } = generate(seed * 7919, timezone);
      const app = metricsApp(db, { timezone });
      const r = rng(seed);

      for (let round = 0; round < 3; round++) {
        const { start, end } = randomRange(r);
        const repoFilter = r.pick(['', `&repos=${REPOS[0]}`, `&repos=${REPOS.join(',')}`]);
        const repoIds = repoFilter === '' ? null : repoFilter.slice(7).split(',');
        const inRange = (at: number) => {
          const date = dateInZone(at, timezone);
          return date >= start && date <= end;
        };
        const expectedTokens = (provider: 'codex' | 'claude') =>
          sum(
            events
              .filter((e) => e.provider === provider && inRange(e.at))
              // the repo filter keeps sessions of those repos and drops unknown and untracked ones
              .filter((e) => repoIds === null || (e.repo !== null && repoIds.includes(e.repo)))
              .map((e) => e.tokens),
          );
        const expectedPrs = prs.filter(
          (p) => inRange(p.at) && (repoIds === null || repoIds.includes(p.repo)),
        ).length;

        const totals = [];
        for (const gran of ['day', 'week', 'month'] as const) {
          const { buckets } = await series(
            app,
            `?start=${start}&end=${end}&gran=${gran}&author=all${repoFilter}`,
          );
          // the buckets partition the range: no gap, no overlap
          expect(buckets[0]!.start).toBe(start);
          expect(buckets.at(-1)!.end).toBe(end);
          buckets.slice(1).forEach((b, i) => expect(b.start).toBe(addDays(buckets[i]!.end, 1)));
          expect(sum(buckets.map((b) => diffDays(b.start, b.end) + 1))).toBe(
            diffDays(start, end) + 1,
          );
          expect(buckets.map((b) => b.start)).toEqual(
            bucketsFor(start, end, gran).map((b) => b.start),
          );
          totals.push({
            gran,
            codex: sum(buckets.map((b) => b.tokens.codex)),
            claude: sum(buckets.map((b) => b.tokens.claude)),
            prs: sum(buckets.map((b) => b.prs)),
          });
        }

        const context = `${start}..${end}${repoFilter} in ${timezone}`;
        for (const total of totals) {
          expect(total.codex, `codex by ${total.gran}, ${context}`).toBe(expectedTokens('codex'));
          expect(total.claude, `claude by ${total.gran}, ${context}`).toBe(
            expectedTokens('claude'),
          );
          expect(total.prs, `PRs by ${total.gran}, ${context}`).toBe(expectedPrs);
        }
      }
    });
  }
});

describe('the generator itself', () => {
  it('reaches instants on both sides of local midnight on a DST day, so the property is not vacuous', () => {
    const { events } = generate(1, 'America/Los_Angeles');
    const { start } = utcBounds('2026-11-01', 'America/Los_Angeles');
    expect(events.some((e) => e.at === start - 1)).toBe(true);
    expect(events.some((e) => e.at === start)).toBe(true);
    expect(events.length).toBeGreaterThan(250);
  });
});
