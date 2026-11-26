import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boot, type ListenFn, type RunningServer } from '../../src/server/boot.ts';
import { completeSetup } from '../../src/server/db/queries/setup.ts';
import { HqResponse } from '../../src/shared/contracts/hq.ts';
import { claudePrompt, claudeToolUse, line } from '../collectors/live/lines.ts';
import {
  HOST,
  NOW,
  TZ,
  WRITE,
  call,
  memoryLogger,
  tempConfig,
  tempDir,
  unlockBrowser,
} from './helpers.ts';

// Claude Code hooks through the real boot: the registry the hook script reads is written when the server listens (and the switch is
// on) and removed at shutdown; the endpoint is on the loopback listener and never on the Tailscale one; what the hooks report is
// held in memory only and is gone at shutdown.

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.shutdown();
});

type Fetch = (request: Request) => Response | Promise<Response>;

async function start(
  options: { remote?: { host: string; ownerLogin: string }; now?: () => number } = {},
) {
  const root = tempDir();
  const profile = join(root, 'claude config');
  mkdirSync(profile, { recursive: true });
  const config = tempConfig();
  const listeners: Fetch[] = [];
  const listen: ListenFn = async (listening) => {
    listeners.push(listening.fetch);
    return { address: () => ({ port: listening.port || 44_321 }), close: (done) => done?.() };
  };
  const { logger, entries } = memoryLogger('debug');
  const env = { CLAUDE_CONFIG_DIR: profile };
  const server = await boot(config, {
    logger,
    listen,
    now: options.now ?? (() => NOW),
    timezone: TZ,
    scheduler: false,
    local: { env, home: root },
    claude: { env, home: root, nodePath: process.execPath },
    ...(options.remote ? { remote: options.remote } : {}),
  });
  servers.push(server);
  completeSetup(server.db!, { at: NOW, timezone: TZ });
  const registry = join(config.dataDir, 'claude-hooks', 'registry.json');
  return { server, config, listeners, entries, profile, registry, root };
}

/** The change as the page makes it: read the preview, then send its fingerprint back with the switch. */
const put = async (server: RunningServer, enabled: boolean) => {
  const shown = (await (
    await call(server.app, '/api/hq/claude-hooks', { headers: HOST })
  ).json()) as { preview: string };
  return call(server.app, '/api/hq/claude-hooks', {
    method: 'PUT',
    headers: WRITE,
    body: JSON.stringify({ enabled, preview: shown.preview }),
  });
};
const roster = async (server: RunningServer) =>
  HqResponse.parse(await (await call(server.app, '/api/hq', { headers: HOST })).json());
const tokenOf = (path: string) =>
  (JSON.parse(readFileSync(path, 'utf8')) as { token: string }).token;
