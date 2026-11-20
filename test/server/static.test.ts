import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInside, withPreviewLabel } from '../../src/server/http/static.ts';
import { HOST, call, tempDir, testApp } from './helpers.ts';

const INDEX =
  '<!doctype html><html lang="en"><head><title>Agent Productivity HQ</title></head><body><div id="root"></div></body></html>';

function spa() {
  const root = join(tempDir(), 'client');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), INDEX);
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, 'assets', 'app.css'), 'body{}');
  writeFileSync(join(tempDir(), 'secret.txt'), 'outside');
  return root;
}

describe('resolveInside', () => {
  it('keeps every path inside the root', () => {
    const root = '/srv/app';
    expect(resolveInside(root, '/assets/app.js')).toBe('/srv/app/assets/app.js');
    expect(resolveInside(root, '/')).toBe('/srv/app');
    expect(resolveInside(root, '/../etc/passwd')).toBe(
      '/srv/etc/passwd'.startsWith('/srv/app') ? '/srv/etc/passwd' : null,
    );
    for (const bad of [
      '/../secret',
      '/assets/../../secret',
      '/%2e%2e/secret',
      '/%2e%2e%2fsecret',
      '/a%00b',
      '/a\\b',
      '/%E0%A4%A',
    ]) {
      expect(resolveInside(root, bad), bad).toBeNull();
    }
  });
});

describe('static SPA', () => {
  it('serves index.html at / and for unknown routes (history fallback), with the security headers', async () => {
    const { app } = testApp({ staticDir: spa() });
    for (const path of ['/', '/delivery', '/usage/anything', '/setup']) {
      const res = await call(app, path, { headers: HOST });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe(INDEX);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    }
  });

  it('serves built assets with the right type and 404s a missing asset instead of the page', async () => {
    const { app } = testApp({ staticDir: spa() });
    const js = await call(app, '/assets/app.js', { headers: HOST });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(
      (await call(app, '/assets/app.css', { headers: HOST })).headers.get('content-type'),
    ).toContain('text/css');
    expect((await call(app, '/assets/missing.js', { headers: HOST })).status).toBe(404);
  });

  it('does not let a path leave the folder', async () => {
    const { app } = testApp({ staticDir: spa() });
    for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await call(app, path, { headers: HOST });
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain('outside');
    }
  });

  it('keeps unknown /api paths as JSON errors, not the SPA', async () => {
    const { app } = testApp({ staticDir: spa() });
    const res = await call(app, '/api/nothing', { headers: HOST });
    expect(res.status).toBe(404);
    expect((await res.json()) as unknown).toMatchObject({ error: { code: 'not_found' } });
  });

  it('says plainly when the app has not been built', async () => {
    const { app } = testApp({ staticDir: join(tempDir(), 'missing') });
    const res = await call(app, '/', { headers: HOST });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('pnpm build');
  });
});

describe('preview label', () => {
  it('adds a visible note and a title suffix only when asked', async () => {
    const plain = testApp({ staticDir: spa() });
    expect(await (await call(plain.app, '/', { headers: HOST })).text()).not.toContain(
      'Synthetic preview data',
    );

    const labelled = testApp({ staticDir: spa(), previewLabel: 'Synthetic preview data' });
    const html = await (await call(labelled.app, '/', { headers: HOST })).text();
    expect(html).toContain('<title>Agent Productivity HQ · Synthetic preview data</title>');
    expect(html).toMatch(
      /<body><aside aria-label="Preview data notice" data-preview-label style="[^"]*">Synthetic preview data<\/aside>/,
    );
  });

  it('escapes the label', () => {
    expect(withPreviewLabel(INDEX, '<img src=x onerror=1>')).not.toContain('<img');
  });
});
