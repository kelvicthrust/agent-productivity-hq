import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORIGIN, resolveRequest } from './virtualOrigin';

// Pure logic of the interception helper, so it is checked even where no browser can start.
const root = resolve('/tmp/crew-build');
const at = (path: string) => resolveRequest(root, `${ORIGIN}${path}`);

describe('resolveRequest', () => {
  it('serves files by path with the right content type', () => {
    expect(at('/assets/index-abc.js')).toEqual({
      file: resolve(root, 'assets/index-abc.js'),
      contentType: 'text/javascript; charset=utf-8',
    });
    expect(at('/assets/index-abc.css')?.contentType).toBe('text/css; charset=utf-8');
    expect(at('/index.html')?.file).toBe(resolve(root, 'index.html'));
  });

  it('gives client routes (no extension) the app shell', () => {
    for (const route of ['/', '/usage', '/sources', '/deep/link/here']) {
      expect(at(route)?.file, route).toBe(resolve(root, 'index.html'));
    }
  });

  it('never leaves the build folder', () => {
    // The URL parser already collapses literal and %2e-encoded dot segments to a path inside the root;
    // either way the answer must be inside the root or null.
    for (const evil of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/../../secret.txt',
      '/..%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
    ]) {
      const hit = at(evil);
      expect(hit === null || hit.file.startsWith(root + sep), evil).toBe(true);
    }
    // A dot segment hidden behind %2f survives URL parsing and is what the guard exists for.
    expect(at('/..%2fsecret.txt')).toBeNull();
    expect(at('/assets/..%2f..%2fsecret.txt')).toBeNull();
  });

  it('rejects a malformed escape', () => {
    expect(at('/%E0%A4%A.js')).toBeNull();
  });
});
