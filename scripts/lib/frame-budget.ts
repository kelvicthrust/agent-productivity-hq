// The verdict of the chart redraw budget, and how a report states it (TECH › Performance, UI rendering; TECH › Chart redraw measurement and
// check): every SAMPLED warm redraw's work, in each class (pointer, keyboard, full relayout), is at most 16 ms. It is a ceiling on the
// slowest sample, not an allowance for a slow tail, so a p95 can never pass it: 199 samples of 1 ms and one of 32 ms have a p95 of 1 ms.
//
// The rules, applied to each class on its UNROUNDED samples:
//   - a finite sample above the ceiling makes the class OVER, whatever else is true of it (an incomplete set cannot hide a slow redraw);
//   - otherwise a set that is not complete is INCONCLUSIVE, never a pass: it has fewer finite samples than the run asked for, it has a
//     redraw where nothing changed (no sample exists for it), it has a sample that is not a finite number, or the run asked for fewer
//     samples than the declared count (200, 200 and 40) so it is not the measurement TECH declares;
//   - otherwise it is WITHIN.
// The three classes are never averaged: any OVER makes the whole OVER, else any INCONCLUSIVE makes the whole INCONCLUSIVE.
//
// This is pure (no browser, no clock, no file), so test/bench/frameBudget.test.ts holds it. It is the only place the ceiling is compared.

/** The work a redraw may take, in ms: what must fit inside one 60 Hz frame. Compared before any rounding. */
export const FRAME_CEILING_MS = 16;

export type WorkClass = 'pointer' | 'keyboard' | 'relayout';

/** The sample counts TECH declares for a full run (`--samples 200`, and 40 alternating resizes). */
export const DECLARED_SAMPLES: Readonly<Record<WorkClass, number>> = {
  pointer: 200,
  keyboard: 200,
  relayout: 40,
};

export type Verdict = 'within' | 'over' | 'inconclusive';

export interface WorkSet {
  id: WorkClass;
  label: string;
  /** The work time of each redraw, in ms, as the browser's clock gave it. A value that is not a finite number is counted as missing. */
  samples: readonly (number | null)[];
  /** How many redraws this run asked for in this class. */
  requested: number;
  /** Redraws that changed nothing within the wait: they have no sample, and a run with any is not complete. */
  noChange: number;
}

export interface SetVerdict {
  id: WorkClass;
  label: string;
  requested: number;
  declared: number;
  /** Samples that are finite numbers. */
  finite: number;
  /** Entries that were not finite numbers (they are left out of every figure). */
  notFinite: number;
  noChange: number;
  p50: number;
  p95: number;
  /** The slowest finite sample, unrounded. NaN when there is none. */
  max: number;
  /** Which sample that was, counting from 1 in the order the samples were taken (a spike at the start reads differently from a steady cost). */
  slowestAt: number | null;
  /** How many finite samples are above the ceiling. */
  over: number;
  verdict: Verdict;
  /** Why the set is not complete (empty when it is). */
  incomplete: string[];
}

