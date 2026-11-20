import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunner } from '../../src/server/collectors/runner.ts';
import { getRun } from '../../src/server/db/queries/sources.ts';
import { runRetention } from '../../src/server/services/retention.ts';
import { recomputeLinks } from '../../src/server/services/links.ts';
import { FIXED_NOW, FIXED_TIMEZONE, seedDatabase } from '../fixtures/seed.ts';
import { fixtureBytes, installHookFiles, rig, runHookScript } from '../claudeCapture/helpers.ts';
import { history, startMachine } from '../integration/import/helpers.ts';
import { memoryDb, memoryLogger, tempDir } from '../server/helpers.ts';
import { get as getMetrics, metricsApp } from '../server/metrics/helpers.ts';
import { get as getUsage, usageApp } from '../server/usage/helpers.ts';
import { techTable } from '../security/techTable.ts';
import { budgetMs, p95, renderTable, type Result } from './table.ts';

// `pnpm bench`: every row of TECH › Performance, measured on the synthetic year (150,000 usage events, 6,000 sessions, 2,000 PRs
// across 6 repos). The budgets are read from TECH.md, so an owner change there changes the limit here. Each row is its own test and
// fails when its number is over; the last test prints the table and lists the rows that have no number and why. A row of TECH
// that is neither timed nor listed fails, so a new budget cannot be added without a measurement or an honest "cannot be timed".
// Each request goes through the HTTP app (routing, queries, JSON), as the browser waits for it.

const TABLE = techTable('Performance (proposed budgets; owner may change)');
const row = (obligation: string) => {
  const found = TABLE.find((r) => r.risk.startsWith(obligation));
  if (!found) throw new Error(`TECH › Performance has no row "${obligation}".`);
  return found;
};
const limit = (obligation: string) => {
  const ms = budgetMs(row(obligation).mechanism);
  if (ms === null) throw new Error(`"${obligation}" sets no time budget in TECH.`);
  return ms;
};

/** Rows with no number, and why. Each is a row of the TECH table; the final test checks the list against it. */
const NOT_TIMED: Record<string, string> = {
  'First full import':
    'TECH sets no time, only "progress per source, UI responsive": timed in a real browser by `pnpm bench:browser` (test/bench/BROWSER-RESULTS.md), and verified by hand on the owner’s data (E1/E2)',
  'UI rendering':
    'a frame time needs a real browser, not a Vitest bench: timed by `pnpm bench:browser` (test/bench/BROWSER-RESULTS.md)',
};

const results = new Map<string, Result>();
const record = (obligation: string, r: Omit<Result, 'obligation' | 'budget' | 'limitMs'>) => {
  const budget = row(obligation).mechanism;
  results.set(obligation, { obligation, budget, limitMs: budgetMs(budget), ...r });
};

