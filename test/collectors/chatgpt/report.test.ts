import { describe, expect, it } from 'vitest';
import { AccountReport } from '../../../src/shared/contracts/accounts.ts';
import { AccountStatus } from '../../../src/shared/contracts/sources.ts';
import { recordObserved } from '../../../src/server/collectors/chatgpt/observed.ts';
import {
  markChatgptConnected,
  markChatgptDisconnected,
  replaceDailyTokens,
  replaceRateLimits,
} from '../../../src/server/db/queries/accounts.ts';
import {
  ACCOUNT_SCOPE_LABEL,
  buildChatgptReport,
  chatgptStatus,
  windowLabel,
} from '../../../src/server/services/accounts.ts';
import { TZ } from '../../server/helpers.ts';
import { NOW, codexSession, localEvent, world } from './helpers.ts';
import { loadScenario, withMethods } from './scripted.ts';

// G9_3 and G9_4 at the report: the account's figure for exactly the selected dates, its own window, this machine's tokens beside it
// and never added, and the percent-only card with no period figure. Buckets are 1 to 7 November 2026 (100 ... 700 tokens) and a
// day is a bucket the app-server named: a day with no bucket is not zero.

const at = (iso: string) => Date.parse(iso);
const LA = (day: string, hour = 12) => at(`${day}T${String(hour + 8).padStart(2, '0')}:00:00Z`);

/** A world that has read the signed-in account once (buckets 1 to 7 Nov, two windows), with the clock on 8 Nov. */
async function read(scenario = 'chatgpt-with-threads') {
  const w = world(loadScenario(scenario));
  await w.refresh();
  return w;
}

const opts = (start: string, end: string, now = at('2026-11-08T20:00:00Z')) => ({
  start,
  end,
  timezone: TZ,
  now,
});

