import { describe, expect, it } from 'vitest';
import {
  appSessions,
  compareProvider,
  notRun,
  parseClaudeReport,
  parseCodexReport,
  providerFails,
  providerPasses,
  renderReport,
  sessionRows,
} from '../../scripts/lib/reconcile.ts';
import type { SessionFigures } from '../../src/server/db/queries/ingest.ts';

// The comparison behind scripts/reconcile-usage.ts (M5, G5_3): the app's stored sessions against ccusage's report, category by
// category. Everything here is INVENTED; the shapes are the ones the fixture oracles have (ccusage 20.0.48 over invented data).

const U1 = '11111111-aaaa-4aaa-8aaa-000000000001';
const U2 = '22222222-bbbb-4bbb-8bbb-000000000002';
const U3 = '33333333-cccc-4ccc-8ccc-000000000003';

const stored = (over: Partial<SessionFigures> & { providerSessionId: string }): SessionFigures => ({
  kind: 'root',
  parentProviderSessionId: null,
  startedAt: 1_000_000,
  startedBasis: 'source_start',
  firstEventAt: 1_005_000,
  events: 2,
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  reasoning: 0,
  total: 0,
  ...over,
});

describe('reading a ccusage report', () => {
  it('finds the session list under any of the shapes ccusage has, and says so when there is none', () => {
    const rows = [{ sessionId: U1 }];
    expect(sessionRows(rows)).toEqual(rows);
    expect(sessionRows({ sessions: rows })).toEqual(rows);
    expect(sessionRows({ session: rows })).toEqual(rows);
    expect(sessionRows({ data: rows })).toEqual(rows);
    expect(sessionRows({ totals: {} })).toBeNull();
    expect(sessionRows('nope')).toBeNull();
    expect(parseClaudeReport({ totals: {} })).toBeNull();
  });

  it('reads a Claude Code session by its id and its four categories and total', () => {
    expect(
      parseClaudeReport({
        sessions: [
          {
            sessionId: U1,
            projectPath: '-some-project',
            inputTokens: 1,
            cacheCreationTokens: 2,
            cacheReadTokens: 3,
            outputTokens: 4,
            totalTokens: 10,
          },
        ],
      }),
    ).toEqual([
      { key: U1, figures: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, total: 10 } },
    ]);
  });

  it('reads a Codex session by the thread id at the end of its rollout name, whether it is in a path or not', () => {
    const parsed = parseCodexReport([
      {
        sessionFile: `rollout-2026-10-12T09-00-00-${U2}`,
        sessionId: `2026/10/12/rollout-2026-10-12T09-00-00-${U2}`,
        inputTokens: 600,
        cacheReadTokens: 1900,
        outputTokens: 400,
        reasoningOutputTokens: 90,
        totalTokens: 2900,
      },
      { sessionId: `2026/10/13/rollout-x-${U3.toUpperCase()}`, totalTokens: 5 },
    ]);
    expect(parsed?.map((s) => s.key)).toEqual([U2, U3]);
    expect(parsed?.[0]?.figures).toEqual({
      input: 600,
      cacheWrite: 0,
      cacheRead: 1900,
      output: 400,
      reasoning: 90,
      total: 2900,
    });
  });
});

describe('the app side', () => {
  it("folds a Claude Code session's subagents into it by location, as ccusage does", () => {
    const sessions = appSessions('claude', [
      stored({
        providerSessionId: U1,
        input: 10,
        cacheWrite: 20,
        cacheRead: 30,
        output: 40,
        total: 100,
      }),
      stored({
        providerSessionId: `${U1}:agent-a`,
        kind: 'child',
        parentProviderSessionId: U1,
        input: 1,
        cacheWrite: 2,
        cacheRead: 3,
        output: 4,
        total: 10,
      }),
      // A subagent whose parent has no transcript still belongs to that session's id.
      stored({ providerSessionId: `${U2}:agent-b`, kind: 'child', input: 5, total: 5 }),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.key === U1)).toMatchObject({
      members: 2,
      spawned: true,
      figures: { input: 11, cacheWrite: 22, cacheRead: 33, output: 44, total: 110 },
    });
    expect(sessions.find((s) => s.key === U2)).toMatchObject({ members: 1 });
  });

  it('takes the cache-write part out of a Codex session’s input too, and compares it as its own category', () => {
    const [session] = appSessions('codex', [
      stored({
        providerSessionId: U1,
        input: 2500,
        cachedInput: 1900,
        cacheWrite: 100,
        output: 400,
        reasoning: 90,
        total: 2900,
      }),
    ]);
    expect(session?.figures).toEqual({
      input: 500,
      cacheWrite: 100,
      cacheRead: 1900,
      output: 400,
      reasoning: 90,
      total: 2900,
    });
  });

  it("takes the cached part out of a Codex session's input, because ccusage reports input without it", () => {
    const [session] = appSessions('codex', [
      stored({
        providerSessionId: U1,
        input: 2500,
        cachedInput: 1900,
        output: 400,
        reasoning: 90,
        total: 2900,
      }),
    ]);
    expect(session?.figures).toEqual({
      input: 600,
      cacheWrite: 0,
      cacheRead: 1900,
      output: 400,
      reasoning: 90,
      total: 2900,
    });
  });
});

