import { describe, expect, it } from 'vitest';
import {
  parseAccount,
  parseLoginOffer,
  parseRateLimits,
  parseUsage,
} from '../../../src/server/collectors/chatgpt/parse.ts';
import { parseThreadPage } from '../../../src/server/collectors/codex/names.ts';
import { loadScenario } from './scripted.ts';

// What the app-server's answers become (G9_3, G9_4): only what the dashboard stores, and a malformed item is dropped and counted
// instead of reaching a db writer that would throw.

const resultOf = (file: string, method: string): unknown => {
  const entry = loadScenario(file).methods[method];
  if (entry === undefined || typeof entry === 'string' || !('result' in entry))
    throw new Error(method);
  return entry.result;
};

describe('account/read', () => {
  it('reduces the account to the kind of sign-in and nothing else', () => {
    expect(parseAccount(resultOf('signed-in', 'account/read'))).toBe('chatgpt');
    expect(parseAccount(resultOf('api-key', 'account/read'))).toBe('unsupported');
    expect(parseAccount(resultOf('signed-out', 'account/read'))).toBe('signed_out');
  });

  it('takes any other kind of account as one that reports no usage here', () => {
    expect(parseAccount({ account: { type: 'amazonBedrock' } })).toBe('unsupported');
    expect(parseAccount({ account: { type: 'gcp' } })).toBe('unsupported');
  });

  it('is no answer at all for something that is not an account result', () => {
    for (const value of [null, undefined, 'x', 7, [], { account: 'chatgpt' }]) {
      expect(parseAccount(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('account/usage/read', () => {
  it('reads the lifetime figure and the daily buckets, and drops streaks and the peak day', () => {
    const usage = parseUsage(resultOf('signed-in', 'account/usage/read'));
    expect(usage?.lifetimeTokens).toBe(123456);
    expect(usage?.buckets).toHaveLength(7);
    expect(usage?.buckets?.[0]).toEqual({ date: '2026-11-01', tokens: 100 });
    expect(usage?.unreadable).toBe(0);
    expect(Object.keys(usage ?? {}).sort()).toEqual(['buckets', 'lifetimeTokens', 'unreadable']);
  });

  it('reports null buckets as null, not as an empty list (the percent-only card)', () => {
    const usage = parseUsage(resultOf('buckets-null', 'account/usage/read'));
    expect(usage?.buckets).toBeNull();
    expect(usage?.lifetimeTokens).toBe(123456);
    expect(parseUsage({ summary: null, dailyUsageBuckets: [] })?.buckets).toEqual([]);
    expect(parseUsage({})?.buckets).toBeNull();
    expect(parseUsage({})?.lifetimeTokens).toBeNull();
  });

  it('drops a bucket that is not a date and a whole number of tokens, counts it, and keeps one figure per date', () => {
    const usage = parseUsage(resultOf('buckets-messy', 'account/usage/read'));
    // 2026-11-02 appears twice (the last figure wins), an epoch in seconds is 2026-11-03, and five items are unusable.
    expect(usage?.buckets).toEqual([
      { date: '2026-11-02', tokens: 25 },
      { date: '2026-11-03', tokens: 30 },
    ]);
    expect(usage?.unreadable).toBe(5);
    expect(new Date(1793664000 * 1000).toISOString().slice(0, 10)).toBe('2026-11-03');
  });

  it('counts a lifetime figure that is not a whole number as unreadable and stores none', () => {
    expect(parseUsage({ summary: { lifetimeTokens: -5 }, dailyUsageBuckets: null })).toEqual({
      lifetimeTokens: null,
      buckets: null,
      unreadable: 1,
    });
    expect(
      parseUsage({ summary: { lifetimeTokens: null }, dailyUsageBuckets: null })?.unreadable,
    ).toBe(0);
  });

  it('is no answer for something that is not an object', () => {
    for (const value of [null, 'x', 3, []]) expect(parseUsage(value)).toBeNull();
  });

  it('rejects a malformed bucket list and a nonempty list with no valid buckets', () => {
    expect(parseUsage({ dailyUsageBuckets: 'invalid' })).toBeNull();
    expect(parseUsage({ dailyUsageBuckets: [{ startDate: 'invalid', tokens: 42 }] })).toBeNull();
  });
});

describe('account/rateLimits/read', () => {
  it('keeps each window with its own length and reset time, converting seconds to milliseconds', () => {
    const report = parseRateLimits(resultOf('signed-in', 'account/rateLimits/read'));
    expect(report).toEqual({
      limits: [
        { limitId: 'primary', usedPercent: 23, windowMinutes: 300, resetsAt: 1762432800000 },
        { limitId: 'secondary', usedPercent: 41, windowMinutes: 10080, resetsAt: 1762857600000 },
      ],
      quota: null,
      unreadable: 0,
    });
  });

  it('uses the Codex bucket in the modern map instead of the compatibility snapshot', () => {
    expect(
      parseRateLimits({
        rateLimits: {
          limitId: 'codex_model',
          primary: { usedPercent: 90, windowDurationMins: 10_080 },
        },
        rateLimitsByLimitId: {
          codex: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 10_080 } },
          codex_model: {
            limitId: 'codex_model',
            primary: { usedPercent: 90, windowDurationMins: 10_080 },
          },
        },
      }),
    ).toEqual({
      limits: [{ limitId: 'primary', usedPercent: 0, windowMinutes: 10_080, resetsAt: null }],
      quota: 'codex',
      unreadable: 0,
    });
  });

  it('ignores model-specific quota when the Codex bucket is absent', () => {
    const model = {
      limitId: 'codex_model',
      primary: { usedPercent: 90, windowDurationMins: 10_080 },
    };
    const empty = { limits: [], quota: null, unreadable: 0 };
    expect(parseRateLimits({ rateLimits: model })).toEqual(empty);
    expect(
      parseRateLimits({ rateLimits: model, rateLimitsByLimitId: { codex_model: model } }),
    ).toEqual(empty);
  });

  it('ignores what is not a window (name, plan, credits) and keeps no text from them', () => {
    const report = parseRateLimits(resultOf('signed-in', 'account/rateLimits/read'));
    expect(JSON.stringify(report)).not.toMatch(/SENTINEL|plus|credits/);
  });

  it('drops a window with a negative or non-numeric percentage or an unusable id, counts it, and nulls what it cannot read', () => {
    const report = parseRateLimits(resultOf('buckets-messy', 'account/rateLimits/read'));
    expect(report?.limits).toEqual([
      // already in milliseconds: kept as it is
      { limitId: 'primary', usedPercent: 150, windowMinutes: 300, resetsAt: 1762432800000 },
      { limitId: 'tertiary', usedPercent: 7, windowMinutes: null, resetsAt: null },
    ]);
    expect(report?.unreadable).toBe(2);
  });

  it('is an empty report for no windows, and no answer for something that is not an object', () => {
    const empty = { limits: [], quota: null, unreadable: 0 };
    expect(parseRateLimits({ rateLimits: null })).toEqual(empty);
    expect(parseRateLimits({ rateLimits: {} })).toEqual(empty);
    expect(parseRateLimits({ rateLimits: 'x' })).toBeNull();
    expect(parseRateLimits(null)).toBeNull();
  });

  it('rejects recognized windows when none has a usable percentage', () => {
    expect(parseRateLimits({ rateLimits: { primary: {} } })).toBeNull();
    expect(parseRateLimits({ rateLimits: { secondary: { usedPercent: '42' } } })).toBeNull();
    expect(parseRateLimits({ rateLimits: { primary: null, secondary: null } })).toEqual({
      limits: [],
      quota: null,
      unreadable: 0,
    });
  });
});

describe('account/login/start', () => {
  it('takes an https sign-in address and the login id', () => {
    const offer = parseLoginOffer(resultOf('login-ok', 'account/login/start'));
    expect(offer?.authUrl).toMatch(/^https:\/\/auth\.example\.test\//);
    expect(offer?.loginId).toBeTruthy();
  });

  it('refuses any address a browser must not be sent to', () => {
    for (const authUrl of [
      'http://auth.example.test/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>',
      'not a url',
      '',
      null,
      42,
    ]) {
      expect(parseLoginOffer({ loginId: 'a', authUrl }), String(authUrl)).toBeNull();
    }
    expect(parseLoginOffer({ loginId: '', authUrl: 'https://auth.example.test/' })).toBeNull();
    expect(parseLoginOffer({ authUrl: 'https://auth.example.test/' })).toBeNull();
  });
});

describe('thread/list', () => {
  it('keeps a thread id and name only: the preview is never read', () => {
    const first = loadScenario('chatgpt-with-threads').methods['thread/list'];
    if (first === undefined || typeof first === 'string' || !('sequence' in first))
      throw new Error('sequence');
    const entry = first.sequence[0];
    if (entry === undefined || typeof entry === 'string' || !('result' in entry))
      throw new Error('result');
    const parsed = parseThreadPage(entry.result);
    expect(parsed?.threads).toEqual([
      { threadId: 'codex-thread-aaa', name: 'Fix the login redirect' },
      { threadId: 'codex-thread-unknown', name: 'A thread this machine has no session for' },
    ]);
    expect(parsed?.nextCursor).toBe('page-2');
    expect(JSON.stringify(parsed)).not.toContain('SENTINEL');
  });

  it('is no answer for something that is not a page', () => {
    for (const value of [null, {}, { data: 'x' }, []]) expect(parseThreadPage(value)).toBeNull();
  });
});