export interface BudgetVerdict {
  ceiling: number;
  sets: SetVerdict[];
  overall: Verdict;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[at]!;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function judgeSet(set: WorkSet, ceiling: number = FRAME_CEILING_MS): SetVerdict {
  const taken = set.samples.filter(isFiniteNumber);
  const finite = [...taken].sort((a, b) => a - b);
  const notFinite = set.samples.length - finite.length;
  const declared = DECLARED_SAMPLES[set.id];
  const over = finite.filter((value) => value > ceiling).length;

  const incomplete: string[] = [];
  if (finite.length === 0) incomplete.push('no sample was taken');
  if (finite.length < set.requested) {
    incomplete.push(`${finite.length} of the ${set.requested} asked-for samples were taken`);
  }
  if (set.noChange > 0) {
    incomplete.push(
      `${set.noChange} redraw${set.noChange === 1 ? '' : 's'} changed nothing, so left no sample`,
    );
  }
  if (notFinite > 0) {
    incomplete.push(
      `${notFinite} sample${notFinite === 1 ? ' was' : 's were'} not a finite number`,
    );
  }
  if (set.requested < declared) {
    incomplete.push(
      `the run asked for ${set.requested} samples, fewer than the declared ${declared}`,
    );
  }

  return {
    id: set.id,
    label: set.label,
    requested: set.requested,
    declared,
    finite: finite.length,
    notFinite,
    noChange: set.noChange,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite.length ? finite[finite.length - 1]! : NaN,
    slowestAt: finite.length ? taken.indexOf(finite[finite.length - 1]!) + 1 : null,
    over,
    verdict: over > 0 ? 'over' : incomplete.length > 0 ? 'inconclusive' : 'within',
    incomplete,
  };
}

export function judgeFrameBudget(
  sets: readonly WorkSet[],
  ceiling: number = FRAME_CEILING_MS,
): BudgetVerdict {
  const judged = sets.map((set) => judgeSet(set, ceiling));
  const overall: Verdict = judged.some((s) => s.verdict === 'over')
    ? 'over'
    : judged.length === 0 || judged.some((s) => s.verdict === 'inconclusive')
      ? 'inconclusive'
      : 'within';
  return { ceiling, sets: judged, overall };
}

/**
 * Three decimals, and more when three would hide the comparison: a slowest sample a hair over the ceiling is never printed as the ceiling
 * (a "16.000 ms" that is OVER).
 */
const exact = (value: number): string => {
  if (!Number.isFinite(value)) return 'n/a';
  const short = value.toFixed(3);
  return `${value > FRAME_CEILING_MS && Number(short) <= FRAME_CEILING_MS ? value.toPrecision(10) : short} ms`;
};

const WORDS: Record<Verdict, string> = {
  within: 'WITHIN the ceiling',
  over: 'OVER the ceiling',
  inconclusive: 'INCONCLUSIVE',
};

/** The budget section of the report: one row per class, the overall result, and what the result does not say. */
export function budgetLines(verdict: BudgetVerdict): string[] {
  const out = [
    `Against the budget (TECH › Performance, UI rendering: the work of every sampled warm redraw is at most ${verdict.ceiling} ms). Each class is judged by its slowest sample, unrounded, and only when the set is complete; p50 and p95 above are diagnostic and cannot pass it.`,
    '',
    '| Warm redraw work | Samples taken / asked / declared | Slowest sample | Which one | Samples over the ceiling | Result |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const s of verdict.sets) {
    out.push(
      `| ${s.label} | ${s.finite} / ${s.requested} / ${s.declared} | ${exact(s.max)} | ${s.slowestAt === null ? 'n/a' : `#${s.slowestAt} of ${s.finite}`} | ${s.over} | ${WORDS[s.verdict]} |`,
    );
  }
  out.push('', `Overall: **${WORDS[verdict.overall]}** (${verdict.ceiling} ms).`);
  for (const s of verdict.sets) {
    if (s.incomplete.length)
      out.push('', `- ${s.label}: not complete (${s.incomplete.join('; ')}).`);
  }
  out.push(
    '',
    'INCONCLUSIVE is not a pass: a set that is not complete, or that was not the declared size, says nothing about the ceiling. The next-paint timings, the cold draw, the frame cadence and the import figures are separate diagnostics and are not compared with this ceiling. This script measures and reports: it exits 0 when the measurement RAN, which is not a statement that the budget passed (read the Overall line), and 2 when it could not run.',
  );
  return out;
}

/** What identifies the thing that was measured: the candidate, its build and the browser. A part that could not be read says why. */
export interface MeasuredIdentity {
  /** `git rev-parse HEAD`, or null when this is not a git checkout. */
  commit: string | null;
  /** How many files differ from that commit (`git status --porcelain`), or null when it could not be asked. */
  changedFiles: number | null;
  /** A fingerprint of the production build that was served (dist/client), or null when there was none. */
  buildFingerprint: string | null;
  buildFiles: number;
  /** True when the build was made by this run because it was missing or older than its sources. */
  builtByThisRun: boolean;
  browserVersion: string | null;
  /** The browser build in Playwright's cache (the number in `chromium_headless_shell-<build>`), or null. */
  browserBuild: string | null;
  playwright: string | null;
  node: string;
}

export function identityLines(identity: MeasuredIdentity): string[] {
  const commit =
    identity.commit === null
      ? 'not a git checkout, so no commit can be named (the build fingerprint below is the identity)'
      : `commit \`${identity.commit.slice(0, 12)}\`, ${
          identity.changedFiles === null
            ? 'working tree state unknown'
            : identity.changedFiles === 0
              ? 'working tree clean'
              : `${identity.changedFiles} file${identity.changedFiles === 1 ? '' : 's'} changed since that commit`
        }`;
  const build =
    identity.buildFingerprint === null
      ? 'no production build was found'
      : `production build \`dist/client\` fingerprint \`${identity.buildFingerprint}\` (${identity.buildFiles} files${identity.builtByThisRun ? ', built by this run' : ', already built and not older than its sources'})`;
  const browser =
    identity.browserVersion === null
      ? 'the browser version could not be read'
      : `Chromium headless shell ${identity.browserVersion}${identity.browserBuild ? ` (Playwright build ${identity.browserBuild})` : ''}`;
  return [
    `Candidate: ${commit}.`,
    `Build: ${build}.`,
    `Browser: ${browser}${identity.playwright ? `, driven by @playwright/test ${identity.playwright}` : ''}; Node ${identity.node}.`,
  ];
}