describe('choosing and comparing three sessions', () => {
  const claudeApp = appSessions('claude', [
    stored({ providerSessionId: U1, input: 1, output: 9, total: 10 }),
    stored({ providerSessionId: `${U1}:agent-a`, kind: 'child', input: 0, output: 1, total: 1 }),
    stored({ providerSessionId: U2, input: 3, output: 6, total: 500 }),
    stored({ providerSessionId: U3, input: 1, output: 1, total: 2 }),
    stored({ providerSessionId: '44444444-dddd-4ddd-8ddd-000000000004', total: 50 }),
  ]);
  const oracleOf = (overrides: Record<string, Record<string, number>> = {}) =>
    claudeApp.map((s) => ({ key: s.key, figures: { ...s.figures, ...(overrides[s.key] ?? {}) } }));

  it('takes the largest, one with subagents, and the next largest, and says why', () => {
    const report = compareProvider('claude', claudeApp, oracleOf());
    expect(report.compared.map((c) => [c.label, c.why])).toEqual([
      ['22222222', 'largest'],
      ['11111111', 'with subagents'],
      ['44444444', 'next largest'],
    ]);
    expect(providerPasses(report)).toBe(true);
    expect(providerFails(report)).toBe(false);
    expect(report).toMatchObject({ appSessions: 4, oracleSessions: 4, matched: 4, differing: 0 });
  });

  it('finds a one-token difference in any category, and names the category in the difference', () => {
    const report = compareProvider(
      'claude',
      claudeApp,
      oracleOf({ [U2]: { cacheRead: 1, total: 501 } }),
    );
    expect(providerFails(report)).toBe(true);
    expect(providerPasses(report)).toBe(false);
    const c = report.compared.find((x) => x.label === '22222222')!;
    expect(c.difference).toMatchObject({
      cacheRead: -1,
      total: -1,
      input: 0,
      output: 0,
      cacheWrite: 0,
    });
    expect(report.differing).toBe(1);
    expect(report.worst).toEqual([{ label: '22222222', total: -1 }]);
  });

  it('compares only what both sides list and counts the rest, never forcing a match', () => {
    const oracle = oracleOf().filter((s) => s.key !== U3);
    oracle.push({ key: '99999999-eeee-4eee-8eee-000000000009', figures: { total: 7 } });
    const report = compareProvider('claude', claudeApp, oracle);
    expect(report).toMatchObject({ matched: 3, onlyInApp: 1, onlyInOracle: 1 });
    expect(report.compared.map((c) => c.label)).not.toContain('33333333');
  });

  it('says how many it could compare when there are fewer than three, and counts no pass for none', () => {
    const one = compareProvider('claude', claudeApp, oracleOf().slice(0, 1));
    expect(one.compared).toHaveLength(1);
    expect(renderReport([one])).toContain('Only 1 session could be compared; the goal names 3.');
    const none = compareProvider('claude', claudeApp, []);
    expect(providerPasses(none)).toBe(false);
    expect(providerFails(none)).toBe(false);
    expect(renderReport([none])).toContain('RESULT: nothing was compared.');
  });

  it('prefers a spawned Codex thread, the part with a replayed prefix, as its second session', () => {
    const app = appSessions('codex', [
      stored({ providerSessionId: U1, input: 100, cachedInput: 10, output: 50, total: 150 }),
      stored({
        providerSessionId: U2,
        kind: 'child',
        parentProviderSessionId: U1,
        input: 40,
        output: 10,
        total: 50,
      }),
      stored({ providerSessionId: U3, input: 20, output: 5, total: 25 }),
    ]);
    const oracle = app.map((s) => ({ key: s.key, figures: s.figures }));
    const report = compareProvider('codex', app, oracle);
    expect(report.compared.map((c) => [c.label, c.why])).toEqual([
      ['11111111', 'largest'],
      ['22222222', 'spawned thread or its parent'],
      ['33333333', 'next largest'],
    ]);
  });

  it('gives the gap between a stored start and the first usage, and the basis the start has', () => {
    const app = appSessions('claude', [
      stored({ providerSessionId: U1, total: 5, startedAt: 10_000, firstEventAt: 18_000 }),
      stored({
        providerSessionId: U2,
        total: 4,
        startedAt: 10_000,
        firstEventAt: 10_000,
        startedBasis: 'first_event',
      }),
      stored({ providerSessionId: U3, total: 3, firstEventAt: null }),
    ]);
    const report = compareProvider(
      'claude',
      app,
      app.map((s) => ({ key: s.key, figures: s.figures })),
    );
    expect(report.compared.map((c) => [c.startGapSeconds, c.startedBasis])).toEqual([
      [8, 'source_start'],
      [0, 'first_event'],
      [null, 'source_start'],
    ]);
  });
});

describe('the report', () => {
  it('is metadata only: counts, token numbers and eight-character id prefixes, no path and no text', () => {
    const app = appSessions('claude', [
      stored({ providerSessionId: U1, input: 1, total: 1, firstEventAt: 1_002_000 }),
    ]);
    const text = renderReport([
      compareProvider('claude', app, [{ key: U1, figures: { input: 1, total: 1 } }]),
      notRun('codex', 'ccusage is not installed here (no program named that on PATH).'),
    ]);
    expect(text).toContain('11111111');
    expect(text).not.toContain(U1); // the whole id is not needed
    expect(text).not.toMatch(/\/|SENTINEL|\.jsonl/);
    expect(text).toContain('Codex: NOT RUN.');
    expect(text).toContain('RESULT: 0-token difference on all 1 compared sessions.');
  });

  it('says DIFFERENCE, not pass, when a token is off', () => {
    const app = appSessions('claude', [stored({ providerSessionId: U1, input: 2, total: 2 })]);
    const text = renderReport([
      compareProvider('claude', app, [{ key: U1, figures: { input: 1, total: 1 } }]),
    ]);
    expect(text).toContain('RESULT: DIFFERENCE.');
    expect(text).toContain('input +1');
  });
});
