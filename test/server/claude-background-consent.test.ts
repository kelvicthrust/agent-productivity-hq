import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeBackgroundWorkPreference } from '../../src/server/db/queries/claudeBackgroundWork.ts';
import { completeSetup } from '../../src/server/db/queries/setup.ts';
import { watchMutations } from '../../src/server/integrations/claudeHooks/fsguard.ts';
import { createHookStore } from '../../src/server/services/hq/hookStore.ts';
import { ClaudeBackgroundWorkStatus } from '../../src/shared/contracts/hq.ts';
import { ASSET, readJson, rig } from '../claudeHooks/helpers.ts';
import { HOST, NOW, PORT, TZ, WRITE, call, memoryDb, testApp } from './helpers.ts';

const TOKEN = 'c'.repeat(43);
const PATH = '/api/hq/claude-hooks/background-work';
const ADDRESS = { port: PORT, token: TOKEN };
const V1_2_0_ASSET = join(import.meta.dirname, '../fixtures/claude-hooks/v1.2.0-hook.txt');

async function setup() {
  const db = memoryDb();
  const backgroundWork = claudeBackgroundWorkPreference(db);
  const store = createHookStore({ now: () => NOW });
  let acceptsBackgroundWork = false;
  const r = rig({
    settings: '{"theme":"dark"}',
    extra: {
      backgroundWork,
      onBackgroundWorkChange: (enabled) => {
        acceptsBackgroundWork = enabled;
        if (!enabled) store.clearBackground();
      },
    },
  });
  const { app } = testApp({
    db,
    claudeHooks: r.hooks,
    hookIngest: { token: TOKEN, store, acceptsBackgroundWork: () => acceptsBackgroundWork },
  });
  await r.hooks.listening(ADDRESS);
  const status = async () => {
    const res = await call(app, PATH, { headers: HOST });
    expect(res.status).toBe(200);
    return ClaudeBackgroundWorkStatus.parse(await res.json());
  };
  const put = (body: unknown, headers = WRITE) =>
    call(app, PATH, { method: 'PUT', headers, body: JSON.stringify(body) });
  const postStop = () =>
    call(app, '/api/hq/hooks/claude', {
      method: 'POST',
      headers: { ...WRITE, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'test-session',
        background_work: {
          observed_at: NOW,
          tasks: [{ id: 'test-task', type: 'shell', status: 'running' }],
        },
      }),
    });
  return { r, db, store, status, put, postStop };
}