describe('the token report (daily buckets stored)', () => {
  it('sums the buckets inside exactly the selected dates and names the dates it covers', async () => {
    const w = await read();
    const report = buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05'));
    expect(report).toMatchObject({
      account: 'chatgpt',
      unit: 'tokens',
      periodTokens: 1200,
      bucketSpan: { start: '2026-11-03', end: '2026-11-05' },
      windowDiffers: false,
      scopeLabel: ACCOUNT_SCOPE_LABEL,
      refreshedAt: new Date(NOW).toISOString(),
      stale: false,
    });
    expect(report).not.toHaveProperty('rateLimits');
  });

  it('uses the oldest included fetch for a sum of revised and retained buckets', async () => {
    const w = await read();
    const later = NOW + 1000;
    replaceDailyTokens(w.db, 'chatgpt', [{ date: '2026-11-04', tokens: 450 }], later);
    expect(buildChatgptReport(w.db, opts('2026-11-03', '2026-11-04'))).toMatchObject({
      periodTokens: 750,
      refreshedAt: new Date(NOW).toISOString(),
      stale: false,
    });
    expect(buildChatgptReport(w.db, opts('2026-11-04', '2026-11-04'))?.refreshedAt).toBe(
      new Date(later).toISOString(),
    );
  });

  it('keeps old token data stale when the next read only updates usage limits', async () => {
    const w = await read();
    const next = world(
      withMethods(loadScenario('chatgpt-with-threads'), { 'account/usage/read': 'silent' }),
      { db: w.db },
    );
    next.clock.now = NOW + 1000;
    expect((await next.refresh()).result).toBe('partial');
    expect(buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05'))).toMatchObject({
      periodTokens: 1200,
      refreshedAt: new Date(NOW).toISOString(),
      stale: true,
    });
  });

  it('keeps the saved token total when an account read gives a malformed bucket list', async () => {
    const w = await read();
    const next = world(
      withMethods(loadScenario('chatgpt-with-threads'), {
        'account/usage/read': {
          result: { summary: { lifetimeTokens: 99 }, dailyUsageBuckets: {} },
        },
      }),
      { db: w.db },
    );
    next.clock.now = NOW + 1000;
    expect((await next.refresh()).result).toBe('partial');
    expect(buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05'))).toMatchObject({
      unit: 'tokens',
      periodTokens: 1200,
      refreshedAt: new Date(NOW).toISOString(),
      stale: true,
    });
  });

  it('shows this machine’s Codex tokens over the same dates beside the account figure and never adds them (P-36)', async () => {
    const w = await read();
    const session = codexSession(w.db, 'local-1');
    // 60 tokens recorded on this machine on 1 November (report timezone); 500 on a day outside the window.
    localEvent(w.db, session, LA('2026-11-01', 9), 60);
    localEvent(w.db, session, LA('2026-11-06', 9), 500);
    const report = buildChatgptReport(w.db, opts('2026-11-01', '2026-11-01'));
    expect(report?.periodTokens).toBe(100);
    expect(report?.localSameWindow).toBe(60);
    expect(JSON.stringify(report)).not.toContain('160');
    // The local figure follows the covered dates, in the report timezone: 6 Nov is outside 1 to 5 Nov, 1 Nov inside.
    expect(buildChatgptReport(w.db, opts('2026-11-01', '2026-11-05'))?.localSameWindow).toBe(60);
    expect(buildChatgptReport(w.db, opts('2026-11-06', '2026-11-06'))?.localSameWindow).toBe(500);
  });

  it('counts the local day by the report timezone, not UTC', async () => {
    const w = await read();
    const session = codexSession(w.db, 'local-2');
    // 02:00 UTC on 2 Nov is the evening of 1 Nov in Los Angeles.
    localEvent(w.db, session, at('2026-11-02T02:00:00Z'), 70);
    expect(buildChatgptReport(w.db, opts('2026-11-01', '2026-11-01'))?.localSameWindow).toBe(70);
    expect(buildChatgptReport(w.db, opts('2026-11-02', '2026-11-02'))?.localSameWindow).toBe(0);
  });

  it('a selection that runs past the last bucket covers the days that have one, and says the window differs', async () => {
    const w = await read();
    // Today is 8 Nov: 8 Nov has no bucket, so it is not counted as zero and the covered dates end on 7 Nov.
    const report = buildChatgptReport(w.db, opts('2026-11-01', '2026-11-08'));
    expect(report).toMatchObject({
      periodTokens: 2800,
      bucketSpan: { start: '2026-11-01', end: '2026-11-07' },
      windowDiffers: true,
    });
  });

  it('a selection that starts before the first bucket covers the days that have one, and says the window differs', async () => {
    const w = await read();
    const report = buildChatgptReport(w.db, opts('2026-10-25', '2026-11-07'));
    expect(report).toMatchObject({
      periodTokens: 2800,
      bucketSpan: { start: '2026-11-01', end: '2026-11-07' },
      windowDiffers: true,
    });
  });

  it('days that have not happened are not part of the selection, so a week that is still going matches its buckets', async () => {
    const w = await read();
    // This week as the Overview selects it runs to Sunday 8 Nov; "now" is Wednesday 4 Nov and the stored buckets run on to 7 Nov
    // (the fixture is invented, so it has days ahead of the clock): only up to today counts.
    const report = buildChatgptReport(
      w.db,
      opts('2026-11-02', '2026-11-08', at('2026-11-04T20:00:00Z')),
    );
    expect(report).toMatchObject({
      periodTokens: 200 + 300 + 400,
      bucketSpan: { start: '2026-11-02', end: '2026-11-04' },
      windowDiffers: false,
    });
  });

  it('buckets that exist but fall outside the selected dates are not reported as zero', async () => {
    const w = await read();
    const report = buildChatgptReport(w.db, opts('2026-09-01', '2026-09-30'));
    expect(report).toMatchObject({
      unit: 'tokens',
      periodTokens: null,
      bucketSpan: null,
      localSameWindow: null,
      windowDiffers: true,
    });
    // A selection that is wholly in the future has nothing either.
    expect(buildChatgptReport(w.db, opts('2026-12-01', '2026-12-31'))?.periodTokens).toBeNull();
  });

  it('a day with no bucket inside the span is not zero and does not narrow the covered dates', async () => {
    const w = await read();
    replaceDailyTokens(w.db, 'chatgpt', null, NOW);
    replaceDailyTokens(
      w.db,
      'chatgpt',
      [
        { date: '2026-11-01', tokens: 10 },
        { date: '2026-11-03', tokens: 30 },
      ],
      NOW,
    );
    const report = buildChatgptReport(w.db, opts('2026-11-01', '2026-11-03'));
    expect(report).toMatchObject({
      periodTokens: 40,
      bucketSpan: { start: '2026-11-01', end: '2026-11-03' },
      windowDiffers: false,
    });
  });

  it('takes the app’s clock as a function as well as an instant', async () => {
    const w = await read();
    const instant = buildChatgptReport(w.db, opts('2026-11-01', '2026-11-08'));
    const clock = buildChatgptReport(w.db, {
      ...opts('2026-11-01', '2026-11-08'),
      now: () => at('2026-11-08T20:00:00Z'),
    });
    expect(clock).toEqual(instant);
  });

  it('matches the contract’s AccountReport', async () => {
    const w = await read();
    for (const range of [
      opts('2026-11-03', '2026-11-05'),
      opts('2026-09-01', '2026-09-30'),
      opts('2026-10-25', '2026-11-07'),
    ]) {
      expect(() => AccountReport.parse(buildChatgptReport(w.db, range))).not.toThrow();
    }
  });
});

