import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Context } from 'hono';

// Serves the built SPA (dist/client) with history fallback: an unknown path without a file extension gets index.html so
// the router can handle it. Paths are decoded and confined to the root, so `..` cannot leave it. Nothing here is cached
// by the browser (the security-headers middleware sets no-store on every response).

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** The file a URL path names inside `root`, or null when it escapes the root or is malformed. */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const base = resolve(root);
  const target = resolve(join(base, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`));
  return target === base || target.startsWith(base + sep) ? target : null;
}

async function fileAt(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const PREVIEW_STYLE =
  'position:fixed;left:8px;bottom:calc(var(--bottomnav-h,0px) + 8px);z-index:2147483647;margin:0;padding:4px 10px;' +
  'border:1px solid #78716c;border-radius:4px;background:#fffbeb;color:#1c1917;font:600 12px/1.4 system-ui,sans-serif;' +
  'pointer-events:none';

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** Adds the preview label to the page: a note in the corner and a title suffix. Only the preview command asks for it. */
export function withPreviewLabel(html: string, label: string): string {
  const text = escapeHtml(label);
  const note = `<aside aria-label="Preview data notice" data-preview-label style="${PREVIEW_STYLE}">${text}</aside>`;
  return html
    .replace(/<title>([^<]*)<\/title>/, (_m, title: string) => `<title>${title} · ${text}</title>`)
    .replace(/<body([^>]*)>/, (_m, attrs: string) => `<body${attrs}>${note}`);
}

const NOT_BUILT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent Productivity HQ</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<main><h1>The app has not been built yet</h1><p>The server is running, but there is no built interface to show.
Run <code>pnpm build</code>, then reload this page.</p></main></body></html>`;

export function staticHandler(root: string, options: { previewLabel?: string | undefined } = {}) {
  const page = async (): Promise<string | null> => {
    try {
      const html = await readFile(join(root, 'index.html'), 'utf8');
      return options.previewLabel ? withPreviewLabel(html, options.previewLabel) : html;
    } catch {
      return null;
    }
  };

  return async (c: Context): Promise<Response> => {
    if (c.req.method !== 'GET') return c.notFound();
    const path = new URL(c.req.url).pathname;
    const target = resolveInside(root, path);
    if (!target) return c.text('Not found', 404);

    if (extname(path) !== '' && extname(path) !== '.html') {
      if (!(await fileAt(target))) return c.text('Not found', 404);
      return c.body(new Uint8Array(await readFile(target)), 200, {
        'Content-Type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      });
    }

    const html = await page();
    if (html === null) return c.html(NOT_BUILT, 503);
    return c.html(html);
  };
}
