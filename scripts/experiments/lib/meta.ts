import { resolve } from 'node:path';
import { EXPERIMENT_IDS, type ExperimentMeta } from './types.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const EXPERIMENTS_DIR = resolve(REPO_ROOT, 'scripts/experiments');
export const FINDINGS_DIR = resolve(REPO_ROOT, 'docs/implementation/experiments');
export const findingsRelPath = (id: string): string => `docs/implementation/experiments/${id}.md`;
export const defaultFindingsPath = (id: string): string => resolve(REPO_ROOT, findingsRelPath(id));

const KEBAB = /^[a-z][a-z0-9-]{0,40}$/;
const PROGRAM = /^[a-z][a-z0-9._-]{0,30}$/;
const HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/;

/** Problems with a script's meta, one sentence each. Empty means it is usable. */
export function validateMeta(meta: ExperimentMeta): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  need(
    (EXPERIMENT_IDS as readonly string[]).includes(meta.id),
    `id must be one of ${EXPERIMENT_IDS.join(', ')}`,
  );
  need(
    /^scripts\/experiments\/e\d-[a-z0-9-]+\.ts$/.test(meta.script),
    'script must be scripts/experiments/e<n>-<name>.ts',
  );
  need(
    meta.title.trim().length > 0 && meta.title.length <= 120,
    'title must be 1 to 120 characters',
  );
  need(meta.question.trim().length > 0, 'question is required');
  need(meta.criteria.length > 0, 'at least one criterion is required');
  const ids = meta.criteria.map((c) => c.id);
  need(new Set(ids).size === ids.length, 'criterion ids must be unique');
  for (const c of meta.criteria) {
    need(KEBAB.test(c.id), `criterion id "${c.id}" must be lowercase letters, digits and dashes`);
    need(c.text.trim().length > 0, `criterion "${c.id}" needs text`);
  }
  for (const key of ['reads', 'prints', 'writes'] as const) {
    need(
      meta[key].length > 0 && meta[key].every((s) => s.trim().length > 0),
      `${key} must list at least one item`,
    );
  }
  need(
    meta.writes.some((w) => w.includes(findingsRelPath(meta.id))),
    `writes must name the findings file ${findingsRelPath(meta.id)}`,
  );
  for (const host of meta.network)
    need(HOST.test(host), `network entry "${host}" must be a hostname with an optional port`);
  for (const program of meta.spawns)
    need(PROGRAM.test(program), `spawns entry "${program}" must be a program name`);
  need(meta.selftest.length > 0, 'selftest needs at least one case');
  const first = meta.selftest[0];
  if (first) {
    const named = Object.keys(first.expect.verdicts).sort();
    need(
      JSON.stringify(named) === JSON.stringify([...ids].sort()),
      'the first selftest case must name a verdict for every criterion',
    );
  }
  for (const c of meta.selftest) {
    for (const id of Object.keys(c.expect.verdicts))
      need(ids.includes(id), `selftest "${c.name}" names unknown criterion "${id}"`);
  }
  return problems;
}
