import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './cli.ts';
import { EXPERIMENTS_DIR, findingsRelPath, REPO_ROOT } from './meta.ts';
import type { Experiment, ExperimentMeta } from './types.ts';

// The runbook's per-script part is generated from each script's own `meta`, so what the document says a script reads,
// prints, contacts and starts cannot drift from what the script declares (and the guards enforce the declaration).
//   node scripts/experiments/lib/runbook.ts --check   exit 1 if docs/implementation/experiments/README.md is out of date
//   node scripts/experiments/lib/runbook.ts --write   regenerate that part of the README

export const README_PATH = resolve(REPO_ROOT, 'docs/implementation/experiments/README.md');
export const BEGIN =
  '<!-- BEGIN GENERATED RUNBOOK: node scripts/experiments/lib/runbook.ts --write -->';
export const END = '<!-- END GENERATED RUNBOOK -->';

const bulleted = (items: string[], none = 'none'): string =>
  items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : `- ${none}`;

export function renderOne(meta: ExperimentMeta): string {
  return [
    `### ${meta.id} · ${meta.title}`,
    '',
    `Script: \`${meta.script}\``,
    '',
    `Question: ${meta.question}`,
    '',
    'Run it:',
    '',
    '```sh',
    meta.example ?? `node ${meta.script}`,
    '```',
    '',
    '**Reads**',
    '',
    bulleted(meta.reads),
    '',
    '**Prints**',
    '',
    bulleted(meta.prints),
    '',
    '**Writes**',
    '',
    bulleted(meta.writes),
    '',
    '**Network**',
    '',
    bulleted(meta.network, 'none: this script uses no network'),
    '',
    '**Starts programs**',
    '',
    bulleted(meta.spawns, 'none'),
    '',
    '**Pass criteria**',
    '',
    bulleted(meta.criteria.map((c) => `\`${c.id}\` — ${c.text}`)),
    '',
    `**Findings file:** the script writes \`${findingsRelPath(meta.id)}\` by default. Keep results from real environments private.`,
  ].join('\n');
}

export function renderRunbook(metas: readonly ExperimentMeta[]): string {
  const sorted = [...metas].sort((a, b) => a.id.localeCompare(b.id));
  const body =
    sorted.length > 0
      ? sorted.map(renderOne).join('\n\n')
      : 'No experiment scripts have been added yet.';
  return `${BEGIN}\n\n${body}\n\n${END}`;
}

/** The README with its generated part replaced, or null when the markers are missing. */
export function splice(readme: string, block: string): string | null {
  const start = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) return null;
  return `${readme.slice(0, start)}${block}${readme.slice(end + END.length)}`;
}

export async function discoverMetas(dir: string = EXPERIMENTS_DIR): Promise<ExperimentMeta[]> {
  const metas: ExperimentMeta[] = [];
  for (const name of readdirSync(dir)
    .filter((n) => /^e\d+-[a-z0-9-]+\.ts$/.test(n))
    .sort()) {
    const mod = (await import(pathToFileURL(join(dir, name)).href)) as { experiment?: Experiment };
    if (!mod.experiment?.meta)
      throw new Error(
        `${name} does not export \`experiment\` (see scripts/experiments/lib/CONTRACT.md).`,
      );
    metas.push(mod.experiment.meta);
  }
  return metas;
}

async function main(argv: string[]): Promise<number> {
  const mode = argv.includes('--write') ? 'write' : argv.includes('--check') ? 'check' : null;
  if (!mode) {
    console.error('Use --check or --write.');
    return 2;
  }
  if (!existsSync(README_PATH)) {
    console.error(`Missing ${README_PATH}`);
    return 1;
  }
  const readme = readFileSync(README_PATH, 'utf8');
  const next = splice(readme, renderRunbook(await discoverMetas()));
  if (next === null) {
    console.error(`The README has no generated section: add the lines\n${BEGIN}\n${END}`);
    return 1;
  }
  if (mode === 'write') {
    writeFileSync(README_PATH, next);
    console.log('Runbook updated.');
    return 0;
  }
  if (next !== readme) {
    console.error(
      'The runbook in docs/implementation/experiments/README.md is out of date. Run: node scripts/experiments/lib/runbook.ts --write',
    );
    return 1;
  }
  console.log('Runbook matches the scripts.');
  return 0;
}

if (isMain(import.meta.filename)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
