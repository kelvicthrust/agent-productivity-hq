import { extname, resolve, sep } from 'node:path';
import type { Page } from '@playwright/test';

// Serves a built folder to a Playwright page through request interception, on a made-up origin. No server
// and no port: it works where a process may not listen (the sandbox this project's first milestone was built
// in) and anywhere else. The page still loads the production build exactly as a browser would.
export const ORIGIN = 'http://crew.test';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Map a request URL to a file under `root`. A path with no extension is a client route and gets index.html.
 * Returns null for anything that would leave `root`.
 */
export function resolveRequest(
  root: string,
  url: string,
): { file: string; contentType: string } | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const target = extname(pathname) === '' ? '/index.html' : pathname;
  const base = resolve(root);
  const file = resolve(base, `.${target}`);
  if (file !== base && !file.startsWith(base + sep)) return null;
  return { file, contentType: TYPES[extname(file)] ?? 'application/octet-stream' };
}

/** The answer for an /api path when no API is wired: the error envelope, never the app shell. */
const NO_API = JSON.stringify({
  error: {
    code: 'not_found',
    message:
      'No API is served on this origin. Use serveWorld (helpers/world.ts) for a spec that needs one.',
    retryable: false,
  },
});

export async function serveBuild(page: Page, root: string): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    if (new URL(route.request().url()).pathname.startsWith('/api/')) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: NO_API });
      return;
    }
    const hit = resolveRequest(root, route.request().url());
    if (!hit) {
      await route.fulfill({ status: 403, body: 'Forbidden' });
      return;
    }
    try {
      await route.fulfill({ path: hit.file, contentType: hit.contentType });
    } catch {
      await route.fulfill({ status: 404, body: 'Not found' });
    }
  });
}
