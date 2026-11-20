import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSecrets } from '../../scripts/experiments/lib/secrets.ts';
import { FIXTURE_DIRS, FIXTURES, ROOT, scanForSentinels } from './harness.ts';

// G3_8: a draft synthetic fixture folder for every source, labelled, invented, small and free of anything that could be a
// real credential. A fixture that fails these rules would make the sentinel test meaningless or put a secret in the repo.

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesBelow(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe.each(FIXTURE_DIRS)('fixtures/%s', (name) => {
  const dir = join(FIXTURES, name);
  const exists = (() => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  })();

  it('exists, with a README that labels it DRAFT-documented-shape and says where each shape comes from', () => {
    expect(exists, `test/fixtures/${name} is missing`).toBe(true);
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('DRAFT-documented-shape');
    expect(readme).toMatch(/docs\/tech\/|TECH\.md/);
    expect(readme.toLowerCase()).toContain('invented');
  });

  it('holds SENTINEL strings where real data would hold text or secrets', () => {
    expect(exists).toBe(true);
    const withSentinel = filesBelow(dir).filter(
      (f) => scanForSentinels(readFileSync(f, 'utf8')).length > 0,
    );
    expect(withSentinel.length).toBeGreaterThan(0);
  });

  it('has no token-shaped value, no path outside the repo and no real-looking address', () => {
    expect(exists).toBe(true);
    for (const file of filesBelow(dir)) {
      const text = readFileSync(file, 'utf8');
      const where = relative(ROOT, file);
      expect(findSecrets(text), `${where} must not contain a token-shaped value`).toEqual([]);
      expect(text, `${where} must not name a path outside the repo`).not.toMatch(
        /\/Users\/|\/home\/|\/private\/var|C:\\Users/,
      );
      expect(text, `${where} must not hold an email address`).not.toMatch(
        /[A-Za-z0-9._%+-]+@(?!example\.(?:com|test|org))[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      );
    }
  });

  it('stays small and hand-written: each file under 64 KB, the folder under 512 KB', () => {
    expect(exists).toBe(true);
    const sizes = filesBelow(dir).map((f) => statSync(f).size);
    expect(Math.max(...sizes)).toBeLessThan(64 * 1024);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(512 * 1024);
    expect(sizes.length).toBeLessThan(80);
  });
});
