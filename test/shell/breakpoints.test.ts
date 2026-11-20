import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

// The nav switch at 720px and the column at 1024px are plain CSS. A browser would show them; with none available
// this checks, statically, that each nav carries the class tokens that choose its width, and that the built CSS
// contains exactly those rules at the design's pixel breakpoints. It does not prove how they render.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** Class tokens of the first <nav className="..."> in a component source. */
function navClasses(file: string): string[] {
  const literal = /<nav[\s\S]*?className="([^"]+)"/.exec(read(file))?.[1] ?? '';
  return literal.split(/\s+/).filter(Boolean);
}

let css = '';
beforeAll(async () => {
  const result = await build({
    configFile: resolve(ROOT, 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) =>
    'output' in r
      ? (r.output as unknown as Array<{ fileName: string; source?: string | Uint8Array }>)
      : [],
  );
  css = outputs
    .filter((o) => o.fileName.endsWith('.css'))
    .map((o) => (typeof o.source === 'string' ? o.source : Buffer.from(o.source ?? '').toString()))
    .join('\n');
});

describe('nav breakpoints (static)', () => {
  it('SideNav is hidden by default and a flex container from 720px', () => {
    const tokens = navClasses('src/client/app/SideNav.tsx');
    expect(tokens).toContain('hidden');
    expect(tokens).toContain('min-[720px]:flex');
  });

  it('PhoneTabBar is shown by default and hidden from 720px', () => {
    const tokens = navClasses('src/client/app/PhoneTabBar.tsx');
    expect(tokens).toContain('flex');
    expect(tokens).not.toContain('hidden');
    expect(tokens).toContain('min-[720px]:hidden');
  });

  it('the built CSS has those rules at 720px, and the column rules at 1024px (px, not rem)', () => {
    expect(css).toMatch(/\.hidden\{display:none\}/);
    expect(css).toMatch(/@media \(width>=720px\)\{[^@]*\.min-\\\[720px\\\]\\:flex\{display:flex\}/);
    expect(css).toMatch(
      /@media \(width>=720px\)\{[^@]*\.min-\\\[720px\\\]\\:hidden\{display:none\}/,
    );
    expect(css).toMatch(
      /@media \(width>=1024px\)\{[^@]*\.min-\\\[1024px\\\]\\:col-start-2\{grid-column-start:2\}/,
    );
    expect(css, 'a rem-based lg breakpoint crept back in').not.toMatch(/\.lg\\:/);
  });
});
