import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BEGIN,
  discoverMetas,
  END,
  README_PATH,
  renderRunbook,
  splice,
} from '../../scripts/experiments/lib/runbook.ts';
import { EXPECTED } from './harness.ts';

// G3_9: the README lists, per script, exactly what it declares. The generated part cannot drift (this fails if it does),
// and it covers every script this milestone delivers.

describe('runbook', () => {
  it('matches what the scripts declare, and names every script', async () => {
    const readme = readFileSync(README_PATH, 'utf8');
    const metas = await discoverMetas();
    expect(metas.map((m) => m.id).sort()).toEqual(EXPECTED.map((e) => e.id).sort());
    expect(splice(readme, renderRunbook(metas))).toBe(readme);
    for (const meta of metas) {
      for (const item of [
        ...meta.reads,
        ...meta.prints,
        ...meta.writes,
        ...meta.network,
        ...meta.spawns,
      ])
        expect(readme, `${meta.id}: ${item}`).toContain(`- ${item}`);
      for (const c of meta.criteria) expect(readme).toContain(`\`${c.id}\` — ${c.text}`);
      expect(readme).toContain(`### ${meta.id} · ${meta.title}`);
      expect(readme).toContain(meta.example ?? `node ${meta.script}`);
    }
    expect(readme).toContain(BEGIN);
    expect(readme).toContain(END);
  });

  it('keeps its promises in plain words, outside the generated part', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    for (const phrase of [
      'Read-only.',
      'Metadata only.',
      'Will read:',
      'ccusage',
      'CLAUDE_CONFIG_DIR',
      'A public checkout includes no owner-run reports.',
      'Exit codes',
    ])
      expect(readme).toContain(phrase);
  });
});
