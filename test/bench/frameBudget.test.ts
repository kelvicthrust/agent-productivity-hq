import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  budgetLines,
  DECLARED_SAMPLES,
  FRAME_CEILING_MS,
  identityLines,
  judgeFrameBudget,
  judgeSet,
  type MeasuredIdentity,
  type WorkSet,
} from '../../scripts/lib/frame-budget.ts';

// The verdict of the chart redraw budget (FRAME_BUDGET_REPORTING; TECH › Chart redraw measurement and check). The budget is a ceiling on
// the SLOWEST sampled warm redraw of each class, judged on unrounded values and only when the class is complete. The script that measures
// (scripts/measure-browser.ts) used to conclude from p95 alone, so a run whose relayout took 17.1 ms in one sample printed "within 16 ms".
// These tests run without a browser: they hold the rule, and that the script reports through it.

const full = (id: WorkSet['id'], fill: number, overrides: Partial<WorkSet> = {}): WorkSet => ({
  id,
  label: id,
  samples: Array.from({ length: DECLARED_SAMPLES[id] }, () => fill),
  requested: DECLARED_SAMPLES[id],
  noChange: 0,
  ...overrides,
});

/** The three classes at their declared sizes, every sample 1 ms unless a class is replaced. */
const run = (...replaced: WorkSet[]): WorkSet[] =>
  (['pointer', 'keyboard', 'relayout'] as const).map(
    (id) => replaced.find((set) => set.id === id) ?? full(id, 1),
  );

describe('the ceiling is on the slowest sample of a complete set', () => {
  it('passes complete sets whose every sample is at or below 16 ms, the ceiling itself included', () => {
    const verdict = judgeFrameBudget(
      run(full('pointer', 16), full('keyboard', 15.999), full('relayout', 4.1)),
    );
    expect(verdict.overall).toBe('within');
    expect(verdict.sets.map((s) => [s.id, s.verdict, s.over])).toEqual([
      ['pointer', 'within', 0],
      ['keyboard', 'within', 0],
      ['relayout', 'within', 0],
    ]);
  });

  it('fails one slow sample in a class whose p95 is tiny: 199 x 1 ms and one 32 ms is not within 16 ms', () => {
    const relayout = full('relayout', 1);
    relayout.samples = [...Array.from({ length: 39 }, () => 1), 32];
    const slowTail = judgeSet(relayout);
    expect(slowTail.p95).toBe(1);
    expect(slowTail.max).toBe(32);
    expect(slowTail.verdict).toBe('over');

    const pointer = judgeSet({
      ...full('pointer', 1),
      samples: [...Array.from({ length: 199 }, () => 1), 32],
    });
    expect(pointer.p95).toBe(1);
    expect(pointer.verdict).toBe('over');

    const overall = judgeFrameBudget(run({ ...relayout }));
    expect(overall.overall).toBe('over');
    expect(overall.sets.find((s) => s.id === 'relayout')?.over).toBe(1);
  });

  it('compares before rounding: 16.0000001 ms is over although it prints as 16.0', () => {
    const verdict = judgeSet(full('pointer', 16.0000001));
    expect(verdict.verdict).toBe('over');
    expect(verdict.over).toBe(DECLARED_SAMPLES.pointer);
    expect(verdict.max.toFixed(1)).toBe('16.0');
    // ...and the report does not print it as the ceiling it exceeds.
    const text = budgetLines(judgeFrameBudget(run(full('pointer', 16.0000001)))).join('\n');
    expect(text).not.toMatch(/\| 16\.000 ms \|/);
    expect(text).toContain('16.00000010 ms');
  });

  it('reproduces the verified candidate run: pointer 8.2, keyboard 6.6 and relayout 17.1 ms is OVER, from the relayout alone', () => {
    // The three maxima Verification read from the complete 366-bucket run (200 / 200 / 40 samples, none missing).
    const verdict = judgeFrameBudget(
      run(
        full('pointer', 1, {
          samples: [...Array.from({ length: 199 }, () => 1), 8.200000001117587],
        }),
        full('keyboard', 1, {
          samples: [...Array.from({ length: 199 }, () => 1), 6.599999999627471],
        }),
        full('relayout', 4, {
          samples: [...Array.from({ length: 39 }, () => 4), 17.09999999962747],
        }),
      ),
    );
    expect(verdict.sets.map((s) => [s.id, s.verdict, s.max])).toEqual([
      ['pointer', 'within', 8.200000001117587],
      ['keyboard', 'within', 6.599999999627471],
      ['relayout', 'over', 17.09999999962747],
    ]);
    expect(verdict.overall).toBe('over');
    const text = budgetLines(verdict).join('\n');
    expect(text).toContain('Overall: **OVER the ceiling** (16 ms).');
    expect(text).not.toContain('WITHIN the ceiling** (16 ms)');
  });

  it('says which sample was the slowest, in the order taken, so a start-up spike is told from a steady cost', () => {
    const relayout = full('relayout', 3.3);
    relayout.samples = [2.1, 12.8, ...Array.from({ length: 38 }, () => 3.3)];
    const verdict = judgeSet(relayout);
    expect(verdict.slowestAt).toBe(2);
    expect(verdict.verdict).toBe('within');
    expect(judgeSet(full('pointer', 1, { samples: [] })).slowestAt).toBeNull();
    const text = budgetLines(judgeFrameBudget(run(relayout))).join('\n');
    expect(text).toContain('| 12.800 ms | #2 of 40 | 0 | WITHIN the ceiling |');
  });

  it('never averages the classes or lets a fast class excuse a slow one', () => {
    const verdict = judgeFrameBudget(
      run(full('pointer', 0.1), full('keyboard', 0.1), full('relayout', 16.5)),
    );
    expect(verdict.overall).toBe('over');
  });
});