describe('the percent-only report (no daily buckets)', () => {
  it('carries each window with its own length and reset time and no period figure at all (P-34)', async () => {
    const w = await read('buckets-null');
    const report = buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05'));
    expect(report).toEqual({
      account: 'chatgpt',
      unit: 'percent',
      rateLimits: [
        {
          limitId: 'primary',
          label: '5-hour',
          usedPercent: 23,
          windowMinutes: 300,
          resetsAt: new Date(1762432800000).toISOString(),
        },
        {
          limitId: 'secondary',
          label: 'Weekly',
          usedPercent: 41,
          windowMinutes: 10080,
          resetsAt: new Date(1762857600000).toISOString(),
        },
      ],
      scopeLabel: ACCOUNT_SCOPE_LABEL,
      refreshedAt: new Date(NOW).toISOString(),
      stale: false,
    });
    for (const key of ['periodTokens', 'bucketSpan', 'localSameWindow', 'windowDiffers']) {
      expect(report, key).not.toHaveProperty(key);
    }
    expect(() => AccountReport.parse(report)).not.toThrow();
  });

  it('is the same report whatever dates are selected: a percentage has no period', async () => {
    const w = await read('buckets-null');
    expect(buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05'))).toEqual(
      buildChatgptReport(w.db, opts('2025-01-01', '2025-12-31')),
    );
  });

  it('a later read that reports no buckets turns a token report into the percent report', async () => {
    const w = await read();
    expect(buildChatgptReport(w.db, opts('2026-11-01', '2026-11-07'))?.unit).toBe('tokens');
    const next = world(loadScenario('buckets-null'), { db: w.db });
    next.clock.now = NOW + 1000;
    await next.refresh();
    expect(buildChatgptReport(w.db, opts('2026-11-01', '2026-11-07'))?.unit).toBe('percent');
  });

  it('keeps old percent data stale when the next read only updates token usage', async () => {
    const w = await read('buckets-null');
    const next = world(
      withMethods(loadScenario('buckets-null'), { 'account/rateLimits/read': 'silent' }),
      { db: w.db },
    );
    next.clock.now = NOW + 1000;
    expect((await next.refresh()).result).toBe('partial');
    expect(buildChatgptReport(w.db, opts('2026-11-01', '2026-11-07'))).toMatchObject({
      unit: 'percent',
      rateLimits: [
        expect.objectContaining({ usedPercent: 23 }),
        expect.objectContaining({ usedPercent: 41 }),
      ],
      refreshedAt: new Date(NOW).toISOString(),
      stale: true,
    });
  });

  it('keeps stale percent windows after an entirely invalid response and accepts a later valid empty response', async () => {
    const w = await read('buckets-null');
    const scenario = loadScenario('buckets-null');
    const range = opts('2026-11-01', '2026-11-07');
    const next = world(
      withMethods(scenario, {
        'account/rateLimits/read': { result: { rateLimits: { primary: { usedPercent: '42' } } } },
      }),
      { db: w.db },
    );
    next.clock.now = NOW + 1000;
    await next.refresh();
    expect(buildChatgptReport(w.db, range)).toMatchObject({
      rateLimits: [
        expect.objectContaining({ usedPercent: 23 }),
        expect.objectContaining({ usedPercent: 41 }),
      ],
      refreshedAt: new Date(NOW).toISOString(),
      stale: true,
    });

    const cleared = world(
      withMethods(scenario, { 'account/rateLimits/read': { result: { rateLimits: null } } }),
      { db: w.db },
    );
    cleared.clock.now = NOW + 2000;
    await cleared.refresh();
    expect(buildChatgptReport(w.db, range)).toMatchObject({
      rateLimits: [],
      refreshedAt: new Date(cleared.clock.now).toISOString(),
      stale: false,
    });
  });

  it('keeps a window’s own unit when it reports no length or reset', async () => {
    const w = world(loadScenario('signed-in'));
    replaceRateLimits(
      w.db,
      'chatgpt',
      [{ limitId: 'odd', usedPercent: 12.5, windowMinutes: null, resetsAt: null }],
      NOW,
    );
    recordObserved(w.db, 'ok', NOW);
    expect(buildChatgptReport(w.db, opts('2026-11-01', '2026-11-07'))?.rateLimits).toEqual([
      { limitId: 'odd', label: null, usedPercent: 12.5, windowMinutes: null, resetsAt: null },
    ]);
  });
});

