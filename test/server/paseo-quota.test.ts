import { describe, expect, it, vi } from 'vitest';
import type { ClaudeAccounts } from '../../src/server/services/claude-account.ts';
import { createPaseoQuotaService } from '../../src/server/services/paseo-quota.ts';
import type { AccountReport } from '../../src/shared/contracts/accounts.ts';
import { HOST, WRITE, call, testApp } from './helpers.ts';

const FETCHED = '2026-11-20T20:00:00.000Z';
const RESET = '2026-11-23T20:00:00.000Z';
const NOW = Date.parse(FETCHED);

const window = (id: string, label: string, usedPct: number) => ({
  id,
  label,
  usedPct,
  resetsAt: RESET,
});

const provider = (providerId: 'codex' | 'claude', windows: unknown[]) => ({
  providerId,
  status: 'available',
  fetchedAt: FETCHED,
  windows,
});

const report = (providers: unknown[]) => ({ fetchedAt: FETCHED, providers });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const directClaude: AccountReport = {
  account: 'claude',
  provenance: 'claude_code_oauth',
  unit: 'percent',
  scopeLabel: 'Claude subscription plan limits',
  refreshedAt: FETCHED,
  rateLimits: [
    { limitId: 'five_hour', usedPercent: 15, windowMinutes: 300 },
    { limitId: 'seven_day', usedPercent: 23.4, windowMinutes: 10080, resetsAt: RESET },
    { limitId: 'seven_day_opus', label: 'Weekly Opus', usedPercent: 66, windowMinutes: 10080 },
  ],
};

function setup(host: unknown = report([])) {
  let now = NOW;
  const listUsage = vi.fn<() => Promise<unknown>>().mockResolvedValue(host);
  const checkCodex = vi.fn<() => Promise<AccountReport | null>>().mockResolvedValue(null);
  const checkClaude = vi.fn<() => Promise<AccountReport | null>>().mockResolvedValue(directClaude);
  return {
    listUsage,
    checkCodex,
    checkClaude,
    clock: (value: number) => {
      now = value;
    },
    quota: createPaseoQuotaService({ listUsage, checkCodex, checkClaude, now: () => now }),
  };
}