const hook = (server: RunningServer, token: string, body: unknown) =>
  call(server.app, '/api/hq/hooks/claude', {
    method: 'POST',
    headers: { ...WRITE, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('Claude Code hooks through boot', () => {
  it('ignores a task report from an earlier opt-in period after reporting is re-enabled', async () => {
    let now = NOW;
    const { server, registry } = await start({ now: () => now });
    await put(server, true);
    const token = tokenOf(registry);
    const set = (enabled: boolean) =>
      call(server.app, '/api/hq/claude-hooks/background-work', {
        method: 'PUT',
        headers: WRITE,
        body: JSON.stringify({ enabled }),
      });
    const report = async (observed_at: number) => {
      expect(
        (
          await hook(server, token, {
            hook_event_name: 'Stop',
            session_id: 'task-session',
            background_work: {
              observed_at,
              tasks: [{ id: 'opaque-job', type: 'shell', status: 'running' }],
            },
          })
        ).status,
      ).toBe(204);
      return (await roster(server)).agents[0];
    };
    expect((await set(true)).status).toBe(200);
    now += 1_000;
    expect((await report(now))?.backgroundWork?.shellJobs).toBe(1);
    expect((await set(false)).status).toBe(200);
    now += 1_000;
    expect((await set(true)).status).toBe(200);
    now += 1_000;
    expect((await report(NOW + 1_000))?.backgroundWork).toBeUndefined();
    expect((await report(now))?.backgroundWork?.shellJobs).toBe(1);
  });

  it('starts off: no registry, no script, nothing written to the Claude Code folder', async () => {
    const { server, registry, config, profile } = await start();
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(join(config.dataDir, 'claude-hooks'))).toBe(false);
    expect(existsSync(join(profile, 'settings.json'))).toBe(false);
    expect((await roster(server)).exactPrompts).toBe('off');
  });

  it('writes the registry (0600, in a 0700 folder) when the switch is on, and removes it at shutdown', async () => {
    const { server, registry, config } = await start();
    expect((await put(server, true)).status).toBe(200);
    expect(JSON.parse(readFileSync(registry, 'utf8'))).toMatchObject({
      v: 1,
      pid: process.pid,
      port: config.port,
    });
    expect(statSync(registry).mode & 0o777).toBe(0o600);
    expect(statSync(join(config.dataDir, 'claude-hooks')).mode & 0o777).toBe(0o700);
    expect((await roster(server)).exactPrompts).toBe('on');
    await server.shutdown();
    expect(existsSync(registry)).toBe(false);
    // The script stays: the switch is still on, and the next start writes the registry again.
    expect(existsSync(join(config.dataDir, 'claude-hooks', 'agent-productivity-hook.mjs'))).toBe(
      true,
    );
  });

  it('writes the registry at the next start while the switch is still on, with a token of its own', async () => {
    const first = await start();
    await put(first.server, true);
    const token = tokenOf(first.registry);
    await first.server.shutdown();
    servers.splice(servers.indexOf(first.server), 1);
    const again = await boot(first.config, {
      logger: memoryLogger().logger,
      listen: async () => ({ close: (done) => done?.() }),
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
      local: { env: { CLAUDE_CONFIG_DIR: first.profile }, home: first.root },
      claude: { env: { CLAUDE_CONFIG_DIR: first.profile }, home: first.root },
    });
    servers.push(again);
    expect(existsSync(first.registry)).toBe(true);
    expect(tokenOf(first.registry)).not.toBe(token);
    expect(tokenOf(first.registry)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps what the hooks report in memory, shows it on the roster, and drops it at shutdown', async () => {
    const { server, registry } = await start();
    await put(server, true);
    const token = tokenOf(registry);
    expect(
      (
        await hook(server, token, {
          hook_event_name: 'PermissionRequest',
          session_id: 'sess-9',
          cwd: '/work/atlas',
        })
      ).status,
    ).toBe(204);
    const body = await roster(server);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      provider: 'claude',
      state: 'waiting',
      waitReason: 'permission',
      confidence: 'reported',
      workspace: 'atlas',
    });
    expect(
      (await hook(server, 'wrong', { hook_event_name: 'Stop', session_id: 'sess-9' })).status,
    ).toBe(401);
    await server.shutdown();
    expect(existsSync(registry)).toBe(false);
    expect(JSON.stringify((await roster(server)).agents)).toBe('[]');
  });

  it('turns off cleanly: no registry, no script, the settings back as they were', async () => {
    const { server, registry, config, profile } = await start();
    await put(server, true);
    await put(server, false);
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(join(config.dataDir, 'claude-hooks', 'agent-productivity-hook.mjs'))).toBe(
      false,
    );
    expect(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))).toEqual({});
    expect((await roster(server)).exactPrompts).toBe('off');
  });

  it('resumes guessing after turn off, even if a hook request arrives late', async () => {
    const { server, profile, registry } = await start();
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const project = join(profile, 'projects', '-work-invented-project');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${sessionId}.jsonl`);
    const context = { sessionId };
    const records = [
      claudePrompt(NOW - 20_000, context),
      claudeToolUse(NOW - 15_000, context, 'call-1', 'Read'),
    ];
    writeFileSync(transcript, records.map((record) => `${line(record)}\n`).join(''));
    for (const path of [transcript, project]) utimesSync(path, new Date(NOW), new Date(NOW));

    expect((await put(server, true)).status).toBe(200);
    const token = tokenOf(registry);
    const event = { hook_event_name: 'PermissionRequest', session_id: sessionId };
    expect((await hook(server, token, event)).status).toBe(204);
    expect((await roster(server)).agents).toMatchObject([
      { state: 'waiting', waitReason: 'permission', confidence: 'reported' },
    ]);

    expect((await put(server, false)).status).toBe(200);
    expect((await hook(server, token, event)).status).toBe(204);
    const off = await roster(server);
    expect(off.exactPrompts).toBe('off');
    expect(off.agents).toMatchObject([
      { state: 'waiting', waitReason: 'permission', confidence: 'inferred' },
    ]);
  });

  it('serves the hook endpoint on the loopback listener only, never on the Tailscale one', async () => {
    const remote = { host: 'box.example.ts.net', ownerLogin: 'me@example.com' };
    const { server, listeners, registry, config } = await start({ remote });
    await put(server, true);
    const token = tokenOf(registry);
    const [local, tailscale] = listeners;
    const body = JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1' });
    const headers = {
      'x-agent-productivity-request': '1',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };
    const viaLocal = await local!(
      new Request('http://localhost/api/hq/hooks/claude', {
        method: 'POST',
        headers: { ...headers, host: `127.0.0.1:${server.url.split(':').at(-1)}` },
        body,
      }),
    );
    expect(viaLocal.status).toBe(204);
    const owner = await unlockBrowser(tailscale!, config.dataDir, remote);
    const viaTailscale = await tailscale!(
      new Request('http://localhost/api/hq/hooks/claude', {
        method: 'POST',
        headers: { ...headers, ...owner },
        body,
      }),
    );
    expect(viaTailscale.status).toBe(404);
    // The owner can still see and use the switch through Tailscale, behind its guards.
    const status = await tailscale!(
      new Request('http://localhost/api/hq/claude-hooks', {
        headers: owner,
      }),
    );
    expect(status.status).toBe(200);
  });

  it('is unavailable where the process has no Claude Code integration, and has no endpoint', async () => {
    const config = tempConfig();
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen: async () => ({ close: (done) => done?.() }),
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
    });
    servers.push(server);
    expect((await roster(server)).exactPrompts).toBe('unavailable');
    expect((await hook(server, 'x', { hook_event_name: 'Stop', session_id: 's' })).status).toBe(
      404,
    );
    expect(existsSync(join(config.dataDir, 'claude-hooks'))).toBe(false);
  });
});
