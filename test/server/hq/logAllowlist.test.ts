import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeFeed } from '../../../src/server/collectors/live/claudeFeed.ts';
import { createCodexFeed } from '../../../src/server/collectors/live/codexFeed.ts';
import {
  LIVE_LIST_TIMEOUT_MS,
  LIVE_POLL_MS,
  createPaseoLiveFeed,
} from '../../../src/server/collectors/paseo/live.ts';
import { createHqService } from '../../../src/server/services/hq/service.ts';
import { createHookStore } from '../../../src/server/services/hq/hookStore.ts';
import { ClaudeHooksError } from '../../../src/server/integrations/claudeHooks/index.ts';
import { rig } from '../../claudeHooks/helpers.ts';
import { connectErrors } from '../../collectors/paseo/helpers.ts';
import {
  entry,
  fakeLiveDaemon,
  liveAgent,
  manualSleep,
  settle,
} from '../../collectors/paseo/liveHelpers.ts';
import { makeHomes } from '../../collectors/live/feedHelpers.ts';
import { NOW, WRITE, call, memoryLogger, testApp } from '../helpers.ts';

// The log is on disk, so HQ's log lines carry only application-defined codes: a fixed message, a fixed source, a status or a code from a
// fixed list. No count, no flag and no number derived from the roster, and no path, id, title or error text. Each feed and the service
// are run through a whole lifecycle (start, live, failures, drop, retry, stop) and every field of every line is checked against the list.

const MESSAGES = new Set([
  'paseo live feed failed',
  'paseo live feed not usable',
  'paseo live feed connected',
  'transcript live feed failed',
  'transcript live feed not usable',
  'hq feeds started',
  'hq feeds stopped',
  'hq roster repaired',
  'hq hooks enabled',
  'hq hooks disabled',
  'hq hooks failed',
  'hq hooks registry failed',
  'hq hooks cleanup incomplete',
]);
const SOURCES = new Set(['paseo_live', 'claude_live', 'codex_live', 'hq', 'hq_hooks']);
const STATUSES = new Set(['notrunning', 'needspassword', 'notfound', 'denied', 'failed']);
const CODES = new Set([
  'connect_failed',
  'connect_timeout',
  'connection_lost',
  'list_failed',
  'list_timeout',
  'request_timeout',
  'sdk_unavailable',
  'daemon_connection_lost',
  'daemon_request_timeout',
  'econnaborted',
  'econnreset',
  'ehostunreach',
  'enetunreach',
  'enotfound',
  'epipe',
  'etimedout',
  'failed',
  'tick_failed',
  'roster_repaired',
  'roster_failed',
  // Claude Code hooks (the installer): the fixed reasons a settings change did not happen, and the registry.
  'conflict',
  'no_folder',
  'unreadable',
  'not_json',
  'not_an_object',
  'unsupported_shape',
  'not_writable',
  'registry_failed',
  'stale_preview',
  'rollback_failed',
  'unsupported_layout',
  'unsupported_path',
  'cleanup_incomplete',
]);
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const FIELDS = new Set(['ts', 'level', 'msg', 'source', 'status', 'code']);

/** Fails when any line has a field, a message or a value that is not on the lists. Returns how many lines it checked. */
function expectOnlyFixedFields(entries: readonly Record<string, unknown>[]): number {
  for (const line of entries) {
    expect(Object.keys(line).filter((key) => !FIELDS.has(key))).toEqual([]);
    expect(MESSAGES.has(String(line['msg']))).toBe(true);
    expect(LEVELS.has(String(line['level']))).toBe(true);
    expect(SOURCES.has(String(line['source']))).toBe(true);
    expect(line['ts']).toBe(new Date(NOW).toISOString());
    if ('status' in line) expect(STATUSES.has(String(line['status']))).toBe(true);
    if ('code' in line) expect(CODES.has(String(line['code']))).toBe(true);
    for (const value of Object.values(line)) expect(typeof value).toBe('string');
  }
  return entries.length;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the Paseo live feed', () => {
  it('logs only fixed fields through connect, a roster of any size, a page cut, failures, a drop, a retry and a stop', async () => {
    const sleep = manualSleep();
    const { logger, entries } = memoryLogger('debug');
    const daemon = fakeLiveDaemon(
      Array.from({ length: 7 }, (_, index) =>
        entry({ id: `SENTINEL_ID_${index}`, title: 'SENTINEL_TITLE', cwd: '/SENTINEL/path' }),
      ),
    );
    daemon.hasMore = true;
    const feed = createPaseoLiveFeed({
      url: 'ws://127.0.0.1:6767/ws',
      open: daemon.open,
      now: () => NOW,
      logger,
      sleep,
      random: () => 0,
    });
    // A refused connection, a password, a timeout, then a connection that lists, drops, and fails to list.
    daemon.script(connectErrors.refused(), connectErrors.password(), connectErrors.timeout());
    feed.start();
    await settle();
    for (const wait of [1_000, 60_000, 4_000]) {
      sleep.releaseMs(wait);
      await settle();
    }
    await feed.ready();
    expect(feed.status()).toBe('live');
    expect(feed.read().agents).toHaveLength(7);
    daemon.drop();
    sleep.releaseMs(LIVE_POLL_MS);
    await settle();
    daemon.scriptLists(new Error('SENTINEL_LIST_FAILURE'));
    for (let round = 0; round < 6; round += 1) {
      for (const wait of [1_000, 2_000, 4_000, LIVE_POLL_MS]) sleep.releaseMs(wait);
      await settle();
    }
    daemon.scriptLists('hang');
    sleep.releaseMs(LIVE_POLL_MS);
    await settle();
    sleep.releaseMs(LIVE_LIST_TIMEOUT_MS);
    await settle();
    await feed.stop();

    expect(expectOnlyFixedFields(entries)).toBeGreaterThan(3);
    expect(entries.some((line) => line['msg'] === 'paseo live feed connected')).toBe(true);
    const text = JSON.stringify(entries);
    expect(text).not.toMatch(/SENTINEL|true|false|"7"|\b7\b/);
  });
});

