import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSecrets } from '../../scripts/experiments/lib/secrets.ts';
import { tempDir } from '../server/helpers.ts';

// `node scripts/reconcile-usage.ts` as the owner runs it, as a child process: its exit codes and what it prints. The home is a temp
// copy of the INVENTED fixtures, so nothing reads this computer's real history.

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/reconcile-usage.ts');
const FIXTURES = join(ROOT, 'test/fixtures');

function home(): string {
  const dir = tempDir();
  mkdirSync(join(dir, '.claude'), { recursive: true });
  cpSync(join(FIXTURES, 'claude/projects'), join(dir, '.claude/projects'), { recursive: true });
  cpSync(join(FIXTURES, 'codex/home'), join(dir, '.codex'), { recursive: true });
  return dir;
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    // A clean environment: no CODEX_HOME or CLAUDE_CONFIG_DIR of this computer, and no ccusage on the path.
    env: {
      PATH: '/usr/bin:/bin',
      ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
      ...env,
    },
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const ORACLES = [
  '--claude-oracle',
  join(FIXTURES, 'claude/oracle.json'),
  '--codex-oracle',
  join(FIXTURES, 'codex/oracle.json'),
];

describe('node scripts/reconcile-usage.ts', () => {
  it('--selftest behaves as it must on the invented fixtures and exits 0', () => {
    const { code, out } = run(['--selftest']);
    expect(code).toBe(0);
    expect(out).toContain('selftest: 7 of 7 cases behaved as they must');
    expect(out).toContain('says nothing about your own history');
  });

  it('exits 0 and says so when every compared session matches to the token', () => {
    const { code, out, err } = run(['--home', home(), ...ORACLES]);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out.match(/RESULT: 0-token difference on all 3 compared sessions\./g)).toHaveLength(2);
  });

  it('exits 1 when a session is one token off, and names the category', () => {
    const { code, out } = run([
      '--home',
      home(),
      '--claude-oracle',
      join(FIXTURES, 'claude/oracle-one-token-off.json'),
      '--codex-oracle',
      join(FIXTURES, 'codex/oracle-one-token-off.json'),
    ]);
    expect(code).toBe(1);
    expect(out).toContain('RESULT: DIFFERENCE.');
    expect(out).toMatch(/output [+-]1/);
  });

  it('without ccusage on the machine it exits 0 but says NOT RUN and that G5_3 is not shown', () => {
    const { code, out } = run(['--home', home()]);
    expect(code).toBe(0);
    expect(out).toContain('Codex: NOT RUN.');
    expect(out).toContain('Claude Code: NOT RUN.');
    expect(out).toContain('G5_3 is not shown');
    expect(out).not.toContain('0-token difference');
  });

  it('on a machine with neither provider it compares nothing and does not pass', () => {
    const { code, out } = run(['--home', tempDir(), ...ORACLES]);
    expect(code).toBe(0);
    expect(out).toContain('RESULT: nothing was compared.');
    expect(out).not.toContain('0-token difference');
  });

  it('writes the same report to --out, with nothing private in it', () => {
    const out = join(tempDir(), 'report.txt');
    const result = run(['--home', home(), ...ORACLES, '--out', out]);
    expect(result.code).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(result.out).toContain(text);
    expect(text).toMatch(/^Import: Codex succeeded.+Claude Code succeeded/m);
    expect(text).toMatch(/^Codex: the app holds \d+ sessions/m);
    expect(text).toMatch(/^Claude Code: the app holds \d+ sessions/m);
    expect(text.match(/RESULT: 0-token difference/g)).toHaveLength(2);
    expect(text).not.toMatch(/SENTINEL|\.jsonl|\/tmp|\/private/);
    expect(text).not.toMatch(/\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\/);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(findSecrets(text)).toEqual([]);
  });

  it('exits 2 for a flag it does not know, and a report file it cannot read is NOT RUN, not a difference', () => {
    const { code, err } = run(['--nonsense']);
    expect(code).toBe(2);
    expect(err).toContain('See the comment at the top');
    const bad = run([
      '--home',
      home(),
      '--claude-oracle',
      '/nowhere/missing.json',
      '--codex-oracle',
      '/nowhere/missing.json',
    ]);
    expect(bad.code).toBe(0); // a report file that cannot be read is NOT RUN, not a difference
    expect(bad.out).toContain('NOT RUN');
  });

  it('never prints a prompt, reply, path, project name or timestamp, even on a machine full of sentinels', () => {
    const { out, err } = run(['--home', home(), ...ORACLES]);
    expect(out + err).not.toMatch(/SENTINEL|\.jsonl|rollout-|\/tmp|\/private|\/var\/|-fixture-/);
    expect(out + err).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
