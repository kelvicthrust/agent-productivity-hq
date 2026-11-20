import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The two self-hosted fonts (no font CDN): each is one latin woff2 beside its SIL OFL text, and globals.css points at it.

const fonts = new URL('../../src/client/theme/fonts/', import.meta.url);
const css = readFileSync(new URL('../../src/client/theme/globals.css', import.meta.url), 'utf8');

describe.each([
  {
    family: 'Nunito',
    file: 'nunito-latin-wght.woff2',
    licence: 'OFL.txt',
    copyright: 'Copyright 2014 The Nunito Project Authors',
  },
  {
    family: 'Shantell Sans',
    file: 'shantell-sans-latin-wght.woff2',
    licence: 'OFL-ShantellSans.txt',
    copyright: 'Copyright 2022 The Shantell Sans Project Authors',
  },
])('$family', ({ family, file, licence, copyright }) => {
  it('is a small woff2 file', () => {
    const bytes = readFileSync(new URL(file, fonts));
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(statSync(new URL(file, fonts)).size).toBeLessThan(100_000);
  });

  it('keeps its licence beside it', () => {
    const text = readFileSync(new URL(licence, fonts), 'utf8');
    expect(text).toContain(copyright);
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('is declared once in globals.css, from the local file, with a swap', () => {
    const face = new RegExp(`@font-face\\s*{[^}]*font-family: '${family}';[^}]*}`).exec(css)?.[0];
    expect(face).toBeDefined();
    expect(face).toContain(`url('./fonts/${file}') format('woff2')`);
    expect(face).toContain('font-display: swap');
    expect(face).not.toMatch(/https?:/);
  });
});
