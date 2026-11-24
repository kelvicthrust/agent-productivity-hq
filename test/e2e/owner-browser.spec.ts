import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { getRequestListener } from '@hono/node-server';
import type { Page } from '@playwright/test';
import { boot, type ListenFn } from '../../src/server/boot.ts';
import { completeSetup } from '../../src/server/db/queries/setup.ts';
import { TAILSCALE_LOGIN_HEADER } from '../../src/server/http/guards.ts';
import { OWNER_BROWSER_CODE_FILE } from '../../src/server/http/owner-browser.ts';
import { loadConfig } from '../../src/server/lib/config.ts';
import { FIXED_NOW, FIXED_TIMEZONE } from '../fixtures/seed.ts';
import { expect, test } from './fixtures';

async function withPrivateShare(
  page: Page,
  run: (options: {
    origin: string;
    dataDir: string;
    share: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof boot>>['attachRemote']>>>;
    advance: (milliseconds: number) => void;
  }) => Promise<void>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-hq-owner-browser-'));
  const ownerLogin = 'owner@example.test';
  let now = FIXED_NOW;
  let dispatch: Parameters<ListenFn>[0]['fetch'] | undefined;
  let proxy: ReturnType<typeof createServer> | undefined;
  try {
    const key = join(dataDir, 'proxy-key.pem');
    const cert = join(dataDir, 'proxy-cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    // This loopback HTTPS proxy supplies the identity header normally set by Tailscale Serve.
    proxy = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      getRequestListener((request) => {
        if (!dispatch) throw new Error('Owner browser listener was not registered.');
        const headers = new Headers(request.headers);
        headers.set(TAILSCALE_LOGIN_HEADER, ownerLogin);
        return dispatch(new Request(request, { headers }));
      }),
    );
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTPS proxy address.');
    const host = `127.0.0.1:${address.port}`;
    const origin = `https://${host}`;
    const browser = await page.context().newCDPSession(page);
    await browser.send('Security.setIgnoreCertificateErrors', { ignore: true });

    const config = loadConfig({ AGENT_PRODUCTIVITY_DATA_DIR: dataDir });
    const server = await boot(config, {
      managed: true,
      paseoUsage: async () => ({ providers: [] }),
      scheduler: false,
      timezone: FIXED_TIMEZONE,
      now: () => now,
      listen: async (options) => {
        dispatch = options.fetch;
        return { address: () => ({ port: 43_192 }), close: (done) => done?.() };
      },
    });
    try {
      completeSetup(server.db!, { at: now, timezone: FIXED_TIMEZONE });
      const share = await server.attachRemote!({ host, ownerLogin });
      await run({
        origin,
        dataDir,
        share,
        advance: (milliseconds) => {
          now += milliseconds;
        },
      });
    } finally {
      await server.shutdown();
    }
  } finally {
    const closing = proxy;
    if (closing?.listening) {
      await new Promise<void>((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections();
      });
    }
    await rm(dataDir, { force: true, recursive: true });
  }
}

test('unlocking the owner browser returns to Sources & repos and expires @a11y @responsive', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withPrivateShare(page, async ({ origin, dataDir, advance }) => {
    await page.goto(`${origin}/sources`);
    await expect(page.getByRole('heading', { name: 'Unlock Agent HQ' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    const field = page.getByLabel('Browser unlock code');
    await field.fill('A'.repeat(43));
    await field.press('Enter');
    await expect(page.getByRole('alert')).toContainText('That code did not match');
    const currentCode = (await readFile(join(dataDir, OWNER_BROWSER_CODE_FILE), 'utf8')).trim();
    await field.fill(currentCode);
    await field.press('Enter');
    await expect(page).toHaveURL(`${origin}/sources`);
    await expect(page.getByRole('heading', { name: 'Sources & repos', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-agent-hq-owner');

    advance(8 * 60 * 60 * 1_000);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Unlock Agent HQ' })).toBeVisible();
  });
});

test('Open full dashboard enters a fresh browser without the owner code @a11y @responsive', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withPrivateShare(page, async ({ origin, share, advance }) => {
    const { ticket } = share.issueBrowserTicket()!;
    const exchange = page.waitForRequest(`${origin}/api/paseo-handoff`);
    await page.goto(`${origin}/paseo/#ticket=${ticket}`);
    const headers = await (await exchange).allHeaders();
    expect(headers).not.toHaveProperty('x-agent-productivity-browser-session');
    expect(headers).not.toHaveProperty('cookie');
    expect(headers.origin).toBe(origin);
    await expect(page.getByRole('heading', { name: /^Overview:/ })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/paseo/`);
    expect(await page.context().cookies()).toEqual([]);

    await page.reload();
    await expect(page.getByRole('heading', { name: /^Overview:/ })).toBeVisible();
    await page.getByRole('link', { name: 'Delivery' }).click();
    await expect(page.getByRole('heading', { name: 'Delivery', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Sources & repos' }).click();
    await expect(page.getByRole('heading', { name: 'Sources & repos', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open owner settings' })).toHaveAttribute(
      'href',
      '/sources',
    );
    await expect(page.getByRole('heading', { name: 'Reset Agent HQ', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    advance(8 * 60 * 60 * 1_000);
    await page.reload();
    await expect(page.getByText(/reopen.*Paseo/i)).toBeVisible();
  });
});