describe('Paseo weekly quotas', () => {
  it('uses only explicit general weekly limits, preserving each scoped weekly limit and its freshness', async () => {
    const { quota, listUsage, checkCodex, checkClaude } = setup(
      report([
        provider('codex', [
          window('unknown_secondary', 'Weekly', 33),
          window('weekly', 'Weekly', 0),
          window('limit:gpt-x:weekly', 'GPT X · Weekly', 47.5),
          window('code_review:weekly', 'Code review · Weekly', 55),
        ]),
        provider('claude', [
          window('five_hour', 'Session', 60),
          window('weekly_model_fable', 'Weekly · Fable', 65),
          window('weekly_surface_desktop', 'Weekly · Desktop', 13),
        ]),
      ]),
    );
    const first = quota.read();
    expect(await quota.read()).toEqual(await first);
    expect(listUsage).toHaveBeenCalledTimes(1);
    expect((await first).providers).toEqual([
      {
        provider: 'codex',
        source: 'paseo',
        usedPercent: 0,
        refreshedAt: FETCHED,
        resetsAt: RESET,
        stale: false,
        canCheck: false,
        windows: [
          {
            id: 'limit:gpt-x:weekly',
            label: 'GPT X · Weekly',
            usedPercent: 47.5,
            resetsAt: RESET,
            source: 'paseo',
            refreshedAt: FETCHED,
            stale: false,
          },
          {
            id: 'code_review:weekly',
            label: 'Code review · Weekly',
            usedPercent: 55,
            resetsAt: RESET,
            source: 'paseo',
            refreshedAt: FETCHED,
            stale: false,
          },
        ],
      },
      {
        provider: 'claude',
        source: null,
        usedPercent: null,
        refreshedAt: null,
        resetsAt: null,
        stale: false,
        canCheck: true,
        windows: [
          {
            id: 'weekly_model_fable',
            label: 'Weekly · Fable',
            usedPercent: 65,
            resetsAt: RESET,
            source: 'paseo',
            refreshedAt: FETCHED,
            stale: false,
          },
          {
            id: 'weekly_surface_desktop',
            label: 'Weekly · Desktop',
            usedPercent: 13,
            resetsAt: RESET,
            source: 'paseo',
            refreshedAt: FETCHED,
            stale: false,
          },
        ],
      },
    ]);
    expect(checkCodex).not.toHaveBeenCalled();
    expect(checkClaude).not.toHaveBeenCalled();
  });

  it('checks the requested provider once, re-reading Paseo before any authorized fallback', async () => {
    const { quota, listUsage, checkCodex, checkClaude } = setup();
    await quota.read();
    listUsage.mockResolvedValueOnce(report([provider('claude', [window('weekly', 'Weekly', 50)])]));
    expect((await quota.check('claude')).providers[1]).toMatchObject({
      source: 'paseo',
      usedPercent: 50,
      canCheck: false,
    });
    expect(checkClaude).not.toHaveBeenCalled();
    listUsage.mockResolvedValue(
      report([provider('claude', [window('weekly_model_fable', 'Weekly · Fable', 65)])]),
    );
    const checking = quota.check('claude');
    expect(await quota.check('claude')).toEqual(await checking);
    expect(checkClaude).toHaveBeenCalledOnce();
    expect(checkCodex).not.toHaveBeenCalled();
    expect(listUsage).toHaveBeenCalledTimes(3);
    expect((await checking).providers[1]).toMatchObject({
      source: 'direct',
      usedPercent: 23.4,
      canCheck: true,
      resetsAt: RESET,
      windows: [
        { id: 'weekly_model_fable', source: 'paseo' },
        { id: 'seven_day_opus', source: 'direct' },
      ],
    });
    expect(await quota.read()).toEqual(await checking);
  });

  it('uses the aggregate report time when Paseo omits account timestamps and checks every same-provider report', async () => {
    const { quota, checkCodex } = setup(
      report([
        { providerId: 'codex', status: 'error', windows: [] },
        { providerId: 'codex', status: 'available', windows: [window('weekly', 'Weekly', 48)] },
        {
          providerId: 'codex',
          status: 'available',
          windows: [window('limit:another-account:weekly', 'Another model · Weekly', 15)],
        },
      ]),
    );
    expect((await quota.check('codex')).providers[0]).toMatchObject({
      usedPercent: 48,
      source: 'paseo',
      refreshedAt: FETCHED,
      stale: false,
      canCheck: false,
      windows: [],
    });
    expect(checkCodex).not.toHaveBeenCalled();
  });

  it('keeps cached host data stale on a failure and never falls back during reads', async () => {
    const { quota, listUsage, checkCodex, clock } = setup(
      report([
        provider('codex', [{ id: 'weekly', label: 'Weekly', remainingPct: 20, resetsAt: RESET }]),
      ]),
    );
    expect((await quota.read()).providers[0]).toMatchObject({
      source: 'paseo',
      usedPercent: 80,
      stale: false,
    });
    clock(NOW + 60_000);
    listUsage.mockRejectedValueOnce(new Error('upstream detail'));
    expect((await quota.read()).providers[0]).toMatchObject({
      source: 'paseo',
      refreshedAt: FETCHED,
      stale: true,
      canCheck: true,
    });
    expect(checkCodex).not.toHaveBeenCalled();
    clock(Date.parse(RESET));
    expect((await quota.read()).providers[0]).toMatchObject({ stale: true, canCheck: true });
  });

  it('ignores broken rows and does not use a direct token or legacy history report', async () => {
    const { quota, checkCodex, checkClaude } = setup(
      report([
        null,
        provider('codex', [
          null,
          window('five_hour', 'Weekly', 18),
          window('weekly', 'Weekly', -1),
        ]),
        provider('claude', [window('weekly_model_opus', 'Weekly · Opus', 5)]),
      ]),
    );
    checkCodex.mockResolvedValue({ ...directClaude, account: 'chatgpt', unit: 'tokens' });
    checkClaude.mockResolvedValue({ ...directClaude, provenance: 'claude_statusline' });
    expect((await quota.check('codex')).providers[0]).toMatchObject({
      usedPercent: null,
      source: null,
    });
    expect((await quota.check('claude')).providers[1]).toMatchObject({
      usedPercent: null,
      source: null,
      windows: [{ id: 'weekly_model_opus' }],
    });
  });

  it('discards an in-flight host read and direct result when quota data is cleared', async () => {
    const { quota, listUsage, checkClaude } = setup();
    const first = deferred<unknown>();
    listUsage.mockReturnValueOnce(first.promise);
    const oldCheck = quota.check('claude');
    quota.clear();
    first.resolve(report([provider('codex', [window('weekly', 'Weekly', 50)])]));
    expect((await oldCheck).providers[0]?.usedPercent).toBeNull();
    expect(checkClaude).not.toHaveBeenCalled();

    const directResult = deferred<AccountReport | null>();
    const started = deferred<void>();
    checkClaude.mockImplementationOnce(() => {
      started.resolve();
      return directResult.promise;
    });
    const direct = quota.check('claude');
    await started.promise;
    quota.clear();
    directResult.resolve(directClaude);
    expect((await direct).providers[1]?.usedPercent).toBeNull();
    expect((await quota.read()).providers[1]?.usedPercent).toBeNull();
  });

  it('limits managed direct access to the guarded per-provider action', async () => {
    const { quota, checkCodex, checkClaude } = setup();
    const legacyCheck = vi.fn<ClaudeAccounts['check']>();
    const claude = { check: legacyCheck } as unknown as ClaudeAccounts;
    const { app } = testApp({ paseoQuota: quota, claude });
    const plain = testApp().app;
    const bootstrap = await call(app, '/api/bootstrap', { headers: HOST });
    expect(await bootstrap.json()).toHaveProperty('paseoManaged', true);
    expect((await call(plain, '/api/paseo-quota', { headers: HOST })).status).toBe(404);
    expect((await call(app, '/api/paseo-quota', { headers: HOST })).status).toBe(200);
    expect(
      (
        await call(app, '/api/accounts/claude/plan-limits/check', {
          method: 'POST',
          headers: WRITE,
          body: '{"mode":"refresh"}',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(app, '/api/paseo-quota/claude/check', {
          method: 'POST',
          headers: HOST,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(app, '/api/paseo-quota/unsupported/check', {
          method: 'POST',
          headers: WRITE,
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect(legacyCheck).not.toHaveBeenCalled();
    expect(checkClaude).not.toHaveBeenCalled();
    expect(
      (
        await call(app, '/api/paseo-quota/claude/check', {
          method: 'POST',
          headers: WRITE,
          body: '{}',
        })
      ).status,
    ).toBe(200);
    expect(checkClaude).toHaveBeenCalledOnce();
    expect(checkCodex).not.toHaveBeenCalled();
  });
});
