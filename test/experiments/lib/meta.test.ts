import { describe, expect, it } from 'vitest';
import { validateMeta } from '../../../scripts/experiments/lib/meta.ts';
import type { ExperimentMeta } from '../../../scripts/experiments/lib/types.ts';
import { experiment } from './support/good.ts';

const base = experiment.meta;
const with_ = (patch: Partial<ExperimentMeta>): string[] => validateMeta({ ...base, ...patch });

describe('validateMeta', () => {
  it('accepts a complete meta', () => {
    expect(validateMeta(base)).toEqual([]);
  });

  it.each([
    ['an unknown id', { id: 'E7' as never }, /id must be one of/],
    ['a script outside the folder', { script: 'src/server/x.ts' }, /script must be/],
    ['no criteria', { criteria: [] }, /at least one criterion/],
    ['duplicate criteria', { criteria: [base.criteria[0]!, base.criteria[0]!] }, /unique/],
    ['a bad criterion id', { criteria: [{ id: 'Bad Id', text: 'x' }] }, /lowercase/],
    ['an empty read list', { reads: [] }, /reads must list/],
    ['no findings file in writes', { writes: ['somewhere else'] }, /findings file/],
    ['a host with a scheme', { network: ['https://api.github.com'] }, /hostname/],
    ['a program with a path', { spawns: ['/usr/bin/gh'] }, /program name/],
    ['no selftest', { selftest: [] }, /selftest needs/],
  ] as const)('rejects %s', (_name, patch, message) => {
    expect(with_(patch as Partial<ExperimentMeta>).join(' | ')).toMatch(message);
  });

  it('requires the first selftest case to name every criterion, and only real ones', () => {
    const partial = {
      name: 'p',
      args: [],
      expect: { exit: 0 as const, verdicts: { 'reads-lines': 'pass' as const } },
    };
    expect(with_({ selftest: [partial] }).join(' | ')).toMatch(
      /first selftest case must name a verdict for every criterion/,
    );
    const wrong = {
      ...base.selftest[0]!,
      expect: {
        exit: 0 as const,
        verdicts: { ...base.selftest[0]!.expect.verdicts, nope: 'pass' as const },
      },
    };
    expect(with_({ selftest: [wrong] }).join(' | ')).toMatch(/unknown criterion "nope"/);
  });
});