describe('the transcript feeds', () => {
  let temp: string;
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'live-log-'));
  });
  afterEach(() => {
    chmodSync(temp, 0o755);
    rmSync(temp, { recursive: true, force: true });
  });

  it('log only fixed fields over real folders: live, not found, denied, and a stop', async () => {
    const homes = makeHomes(NOW);
    const sleep = manualSleep();
    const { logger, entries } = memoryLogger('debug');
    const options = { now: () => NOW, logger, sleep };
    const lifecycle = async (feed: ReturnType<typeof createClaudeFeed>) => {
      feed.start();
      await feed.ready();
      await settle();
      expect(feed.status()).toBe('live');
      sleep.release();
      await settle();
      await feed.stop();
    };
    await lifecycle(createClaudeFeed({ configDirs: () => [homes.claudeDir], ...options }));
    await lifecycle(createCodexFeed({ homes: () => [homes.codexHome], ...options }));

    // Nothing there, and a folder that cannot be read.
    for (const make of [createClaudeFeed, createCodexFeed]) {
      const missing = join(temp, 'missing');
      const feed =
        make === createClaudeFeed
          ? createClaudeFeed({ configDirs: () => [missing], ...options })
          : createCodexFeed({ homes: () => [missing], ...options });
      feed.start();
      await feed.ready();
      await settle();
      expect(feed.status()).toBe('notfound');
      await feed.stop();
    }
    const locked = join(temp, 'locked');
    mkdirSync(join(locked, 'projects'), { recursive: true });
    mkdirSync(join(locked, 'sessions'), { recursive: true });
    chmodSync(join(locked, 'projects'), 0);
    chmodSync(join(locked, 'sessions'), 0);
    for (const feed of [
      createClaudeFeed({ configDirs: () => [locked], ...options }),
      createCodexFeed({ homes: () => [locked], ...options }),
    ]) {
      feed.start();
      await feed.ready();
      await settle();
      await feed.stop();
    }
    chmodSync(join(locked, 'projects'), 0o755);
    chmodSync(join(locked, 'sessions'), 0o755);

    expect(expectOnlyFixedFields(entries)).toBeGreaterThan(1);
    const text = JSON.stringify(entries);
    expect(text).not.toContain(temp);
    expect(text).not.toContain(homes.root);
    expect(entries.some((line) => line['status'] === 'notfound')).toBe(true);
  });
});

describe('the service and the gate', () => {
  it('log only fixed fields through start, a repair, an idle stop and a close', async () => {
    const { logger, entries } = memoryLogger('debug');
    let status: 'live' | 'stopped' = 'stopped';
    const feed = {
      start: () => {
        status = 'live';
      },
      stop: () => {
        status = 'stopped';
        return Promise.resolve();
      },
      ready: () => Promise.resolve(),
      status: () => status,
      read: () => ({
        agents: [
          liveAgent({
            id: 'SENTINEL_ID_1',
            title: 'SENTINEL_TITLE',
            status: 'running',
            updatedAt: 1e16,
          }),
          liveAgent({ id: 'SENTINEL_ID_2', status: 'running' }),
        ],
        truncated: false,
      }),
    };
    const hq = createHqService({
      feeds: { paseo: feed },
      now: () => NOW,
      logger,
      waitsForSetup: () => false,
      sleep: manualSleep(),
      idleMs: 1_000,
    });
    await hq.snapshot();
    await vi.advanceTimersByTimeAsync(1_000);
    await hq.snapshot();
    await hq.close();
    expect(expectOnlyFixedFields(entries)).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(entries)).not.toMatch(/SENTINEL|1e\+?16|\d{6}/);
  });
});

