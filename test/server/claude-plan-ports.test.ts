import { createHash } from 'node:crypto';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  claudePlanProfile,
  createClaudePlanCredentialReader,
} from '../../src/server/integrations/claudePlan/credentials.ts';
import { readClaudePlanUsage } from '../../src/server/integrations/claudePlan/usage.ts';
import { createNet, CLAUDE_PLAN_LIMITS_URL } from '../../src/server/lib/net.ts';
import { NOW, tempDir } from './helpers.ts';

const OAUTH = 'sk-ant-oat01-synthetic';
const raw = JSON.stringify({
  claudeAiOauth: { accessToken: OAUTH, refreshToken: 'never-use-this', expiresAt: NOW + 30_000 },
});

describe('the active Claude Code credential store', () => {
  it('reads the exact normalized, account-scoped macOS item', async () => {
    const keychain = vi.fn(async () => raw);
    const file = vi.fn(async () => null);
    const location = '/profile/cafe\u0301';
    const profile = claudePlanProfile(
      {
        CLAUDE_CONFIG_DIR: '/other',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: location,
        USER: 'unsupported account',
      },
      '/default',
      'darwin',
    )!;
    const expected = createHash('sha256').update('/profile/café').digest('hex').slice(0, 8);
    expect(profile.directory).toBe('/profile/café');
    const read = createClaudePlanCredentialReader({ platform: 'darwin', keychain, file });
    expect(keychain).not.toHaveBeenCalled();
    expect(await read(profile, NOW)).toEqual({ state: 'ok', accessToken: OAUTH });
    expect(keychain).toHaveBeenCalledExactlyOnceWith(
      `Claude Code-credentials-${expected}`,
      'claude-code-user',
    );
    expect(file).not.toHaveBeenCalled();
    expect(claudePlanProfile({ CLAUDE_CONFIG_DIR: '/a,/b' }, '/default')).toBeNull();
    expect(
      claudePlanProfile({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/team,west' }, '/default')?.directory,
    ).toBe('/team,west');
    expect(
      claudePlanProfile(
        { CLAUDE_CONFIG_DIR: '/other', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
        '/default',
      ),
    ).toMatchObject({
      directory: '/default/.claude',
      keychainService: 'Claude Code-credentials',
    });
    expect(claudePlanProfile({ CLAUDE_CONFIG_DIR: '' }, '/default')).toMatchObject({
      directory: resolve(''),
      keychainService: 'Claude Code-credentials',
    });
  });

  it('falls back only when the exact item is absent, and never sends an expired or non-OAuth credential', async () => {
    const profile = claudePlanProfile({ USER: 'owner' }, '/default', 'darwin')!;
    const keychain = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('private macOS failure'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'wrong-kind' } }));
    const file = vi.fn(async () => raw);
    const read = createClaudePlanCredentialReader({ platform: 'darwin', keychain, file });

    expect(await read(profile, NOW)).toEqual({ state: 'credential_denied' });
    expect(file).not.toHaveBeenCalled();
    expect(await read(profile, NOW)).toEqual({ state: 'ok', accessToken: OAUTH });
    expect(file).toHaveBeenCalledExactlyOnceWith('/default/.claude');
    expect(keychain).toHaveBeenCalledWith('Claude Code-credentials', 'owner');
    expect(await read(profile, NOW + 30_001)).toEqual({ state: 'reconnect' });
    expect(await read(profile, NOW)).toEqual({ state: 'unsupported' });
    expect(file).toHaveBeenCalledTimes(1);
  });

  it('opens only the selected profile’s private file on a file-backed platform', async () => {
    const root = tempDir();
    const profile = claudePlanProfile({ CLAUDE_CONFIG_DIR: root }, '/other', 'linux')!;
    const keychain = vi.fn(async () => null);
    const read = createClaudePlanCredentialReader({ platform: 'linux', keychain });
    const file = join(root, '.credentials.json');
    expect(await read(profile, NOW)).toEqual({ state: 'signed_out' });
    writeFileSync(file, raw, { mode: 0o600 });
    expect(await read(profile, NOW)).toEqual({ state: 'ok', accessToken: OAUTH });
    chmodSync(file, 0o644);
    expect(await read(profile, NOW)).toEqual({ state: 'credential_denied' });
    const linked = tempDir();
    symlinkSync(file, join(linked, '.credentials.json'));
    expect(await read(claudePlanProfile({ CLAUDE_CONFIG_DIR: linked }, '/other')!, NOW)).toEqual({
      state: 'credential_denied',
    });
    expect(keychain).not.toHaveBeenCalled();
  });

  it('keys saved outcomes to the effective store location and account', () => {
    expect(claudePlanProfile({ USER: userInfo().username }, '/default', 'darwin')?.key).toBe(
      claudePlanProfile({}, '/default', 'darwin')?.key,
    );
    expect(claudePlanProfile({ USER: 'first' }, '/default', 'darwin')?.key).not.toBe(
      claudePlanProfile({ USER: 'second' }, '/default', 'darwin')?.key,
    );
    expect(claudePlanProfile({ USER: 'first' }, '/default', 'linux')?.key).toBe(
      claudePlanProfile({ USER: 'second' }, '/default', 'linux')?.key,
    );
  });
});

