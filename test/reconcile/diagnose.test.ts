import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnose, renderDiagnosis, type ProviderDiagnosis } from '../../scripts/lib/diagnose.ts';
import { runReconcile } from '../../scripts/lib/reconcile-run.ts';
import { tempDir } from '../server/helpers.ts';

// `--diagnose` (M5, G5_1 to G5_3): why do sessions differ from ccusage, in counts only. Every file here is INVENTED
// (test/fixtures/reconcile-diagnose/README.md): a Codex root with a compaction pair, a forked child that replays its parent, a rollout
// with no model, and two Claude Code transcripts that both hold one message. The importer follows the real ccusage (see
// docs/implementation/ccusage-rules.md); the saved oracles are a PRETEND ccusage that counts no compaction usage, skips no replay and
// gives a shared message to the later copy, so there is a difference for the diagnosis to name. Nothing is a finding about a real
// ccusage, and nothing reads this computer's folders.

const ROOT = join(import.meta.dirname, '../..');
const FIXTURES = join(ROOT, 'test/fixtures/reconcile-diagnose');
const HOME = join(FIXTURES, 'home');
const SCRIPT = join(ROOT, 'scripts/reconcile-usage.ts');

const ORACLES = {
  claude: { kind: 'file', path: join(FIXTURES, 'claude-oracle.json') },
  codex: { kind: 'file', path: join(FIXTURES, 'codex-oracle.json') },
} as const;

async function diagnoseFixtures() {
  const { material } = await runReconcile({ env: {}, home: HOME, sources: ORACLES });
  const results = await diagnose({ env: {}, home: HOME, material });
  const full = results.filter((d): d is ProviderDiagnosis => 'matched' in d);
  return {
    results,
    codex: full.find((d) => d.provider === 'codex')!,
    claude: full.find((d) => d.provider === 'claude')!,
  };
}

describe('the Codex diagnosis', () => {
  it('finds that the importer today reproduces neither session, and that counting no compaction and skipping no replay reproduces both', async () => {
    const { codex } = await diagnoseFixtures();
    expect(codex).toMatchObject({ matched: 2, differing: 2, filesRead: 3, selfCheckMismatches: 0 });
    const reproducing = codex.tallies.filter((t) => t.matches === 2);
    expect(reproducing.map((t) => `${t.rule}, ${t.addon}`).sort()).toEqual([
      'before-last-ordinal-decrease, none',
      'before-last-session_meta, none',
      'no-prefix, none',
      'previous-importer, none',
    ]);
    // the importer follows the real ccusage: it counts the compaction usage and skips the replay, so it matches neither pretend total
    expect(codex.tallies.find((t) => t.rule === 'as-built')?.matches).toBe(0);
    expect(
      codex.tallies.find((t) => t.rule === 'equals-a-parent-snapshot' && t.addon === 'none')
        ?.matches,
    ).toBe(1);
  });

  it('says what each differing session holds: what the importer made of it, the record tokens that match a compacted line, and how much of the start is the parent’s', async () => {
    const { codex } = await diagnoseFixtures();
    const root = codex.codex.find((c) => c.label === 'a1a1a1a1')!;
    expect(root).toMatchObject({
      total: 2700,
      oracleTotal: 2250,
      compactedLines: 1,
      records: 2,
      recordsMatchingCompacted: 1,
      matchingUsageTokens: 450,
      matchingTurnTokens: 430,
      allUsageTokens: 550,
      spawned: false,
      multiAgent: 'v2',
      historyMode: 'full',
      importerEvents: 3, // two counts and the compaction request
      importerCompactionEvents: 1,
      importerSkippedAsReplay: 0,
    });
    expect(root.grid.find((c) => c.rule === 'as-built')?.difference).toBe(450);
    expect(
      root.grid.find((c) => c.rule === 'previous-importer' && c.addon === 'none')?.difference,
    ).toBe(0);
    expect(
      root.grid.find((c) => c.rule === 'previous-importer' && c.addon === '+matching usage')
        ?.difference,
    ).toBe(450);

    const child = codex.codex.find((c) => c.label === 'b2b2b2b2')!;
    expect(child).toMatchObject({
      total: 650,
      oracleTotal: 2900,
      spawned: true,
      snapshots: 3,
      leadingEqualToParent: 2,
      parentReadHere: true,
      forkedFrom: 'present', // a thread id is never printed, only that the marker is there
      historyMode: 'forked',
      importerEvents: 1,
      importerSkippedAsReplay: 2, // the two events it copied from its parent
    });
    expect(
      child.grid.find((c) => c.rule === 'equals-a-parent-snapshot' && c.addon === 'none')
        ?.difference,
    ).toBe(-2250);
    expect(child.grid.find((c) => c.rule === 'no-prefix' && c.addon === 'none')?.difference).toBe(
      0,
    );
  });

  it('names a session only the app holds, and why ccusage may skip it', async () => {
    const { codex } = await diagnoseFixtures();
    expect(codex.onlyInAppCount).toBe(1);
    expect(codex.onlyInApp[0]).toMatchObject({ label: 'c3c3c3c3', total: 110 });
    expect(codex.onlyInApp[0]!.detail).toContain('a turn_context named a model: no');
  });
});

