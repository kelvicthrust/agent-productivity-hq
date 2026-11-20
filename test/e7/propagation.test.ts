import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateThemeCSS } from '@astryxdesign/core/theme';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { crewTheme } from '../../src/client/theme/generated/crewTheme';

// E7, the part that needs no browser: follow ONE product token (--color-action) through the real build and
// the real Astryx CSS to both consumers. This is a STATIC proof of the chain. test/e2e/e7-token-propagation.spec.ts
// is the rendered proof (it changes the token in a page and reads computed styles); it needs a browser that can
// start, which the sandbox this milestone was built in does not allow.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

interface OutputFile {
  type: 'asset' | 'chunk';
  fileName: string;
  source?: string | Uint8Array;
}

let css = '';

beforeAll(async () => {
  const result = await build({
    configFile: resolve(ROOT, 'vite.harness.config.ts'),
    logLevel: 'silent',
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) =>
    'output' in r ? (r.output as unknown as OutputFile[]) : [],
  );
  css = outputs
    .filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
    .map((o) => (typeof o.source === 'string' ? o.source : Buffer.from(o.source ?? '').toString()))
    .join('\n');
});

describe('E7: --color-action reaches Astryx and Tailwind (static chain)', () => {
  it('declares the product token once, in the astryx-theme layer', () => {
    const declarations = css.match(/--color-action:/g) ?? [];
    expect(declarations).toHaveLength(1);
    expect(css).toMatch(/@layer astryx-theme\s*\{\s*:root\s*\{[^}]*--color-action:#5a3fd6/i);
  });

  it('Tailwind consumer: bg-action and text-on-action read the token, not a copy of its value', () => {
    expect(css).toMatch(/\.bg-action\s*\{\s*background-color:\s*var\(--color-action\)\s*\}/);
    expect(css).toMatch(/\.text-on-action\s*\{\s*color:\s*var\(--color-on-action\)\s*\}/);
  });

  it("theme maps Astryx's accent roles onto the token", () => {
    const theme = generateThemeCSS(crewTheme).component ?? '';
    expect(theme).toContain('--color-accent: var(--color-action)');
    expect(theme).toContain('--color-on-accent: var(--color-on-action)');
    expect(theme).toContain('--color-text-accent: var(--color-action)');
  });

  it("Astryx consumer: the Button's primary variant paints with --color-accent and --color-on-accent", () => {
    // Button.js lists the compiled StyleX class names of each variant; astryx.css holds their rules.
    const buttonIndex = require.resolve('@astryxdesign/core/Button');
    const buttonSource = readFileSync(join(dirname(buttonIndex), 'Button.js'), 'utf8');
    const primary = /const variants = \{\s*primary: \{([^}]*)\}/.exec(buttonSource)?.[1] ?? '';
    const classes = [...primary.matchAll(/"(x[a-z0-9]+)"/g)].map((m) => m[1] as string);
    expect(classes.length, 'found no primary-variant classes in Button.js').toBeGreaterThan(0);

    const astryxCss = readFileSync(require.resolve('@astryxdesign/core/astryx.css'), 'utf8');
    const declared = (value: string): boolean =>
      classes.some((c) => new RegExp(`\\.${c}[^{]*\\{${value}\\}`).test(astryxCss));
    expect(declared('background-color:var\\(--color-accent\\)')).toBe(true);
    expect(declared('color:var\\(--color-on-accent\\)')).toBe(true);
  });
});

describe('cascade layers (the order Astryx documents for Tailwind)', () => {
  it('appear in the built CSS in the documented order', () => {
    const order = [...css.matchAll(/@layer ([a-z-]+)\s*[{;]/g)].map((m) => m[1] as string);
    const firstSeen = [...new Set(order)].filter((name) => name !== 'properties');
    expect(firstSeen).toEqual([
      'reset',
      'theme',
      'base',
      'astryx-base',
      'astryx-theme',
      'components',
      'utilities',
    ]);
  });
});

describe('crewTheme', () => {
  const theme = generateThemeCSS(crewTheme).component ?? '';

  it('sets the literal product value where Astryx and the product share a token name', () => {
    // A theme token cannot read itself, so these three must be literals, not var(--same-name).
    expect(theme).toContain('--color-border: #E8E1D6');
    expect(theme).toContain('--color-success: #1E7A46');
    expect(theme).toContain('--color-warning: #8A5A00');
  });

  it('has no token that refers to itself', () => {
    const selfReferences = [...theme.matchAll(/(--[a-z0-9-]+):\s*var\(\1\)/g)].map((m) => m[0]);
    expect(selfReferences).toEqual([]);
  });
});