describe('Claude Code hooks: the installer and the hook endpoint', () => {
  // The real timers are back for these: nothing here waits on one.
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('logs only fixed codes through every outcome of a change, with sentinel text in the files and paths', async () => {
    const outcomes: [string | null, (r: ReturnType<typeof rig>) => void][] = [
      ['{"SENTINEL_KEY": "SENTINEL_VALUE"}', () => undefined],
      ['SENTINEL not json', () => undefined],
      ['[]', () => undefined],
      ['{"hooks": {"Stop": "SENTINEL"}}', () => undefined],
      ['{}', (r) => chmodSync(r.settings, 0o444)],
    ];
    let lines = 0;
    for (const [settings, prepare] of outcomes) {
      const r = rig({ settings });
      prepare(r);
      await r.hooks.set(true).catch((error: unknown) => {
        expect(error).toBeInstanceOf(ClaudeHooksError);
      });
      await r.hooks.set(false).catch(() => undefined);
      await r.hooks.listening({ port: 4317, token: 'SENTINEL_TOKEN_0123456789abcdefghijkl' });
      await r.hooks.close();
      lines += expectOnlyFixedFields(r.logs);
      expect(JSON.stringify(r.logs)).not.toMatch(/SENTINEL|hooks test-|settings\.json|\.mjs/);
    }
    expect(lines).toBeGreaterThanOrEqual(6);
    // No folder at all.
    const none = rig({ config: false });
    await none.hooks.set(true).catch(() => undefined);
    expect(expectOnlyFixedFields(none.logs)).toBe(1);
    // A registry that cannot be written.
    const stuck = rig({ settings: '{}' });
    await stuck.hooks.set(true);
    mkdirSync(stuck.hooks.paths.registry); // a folder where the file goes: the rename fails
    await stuck.hooks.listening({ port: 2, token: 'T'.repeat(43) });
    expectOnlyFixedFields(stuck.logs);
    expect(stuck.logs.some((line) => line['code'] === 'registry_failed')).toBe(true);
    // A preview that is no longer current, and a file that could not be put back: fixed codes, no path, no text.
    const stale = rig({ settings: '{"SENTINEL_KEY": 1}' });
    await stale.hooks.set(true, { preview: 'SENTINEL_PREVIEW' }).catch(() => undefined);
    expectOnlyFixedFields(stale.logs);
    expect(stale.logs.some((line) => line['code'] === 'stale_preview')).toBe(true);
    const second = join(stale.root, 'second');
    mkdirSync(second);
    writeFileSync(join(second, 'settings.json'), '{"SENTINEL_TWO": 2}');
    const torn = stale.another({
      env: { CLAUDE_CONFIG_DIR: `${stale.config},${second}` },
      onStep: (step, path) => {
        if (step !== 'before_commit') return;
        if (path.startsWith(second)) {
          writeFileSync(stale.settings, '{"SENTINEL_SAVED": 3}');
          for (const name of readdirSync(second))
            if (name.endsWith('.tmp')) rmSync(join(second, name));
        }
      },
    });
    await torn.set(true).catch(() => undefined);
    expectOnlyFixedFields(stale.logs);
    expect(stale.logs.some((line) => line['code'] === 'rollback_failed')).toBe(true);
    expect(JSON.stringify(stale.logs)).not.toMatch(/SENTINEL|hooks test-|settings\.json/);
  });

  it('writes no log line at all for a hook event, accepted, ignored, refused or unauthorised', async () => {
    const store = createHookStore({ now: () => NOW });
    const token = 'k'.repeat(43);
    const { app, entries } = testApp({ hookIngest: { store, token } });
    const send = (body: unknown, authorization = token) =>
      call(app, '/api/hq/hooks/claude', {
        method: 'POST',
        headers: { ...WRITE, authorization: `Bearer ${authorization}` },
        body: JSON.stringify(body),
      });
    const accepted = await send({
      hook_event_name: 'PermissionRequest',
      session_id: 'SENTINEL_SESSION',
      cwd: '/SENTINEL',
    });
    const ignored = await send({
      hook_event_name: 'SomethingElse',
      session_id: 'SENTINEL_SESSION',
    });
    const refused = await send({ hook_event_name: 'Stop', session_id: 's', message: 'SENTINEL' });
    const unauthorised = await send({ hook_event_name: 'Stop', session_id: 's' }, 'wrong');
    expect([accepted.status, ignored.status, refused.status, unauthorised.status]).toEqual([
      204, 204, 400, 401,
    ]);
    expect(entries).toEqual([]);
  });
});
