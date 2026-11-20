import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Experiment, FindingsDoc, SelftestCase } from '../../scripts/experiments/lib/types.ts';

// Shared by the harness tests: which scripts must exist, how a self-test case is run (a real `node` child process in a
// clean environment, like an owner running it), and how output is scanned for sentinel strings.

export const ROOT = resolve(import.meta.dirname, '../..');
export const FIXTURES = join(ROOT, 'test/fixtures');
export const FIXED_NOW = '2026-11-08T12:00:00Z';

/** The scripts this milestone delivers. A missing one is a failing test, not a skipped one. */
export const EXPECTED = [
  { id: 'E1', script: 'scripts/experiments/e1-claude.ts' },
  { id: 'E2', script: 'scripts/experiments/e2-codex.ts' },
  { id: 'E3', script: 'scripts/experiments/e3-paseo.ts' },
  { id: 'E4', script: 'scripts/experiments/e4-chatgpt.ts' },
  { id: 'E5', script: 'scripts/experiments/e5-evidence.ts' },
  { id: 'E6', script: 'scripts/experiments/e6-github.ts' },
  { id: 'E8', script: 'scripts/experiments/e8-claude-probe.ts' },
  { id: 'E9', script: 'scripts/experiments/e9-live-activity.ts' },
] as const;

/** One folder per source the experiments read (G3_8). */
export const FIXTURE_DIRS = [
  'claude',
  'codex',
  'paseo',
  'appserver',
  'github',
  'statusline',
  'live',
] as const;

/** Fixtures put these where real data would hold message text, titles, prompts or secrets. They must never come out. */
export const SENTINEL = /SENTINEL_[A-Za-z0-9_]+/g;

export function scanForSentinels(...texts: (string | null | undefined)[]): string[] {
  return texts.flatMap((text) => (text ? [...text.matchAll(SENTINEL)].map((m) => m[0]) : []));
}

/**
 * Every file below a case's temp folder (without following links) whose name or text holds a sentinel, as paths relative
 * to that folder. A script may write into a temporary workspace (E8 does); none of that may carry fixture text either.
 */
export function sentinelsWrittenBelow(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const shown = path.slice(root.length + 1);
      if (scanForSentinels(entry.name).length > 0) hits.push(shown);
      else if (entry.isDirectory()) walk(path);
      else if (
        entry.isFile() &&
        !lstatSync(path).isSymbolicLink() &&
        scanForSentinels(readFileSync(path, 'utf8')).length > 0
      )
        hits.push(shown);
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}

const made: string[] = [];
export function makeTmp(prefix = 'exp-test'): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  made.push(dir);
  return dir;
}
export function cleanupTmp(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function loadExperiment(
  script: string,
): Promise<{ experiment: Experiment | null; error: string | null }> {
  const path = join(ROOT, script);
  if (!existsSync(path)) return { experiment: null, error: `${script} does not exist` };
  try {
    const mod = (await import(pathToFileURL(path).href)) as { experiment?: Experiment };
    return mod.experiment
      ? { experiment: mod.experiment, error: null }
      : { experiment: null, error: `${script} does not export \`experiment\`` };
  } catch (error) {
    return {
      experiment: null,
      error: `${script} failed to load: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

export interface CaseRun {
  status: number | null;
  stdout: string;
  stderr: string;
  md: string | null;
  json: FindingsDoc | null;
  tmp: string;
  mdPath: string;
}

const expand = (text: string, tmp: string): string =>
  text.replaceAll('{fixtures}', FIXTURES).replaceAll('{tmp}', tmp).replaceAll('{root}', ROOT);

/** Runs one self-test case as the owner would: a child process, a bare HOME, a fresh temp folder, a fixed clock. */
export function runCase(
  script: string,
  id: string,
  testCase: SelftestCase,
  extraArgs: string[] = [],
): CaseRun {
  const tmp = makeTmp(`exp-${id.toLowerCase()}`);
  const mdPath = join(tmp, `${id}.md`);
  const jsonPath = join(tmp, 'result.json');
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: join(tmp, 'home'),
    TMPDIR: tmp,
    NODE_ENV: 'test',
  };
  for (const [key, value] of Object.entries(testCase.env ?? {})) env[key] = expand(value, tmp);
  const args = [
    ...testCase.args.map((a) => expand(a, tmp)),
    '--out',
    mdPath,
    '--json',
    jsonPath,
    '--now',
    FIXED_NOW,
    ...extraArgs,
  ];
  const run = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    md: existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : null,
    json: existsSync(jsonPath) ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as FindingsDoc) : null,
    tmp,
    mdPath,
  };
}