describe('when there is no report', () => {
  it('is null before anything has been read', () => {
    const w = world(null);
    expect(buildChatgptReport(w.db, opts('2026-11-01', '2026-11-07'))).toBeNull();
  });

  it('is null after Disconnect, and the imported report returns when ChatGPT is connected again', async () => {
    const w = await read();
    markChatgptDisconnected(w.db);
    expect(buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05'))).toBeNull();
    markChatgptConnected(w.db, NOW + 5);
    expect(buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05'))?.periodTokens).toBe(1200);
  });

  it('is null while Codex has no ChatGPT sign-in, no usage report or no program, and keeps what was imported', async () => {
    const w = await read();
    for (const state of ['signed_out', 'unsupported', 'no_codex'] as const) {
      recordObserved(w.db, state, NOW + 10);
      expect(buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05')), state).toBeNull();
    }
    recordObserved(w.db, 'ok', NOW + 20);
    expect(buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05'))?.periodTokens).toBe(1200);
  });

  it('is the last report, marked stale, while the last read failed or Codex asks for a sign-in', async () => {
    const w = await read();
    for (const state of ['failed', 'reconnect'] as const) {
      recordObserved(w.db, state, NOW + 10);
      expect(buildChatgptReport(w.db, opts('2026-11-03', '2026-11-05')), state).toMatchObject({
        periodTokens: 1200,
        stale: true,
        refreshedAt: new Date(NOW).toISOString(),
      });
    }
  });
});

describe('windowLabel', () => {
  it('words a window by its own length', () => {
    expect(windowLabel(300)).toBe('5-hour');
    expect(windowLabel(60)).toBe('1-hour');
    expect(windowLabel(10080)).toBe('Weekly');
    expect(windowLabel(20160)).toBe('2-week');
    expect(windowLabel(1440)).toBe('1-day');
    expect(windowLabel(4320)).toBe('3-day');
    expect(windowLabel(90)).toBe('90-minute');
    expect(windowLabel(null)).toBeNull();
  });
});

describe('the ChatGPT card', () => {
  const card = (db: ReturnType<typeof world>['db'], extra: { connecting?: boolean } = {}) =>
    chatgptStatus(db, { now: NOW, timezone: TZ, ...extra });

  it('says Not connected until a read has found a sign-in or Connect has finished', () => {
    const w = world(null);
    expect(card(w.db)).toEqual({
      id: 'chatgpt',
      name: 'ChatGPT',
      status: 'notconnected',
      statusText: 'Not connected',
      via: null,
    });
  });

  it('says existing for a sign-in that was there before the dashboard and connected after Connect finished here', async () => {
    const w = await read();
    expect(card(w.db)).toMatchObject({
      status: 'existing',
      statusText: 'Using your existing Codex sign-in',
      via: 'codex',
    });
    markChatgptConnected(w.db, NOW + 1);
    expect(card(w.db)).toMatchObject({
      status: 'connected',
      statusText: 'Connected through Codex',
      via: 'codex',
    });
  });

  it('says Connected as soon as Connect finishes, before the first read', () => {
    const w = world(null);
    markChatgptConnected(w.db, NOW);
    expect(card(w.db)).toMatchObject({ status: 'connected' });
  });

  it('says Not connected after Disconnect whatever was read before, and Waiting while a sign-in runs', async () => {
    const w = await read();
    markChatgptDisconnected(w.db);
    expect(card(w.db)).toMatchObject({ status: 'notconnected', reason: 'disconnected', via: null });
    expect(card(w.db, { connecting: true })).toMatchObject({
      status: 'connecting',
      statusText: 'Waiting for sign-in…',
      via: 'codex',
    });
  });

  it('words a failed read with the time of the last good one, in the report timezone, and without one when there is none', async () => {
    const w = await read();
    recordObserved(w.db, 'failed', NOW + 1);
    expect(card(w.db).statusText).toBe('Couldn’t update; last report Nov 4, 12:00 PM');
    const none = world(null);
    recordObserved(none.db, 'failed', NOW);
    expect(card(none.db).statusText).toBe('Couldn’t read your ChatGPT usage');
  });

  it('every card matches the contract’s AccountStatus', async () => {
    const w = await read();
    for (const state of [
      'ok',
      'signed_out',
      'unsupported',
      'no_codex',
      'reconnect',
      'failed',
    ] as const) {
      recordObserved(w.db, state, NOW);
      expect(() => AccountStatus.parse(card(w.db)), state).not.toThrow();
    }
    expect(() => AccountStatus.parse(card(w.db, { connecting: true }))).not.toThrow();
  });

  it('never carries an e-mail address, plan or account id', async () => {
    const w = await read();
    for (const state of ['ok', 'failed', 'reconnect'] as const) {
      recordObserved(w.db, state, NOW);
      expect(JSON.stringify(card(w.db))).not.toMatch(/@|plus|SENTINEL/);
    }
  });
});
