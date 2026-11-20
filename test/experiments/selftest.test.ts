import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeMeta } from '../../scripts/experiments/lib/cli.ts';
import { verdictWord } from '../../scripts/experiments/lib/findings.ts';
import { validateMeta } from '../../scripts/experiments/lib/meta.ts';
import { findSecrets } from '../../scripts/experiments/lib/secrets.ts';
import { cleanupTmp, EXPECTED, loadExperiment, makeTmp, ROOT, runCase } from './harness.ts';

// C11: every script runs against synthetic fixtures, as a real child process in a clean environment, and must do what
// its own declaration says. A script that is missing, or does not declare itself properly, is a failing test.

const loaded = await Promise.all(
  EXPECTED.map(async (e) => ({ ...e, ...(await loadExperiment(e.script)) })),
);

const experimentsDir = join(ROOT, 'docs/implementation/experiments');
let findingsBefore: string[] = [];
beforeAll(() => {
  findingsBefore = readdirSync(experimentsDir);
});
afterAll(() => {
  // The self-test never writes into the real findings folder: a findings file there must mean the owner ran the script.
  expect(readdirSync(experimentsDir)).toEqual(findingsBefore);
  cleanupTmp();
});

describe.each(loaded)('$id selftest', ({ id, script, experiment, error }) => {
  it(`${id} script exists, exports a valid experiment and covers its criteria`, () => {
    expect(error).toBeNull();
    const { meta } = experiment!;
    expect(meta.id).toBe(id);
    expect(meta.script).toBe(script);
    expect(validateMeta(meta)).toEqual([]);
    expect(meta.selftest.length).toBeGreaterThanOrEqual(2);
    for (const criterion of meta.criteria) {
      const verdicts = meta.selftest.map((c) => c.expect.verdicts[criterion.id]);
      expect(verdicts, `${criterion.id} must be expected to pass in some case`).toContain('pass');
      expect(
        verdicts.some((v) => v === 'fail' || v === 'not-run'),
        `${criterion.id} must be expected to fail or not run in some case`,
      ).toBe(true);
    }
    expect(meta.selftest.some((c) => c.expect.exit === 1)).toBe(true);
  });

  if (!experiment) return;
  const { meta } = experiment;

  it(`${id} --list-reads prints the declaration and reads nothing`, () => {
    const home = makeTmp();
    const run = spawnSync(process.execPath, [join(ROOT, script), '--list-reads'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: join(home, 'nothing') },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(describeMeta(meta));
    expect(run.stdout).not.toContain('Will read:');
  });

  describe.each(meta.selftest)(`${id} case: $name`, (testCase) => {
    it('behaves as declared', () => {
      const run = runCase(script, id, testCase);
      expect(run.status, `stderr: ${run.stderr.slice(0, 400)}`).toBe(testCase.expect.exit);
      expect(run.stdout.split('\n')[0]).toBe(`${id} · ${meta.title}`);
      expect(run.stdout).toContain('Read-only and metadata-only');
      for (const text of testCase.expect.stdoutIncludes ?? []) expect(run.stdout).toContain(text);

      if (testCase.expect.exit === 2) {
        expect(run.stderr).toContain(`${id} stopped:`);
        expect(run.md).toBeNull();
        return;
      }
      // It declared what it touches before it touched it.
      expect(run.stdout).toMatch(/^Will (read|start|contact|write only)/m);
      const firstWill = run.stdout.search(/^Will (read|start|contact|write only)/m);
      expect(firstWill).toBeLessThan(run.stdout.indexOf('Findings written'));

      expect(run.json?.id).toBe(id);
      expect(run.md).toContain(`# ${id} · ${meta.title}`);
      expect(run.md).toContain(`- Result: **${verdictWord(run.json!.overall)}**`);
      expect(run.md).toMatch(/^## Criteria$/m);
      const byId = new Map(run.json!.criteria.map((c) => [c.id, c.verdict]));
      expect([...byId.keys()]).toEqual(meta.criteria.map((c) => c.id));
      for (const [criterion, verdict] of Object.entries(testCase.expect.verdicts)) {
        expect(byId.get(criterion), criterion).toBe(verdict);
        expect(run.md).toContain(`- **${verdictWord(verdict)}** \`${criterion}\``);
      }

      if (id === 'E1' || id === 'E2') {
        const markdown = run.md!;
        expect(findSecrets(markdown)).toEqual([]);
        expect(markdown).not.toMatch(/\/Users\/|\/home\/|\/var\/folders\/|\/private\/|[A-Za-z]:\\/);
        expect(markdown).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
        const startsCcusage = testCase.args.some(
          (arg) => arg.startsWith('ccusage=') && arg.endsWith('/fake-ccusage.ts'),
        );
        if (testCase.args.includes('--oracle') || startsCcusage) {
          expect(markdown).toMatch(/^## Reconciliation$/m);
          if (id === 'E2') expect(markdown).toMatch(/^## Replay prefix rules tried$/m);
        }
        if (startsCcusage) expect(markdown).toMatch(/^- Tools: .*ccusage \d/m);
      }

      // What it really did stays inside what it declared.
      const hosts = meta.network.map((h) => h.split(':')[0]);
      expect(run.json!.trace.programsStarted.filter((p) => !meta.spawns.includes(p))).toEqual([]);
      expect(run.json!.trace.hostsContacted.filter((h) => !hosts.includes(h))).toEqual([]);
      expect(run.json!.overall).toBe(testCase.expect.exit === 1 ? 'fail' : run.json!.overall);
    });
  });
});