describe('the Claude outbound scope', () => {
  it('allows just the exact GET and never follows a redirect', async () => {
    const send = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } }),
    );
    const net = createNet({ scope: 'claude-plan', fetch: send });
    for (const target of [
      'https://api.github.com/user',
      'http://api.anthropic.com/api/oauth/usage',
      'https://api.anthropic.com:443/api/oauth/usage',
      'https://someone@api.anthropic.com/api/oauth/usage',
      'https://api.anthropic.com/api/oauth/usage?',
      'https://api.anthropic.com/api/oauth/usage#',
      'https://api.anthropic.com/api/oauth/token',
      'https://api.anthropic.com/api/oauth/usage/',
    ]) {
      await expect(net(target)).rejects.toMatchObject({ kind: 'refused' });
    }
    await expect(net(CLAUDE_PLAN_LIMITS_URL, { method: 'POST' })).rejects.toMatchObject({
      kind: 'refused',
    });
    await expect(net(CLAUDE_PLAN_LIMITS_URL, { body: 'body' })).rejects.toMatchObject({
      kind: 'refused',
    });
    expect(send).not.toHaveBeenCalled();
    await expect(readClaudePlanUsage(net, OAUTH, () => NOW)).resolves.toEqual({ state: 'failed' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toMatchObject([
      CLAUDE_PLAN_LIMITS_URL,
      { method: 'GET', redirect: 'manual' },
    ]);
  });

  it('uses a date Retry-After or the fallback and refuses malformed, oversized, or unsupported bodies', async () => {
    const future = NOW + 120_000;
    const rateLimit = async (value: string) =>
      new Response(null, { status: 429, headers: { 'retry-after': value } });
    await expect(
      readClaudePlanUsage(
        () => rateLimit(new Date(future).toUTCString()),
        OAUTH,
        () => NOW,
      ),
    ).resolves.toEqual({ state: 'limited', retryAt: future });
    await expect(
      readClaudePlanUsage(
        () => rateLimit('invalid'),
        OAUTH,
        () => NOW,
      ),
    ).resolves.toEqual({ state: 'limited', retryAt: NOW + 3_600_000 });
    for (const text of [
      '[',
      '{}',
      '{"five_hour":{"utilization":"20"}}',
      '"' + 'x'.repeat(70_000) + '"',
    ]) {
      await expect(
        readClaudePlanUsage(
          async () => new Response(text),
          OAUTH,
          () => NOW,
        ),
      ).resolves.toEqual({ state: 'failed' });
    }
    await expect(
      readClaudePlanUsage(
        async () => Response.json({ five_hour: null, seven_day: null }),
        OAUTH,
        () => NOW,
      ),
    ).resolves.toEqual({ state: 'unsupported' });
  });
});
