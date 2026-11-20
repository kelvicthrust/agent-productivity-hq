import { readFileSync } from 'node:fs';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import {
  BEGIN,
  END,
  README_PATH,
  renderRunbook,
  splice,
} from '../../../scripts/experiments/lib/runbook.ts';
import { experiment as good } from './support/good.ts';

const other = {
  ...good.meta,
  id: 'E3' as const,
  script: 'scripts/experiments/e3-other.ts',
  title: 'Other',
  network: [],
  spawns: [],
  writes: ['docs/implementation/experiments/E3.md (the findings)'],
};

describe('runbook generator', () => {
  it('lists each script’s declaration and where it saves local findings', () => {
    const text = renderRunbook([good.meta]);
    for (const item of [
      ...good.meta.reads,
      ...good.meta.prints,
      ...good.meta.writes,
      ...good.meta.network,
      ...good.meta.spawns,
    ])
      expect(text).toContain(`- ${item}`);
    for (const c of good.meta.criteria) expect(text).toContain(`- \`${c.id}\` — ${c.text}`);
    expect(text).toContain('### E1 · Support experiment');
    expect(text).toContain('node scripts/experiments/e1-support.ts');
    expect(text).toContain('docs/implementation/experiments/E1.md');
    expect(text).toContain('Keep results from real environments private.');
    expect(text.startsWith(BEGIN)).toBe(true);
    expect(text.endsWith(END)).toBe(true);
  });

  it('says plainly when a script uses no network and starts no programs', () => {
    const text = renderRunbook([other]);
    expect(text).toContain('- none: this script uses no network');
    expect(text).toMatch(/\*\*Starts programs\*\*\n\n- none/);
  });

  it('uses the script’s own example command when it has one', () => {
    expect(
      renderRunbook([
        { ...good.meta, example: 'node scripts/experiments/e1-support.ts --oracle oracle.json' },
      ]),
    ).toContain('--oracle oracle.json');
  });

  it('is deterministic and ordered by id; empty says so', () => {
    expect(renderRunbook([other, good.meta])).toBe(renderRunbook([good.meta, other]));
    expect(renderRunbook([other, good.meta]).indexOf('### E1')).toBeLessThan(
      renderRunbook([other, good.meta]).indexOf('### E3'),
    );
    expect(renderRunbook([])).toContain('No experiment scripts have been added yet.');
  });

  it('replaces only the generated block, and reports missing markers', () => {
    const readme = `intro\n\n${BEGIN}\n\nSTALE_BLOCK\n\n${END}\n\noutro\n`;
    const next = splice(readme, renderRunbook([good.meta]));
    expect(next?.startsWith('intro\n\n')).toBe(true);
    expect(next?.endsWith('\n\noutro\n')).toBe(true);
    expect(next).toContain('### E1 · Support experiment');
    expect(next).not.toContain('STALE_BLOCK');
    expect(splice('no markers here', 'x')).toBeNull();
    expect(splice(`${END}\n${BEGIN}`, 'x')).toBeNull();
  });

  it('keeps the whole README Prettier-stable with scripts in it, so format:check stays green after a regeneration', async () => {
    const next = splice(readFileSync(README_PATH, 'utf8'), renderRunbook([good.meta, other])) ?? '';
    const config = (await prettier.resolveConfig(README_PATH)) ?? {};
    expect(await prettier.format(next, { ...config, parser: 'markdown' })).toBe(next);
  });
});
