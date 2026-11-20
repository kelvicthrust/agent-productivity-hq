import { describe, expect, it } from 'vitest';
import { experiment as e3 } from '../../scripts/experiments/e3-paseo.ts';
import { experiment as e5 } from '../../scripts/experiments/e5-evidence.ts';
import { renderFindings } from '../../scripts/experiments/lib/findings.ts';
import { findSecrets } from '../../scripts/experiments/lib/secrets.ts';
import type { FindingsDoc, Verdict } from '../../scripts/experiments/lib/types.ts';

// Synthetic E3 and E5 reports exercise the structure, privacy and result checks for G8_1.

interface Spec {
  id: 'E3' | 'E5';
  title: RegExp;
  /** Every criterion the script lists, read from the script itself so the two cannot drift. */
  criteria: string[];
}

const SPECS: Spec[] = [
  {
    id: 'E3',
    title: /^# E3 · Paseo daemon listing/m,
    criteria: e3.meta.criteria.map((c) => c.id),
  },
  {
    id: 'E5',
    title: /^# E5 · Evidence availability/m,
    criteria: e5.meta.criteria.map((c) => c.id),
  },
];

type Word = 'PASS' | 'FAIL' | 'NOT RUN';

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

/** A findings file as the writer renders it, with the verdict of each criterion chosen by the caller. */
function synthetic(spec: Spec, verdicts: Partial<Record<string, Verdict>> = {}): string {
  const meta = spec.id === 'E3' ? e3.meta : e5.meta;
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
    ranAt: '2026-11-12T12:00:00.000Z',
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

describe('the E3 and E5 findings guard catches what it exists to catch (negative controls on synthetic copies)', () => {
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
        const real = synthetic(spec);
        expect(problems(`${real}\n- leaked ${tokenShaped()}`, spec)).toContain(
          'a token-shaped value is present',
        );
        expect(problems(`${real}\n- file /Users/someone/x`, spec)).toContain(
          'an absolute path is present',
        );
        expect(problems(`${real}\n- someone@example.com`, spec)).toContain(
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
