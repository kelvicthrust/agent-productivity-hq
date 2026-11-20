import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudePlanLimitsCheckResponse } from '../../src/shared/contracts/accounts.ts';
import { boot, type ListenFn } from '../../src/server/boot.ts';
import { createClaudeCapture } from '../../src/server/integrations/claudeCapture/index.ts';
import type { ClaudePlanLimitsPorts } from '../../src/server/services/claude-account.ts';
import { gate } from '../fixtures/scripted-adapters/scripted.ts';
import { makeHome } from '../integration/import/helpers.ts';
import { runHookScript } from '../claudeCapture/helpers.ts';
import { HOST, NOW, TZ, WRITE, call, memoryLogger, tempConfig, tempDir } from './helpers.ts';

const listen: ListenFn = async () => ({ close: (callback) => callback?.() });
const CAPTURE = '/api/accounts/claude/usage-capture';
const CHECK = '/api/accounts/claude/plan-limits/check';
const REFRESH_PLAN = JSON.stringify({ mode: 'refresh' });
const WEEK = '/api/overview?start=2026-11-02&end=2026-11-08';
const SENTINEL = 'synthetic-private-value';
const RESET = '2026-11-05T00:00:00.000Z';

function world(planLimits?: ClaudePlanLimitsPorts) {
  const root = tempDir();
  const profile = join(root, 'claude config');
  mkdirSync(profile, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: profile };
  const config = tempConfig();
  const time = { now: NOW };
  const { logger, entries } = memoryLogger('debug');
  const settingsPath = join(profile, 'settings.json');
  const start = () =>
    boot(config, {
      logger,
      listen,
      now: () => time.now,
      timezone: TZ,
      scheduler: false,
      local: { env: {}, home: makeHome() },
      claude: { env, home: root, ...(planLimits ? { planLimits } : {}) },
    });
  return { config, env, root, time, entries, settingsPath, start };
}

type Server = Awaited<ReturnType<ReturnType<typeof world>['start']>>;

const check = async (server: Server, path = CHECK, body?: string) =>
  call(server.app, path, { method: 'POST', headers: WRITE, ...(body ? { body } : {}) });

const get = async (server: Server, path: string) =>
  (await call(server.app, path, { headers: HOST })).json();

const put = (server: Server, path: string, json: unknown) =>
  call(server.app, path, { method: 'PUT', headers: WRITE, body: JSON.stringify(json) });

async function refresh(server: Server): Promise<void> {
  const response = await check(server, '/api/refresh', '{}');
  const { id } = (await response.json()) as { id: number };
  await vi.waitFor(async () => {
    const run = (await get(server, `/api/refresh/${id}`)) as { state: string };
    expect(['queued', 'running']).not.toContain(run.state);
  });
}

function usageResponse(): Response {
  return Response.json({
    five_hour: { utilization: 0, resets_at: RESET, token: SENTINEL },
    seven_day: { utilization: 42.5, resets_at: null },
    seven_day_sonnet: { utilization: 13, resets_at: RESET },
    seven_day_opus: { utilization: -1, resets_at: RESET },
    from_the_future: { utilization: 20, resets_at: RESET, token: SENTINEL },
    extra_usage: { monthly_limit: 10000, note: SENTINEL },
  });
}

const readCredential = async () => ({ state: 'ok', accessToken: SENTINEL }) as const;