describe('the Claude Code diagnosis', () => {
  it('finds that the session that owns a message both transcripts hold is decided by the later copy, not the earliest', async () => {
    const { claude } = await diagnoseFixtures();
    expect(claude).toMatchObject({
      matched: 2,
      differing: 2,
      filesRead: 3,
      selfCheckMismatches: 0,
    });
    expect(claude.tallies[0]).toEqual({ rule: 'latest', addon: '', matches: 2 });
    const importer = claude.tallies.find((t) => t.rule.startsWith('importer'));
    expect(importer?.matches).toBe(0);
  });

  it('shows the same tokens moving between the two sessions, and how many messages each shares', async () => {
    const { claude } = await diagnoseFixtures();
    const first = claude.claude.find((c) => c.label === '11111111')!;
    const second = claude.claude.find((c) => c.label === '22222222')!;
    expect(first.total - first.oracleTotal).toBe(2045);
    expect(second.total - second.oracleTotal).toBe(-2045);
    expect(first).toMatchObject({ sharedMessages: 1, sharedTokens: 2045, sharedWithSessions: 1 });
    expect(first.grid.find((c) => c.rule === 'latest')?.difference).toBe(0);
    expect(claude.onlyInApp[0]!.detail).toContain('<synthetic>');
  });
});

describe('what the diagnosis prints', () => {
  it('holds no text, path, title, model name or id from the files: counts, booleans and plain words', async () => {
    const { results } = await diagnoseFixtures();
    const text = renderDiagnosis(results);
    expect(text).not.toMatch(/SENTINEL/);
    expect(text).not.toMatch(/\/fixture|\/nowhere|reconcile-diagnose|\.jsonl|\.codex|\.claude/);
    expect(text).not.toMatch(/gpt-5-codex|claude-sonnet/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i); // never a whole id
    expect(text).toContain('Diagnosis (counts only)');
    expect(text).toContain('Candidate rules by matched sessions reproduced exactly (of 2)');
  });

  it('says NOT DIAGNOSED, and invents nothing, when there is no ccusage report', async () => {
    const { material } = await runReconcile({ env: {}, home: HOME, sources: ORACLES });
    const text = renderDiagnosis(
      await diagnose({
        env: {},
        home: HOME,
        material: { app: material.app, oracle: { claude: null, codex: null } },
      }),
    );
    expect(text).toContain('Codex: NOT DIAGNOSED');
    expect(text).toContain('Claude Code: NOT DIAGNOSED');
    expect(text).not.toMatch(/reproduced exactly/);
  });
});

describe('node scripts/reconcile-usage.ts --diagnose', () => {
  it('prints the report and then the diagnosis, writes both to --out, and exits 1 because the sessions differ', () => {
    const out = join(tempDir(), 'diagnose.txt');
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--diagnose',
        '--home',
        HOME,
        '--claude-oracle',
        join(FIXTURES, 'claude-oracle.json'),
        '--codex-oracle',
        join(FIXTURES, 'codex-oracle.json'),
        '--out',
        out,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
        },
        timeout: 60_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('RESULT: DIFFERENCE');
    expect(result.stdout).toContain('Diagnosis (counts only)');
    const written = readFileSync(out, 'utf8');
    expect(written).toContain('RESULT: DIFFERENCE');
    expect(written).toContain('no-prefix, none');
    expect(written).not.toMatch(/SENTINEL|\/fixture|\/nowhere/);
  });
});
