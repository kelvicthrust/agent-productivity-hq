import { describe, expect, it } from 'vitest';
import { experiment as e4 } from '../../scripts/experiments/e4-chatgpt.ts';
import { experiment as e8 } from '../../scripts/experiments/e8-claude-probe.ts';
import { renderFindings } from '../../scripts/experiments/lib/findings.ts';
import { findSecrets } from '../../scripts/experiments/lib/secrets.ts';
import type { FindingsDoc, Verdict } from '../../scripts/experiments/lib/types.ts';

// Synthetic reports exercise the G9_1 and G9_8 findings guards. E4 models a failed comparison.
// E8 models a prepared configuration without any live Claude Code observations.

interface Spec {
  id: 'E4' | 'E8';
  title: RegExp;
  /** Every criterion the script lists, read from the script itself so the two cannot drift. */
  criteria: string[];
}

const SPECS: Spec[] = [
  {
    id: 'E4',
    title: /^# E4 · ChatGPT account reads through the Codex app-server/m,
    criteria: e4.meta.criteria.map((c) => c.id),
  },
  {
    id: 'E8',
    title: /^# E8 · Claude status-line probe/m,
    criteria: e8.meta.criteria.map((c) => c.id),
  },
];

type Word = 'PASS' | 'FAIL' | 'NOT RUN';

const E4_COMPARISON_VERDICTS: Record<string, Word> = {
  'account-read-existing-signin': 'PASS',
  'usage-returns-buckets': 'PASS',
  'lookback-and-nulls-recorded': 'PASS',
  'overlap-window-compared': 'FAIL',
};

const E8_SETUP_ONLY_VERDICTS: Record<string, Word> = {
  'config-dir-prepared': 'PASS',
  'rate-limits-delivered': 'NOT RUN',
  'claude-version-recorded': 'NOT RUN',
  'snapshot-lands-before-cancel': 'NOT RUN',
  'project-statusline-override': 'NOT RUN',
  'concurrent-sessions-observed': 'NOT RUN',
  'footer-hints-recorded': 'NOT RUN',
  'hook-overhead-within-budget': 'NOT RUN',
};

/** The criteria a findings file lists: `- **PASS** \`id\` — …`. */
export function criteriaOf(text: string): Map<string, Word> {
  const found = new Map<string, Word>();
  for (const match of text.matchAll(/^- \*\*(PASS|FAIL|NOT RUN)\*\* `([a-z0-9-]+)` — /gm)) {
    found.set(match[2] as string, match[1] as Word);
  }
  return found;
}

/** The overall `- Result: **WORD**` line. */
export function resultOf(text: string): Word | null {
  const match = text.match(/^- Result: \*\*(PASS|FAIL|NOT RUN)\*\*/m);
  return (match?.[1] as Word | undefined) ?? null;
}

/** What is wrong with a findings text, or an empty list. */
export function problems(text: string, spec: Spec): string[] {
  const out: string[] = [];
  if (!spec.title.test(text)) out.push('the title line is missing');
  const result = resultOf(text);
  if (result === null) out.push('the Result line is missing');
  if (!/^## Criteria/m.test(text)) out.push('the Criteria section is missing');
  if (!/^- Ran at: \d{4}-\d{2}-\d{2}T/m.test(text)) out.push('the Ran at line is missing');
  const listed = criteriaOf(text);
  for (const id of spec.criteria) if (!listed.has(id)) out.push(`criterion ${id} is not listed`);
  // The overall result must agree with the criteria, as the writer computes it: any FAIL fails, else any PASS passes.
  const words = [...listed.values()];
  const expected: Word = words.includes('FAIL')
    ? 'FAIL'
    : words.includes('PASS')
      ? 'PASS'
      : 'NOT RUN';
  if (result !== null && listed.size > 0 && result !== expected)
    out.push(`the Result is ${result} but the criteria say ${expected}`);
  if (findSecrets(text).length > 0) out.push('a token-shaped value is present');
  if (/\/Users\/|\/home\/|\/var\/folders\/|\/private\/|[A-Za-z]:\\/.test(text))
    out.push('an absolute path is present');
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text))
    out.push('an e-mail address is present');
  return out;
}

/** What is wrong with a report of the synthetic E4 comparison failure, or an empty list. */
export function comparisonProblems(text: string): string[] {
  const listed = criteriaOf(text);
  const out: string[] = [];
  for (const [id, word] of Object.entries(E4_COMPARISON_VERDICTS)) {
    if (listed.get(id) !== word) out.push(`${id} is ${listed.get(id) ?? 'missing'}, not ${word}`);
  }
  const result = resultOf(text);
  if (result !== 'FAIL') out.push(`the Result is ${result ?? 'missing'}, not FAIL`);
  return out;
}

