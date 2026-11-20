import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { BootstrapResponse } from '../../src/shared/contracts/bootstrap.ts';
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from '../../src/server/collectors/github/ports.ts';
import { ClaudeHooksStatus } from '../../src/shared/contracts/hq.ts';
import { getMeta, setMeta } from '../../src/server/db/queries/meta.ts';
import { trackRepo } from '../../src/server/db/queries/repos.ts';
import { completeSetup } from '../../src/server/db/queries/setup.ts';
import { renderHookCommand } from '../../src/server/integrations/claudeHooks/command.ts';
import { hookPaths } from '../../src/server/integrations/claudeHooks/paths.ts';
import { gate, holds, scriptedAdapter, succeeds } from '../fixtures/scripted-adapters/scripted.ts';
import { HOST, NOW, TZ, call, tempDir } from './helpers.ts';
import { startWithGithub } from './github-boot.ts';

function saveKeychainToken(
  s: Awaited<ReturnType<typeof startWithGithub>>,
  clientId: string,
  owner?: string,
) {
  s.keyring.set(
    KEYCHAIN_SERVICE,
    KEYCHAIN_ACCOUNT,
    JSON.stringify({
      client_id: clientId,
      owner_install_id: owner,
      access_token: 'test-credential',
      expires_at: null,
      refresh_token: null,
      refresh_expires_at: null,
    }),
  );
}

