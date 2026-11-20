import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT, techTable } from './techTable.ts';
import { readFileSync } from 'node:fs';

// `techTable` reads the OBLIGATION table under a TECH.md heading: the security risks, the performance budgets. TECH's Performance
// section now also holds an "####" subsection with the retained chart measurements, a table of observations. Read as obligations,
// those rows made the required benchmark suite fail on "Retained operation" and nine timing rows it was never meant to time. These
// tests pin that only the section's own first table is an obligation table, on a file built for the purpose and on the real TECH.md.

const dir = mkdtempSync(join(tmpdir(), 'techtable-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

const OBLIGATIONS = [
  '| Obligation | Budget | Mechanism | Verified by |',
  '| --- | --- | --- | --- |',
  '| Overview interactive | ≤ 1 s | Indexed scans | Bench |',
  '| UI rendering | ≤ 16 ms | Memoized SVG | Browser clock |',
].join('\n');
const OBSERVATIONS = [
  '| Retained operation | Samples | p95 | Maximum |',
  '| --- | --- | --- | --- |',
  '| Pointer work | 200 | 1.1ms | 1.2ms |',
].join('\n');

describe('techTable reads only the obligation table of a section', () => {
  it('reads every row of the first table (so an empty parse cannot pass)', () => {
    const file = write(
      'plain.md',
      `### Performance\n\nMeasured on a year.\n\n${OBLIGATIONS}\n\n### Next\n`,
    );
    expect(techTable('Performance', file).map((row) => row.risk)).toEqual([
      'Overview interactive',
      'UI rendering',
    ]);
  });

  it('leaves out a table under an "####" subsection of the same section', () => {
    const file = write(
      'sub.md',
      `### Performance\n\n${OBLIGATIONS}\n\n#### Chart redraw measurement and check\n\nRetained run.\n\n${OBSERVATIONS}\n\n### Next\n`,
    );
    expect(techTable('Performance', file).map((row) => row.risk)).toEqual([
      'Overview interactive',
      'UI rendering',
    ]);
  });

  it('leaves out a second table that follows prose in the same section', () => {
    const file = write(
      'prose.md',
      `### Performance\n\n${OBLIGATIONS}\n\nWhat was measured:\n\n${OBSERVATIONS}\n`,
    );
    expect(techTable('Performance', file).map((row) => row.risk)).toEqual([
      'Overview interactive',
      'UI rendering',
    ]);
  });

  it('still names a section that is missing', () => {
    const file = write('none.md', `### Other\n\n${OBLIGATIONS}\n`);
    expect(() => techTable('Performance', file)).toThrow(/has no "### Performance" section/);
  });
});

describe('the real TECH.md', () => {
  const lines = readFileSync(join(ROOT, 'TECH.md'), 'utf8').split('\n');

  /** The first cell of every table row under each "####" heading inside the "### <heading>" section: observations, found by their own. */
  const supportingRows = (heading: string): string[] => {
    const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
    const out: string[] = [];
    let inSub = false;
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,3} /.test(line)) break;
      if (/^#### /.test(line)) inSub = true;
      if (inSub && line.startsWith('|') && !/^\|\s*-/.test(line)) {
        out.push(
          line
            .replace(/^\|\s*/, '')
            .split(/\s+\|\s+/)[0]!
            .trim(),
        );
      }
    }
    return out;
  };

  it('does not read the Performance section’s retained measurements as obligations', () => {
    const supporting = supportingRows('Performance (proposed budgets; owner may change)');
    expect(supporting.length, 'the retained measurements table is found').toBeGreaterThan(1);
    const obligations = techTable('Performance (proposed budgets; owner may change)').map(
      (row) => row.risk,
    );
    expect(obligations.length).toBeGreaterThanOrEqual(7);
    expect(obligations).toContain('UI rendering');
    expect(obligations.filter((risk) => supporting.includes(risk))).toEqual([]);
  });

  it('still reads every row of the Security table', () => {
    const rows = techTable('Security and privacy');
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.map((row) => row.risk)).toContain('XSS');
  });
});