const year = (() => {
  const db = memoryDb();
  const counts = seedDatabase(db, { scale: 'year' }).counts;
  return { db, counts };
})();
const count = (table: string) =>
  (year.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('the year world', () => {
  it('has 150,000 events, 6,000 sessions and 2,000 PRs across 6 repos', () => {
    expect(year.counts['events']).toBe(150_000);
    expect(year.counts['sessions']).toBe(6_000);
    expect(count('pull_request')).toBeGreaterThanOrEqual(2_000);
    expect(count('repo')).toBeGreaterThanOrEqual(6);
  });
});

const RANGES = [
  { name: '12 months by month', query: 'start=2025-11-04&end=2026-11-04&gran=month' },
  { name: '12 months by week', query: 'start=2025-11-04&end=2026-11-04&gran=week' },
  { name: '12 months by day', query: 'start=2025-11-04&end=2026-11-04&gran=day' },
  { name: 'last 90 days', query: 'start=2026-08-07&end=2026-11-04' },
  { name: 'this week', query: 'start=2026-11-02&end=2026-11-08' },
];
const FILTERS = ['&author=all', '&provider=codex', '&repos=kelvin/atlas-api&provider=claude'];
const ROUNDS = 3;

describe('budgets on the year world', () => {
  const metrics = metricsApp(year.db);
  const timed = async (path: string) => {
    const started = performance.now();
    const res = await getMetrics(metrics, path);
    const ms = performance.now() - started;
    expect(res.status, path).toBe(200);
    return ms;
  };

  it('Overview interactive after navigation', async () => {
    const samples: number[] = [];
    for (const range of RANGES)
      for (const filter of FILTERS)
        for (let i = 0; i < ROUNDS; i++) {
          const query = `${range.query}${filter}`;
          samples.push(
            (await timed(`/api/overview?${query}`)) + (await timed(`/api/series?${query}`)),
          );
        }
    record('Overview interactive after navigation', {
      ms: p95(samples),
      samples: samples.length,
      stat: 'p95',
    });
    expect(p95(samples)).toBeLessThanOrEqual(limit('Overview interactive after navigation'));
  }, 120_000);

  it('Filter change → updated chart', async () => {
    const samples: number[] = [];
    for (const range of RANGES)
      for (let i = 0; i < ROUNDS; i++)
        for (const filter of FILTERS)
          samples.push(await timed(`/api/series?${range.query}${filter}`));
    record('Filter change', { ms: p95(samples), samples: samples.length, stat: 'p95' });
    expect(p95(samples)).toBeLessThanOrEqual(limit('Filter change'));
  }, 120_000);

  it('Usage tree group expansion', async () => {
    const app = usageApp(year.db);
    const ranges = ['start=2025-11-04&end=2026-11-04', 'start=2026-08-07&end=2026-11-04', ''];
    const groups = (
      (await getUsage(app, '/api/usage/groups?start=2025-11-04&end=2026-11-04')).body as {
        groups: { key: string }[];
      }
    ).groups.map((g) => g.key);
    expect(groups.length).toBeGreaterThanOrEqual(6);
    const samples: number[] = [];
    for (const range of ranges)
      for (let round = 0; round < ROUNDS; round++)
        for (const key of groups) {
          const base = `/api/usage/groups/${encodeURIComponent(key)}/roots?limit=15${range ? `&${range}` : ''}`;
          const started = performance.now();
          const res = await getUsage(app, base);
          samples.push(performance.now() - started);
          expect(res.status, base).toBe(200);
        }
    record('Usage tree group expansion', {
      ms: p95(samples),
      samples: samples.length,
      stat: 'p95',
    });
    expect(p95(samples)).toBeLessThanOrEqual(limit('Usage tree group expansion'));
  }, 120_000);
});

// ---- generated machine for the no-new-data refresh --------------------------------------------------------------------------
// Invented, small files; no real transcript is read. A year of use is more than 2,000 files for each provider.

const PER_PROVIDER = 2_200;
const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
const uuid = (n: number) => `${hex(n, 8)}-aaaa-4aaa-8aaa-${hex(n, 12)}`;
const lines = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function writeHome(home: string): void {
  for (let n = 0; n < PER_PROVIDER; n++) {
    const day = String(1 + (n % 28)).padStart(2, '0');
    const claudeDir = join(home, '.claude/projects', `-bench-project-${n % 40}`);
    mkdirSync(claudeDir, { recursive: true });
    const base = { sessionId: uuid(n), cwd: `/bench/project-${n % 40}`, version: '2.0.0' };
    writeFileSync(
      join(claudeDir, `${uuid(n)}.jsonl`),
      lines([
        {
          ...base,
          type: 'user',
          timestamp: `2026-10-${day}T08:00:00.000Z`,
          message: { role: 'user', content: 'x' },
        },
        ...[1, 2].map((turn) => ({
          ...base,
          type: 'assistant',
          timestamp: `2026-10-${day}T08:00:0${turn}.000Z`,
          requestId: `req_${n}_${turn}`,
          message: {
            id: `msg_${n}_${turn}`,
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 300,
              output_tokens: 40 * turn,
            },
          },
        })),
      ]),
    );
    const id = uuid(n + 1_000_000);
    const stamp = `2026-10-${day}T09:00:00.000Z`;
    const codexDir = join(home, '.codex/sessions/2026/10', day);
    mkdirSync(codexDir, { recursive: true });
    const tokens = (turn: number) => ({
      timestamp: `2026-10-${day}T09:00:0${turn}.000Z`,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000 * turn,
            cached_input_tokens: 600 * turn,
            output_tokens: 100 * turn,
            reasoning_output_tokens: 20 * turn,
            total_tokens: 1100 * turn,
          },
        },
      },
    });
    writeFileSync(
      join(codexDir, `rollout-2026-10-${day}T09-00-00-${id}.jsonl`),
      lines([
        {
          timestamp: stamp,
          type: 'session_meta',
          payload: { id, timestamp: stamp, cwd: `/bench/project-${n % 40}`, source: 'cli' },
        },
        { timestamp: stamp, type: 'turn_context', payload: { model: 'gpt-5-codex' } },
        tokens(1),
        tokens(2),
      ]),
    );
  }
}

