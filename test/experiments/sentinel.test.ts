import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupTmp,
  EXPECTED,
  FIXTURES,
  loadExperiment,
  makeTmp,
  runCase,
  scanForSentinels,
  sentinelsWrittenBelow,
} from './harness.ts';

// G3_7: fixtures hold SENTINEL strings where real data would hold message text, titles, prompts and secrets. Every
// self-test case runs the script over them and none may appear in stdout, stderr, the findings or the result.

const loaded = await Promise.all(
  EXPECTED.map(async (e) => ({ ...e, ...(await loadExperiment(e.script)) })),
);
afterAll(cleanupTmp);

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesBelow(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** The fixture folders (test/fixtures/<name>) a case's arguments point into. */
function fixtureFolders(args: string[]): string[] {
  const found = new Set<string>();
  for (const arg of args) {
    const at = arg.indexOf(`${FIXTURES}/`);
    if (at < 0) continue;
    const name = arg.slice(at + FIXTURES.length + 1).split('/')[0];
    if (name) found.add(join(FIXTURES, name));
  }
  return [...found];
}

describe.each(loaded)('$id sentinel', ({ id, script, experiment, error }) => {
  it(`${id} is loadable`, () => {
    expect(error).toBeNull();
  });
  if (!experiment) return;

  it(`${id} runs over fixtures that really contain sentinels, so the scan below is not vacuous`, () => {
    for (const testCase of experiment.meta.selftest) {
      const args = testCase.args.map((a) => a.replaceAll('{fixtures}', FIXTURES));
      const folders = fixtureFolders([
        ...args,
        ...Object.values(testCase.env ?? {}).map((v) => v.replaceAll('{fixtures}', FIXTURES)),
      ]);
      expect(
        folders.length,
        `case "${testCase.name}" must read from test/fixtures`,
      ).toBeGreaterThan(0);
    }
    const folders = new Set(
      experiment.meta.selftest.flatMap((c) =>
        fixtureFolders(
          [...c.args, ...Object.values(c.env ?? {})].map((a) =>
            a.replaceAll('{fixtures}', FIXTURES),
          ),
        ),
      ),
    );
    const withSentinel = [...folders].filter(
      (dir) =>
        statSync(dir).isDirectory() &&
        filesBelow(dir).some((f) => scanForSentinels(readFileSync(f, 'utf8')).length > 0),
    );
    expect(
      withSentinel.length,
      `${id} must read at least one fixture folder that contains SENTINEL strings`,
    ).toBeGreaterThan(0);
  });

  describe.each(experiment.meta.selftest)(`${id} case: $name`, (testCase) => {
    it('prints, writes and records no sentinel', () => {
      const run = runCase(script, id, testCase);
      expect(run.status, `stderr: ${run.stderr.slice(0, 300)}`).toBe(testCase.expect.exit);
      expect(scanForSentinels(run.stdout), 'standard output').toEqual([]);
      expect(scanForSentinels(run.stderr), 'standard error').toEqual([]);
      expect(scanForSentinels(run.md), 'findings file').toEqual([]);
      expect(scanForSentinels(run.json ? JSON.stringify(run.json) : null), 'result file').toEqual(
        [],
      );
      expect(sentinelsWrittenBelow(run.tmp), 'files written below the temp folder').toEqual([]);
    });
  });
});

describe('the written-files scan catches a leak (negative control)', () => {
  it('finds a sentinel in a file, in a nested file and in a file name, and passes a clean folder', () => {
    const clean = makeTmp();
    writeFileSync(join(clean, 'settings.json'), '{"theme":"dark"}\n');
    expect(sentinelsWrittenBelow(clean)).toEqual([]);

    const leaky = makeTmp();
    mkdirSync(join(leaky, 'crew-e8-x', 'claude-config'), { recursive: true });
    writeFileSync(
      join(leaky, 'crew-e8-x', 'claude-config', 'settings.json'),
      'SENTINEL_TOKEN_a41c07',
    );
    writeFileSync(join(leaky, 'SENTINEL_NOTE_1f2e3d.txt'), 'x');
    expect(sentinelsWrittenBelow(leaky).sort()).toEqual([
      'SENTINEL_NOTE_1f2e3d.txt',
      join('crew-e8-x', 'claude-config', 'settings.json'),
    ]);
  });
});
