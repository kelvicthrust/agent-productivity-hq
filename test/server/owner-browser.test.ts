import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import type { HttpEnv } from '../../src/server/http/errors.ts';
import { tailscaleOwnerGuard } from '../../src/server/http/guards.ts';
import {
  createOwnerBrowserAccess,
  OWNER_BROWSER_CODE_FILE,
} from '../../src/server/http/owner-browser.ts';
import { tempDir } from './helpers.ts';

const access = { host: 'hq.example.ts.net:4317', ownerLogin: 'owner@example.test' };
const owner = { 'tailscale-user-login': access.ownerLogin };
const origin = `https://${access.host}`;
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded', origin };

function browser(dataDir = tempDir(), now = () => Date.now()) {
  const share = createOwnerBrowserAccess({ dataDir, access, now });
  const file = join(dataDir, OWNER_BROWSER_CODE_FILE);
  const code = readFileSync(file, 'utf8').trim();
  const app = new Hono<HttpEnv>();
  app.use('*', tailscaleOwnerGuard(access.ownerLogin));
  app.use('*', share.middleware);
  app.all('*', (c) => c.json({ route: c.req.path }));
  return {
    app,
    file,
    code,
    close: share.close,
    unlock: (
      body: URLSearchParams | string,
      headers: Record<string, string> = { ...owner, ...formHeaders },
    ) => app.request('/unlock', { method: 'POST', headers, body }),
  };
}

const fields = (code: string, next = '/sources') => new URLSearchParams({ code, next });

it('unlocks a fixed Work Review destination with its report filters', async () => {
  const { app, code, close } = browser();
  try {
    const search = '?start=2026-11-09&end=2026-11-15&provider=codex&author=all';
    const start = await app.request('/work-review' + search + '&ignore=ignored', {
      headers: owner,
    });
    expect(start.status).toBe(401);
    const form = await start.text();
    expect(form).toContain('value="/work-review"');
    expect(form).toContain('action="/unlock' + search.replaceAll('&', '&amp;') + '"');
    expect(form).not.toContain('ignored');
    const granted = await app.request('/unlock' + search, {
      method: 'POST',
      headers: { ...owner, ...formHeaders },
      body: fields(code, '/work-review'),
    });
    expect(granted.status).toBe(303);
    expect(granted.headers.get('location')).toBe('/work-review' + search);
    expect(granted.headers.get('set-cookie')).toBeTruthy();
  } finally {
    close();
  }
});

it('requires the daemon owner and a browser session before dispatching any dashboard data', async () => {
  const { app, code, unlock } = browser();
  expect((await app.request('/')).status).toBe(403);
  expect((await unlock(fields(code), formHeaders)).status).toBe(403);
  expect(
    (
      await unlock(fields(code), {
        ...formHeaders,
        'tailscale-user-login': 'reader@example.test',
      })
    ).status,
  ).toBe(403);

  const form = await app.request('/sources', { headers: owner });
  expect(form.status).toBe(401);
  expect(form.headers.get('referrer-policy')).toBe('same-origin');
  const html = await form.text();
  expect(html).toContain('value="/sources"');
  expect(html).toContain('<label for="code">Browser unlock code</label>');
  expect(html).not.toContain(code);

  for (const route of ['/api/hq', '/api/health', '/assets/app.js']) {
    const rejected = await app.request(route, { headers: owner });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).not.toHaveProperty('route');
  }
  expect((await app.request('/api/reset', { method: 'POST', headers: owner })).status).toBe(401);
  expect(
    (await app.request('/api/hq/claude-hooks', { method: 'PUT', headers: owner })).status,
  ).toBe(401);
});

it('issues a host-only browser session and returns to the selected screen', async () => {
  const { app, code, unlock } = browser();
  const response = await unlock(fields(code));
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/sources');
  const session = response.headers.get('set-cookie');
  expect(session).toMatch(/^__Host-agent-hq-owner=/);
  expect(session).toContain('Max-Age=28800');
  expect(session).toContain('Path=/');
  expect(session).toContain('HttpOnly');
  expect(session).toContain('Secure');
  expect(session).toContain('SameSite=Strict');
  expect(session).not.toContain('Domain=');
  expect(session).not.toContain(code);
  expect((await unlock(fields(code, '/'))).headers.get('location')).toBe('/');

  const cookie = session!.split(';', 1)[0]!;
  const authorized = await app.request('/sources', { headers: { ...owner, cookie } });
  expect(await authorized.json()).toEqual({ route: '/sources' });
  expect((await app.request('/sources', { headers: { cookie } })).status).toBe(403);
  expect(
    (await app.request('/api/hq', { headers: { ...owner, cookie: cookie + 'x' } })).status,
  ).toBe(401);
});