describe('an incomplete measurement is inconclusive, never a pass', () => {
  it('is inconclusive with fewer finite samples than were asked for', () => {
    const verdict = judgeSet(full('pointer', 1, { samples: Array.from({ length: 199 }, () => 1) }));
    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.incomplete).toEqual(['199 of the 200 asked-for samples were taken']);
  });

  it('is inconclusive when a redraw changed nothing and so left no sample', () => {
    const verdict = judgeSet(
      full('keyboard', 1, { samples: Array.from({ length: 199 }, () => 1), noChange: 1 }),
    );
    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.incomplete.join(' ')).toContain('1 redraw changed nothing');
  });

  it('counts a sample that is not a finite number as missing (a NaN reaches the report as null)', () => {
    const samples: (number | null)[] = Array.from({ length: 40 }, () => 1);
    samples[7] = null;
    samples[8] = Number.NaN;
    samples[9] = Number.POSITIVE_INFINITY;
    const verdict = judgeSet(full('relayout', 1, { samples }));
    expect(verdict.finite).toBe(37);
    expect(verdict.notFinite).toBe(3);
    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.max).toBe(1);
  });

  it('is inconclusive with no samples at all, and with no classes at all', () => {
    expect(judgeSet(full('pointer', 1, { samples: [] })).verdict).toBe('inconclusive');
    expect(judgeSet(full('pointer', 1, { samples: [] })).max).toBeNaN();
    expect(judgeFrameBudget([]).overall).toBe('inconclusive');
  });

  it('is inconclusive when the run was smaller than the declared 200 / 200 / 40, even if it finished', () => {
    const small = judgeSet({
      id: 'pointer',
      label: 'pointer',
      samples: Array.from({ length: 20 }, () => 1),
      requested: 20,
      noChange: 0,
    });
    expect(small.verdict).toBe('inconclusive');
    expect(small.incomplete).toEqual(['the run asked for 20 samples, fewer than the declared 200']);
  });

  it('makes the whole run inconclusive when one class is, and the others are within', () => {
    const verdict = judgeFrameBudget(
      run(full('relayout', 1, { samples: Array.from({ length: 39 }, () => 1) })),
    );
    expect(verdict.overall).toBe('inconclusive');
    const text = budgetLines(verdict).join('\n');
    expect(text).toContain('Overall: **INCONCLUSIVE** (16 ms).');
    expect(text).toContain('INCONCLUSIVE is not a pass');
  });

  it('still reports OVER when a set with a slow sample is also incomplete: a slow redraw is not hidden by a missing one', () => {
    const verdict = judgeSet(full('pointer', 1, { samples: [1, 1, 17], noChange: 5 }));
    expect(verdict.verdict).toBe('over');
    expect(verdict.incomplete.length).toBeGreaterThan(0);
  });

  it('accepts a larger run than the declared one', () => {
    const verdict = judgeSet({
      ...full('pointer', 1),
      samples: Array.from({ length: 400 }, () => 1),
      requested: 400,
    });
    expect(verdict.verdict).toBe('within');
  });
});

