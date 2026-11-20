import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findDrift, generateAll, OUT_FILES } from '../../scripts/generate-tokens.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Custom properties declared in the :root block of a CSS file, comments removed, whitespace collapsed. */
function rootVars(css: string): Map<string, string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(noComments)?.[1] ?? '';
  const vars = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars.set(m[1] as string, (m[2] as string).replace(/\s+/g, ' ').trim());
  }
  return vars;
}

describe('design tokens', () => {
  const generated = generateAll(ROOT);

  it('generated :root values equal the D4 prototype tokens.css (comments excluded)', () => {
    const want = rootVars(read('docs/design/prototype/tokens.css'));
    const got = rootVars(generated[OUT_FILES.tokens] as string);
    // The parser must have captured every declaration in the prototype file, so an empty or partial
    // parse cannot pass vacuously.
    const declared =
      read('docs/design/prototype/tokens.css')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .match(/^\s*--[a-z0-9-]+\s*:/gm) ?? [];
    expect(want.size).toBe(declared.length);
    expect(want.size).toBeGreaterThan(0);
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
    const mismatched = [...want].filter(([name, value]) => got.get(name) !== value);
    expect(mismatched).toEqual([]);
  });

  it('the committed generated files match a fresh generation', () => {
    expect(findDrift(ROOT, generated)).toEqual([]);
  });

  it('flags a generated file that was edited by hand, and a missing one', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'crew-tokens-'));
    for (const [rel, content] of Object.entries(generated)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), content);
    }
    expect(findDrift(tmp, generated)).toEqual([]);
    writeFileSync(
      join(tmp, OUT_FILES.tokens),
      (generated[OUT_FILES.tokens] as string).replace('#5A3FD6', '#FF0000'),
    );
    expect(findDrift(tmp, generated)).toEqual([OUT_FILES.tokens]);
    writeFileSync(join(tmp, OUT_FILES.theme), '');
    expect(findDrift(tmp, generated)).toEqual([OUT_FILES.tokens, OUT_FILES.theme]);
  });
});