it('fails closed for non-origin requests, invalid fields and oversized bodies', async () => {
  const { code, unlock } = browser();
  expect(
    (await unlock(fields(code), { ...owner, ...formHeaders, origin: 'https://example.test' }))
      .status,
  ).toBe(403);
  expect(
    (await unlock(fields(code), { ...owner, 'content-type': formHeaders['content-type'] })).status,
  ).toBe(403);
  expect(
    (await unlock(fields(code), { ...owner, origin, 'content-type': 'application/json' })).status,
  ).toBe(400);
  expect((await unlock(fields(code, '//example.test'))).status).toBe(400);
  expect((await unlock(`${fields(code)}&next=%2F`)).status).toBe(400);
  expect((await unlock(`code=${'x'.repeat(1024)}&next=%2F`)).status).toBe(413);

  const wrong = await unlock(fields('a'.repeat(43)));
  expect(wrong.status).toBe(401);
  expect(wrong.headers.get('referrer-policy')).toBe('same-origin');
  expect(wrong.headers.has('set-cookie')).toBe(false);
  const html = await wrong.text();
  expect(html).toContain('aria-describedby="code-error"');
  expect(html).not.toContain('a'.repeat(43));
});

it('expires session cookies and invalidates them and the code on share close', async () => {
  const folder = tempDir();
  let instant = Date.UTC(2026, 11, 1);
  const { app, code, file, unlock, close } = browser(folder, () => instant);
  const response = await unlock(fields(code));
  const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!;
  const request = () => app.request('/api/hq', { headers: { ...owner, cookie } });
  instant += 8 * 60 * 60 * 1000 - 1;
  expect((await request()).status).toBe(200);
  instant += 1;
  expect((await request()).status).toBe(401);
  instant -= 1;
  close();
  close();
  expect(existsSync(file)).toBe(false);
  expect((await request()).status).toBe(401);
  expect((await unlock(fields(code))).status).toBe(401);

  const replacement = browser(folder, () => instant);
  expect(replacement.code).not.toBe(code);
  expect((await replacement.unlock(fields(code))).status).toBe(401);
  expect((await replacement.app.request('/api/hq', { headers: { ...owner, cookie } })).status).toBe(
    401,
  );
});

it('rotates private stale files and leaves replacement files in place during cleanup', () => {
  const folder = tempDir();
  const first = browser(folder);
  expect(statSync(first.file).mode & 0o777).toBe(0o600);
  expect(first.code).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const second = browser(folder);
  first.close();
  expect(second.code).not.toBe(first.code);
  expect(readFileSync(second.file, 'utf8')).toBe(`${second.code}\n`);
  second.close();
  expect(existsSync(second.file)).toBe(false);
});

it('refuses to use unsafe code paths and any data directory readable by another account', () => {
  const shared = tempDir();
  chmodSync(shared, 0o755);
  expect(() => browser(shared)).toThrow('private data folder');
  expect(existsSync(join(shared, OWNER_BROWSER_CODE_FILE))).toBe(false);

  const folder = tempDir();
  const target = join(tempDir(), 'untouched.txt');
  writeFileSync(target, 'keep', { mode: 0o600 });
  symlinkSync(target, join(folder, OWNER_BROWSER_CODE_FILE));
  expect(() => browser(folder)).toThrow('private browser unlock code file');
  expect(readFileSync(target, 'utf8')).toBe('keep');
});

it.skipIf(process.platform !== 'darwin')(
  'refuses a private-mode directory with an inherited ACL',
  () => {
    const folder = tempDir();
    const mode =
      'group:everyone allow list,search,add_file,delete_child,file_inherit,directory_inherit';
    execFileSync('/bin/chmod', ['+a', mode, folder]);
    execFileSync('/usr/bin/xattr', ['-w', 'com.agenthq-test.fixture', 'yes', folder]);
    const acl = () => execFileSync('/bin/ls', ['-delBn', '--', folder], { encoding: 'utf8' });
    const before = acl();
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(before).toMatch(/^drwx------@ /);
    expect(before).toMatch(/^ 0: .+ allow /m);

    expect(() => browser(folder)).toThrow('private browser unlock code');
    expect(existsSync(join(folder, OWNER_BROWSER_CODE_FILE))).toBe(false);
    expect(acl()).toBe(before);
  },
);