// CHART_REDRAW_LIMIT. The owner kept the 16 ms ceiling and recorded the relayout spike of the headless test browser as a known limit
// (docs/implementation/evidence/chart-redraw-runs.md, "Recorded exception"). That record is an exception to what a run means for the
// product, not a change to what the script says: a run with one sample over 16 ms is still OVER, and the exception must stay written down.
describe('the owner’s chart exception does not turn an OVER into a pass (CHART_REDRAW_LIMIT)', () => {
  // The three complete runs on the candidate (200 / 200 / 40 samples, none missing): the slowest sample of each class, and the relayout's
  // slowest sample was the second of 40 with the rest settled at its steady cost.
  const runs: [
    name: string,
    pointer: number,
    keyboard: number,
    relayout: number,
    overall: string,
  ][] = [
    ['run 1', 4.2, 4.7, 13.1, 'within'],
    ['run 2', 5.2, 6.1, 16.2, 'over'],
    ['run 3', 5.4, 4.7, 15.6, 'within'],
  ];

  it.each(runs)(
    '%s keeps the label its slowest relayout sample earns',
    (_name, pointer, keyboard, relayout, overall) => {
      const spiked = (id: WorkSet['id'], steady: number, slowest: number): WorkSet =>
        full(id, steady, {
          samples: [
            steady,
            slowest,
            ...Array.from({ length: DECLARED_SAMPLES[id] - 2 }, () => steady),
          ],
        });
      const verdict = judgeFrameBudget(
        run(
          spiked('pointer', 1, pointer),
          spiked('keyboard', 1, keyboard),
          spiked('relayout', 4, relayout),
        ),
      );
      expect(verdict.overall).toBe(overall);
      expect(verdict.sets.map((set) => set.id + ':' + set.verdict)).toEqual([
        'pointer:within',
        'keyboard:within',
        'relayout:' + overall,
      ]);
      const text = budgetLines(verdict).join('\n');
      expect(text).toContain(
        overall === 'over'
          ? 'Overall: **OVER the ceiling** (16 ms).'
          : 'Overall: **WITHIN the ceiling** (16 ms).',
      );
    },
  );

  it('is written down beside the runs: owner, scope, reason, the label that stays and what stays unmeasured', () => {
    const record = readFileSync(
      join(import.meta.dirname, '../../docs/implementation/evidence/chart-redraw-runs.md'),
      'utf8',
    );
    const at = record.indexOf('## Recorded exception: a known limit of the test browser');
    expect(at).toBeGreaterThan(-1);
    const exception = record.slice(at);
    expect(exception).toMatch(/owner chose to keep the 16 ms ceiling/);
    expect(exception).toMatch(/only the full-relayout class/);
    expect(exception).toMatch(/single process, software drawing/);
    expect(exception).toMatch(/typical redraw is 3 to 5 ms/i);
    expect(exception).toContain('still labelled OVER the ceiling');
    expect(exception).toMatch(/Native-browser timing[^.]*not measured/);
  });

  it('leaves the ceiling and the declared sample counts as TECH has them', () => {
    expect(FRAME_CEILING_MS).toBe(16);
    expect(DECLARED_SAMPLES).toEqual({ pointer: 200, keyboard: 200, relayout: 40 });
  });
});

describe('the report', () => {
  it('says that exit status 0 is not a pass and keeps p95 out of the verdict', () => {
    const text = budgetLines(judgeFrameBudget(run())).join('\n');
    expect(text).toContain('Overall: **WITHIN the ceiling** (16 ms).');
    expect(text).toContain(
      'exits 0 when the measurement RAN, which is not a statement that the budget passed',
    );
    expect(text).toContain('p95 above are diagnostic and cannot pass it');
    expect(text).toContain('| Warm redraw work | Samples taken / asked / declared |');
    expect(FRAME_CEILING_MS).toBe(16);
  });

  it('names the candidate, build and browser, and says what it could not read', () => {
    const identity: MeasuredIdentity = {
      commit: '0123456789abcdef0123456789abcdef01234567',
      changedFiles: 6,
      buildFingerprint: 'sha256:0123456789abcdef',
      buildFiles: 12,
      builtByThisRun: true,
      browserVersion: '158.0.8127.18',
      browserBuild: '1254',
      playwright: '1.65.0',
      node: 'v26.3.1',
    };
    const text = identityLines(identity).join('\n');
    expect(text).toContain('commit `0123456789ab`, 6 files changed since that commit');
    expect(text).toContain('fingerprint `sha256:0123456789abcdef` (12 files, built by this run)');
    expect(text).toContain('Chromium headless shell 158.0.8127.18 (Playwright build 1254)');
    expect(text).toContain('@playwright/test 1.65.0; Node v26.3.1');

    const bare = identityLines({
      ...identity,
      commit: null,
      changedFiles: null,
      buildFingerprint: null,
      browserVersion: null,
      browserBuild: null,
      playwright: null,
    }).join('\n');
    expect(bare).toContain('not a git checkout');
    expect(bare).toContain('no production build was found');
    expect(bare).toContain('the browser version could not be read');
  });
});

describe('scripts/measure-browser.ts reports the chart through the verdict', () => {
  const source = readFileSync(
    join(import.meta.dirname, '../../scripts/measure-browser.ts'),
    'utf8',
  );

  it('judges the three classes from their raw samples, never by a p95 comparison', () => {
    expect(source).toContain('judgeFrameBudget(r.work)');
    expect(source).not.toMatch(/p95\s*(<=?|>=?)\s*16/);
    expect(source).not.toMatch(/within 16 ms|OVER 16 ms/);
  });

  it('records the candidate, build and browser it measured, and builds what is stale first', () => {
    expect(source).toContain('...identityLines(identity)');
    expect(source).toContain('browser.version()');
    expect(source).toContain('await ensureBuilt(ROOT');
  });
});