describe('explicit Claude plan limits through boot', () => {
  it('keeps credentials off passive paths and coalesces concurrent protected checks', async () => {
    const paused = gate();
    const read = vi.fn(readCredential);
    const net = vi.fn<ClaudePlanLimitsPorts['net']>(async () => {
      await paused.promise;
      return usageResponse();
    });
    const w = world({ readCredential: read, net });
    const server = await w.start();
    try {
      expect(await get(server, '/api/sources')).toMatchObject({
        accounts: [{ id: 'claude', planLimits: { state: 'unchecked', report: null } }],
      });
      expect((await check(server, '/api/setup/discover')).status).toBe(200);
      await refresh(server);
      const before = (await get(server, WEEK)) as { kpis: unknown };
      expect((await call(server.app, CHECK, { method: 'POST', headers: HOST })).status).toBe(403);
      expect((await call(server.app, CHECK, { headers: HOST })).status).toBe(404);
      expect((await check(server, `${CHECK}?profile=other`)).status).toBe(400);
      expect((await check(server, CHECK, JSON.stringify({ value: SENTINEL }))).status).toBe(400);
      expect(read).not.toHaveBeenCalled();
      expect(net).not.toHaveBeenCalled();

      const a = check(server);
      const b = check(server);
      await vi.waitFor(() => expect(net).toHaveBeenCalledTimes(1));
      paused.release();
      const [first, second] = await Promise.all([a, b]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const result = ClaudePlanLimitsCheckResponse.parse(await first.json());
      expect(await second.json()).toEqual(result);
      expect(read).toHaveBeenCalledTimes(1);
      expect(net).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${SENTINEL}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });
      expect(result).toMatchObject({
        account: {
          planLimits: {
            state: 'ok',
            lastCheckedAt: new Date(NOW).toISOString(),
            retryAt: null,
            report: {
              unit: 'percent',
              provenance: 'claude_code_oauth',
              stale: false,
              rateLimits: [
                { limitId: 'five_hour', usedPercent: 0, resetsAt: RESET },
                { limitId: 'seven_day', usedPercent: 42.5, resetsAt: null },
                { limitId: 'seven_day_sonnet', usedPercent: 13, resetsAt: RESET },
              ],
            },
          },
        },
      });
      expect(await get(server, '/api/sources')).toMatchObject({ accounts: [result.account] });
      const after = (await get(server, WEEK)) as { kpis: unknown; accounts: unknown };
      expect(after.kpis).toEqual(before.kpis);
      expect(after.accounts).toMatchObject([result.account.planLimits?.report]);
      const disk = JSON.stringify({
        metadata: server.db!.prepare('SELECT value FROM app_meta').all(),
        snapshots: server.db!.prepare('SELECT * FROM account_snapshot').all(),
        logs: w.entries,
        result,
      });
      expect(disk).not.toContain(SENTINEL);
      expect(disk).not.toContain('extra_usage');
      expect(disk).not.toContain('from_the_future');
    } finally {
      paused.release();
      await server.shutdown();
    }
  });

  it('rechecks only a previously successful profile and honors cooldown on manual refresh', async () => {
    const read = vi.fn(readCredential);
    const net = vi
      .fn<ClaudePlanLimitsPorts['net']>()
      .mockImplementationOnce(async () => new Response(null, { status: 401 }))
      .mockImplementationOnce(async () => usageResponse())
      .mockImplementationOnce(
        async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
      )
      .mockImplementationOnce(async () =>
        Response.json({ seven_day: { utilization: 83, resets_at: RESET } }),
      );
    const w = world({ readCredential: read, net });
    let server = await w.start();
    const refreshPlan = async () =>
      ClaudePlanLimitsCheckResponse.parse(
        await check(server, CHECK, REFRESH_PLAN).then((r) => r.json()),
      ).account.planLimits;
    try {
      expect(
        (await call(server.app, CHECK, { method: 'POST', headers: HOST, body: REFRESH_PLAN }))
          .status,
      ).toBe(403);
      expect(await refreshPlan()).toMatchObject({ state: 'unchecked', report: null });
      expect(read).not.toHaveBeenCalled();
      expect((await check(server)).status).toBe(200);
      expect(await refreshPlan()).toMatchObject({ state: 'reconnect', report: null });
      expect(read).toHaveBeenCalledTimes(1);

      expect((await check(server)).status).toBe(200);
      expect((await check(server, '/api/setup/discover')).status).toBe(200);
      expect((await check(server, '/api/setup/complete')).status).toBe(202);
      await server.shutdown();
      server = await w.start();
      await refresh(server);
      expect(await get(server, WEEK)).toMatchObject({
        accounts: [{ provenance: 'claude_code_oauth' }],
      });
      expect(read).toHaveBeenCalledTimes(2);

      const optedInProfile = w.env.CLAUDE_CONFIG_DIR;
      w.env.CLAUDE_CONFIG_DIR = join(w.root, 'other profile');
      expect(await refreshPlan()).toMatchObject({ state: 'unchecked', report: null });
      expect(read).toHaveBeenCalledTimes(2);

      w.env.CLAUDE_CONFIG_DIR = optedInProfile;
      w.time.now += 1_000;
      const limited = await refreshPlan();
      expect(limited).toMatchObject({
        state: 'limited',
        retryAt: new Date(w.time.now + 120_000).toISOString(),
        report: { refreshedAt: new Date(NOW).toISOString(), stale: true },
      });
      expect(await refreshPlan()).toEqual(limited);
      expect(read).toHaveBeenCalledTimes(3);

      w.time.now += 120_000;
      expect(await refreshPlan()).toMatchObject({
        state: 'ok',
        report: {
          refreshedAt: new Date(w.time.now).toISOString(),
          rateLimits: [{ limitId: 'seven_day', usedPercent: 83 }],
        },
      });
      expect(net).toHaveBeenCalledTimes(4);
    } finally {
      await server.shutdown();
    }
  });

  it('retains each profile’s own windows across switches, failed checks, and restart', async () => {
    const read = vi.fn(readCredential);
    const net = vi
      .fn<ClaudePlanLimitsPorts['net']>()
      .mockImplementationOnce(async () => usageResponse())
      .mockImplementationOnce(
        async () =>
          new Response(SENTINEL, {
            status: 429,
            headers: { 'retry-after': '120' },
          }),
      )
      .mockImplementationOnce(async () =>
        Response.json({ seven_day: { utilization: 83, resets_at: RESET } }),
      )
      .mockImplementationOnce(async () => new Response(SENTINEL, { status: 401 }));
    const w = world({ readCredential: read, net });
    let server = await w.start();
    try {
      expect((await check(server)).status).toBe(200);
      w.time.now += 1_000;
      const limited = await check(server).then((r) => r.json());
      expect(limited).toMatchObject({
        account: {
          planLimits: {
            state: 'limited',
            retryAt: new Date(w.time.now + 120_000).toISOString(),
            report: { refreshedAt: new Date(NOW).toISOString(), stale: true },
          },
        },
      });
      expect(JSON.stringify(limited)).not.toContain(SENTINEL);
      await server.shutdown();
      server = await w.start();
      expect(await check(server).then((r) => r.json())).toEqual(limited);
      expect(read).toHaveBeenCalledTimes(2);
      expect(net).toHaveBeenCalledTimes(2);

      const savedProfile = w.env.CLAUDE_CONFIG_DIR;
      w.env.CLAUDE_CONFIG_DIR = join(w.root, 'other profile');
      expect(await get(server, '/api/sources')).toMatchObject({
        accounts: [{ planLimits: { state: 'unchecked', report: null } }],
      });
      expect(await get(server, WEEK)).toMatchObject({ accounts: [] });
      w.time.now += 500;
      const secondProfile = ClaudePlanLimitsCheckResponse.parse(
        await check(server).then((r) => r.json()),
      );
      expect(secondProfile).toMatchObject({
        account: {
          planLimits: {
            state: 'ok',
            report: {
              provenance: 'claude_code_oauth',
              refreshedAt: new Date(w.time.now).toISOString(),
              stale: false,
              rateLimits: [{ limitId: 'seven_day', usedPercent: 83 }],
            },
          },
        },
      });

      w.env.CLAUDE_CONFIG_DIR = savedProfile;
      w.time.now += 120_000;
      const expired = await check(server).then((r) => r.json());
      expect(expired).toMatchObject({
        account: {
          status: 'reconnect',
          planLimits: {
            state: 'reconnect',
            retryAt: null,
            report: {
              provenance: 'claude_code_oauth',
              refreshedAt: new Date(NOW).toISOString(),
              stale: true,
              rateLimits: [
                { limitId: 'five_hour', usedPercent: 0 },
                { limitId: 'seven_day', usedPercent: 42.5 },
                { limitId: 'seven_day_sonnet', usedPercent: 13 },
              ],
            },
          },
        },
      });
      w.env.CLAUDE_CONFIG_DIR = join(w.root, 'other profile');
      expect(await get(server, '/api/sources')).toMatchObject({
        accounts: [secondProfile.account],
      });
      expect(net).toHaveBeenCalledTimes(4);
    } finally {
      await server.shutdown();
    }
  });

  it('saves an in-flight reading to the profile that supplied its credential', async () => {
    const paused = gate();
    const net = vi
      .fn<ClaudePlanLimitsPorts['net']>()
      .mockImplementationOnce(async () => {
        await paused.promise;
        return Response.json({ five_hour: { utilization: 27, resets_at: RESET } });
      })
      .mockImplementationOnce(async () =>
        Response.json({ five_hour: { utilization: 78, resets_at: RESET } }),
      );
    const w = world({ readCredential, net });
    const server = await w.start();
    try {
      const firstPath = w.env.CLAUDE_CONFIG_DIR;
      const first = check(server);
      await vi.waitFor(() => expect(net).toHaveBeenCalledTimes(1));
      w.env.CLAUDE_CONFIG_DIR = join(w.root, 'other profile');
      const second = await check(server);
      expect(second.status).toBe(200);
      paused.release();
      expect((await first).status).toBe(200);
      expect(await get(server, WEEK)).toMatchObject({
        accounts: [{ rateLimits: [{ usedPercent: 78 }] }],
      });
      w.env.CLAUDE_CONFIG_DIR = firstPath;
      expect(await get(server, WEEK)).toMatchObject({
        accounts: [{ rateLimits: [{ usedPercent: 27 }] }],
      });
    } finally {
      paused.release();
      await server.shutdown();
    }
  });

  it('retires a recorded hook with its settings untouched and keeps saved windows after manual removal', async () => {
    const read = vi.fn(readCredential);
    const net = vi.fn<ClaudePlanLimitsPorts['net']>(async () => usageResponse());
    const w = world({ readCredential: read, net });
    const prior = { type: 'command', command: 'printf owner-line', padding: 2 };
    writeFileSync(w.settingsPath, JSON.stringify({ theme: 'dark', statusLine: prior }));
    const capture = createClaudeCapture({ dataDir: w.config.dataDir, env: w.env, home: w.root });
    const install = await capture.preview('install');
    capture.change({ action: 'prepare_install', confirm: install.previewDigest });
    const edited = JSON.stringify({ theme: 'dark', statusLine: install.next });
    writeFileSync(w.settingsPath, edited);
    capture.change({ action: 'verify_install' });
    const snapshotPath = capture.activeSnapshotPath()!;
    const capturedAt = NOW - 1_000;
    const savedSnapshot = JSON.stringify({
      v: 1,
      captured_at: capturedAt / 1000,
      five_hour: { used_percentage: 25, resets_at: NOW / 1000 + 10 },
    });
    writeFileSync(snapshotPath, savedSnapshot, { mode: 0o600 });
    const server = await w.start();
    try {
      expect(readFileSync(w.settingsPath, 'utf8')).toBe(edited);
      expect(capture.activeSnapshotPath()).toBeNull();
      const hook = await runHookScript(
        w.config.dataDir,
        '{"rate_limits":{"five_hour":{"used_percentage":99,"resets_at":253402300799}}}',
      );
      expect(hook.stdout.toString()).toBe('owner-line');
      expect(readFileSync(snapshotPath, 'utf8')).toBe(savedSnapshot);
      expect(
        (await call(server.app, `${CAPTURE}/preview?action=install`, { headers: HOST })).status,
      ).toBe(400);
      expect(
        (await put(server, CAPTURE, { action: 'prepare_install', confirm: 'retired' })).status,
      ).toBe(400);
      expect((await put(server, CAPTURE, { action: 'verify_install' })).status).toBe(400);
      expect(await get(server, '/api/sources')).toMatchObject({
        accounts: [
          {
            captureEnabled: false,
            captureHealth: { phase: 'awaiting_removal' },
            planLimits: { report: { provenance: 'claude_statusline', stale: true } },
          },
        ],
      });
      expect((await check(server, CHECK, REFRESH_PLAN)).status).toBe(200);
      expect(await get(server, `${CAPTURE}/preview?action=remove`)).toMatchObject({
        files: [{ hookReferenced: true, next: prior }],
      });
      expect((await put(server, CAPTURE, { action: 'begin_remove' })).status).toBe(200);
      expect((await put(server, CAPTURE, { action: 'verify_remove' })).status).toBe(409);
      const restored = JSON.stringify({ theme: 'dark', model: 'sonnet', statusLine: prior });
      writeFileSync(w.settingsPath, restored);
      expect((await put(server, CAPTURE, { action: 'verify_remove' })).status).toBe(200);
      expect(readFileSync(w.settingsPath, 'utf8')).toBe(restored);
      expect(existsSync(capture.paths.script)).toBe(false);
      expect(await get(server, WEEK)).toMatchObject({
        accounts: [
          {
            provenance: 'claude_statusline',
            stale: true,
            refreshedAt: new Date(capturedAt).toISOString(),
            rateLimits: [{ usedPercent: 25 }],
          },
        ],
      });
      expect(read).not.toHaveBeenCalled();
      expect(net).not.toHaveBeenCalled();
    } finally {
      await server.shutdown();
    }
  });
});