describe('the refresh and the hook', () => {
  it('Incremental refresh with no new data', async () => {
    // What a no-new-data refresh does on a machine with a year of history, in its two halves: the scan of 4,400 files (discovery,
    // both adapters' listing and stat, no read) and the retention and link-health check over the year world's database.
    // Both stages run 3 times; the two slowest timings added together must fit.
    const home = tempDir();
    writeHome(home);
    const machine = startMachine({
      home,
      dbPath: join(tempDir(), 'agent-productivity.db'),
      links: true,
    });
    const first = await machine.refresh();
    expect(first.state).toBe('succeeded');
    expect(first.sources['codex']).toMatchObject({ imported: PER_PROVIDER });
    expect(first.sources['claude']).toMatchObject({ imported: PER_PROVIDER });
    const stored = history(machine.db);
    const scans: number[] = [];
    for (let i = 0; i < 3; i++) {
      machine.tick(15 * 60_000);
      const started = performance.now();
      const run = await machine.refresh();
      scans.push(performance.now() - started);
      expect(run.sources['codex']).toMatchObject({ imported: 0 });
      expect(run.sources['claude']).toMatchObject({ imported: 0 });
      expect(run.linkRebuild).toBeNull();
    }
    expect(history(machine.db)).toEqual(stored); // nothing was read, nothing was written
    machine.close();

    const eventsBefore = count('usage_event');
    recomputeLinks(year.db, FIXED_NOW);
    const maintenance = createRunner({
      db: year.db,
      now: () => FIXED_NOW,
      logger: memoryLogger().logger,
      adapters: [],
      afterSources: [
        {
          name: 'retention',
          run: () => void runRetention(year.db, { nowMs: FIXED_NOW, timezone: FIXED_TIMEZONE }),
        },
        { name: 'links', rebuild: (id) => void recomputeLinks(year.db, FIXED_NOW, id) },
      ],
    });
    const afters: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const run = maintenance.start({ trigger: 'manual' });
      if (!run.started) throw new Error('The previous benchmark refresh is still running.');
      await maintenance.idle();
      afters.push(performance.now() - started);
      expect(getRun(year.db, run.run.id)).toMatchObject({ state: 'succeeded', linkRebuild: null });
    }
    expect(count('usage_event'), 'retention left the year world as it was').toBe(eventsBefore);

    const total = Math.max(...scans) + Math.max(...afters);
    console.info(
      `no-new-data refresh: scan of ${2 * PER_PROVIDER} files ${scans.map((s) => Math.round(s)).join('/')} ms; ` +
        `retention + link-health check on the year world ${afters.map((s) => Math.round(s)).join('/')} ms; together ${Math.round(total)} ms`,
    );
    record('Incremental refresh with no new data', {
      ms: total,
      samples: 3,
      stat: 'slowest scan + maintenance',
    });
    expect(total).toBeLessThanOrEqual(limit('Incremental refresh with no new data'));
  }, 120_000);

  it('Claude hook overhead per status-line update', async () => {
    // The hook script as a child process with a real status-line payload, Node start-up included. With no status line of the
    // owner's to chain, the whole wall time is what the hook adds. E8 on the owner's own machine stays the authority.
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    const stdin = fixtureBytes('stdin', 'full.json');
    for (let i = 0; i < 3; i++) await runHookScript(dataDir, stdin); // warm-up: the OS file cache
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const run = await runHookScript(dataDir, stdin);
      expect(run.code).toBe(0);
      samples.push(run.ms);
    }
    record('Claude hook overhead per status-line update', {
      ms: p95(samples),
      samples: samples.length,
      stat: 'p95',
    });
    expect(p95(samples)).toBeLessThanOrEqual(limit('Claude hook overhead per status-line update'));
  }, 120_000);
});

describe('every TECH performance row is timed or listed', () => {
  it('prints the table, and every row has a number or a stated reason', () => {
    for (const [obligation, reason] of Object.entries(NOT_TIMED)) {
      const r = row(obligation);
      results.set(obligation, {
        obligation,
        budget: r.mechanism,
        ms: null,
        limitMs: budgetMs(r.mechanism),
        samples: 0,
        stat: '',
        note: reason,
      });
    }
    const ordered = TABLE.map((r) =>
      [...results.values()].find((x) => r.risk.startsWith(x.obligation)),
    );
    const missing = TABLE.filter((_, i) => ordered[i] === undefined).map((r) => r.risk);
    const table = renderTable(ordered.filter((r): r is Result => r !== undefined));
    const notTimed = Object.entries(NOT_TIMED)
      .map(([k, v]) => `  - ${k}: ${v}`)
      .join('\n');
    const cpu = `${cpus()[0]?.model ?? 'cpu'} x${cpus().length}, ${platform()} ${release()}, Node ${process.version}`;
    const header = `TECH › Performance on the year world (${year.counts['events']} events, ${year.counts['sessions']} sessions, ${count('pull_request')} PRs); ${cpu}`;
    console.info(`\n${header}\n${table}\n\nCannot be timed here:\n${notTimed}\n`);
    if (process.env['BENCH_RECORD']) {
      const day = new Date().toISOString().slice(0, 10);
      writeFileSync(
        join(import.meta.dirname, 'RESULTS.md'),
        `# Budget bench results\n\nRun ${day} with \`BENCH_RECORD=1 pnpm bench\`.\n\n${header}\n\n\`\`\`\n${table}\n\`\`\`\n\nCannot be timed here:\n\n${notTimed}\n`,
      );
    }
    expect(missing, 'TECH rows that are neither timed nor listed').toEqual([]);
    const failed = [...results.values()].filter(
      (r) => r.ms !== null && r.limitMs !== null && r.ms > r.limitMs,
    );
    expect(failed.map((r) => `${r.obligation}: ${r.ms} ms over ${r.limitMs} ms`)).toEqual([]);
  });
});