describe('Claude Code background reporting consent', () => {
  it('requires working wait hooks and a guarded, explicit opt-in', async () => {
    const { r, status, put, postStop, store } = await setup();
    expect(await status()).toEqual({ enabled: false, available: false });
    expect((await put({ enabled: true })).status).toBe(422);
    await r.hooks.set(true);
    expect(await status()).toEqual({ enabled: false, available: true });
    expect(readJson(r.hooks.paths.registry)).not.toHaveProperty('backgroundWork');
    expect(
      (await put({ enabled: true }, { ...WRITE, 'x-agent-productivity-request': '' })).status,
    ).toBe(403);
    expect((await put({ enabled: true, extra: true })).status).toBe(400);
    expect((await postStop()).status).toBe(204);
    expect(store.readBackground().size).toBe(0);
    expect(store.read().get('test-session')?.kind).toBe('stop');

    const settings = readFileSync(r.settings);
    expect((await put({ enabled: true })).status).toBe(200);
    expect(await status()).toEqual({ enabled: true, available: true });
    expect(readJson(r.hooks.paths.registry)).toMatchObject({ backgroundWork: true });
    expect(statSync(r.hooks.paths.registry).mode & 0o777).toBe(0o600);
    expect((await postStop()).status).toBe(204);
    expect(store.readBackground().get('test-session')?.tasks).toEqual([
      { id: 'test-task', type: 'shell', status: 'running' },
    ]);

    expect((await put({ enabled: false })).status).toBe(200);
    expect(await status()).toEqual({ enabled: false, available: true });
    expect(readJson(r.hooks.paths.registry)).not.toHaveProperty('backgroundWork');
    expect(readFileSync(r.settings)).toEqual(settings);
    expect(store.readBackground().size).toBe(0);
    expect((await postStop()).status).toBe(204);
    expect(store.readBackground().size).toBe(0);
    expect(store.read().get('test-session')?.kind).toBe('stop');
  });

  it('withdraws consent and keeps wait events when the registry cannot be replaced', async () => {
    const { r, db, status, put, postStop, store } = await setup();
    await r.hooks.set(true);
    expect((await put({ enabled: true })).status).toBe(200);
    expect((await postStop()).status).toBe(204);
    expect(store.readBackground().size).toBe(1);

    const registry = readFileSync(r.hooks.paths.registry);
    let blocked = false;
    const stopWatching = watchMutations(({ op, to }, phase) => {
      if (phase === 'before' && op === 'rename' && to === r.hooks.paths.registry) {
        blocked = true;
        throw new Error('Registry rename denied');
      }
    });
    try {
      expect((await put({ enabled: false })).status).toBe(200);
    } finally {
      stopWatching();
    }

    expect(blocked).toBe(true);
    expect(readFileSync(r.hooks.paths.registry)).toEqual(registry);
    expect(claudeBackgroundWorkPreference(db).read()).toBe(false);
    expect(await status()).toEqual({ enabled: false, available: true });
    expect(await r.hooks.state()).toBe('on');
    expect(store.readBackground().size).toBe(0);
    expect((await postStop()).status).toBe(204);
    expect(store.readBackground().size).toBe(0);
    expect(store.read().get('test-session')?.kind).toBe('stop');
  });

  it.each([false, true])(
    'upgrades the owned release script on startup only when its bytes are intact (edited: %s)',
    async (edited) => {
      const backgroundWork = claudeBackgroundWorkPreference(memoryDb());
      const r = rig({
        settings: '{"theme":"dark"}',
        extra: { assetPath: V1_2_0_ASSET, backgroundWork },
      });
      await r.hooks.listening(ADDRESS);
      await r.hooks.set(true);
      await r.hooks.close();
      const { script, registry } = r.hooks.paths;
      expect(readFileSync(script)).toEqual(readFileSync(V1_2_0_ASSET));
      if (edited) appendFileSync(script, '\n// owner edit\n');
      const previous = readFileSync(script);
      const settings = readFileSync(r.settings);

      const upgraded = r.another({ assetPath: ASSET });
      await upgraded.listening(ADDRESS);
      expect(readFileSync(r.settings)).toEqual(settings);
      expect(await upgraded.backgroundWorkStatus()).toEqual({ enabled: false, available: !edited });
      if (edited) {
        expect(readFileSync(script)).toEqual(previous);
        expect(existsSync(registry)).toBe(false);
        expect(await upgraded.state()).toBe('needs_repair');
      } else {
        expect(readFileSync(script)).toEqual(readFileSync(ASSET));
        expect(readJson(registry)).not.toHaveProperty('backgroundWork');
        expect(await upgraded.state()).toBe('on');
      }
    },
  );

  it('remembers the opt-in on restart and clears it when wait hooks are disabled or HQ is reset', async () => {
    const { r, db, put } = await setup();
    completeSetup(db, { at: NOW, timezone: TZ });
    await r.hooks.set(true);
    expect((await put({ enabled: true })).status).toBe(200);
    await r.hooks.close();
    expect(existsSync(r.hooks.paths.registry)).toBe(false);

    const restarted = r.another();
    await restarted.listening(ADDRESS);
    expect(await restarted.backgroundWorkStatus()).toEqual({ enabled: true, available: true });
    expect(readJson(restarted.paths.registry)).toMatchObject({ backgroundWork: true });
    await restarted.set(false);
    expect(await restarted.backgroundWorkStatus()).toEqual({ enabled: false, available: false });
    await restarted.set(true);
    expect(readJson(restarted.paths.registry)).not.toHaveProperty('backgroundWork');

    await restarted.setBackgroundWork(true);
    const resetApp = testApp({ db, claudeHooks: restarted }).app;
    const reset = await call(resetApp, '/api/setup/reset', {
      method: 'POST',
      headers: WRITE,
      body: '{"confirmed":true}',
    });
    expect(reset.status).toBe(204);
    expect(claudeBackgroundWorkPreference(db).read()).toBe(false);
    expect(existsSync(restarted.paths.registry)).toBe(false);
  });
});