describe('resetting the running app', () => {
  it('requires confirmation and clears existing state before onboarding starts again', async () => {
    const s = await startWithGithub();
    try {
      const db = s.db();
      completeSetup(db, { at: NOW, timezone: TZ });
      trackRepo(db, {
        id: 'kelvin/atlas-api',
        nodeId: 'R_atlasapi0001',
        displayName: 'Kelvin/Atlas-API',
        now: NOW,
      });
      await s.refreshGithub();
      expect(db.prepare('SELECT count(*) AS n FROM pull_request').get()).toEqual({ n: 3 });
      expect((await s.send('POST', '/api/setup/reset', { confirmed: false })).status).toBe(400);
      expect(
        BootstrapResponse.parse((await s.send('GET', '/api/bootstrap')).json).setupComplete,
      ).toBe(true);

      const clientId = 'Iv1.reset';
      expect((await s.send('PUT', '/api/accounts/github/app', { clientId })).status).toBe(200);
      saveKeychainToken(s, clientId, getMeta(db, 'install_id')!);
      setMeta(db, 'github_app_login', 'octo-kelvin');
      s.keyring.refuse = 'locked';
      expect((await s.send('POST', '/api/setup/reset', { confirmed: true })).status).toBe(500);
      expect(db.prepare('SELECT count(*) AS n FROM pull_request').get()).toEqual({ n: 3 });
      s.keyring.refuse = null;

      const result = await call(s.server.app, '/api/setup/reset', {
        method: 'POST',
        headers: HOST,
        body: '{"confirmed":true}',
      });
      expect(result.status).toBe(403);
      expect((await s.send('POST', '/api/setup/reset', { confirmed: true })).status).toBe(204);
      expect(
        BootstrapResponse.parse((await s.send('GET', '/api/bootstrap')).json).setupComplete,
      ).toBe(false);
      for (const table of ['repo', 'pull_request', 'source_state', 'refresh_run']) {
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
      }
      expect(s.keyring.snapshot()).toEqual([]);
      expect((await s.send('GET', '/api/sources')).json).toMatchObject({
        accounts: [{ id: 'github', status: 'notconnected', login: null }],
      });
      expect((await s.send('POST', '/api/accounts/github/connect')).json).toMatchObject({
        mode: 'existing',
      });
      expect((await s.send('POST', '/api/setup/complete')).status).toBe(202);
    } finally {
      await s.stop();
    }
  });

  it('removes the GitHub App grant this installation created after editing its client ID', async () => {
    const s = await startWithGithub({ ghSignedIn: false });
    try {
      completeSetup(s.db(), { at: NOW, timezone: TZ });
      await s.send('PUT', '/api/accounts/github/app', { clientId: 'Iv1.testclient' });
      const { json } = await s.send('POST', '/api/accounts/github/connect');
      const { loginId } = json as { loginId: string };
      await vi.waitFor(async () => {
        expect((await s.send('GET', `/api/accounts/github/connect/${loginId}`)).json).toMatchObject(
          { state: 'connected' },
        );
      });
      expect(s.keyring.snapshot()).toHaveLength(1);
      expect(
        (await s.send('PUT', '/api/accounts/github/app', { clientId: 'Iv1.nextApp' })).status,
      ).toBe(200);
      expect((await s.send('POST', '/api/setup/reset', { confirmed: true })).status).toBe(204);
      expect(s.keyring.snapshot()).toEqual([]);
    } finally {
      await s.stop();
    }
  });

  it('preserves an untagged shared credential even if this installation previously used the same App', async () => {
    const s = await startWithGithub();
    try {
      completeSetup(s.db(), { at: NOW, timezone: TZ });
      const clientId = 'Iv1.shared';
      await s.send('PUT', '/api/accounts/github/app', { clientId });
      saveKeychainToken(s, clientId);
      setMeta(s.db(), 'github_app_login', 'octo-kelvin');
      expect((await s.send('POST', '/api/setup/reset', { confirmed: true })).status).toBe(204);
      expect(s.keyring.snapshot()).toHaveLength(1);
    } finally {
      await s.stop();
    }
  });

  it('retries WAL cleanup when a separate local reader kept old pages open', async () => {
    const s = await startWithGithub();
    const reader = new DatabaseSync(s.config.dbPath, { readOnly: true });
    try {
      const db = s.db();
      db.exec('PRAGMA busy_timeout = 0');
      completeSetup(db, { at: NOW, timezone: TZ });
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM app_meta').get();

      const reset = () => s.send('POST', '/api/setup/reset', { confirmed: true });
      expect((await reset()).status).toBe(500);
      reader.exec('ROLLBACK');
      expect((await reset()).status).toBe(204);
      expect(readFileSync(`${s.config.dbPath}-wal`)).toHaveLength(0);
    } finally {
      reader.close();
      await s.stop();
    }
  });

  it('ignores other installations’ GitHub App credentials, even after finishing setup', async () => {
    const s = await startWithGithub({ ghSignedIn: false });
    try {
      completeSetup(s.db(), { at: NOW, timezone: TZ });
      saveKeychainToken(s, 'Iv1.other-install');
      s.keyring.refuse = 'locked';
      expect((await s.send('POST', '/api/setup/reset', { confirmed: true })).status).toBe(204);
      s.keyring.refuse = null;
      expect(s.keyring.snapshot()).toHaveLength(1);
      expect((await s.send('POST', '/api/setup/complete')).status).toBe(202);
      expect((await s.send('GET', '/api/sources')).json).toMatchObject({
        accounts: [{ id: 'github', status: 'needsapp', login: null }],
      });
      expect((await s.send('POST', '/api/accounts/github/connect')).json).toMatchObject({
        error: { code: 'github_app_required' },
      });
    } finally {
      await s.stop();
    }
  });

  it('waits for an active refresh and rejects another reset during that wait', async () => {
    const held = gate();
    const adapter = scriptedAdapter('codex', [holds(held, succeeds({ imported: 1 }))]);
    const s = await startWithGithub({
      boot: { adapters: [adapter], local: { home: tempDir(), env: {} } },
    });
    try {
      const db = s.db();
      completeSetup(db, { at: NOW, timezone: TZ });
      expect((await s.send('POST', '/api/refresh')).status).toBe(202);
      await adapter.called();
      const resetting = s.send('POST', '/api/setup/reset', { confirmed: true });
      try {
        await vi.waitFor(async () => {
          expect((await s.send('GET', '/api/bootstrap')).status).toBe(409);
        });
        expect((await s.send('POST', '/api/setup/reset', { confirmed: true })).status).toBe(409);
      } finally {
        held.release();
      }
      expect((await resetting).status).toBe(204);
      expect(db.prepare('SELECT count(*) AS n FROM refresh_run').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM source_state').get()).toEqual({ n: 0 });
      expect((await s.send('POST', '/api/refresh')).status).toBe(400);
      expect(adapter.calls).toBe(1);
    } finally {
      held.release();
      await s.stop();
    }
  });

  it('removes only HQ’s opt-in Claude Code hooks and releases their files', async () => {
    const home = tempDir();
    const claudeDir = join(home, '.claude');
    const settings = join(claudeDir, 'settings.json');
    const original = '{ "cleanupPeriodDays": 45 }\n';
    mkdirSync(claudeDir);
    writeFileSync(settings, original);
    const s = await startWithGithub({ boot: { claude: { env: {}, home } } });
    try {
      completeSetup(s.db(), { at: NOW, timezone: TZ });
      const before = ClaudeHooksStatus.parse((await s.send('GET', '/api/hq/claude-hooks')).json);
      expect(
        (
          await s.send('PUT', '/api/hq/claude-hooks', {
            enabled: true,
            preview: before.plans.on?.preview,
          })
        ).status,
      ).toBe(200);
      const paths = hookPaths(s.config.dataDir);
      expect(existsSync(paths.script)).toBe(true);
      expect(existsSync(paths.registry)).toBe(true);
      const otherHandler = {
        type: 'command',
        command: renderHookCommand({ node: process.execPath, script: hookPaths(tempDir()).script }),
        timeout: 3,
      };
      const installed = JSON.parse(readFileSync(settings, 'utf8')) as {
        hooks: Record<string, unknown[]>;
      };
      installed.hooks['SessionStart']!.push({ hooks: [otherHandler] });
      writeFileSync(settings, JSON.stringify(installed, null, 2) + '\n');
      expect((await s.send('POST', '/api/setup/reset', { confirmed: true })).status).toBe(204);
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
        ...JSON.parse(original),
        hooks: { SessionStart: [{ hooks: [otherHandler] }] },
      });
      expect(existsSync(paths.script)).toBe(false);
      expect(existsSync(paths.registry)).toBe(false);
    } finally {
      await s.stop();
    }
  });

  it('can reset when unrelated Claude settings are invalid and this installation never enabled hooks', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.claude'));
    const settings = join(home, '.claude', 'settings.json');
    writeFileSync(settings, 'invalid');
    const s = await startWithGithub({ boot: { claude: { env: {}, home } } });
    try {
      completeSetup(s.db(), { at: NOW, timezone: TZ });
      expect((await s.send('POST', '/api/setup/reset', { confirmed: true })).status).toBe(204);
      expect(readFileSync(settings, 'utf8')).toBe('invalid');
    } finally {
      await s.stop();
    }
  });
});