/**
 * What is wrong with a report of the synthetic setup-only E8 case, or an empty list. The Result is PASS only because the
 * one setup criterion passed; the Result line must still say that seven of eight criteria were not run.
 */
export function setupOnlyProblems(text: string): string[] {
  const listed = criteriaOf(text);
  const out: string[] = [];
  for (const [id, word] of Object.entries(E8_SETUP_ONLY_VERDICTS)) {
    if (listed.get(id) !== word) out.push(`${id} is ${listed.get(id) ?? 'missing'}, not ${word}`);
  }
  const result = resultOf(text);
  if (result !== 'PASS') out.push(`the Result is ${result ?? 'missing'}, not PASS`);
  if (!/^- Result: \*\*PASS\*\* \(7 of 8 criteria not run\)$/m.test(text))
    out.push('the Result line does not say that 7 of 8 criteria were not run');
  return out;
}

/** A findings file as the writer renders it, with the verdict of each criterion chosen by the caller. */
function synthetic(spec: Spec, verdicts: Partial<Record<string, Verdict>> = {}): string {
  const meta = spec.id === 'E4' ? e4.meta : e8.meta;
  const criteria = meta.criteria.map((c) => ({
    id: c.id,
    text: c.text,
    verdict: verdicts[c.id] ?? ('pass' as Verdict),
  }));
  const overall: Verdict = criteria.some((c) => c.verdict === 'fail')
    ? 'fail'
    : criteria.some((c) => c.verdict === 'pass')
      ? 'pass'
      : 'not-run';
  const doc: FindingsDoc = {
    id: spec.id,
    title: meta.title,
    ranAt: '2000-01-01T00:00:00.000Z',
    overall,
    environment: { node: 'v26.3.1', platform: 'darwin', arch: 'arm64', tools: {} },
    criteria,
    facts: [],
    notes: [],
    trace: {
      filesRead: 0,
      bytesRead: 0,
      programsStarted: [],
      hostsContacted: [],
      workspaceFolders: 0,
    },
  };
  return renderFindings(doc);
}

/** Built at run time: no token-shaped literal is committed (a secret scanner would flag one). */
const tokenShaped = (): string => ['ghu', 'A1b2C3d4E5'.repeat(4)].join('_');

describe('the E4 and E8 findings guard catches what it exists to catch (negative controls on synthetic copies)', () => {
  for (const spec of SPECS) {
    describe(spec.id, () => {
      const first = spec.criteria[0] as string;
      const last = spec.criteria[spec.criteria.length - 1] as string;

      it('is clean for a rendered findings file, so a failure below is the mutation and not the guard', () => {
        expect(problems(synthetic(spec), spec)).toEqual([]);
        expect(problems(synthetic(spec, { [first]: 'fail' }), spec)).toEqual([]);
        expect(
          problems(
            synthetic(spec, Object.fromEntries(spec.criteria.map((id) => [id, 'not-run']))),
            spec,
          ),
        ).toEqual([]);
      });

      it('notices a criterion that is missing from the list', () => {
        const removed = synthetic(spec)
          .split('\n')
          .filter((line) => !line.includes(`\`${last}\``))
          .join('\n');
        expect(problems(removed, spec)).toContain(`criterion ${last} is not listed`);
      });

      it('notices an overall Result that was turned into a pass over a failed criterion', () => {
        const failed = synthetic(spec, { [first]: 'fail' });
        const doctored = failed.replace(/^- Result: \*\*FAIL\*\*/m, '- Result: **PASS**');
        expect(doctored).not.toBe(failed);
        expect(problems(doctored, spec)).toContain('the Result is PASS but the criteria say FAIL');
      });

      it('notices a criterion that was turned from not-run into a pass without the Result following', () => {
        const allNotRun = synthetic(
          spec,
          Object.fromEntries(spec.criteria.map((id) => [id, 'not-run' as Verdict])),
        );
        expect(resultOf(allNotRun)).toBe('NOT RUN');
        const doctored = allNotRun.replace(
          new RegExp(`^- \\*\\*NOT RUN\\*\\* \`${first}\``, 'm'),
          `- **PASS** \`${first}\``,
        );
        expect(doctored).not.toBe(allNotRun);
        expect(problems(doctored, spec)).toContain(
          'the Result is NOT RUN but the criteria say PASS',
        );
      });

      it('notices a token-shaped value, an absolute path and an e-mail address', () => {
        const text = synthetic(spec);
        expect(problems(`${text}\n- leaked ${tokenShaped()}`, spec)).toContain(
          'a token-shaped value is present',
        );
        expect(problems(`${text}\n- file /Users/someone/x`, spec)).toContain(
          'an absolute path is present',
        );
        expect(problems(`${text}\n- someone@example.com`, spec)).toContain(
          'an e-mail address is present',
        );
      });

      it('notices a file that is not this experiment’s', () => {
        const other = SPECS.find((s) => s.id !== spec.id) as Spec;
        expect(problems(synthetic(other), spec)).toContain('the title line is missing');
      });
    });
  }
});

describe('the synthetic E4 comparison failure', () => {
  const e4Spec = SPECS.find((s) => s.id === 'E4') as Spec;
  const recorded = (): string => synthetic(e4Spec, { 'overlap-window-compared': 'fail' });

  it('is clean for a copy that has the recorded verdicts, so a failure below is the mutation and not the guard', () => {
    expect(comparisonProblems(recorded())).toEqual([]);
    expect(problems(recorded(), e4Spec)).toEqual([]);
  });

  it('notices the failed comparison turned into a pass, with the Result following', () => {
    const allPass = synthetic(e4Spec);
    expect(allPass).not.toBe(recorded());
    expect(comparisonProblems(allPass)).toEqual([
      'overlap-window-compared is PASS, not FAIL',
      'the Result is PASS, not FAIL',
    ]);
  });

  it('notices the failed comparison turned into not run', () => {
    const notRun = synthetic(e4Spec, {
      'account-read-existing-signin': 'pass',
      'usage-returns-buckets': 'pass',
      'lookback-and-nulls-recorded': 'pass',
      'overlap-window-compared': 'not-run',
    });
    expect(comparisonProblems(notRun)).toContain('overlap-window-compared is NOT RUN, not FAIL');
  });

  it('notices a recorded PASS that no longer passes, and a criterion that is missing', () => {
    const failed = synthetic(e4Spec, {
      'account-read-existing-signin': 'fail',
      'overlap-window-compared': 'fail',
    });
    expect(comparisonProblems(failed)).toContain('account-read-existing-signin is FAIL, not PASS');
    const removed = recorded()
      .split('\n')
      .filter((line) => !line.includes('`lookback-and-nulls-recorded`'))
      .join('\n');
    expect(comparisonProblems(removed)).toContain(
      'lookback-and-nulls-recorded is missing, not PASS',
    );
  });
});

describe('the synthetic E8 setup-only report', () => {
  const e8Spec = SPECS.find((s) => s.id === 'E8') as Spec;
  const setup = 'config-dir-prepared';
  const others = e8Spec.criteria.filter((id) => id !== setup);
  const recorded = (): string =>
    synthetic(e8Spec, Object.fromEntries(others.map((id) => [id, 'not-run' as Verdict])));

  it('is clean for a copy that has the recorded verdicts, so a failure below is the mutation and not the guard', () => {
    expect(others).toHaveLength(7);
    expect(setupOnlyProblems(recorded())).toEqual([]);
    expect(problems(recorded(), e8Spec)).toEqual([]);
  });

  it('notices a not-run criterion turned into a pass, with the Result still PASS', () => {
    const text = recorded();
    for (const id of others) {
      const doctored = text.replace(
        new RegExp(`^- \\*\\*NOT RUN\\*\\* \`${id}\``, 'm'),
        `- **PASS** \`${id}\``,
      );
      expect(doctored).not.toBe(text);
      expect(setupOnlyProblems(doctored)).toContain(`${id} is PASS, not NOT RUN`);
    }
  });

  it('notices every criterion passing, which is what an unobserved Claude Code must never look like', () => {
    const allPass = synthetic(e8Spec);
    expect(allPass).not.toBe(recorded());
    expect(setupOnlyProblems(allPass)).toHaveLength(others.length + 1);
    expect(setupOnlyProblems(allPass)).toContain(
      'the Result line does not say that 7 of 8 criteria were not run',
    );
  });

  it('notices a criterion that is missing, and the setup check turned into a failure or not run', () => {
    const removed = recorded()
      .split('\n')
      .filter((line) => !line.includes('`hook-overhead-within-budget`'))
      .join('\n');
    expect(setupOnlyProblems(removed)).toContain(
      'hook-overhead-within-budget is missing, not NOT RUN',
    );
    const failedSetup = synthetic(
      e8Spec,
      Object.fromEntries([[setup, 'fail'], ...others.map((id) => [id, 'not-run'])]),
    );
    expect(setupOnlyProblems(failedSetup)).toContain(`${setup} is FAIL, not PASS`);
    const allNotRun = synthetic(
      e8Spec,
      Object.fromEntries(e8Spec.criteria.map((id) => [id, 'not-run' as Verdict])),
    );
    expect(setupOnlyProblems(allNotRun)).toContain(`${setup} is NOT RUN, not PASS`);
  });

  it('notices a Result line that no longer says seven criteria were not run', () => {
    const doctored = recorded().replace(
      /^(- Result: \*\*PASS\*\*) \(7 of 8 criteria not run\)$/m,
      '$1',
    );
    expect(doctored).not.toBe(recorded());
    expect(setupOnlyProblems(doctored)).toEqual([
      'the Result line does not say that 7 of 8 criteria were not run',
    ]);
  });
});
