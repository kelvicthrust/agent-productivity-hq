import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { plainSeed } from '../../scripts/experiments/e8-claude-probe.ts';
import { createTempWorkspace } from '../../scripts/experiments/lib/workspace.ts';
import type { SelftestCase } from '../../scripts/experiments/lib/types.ts';
import { cleanupTmp, makeTmp, ROOT, runCase, scanForSentinels } from './harness.ts';

// Two repairs to E8 (G3_6, G3_7), each shown by the real thing rather than a stand-in:
//  1. --prepare --seed-settings used to copy the whole seeded file, credentials included, into the temporary settings.
//  2. The hook, run by Claude Code, used to follow a symlink sitting at samples.jsonl out of its temporary folder.

afterAll(cleanupTmp);

const SCRIPT = join(ROOT, 'scripts/experiments/e8-claude-probe.ts');

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesBelow(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function prepared(seedFile: string): {
  tmp: string;
  workspace: string;
  stdout: string;
  status: number | null;
} {
  const testCase: SelftestCase = {
    name: 'prepare from a seed',
    args: ['--prepare', '--seed-settings', `{fixtures}/statusline/seed/${seedFile}`],
    expect: { exit: 0, verdicts: {} },
  };
  const run = runCase('scripts/experiments/e8-claude-probe.ts', 'E8', testCase);
  const folders = readdirSync(run.tmp).filter((n) => n.startsWith('crew-e8-'));
  expect(folders, 'the run should have made one temporary folder').toHaveLength(1);
  return {
    tmp: run.tmp,
    workspace: join(run.tmp, folders[0]!),
    stdout: run.stdout,
    status: run.status,
  };
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('E8 --seed-settings copies plain preferences only', () => {
  it('copies model, effortLevel and theme and nothing else from a seed full of credentials', () => {
    const run = prepared('settings.json');
    expect(run.status).toBe(0);
    const settings = readJson(join(run.workspace, 'claude-config/settings.json'));
    expect(Object.keys(settings).sort()).toEqual(['effortLevel', 'model', 'statusLine', 'theme']);
    expect(settings['theme']).toBe('dark');
    expect(settings['model']).toBe('claude-sonnet-5');
    expect(settings['effortLevel']).toBe('high');
    const line = settings['statusLine'] as { type: string; command: string };
    expect(line.type).toBe('command');
    expect(line.command).toContain('--hook');
    expect(
      Object.keys(readJson(join(run.workspace, 'project-with-statusline/.claude/settings.json'))),
    ).toEqual(['statusLine']);
    expect(readFileSync(join(run.workspace, 'claude-baseline/settings.json'), 'utf8').trim()).toBe(
      '{}',
    );
  });

  it('puts no seeded credential, command or rule into any file the run created, or onto the screen', () => {
    const run = prepared('settings.json');
    const forbidden = [
      'SENTINEL_',
      'ANTHROPIC_API_KEY',
      'GH_TOKEN',
      'apiKeyHelper',
      'awsAuthRefresh',
      'PostToolUse',
      'permissions',
      '"env"',
    ];
    const files = filesBelow(run.workspace);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const word of forbidden)
        expect(text, `${file} must not hold ${word}`).not.toContain(word);
    }
    for (const word of forbidden) expect(run.stdout).not.toContain(word);
    expect(scanForSentinels(run.stdout)).toEqual([]);
    expect(run.stdout).toContain(
      'Seed settings: 3 plain preferences copied, 5 other entries left out',
    );
  });

  it('copies nothing from a seed that holds only credentials and an object under an allowed name', () => {
    const run = prepared('credentials-only.json');
    expect(run.status).toBe(0);
    const settings = readJson(join(run.workspace, 'claude-config/settings.json'));
    expect(Object.keys(settings)).toEqual(['statusLine']);
    for (const file of filesBelow(run.workspace))
      expect(scanForSentinels(readFileSync(file, 'utf8')), file).toEqual([]);
    expect(run.stdout).toContain(
      'Seed settings: 0 plain preferences copied, 4 other entries left out',
    );
  });

  it('plainSeed: a value is copied only if it is a boolean, a number or a short plain word', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    const { kept, leftOut } = plainSeed({
      model: 'claude-opus-5-5',
      theme: true,
      effortLevel: 3,
      statusLine: { type: 'command', command: 'x' },
      env: { A: 'b' },
      apiKeyHelper: 'echo x',
      hooks: [],
    });
    expect(kept).toEqual({ model: 'claude-opus-5-5', theme: true, effortLevel: 3 });
    expect(leftOut).toBe(3); // env, apiKeyHelper, hooks; statusLine is replaced, not counted

    for (const bad of [
      token,
      `sk-${'b'.repeat(24)}`,
      'Bearer abcdefghijklmnop',
      'two words',
      '/Users/someone/bin/helper',
      'echo hi; rm -rf /',
      'https://example.test/x',
      'Users/someone/bin/helper',
      'host:8080',
      'someone@example.test',
      "it's",
      '',
      'a'.repeat(200),
      { nested: 'object' },
      ['array'],
      null,
      Number.NaN,
    ]) {
      const result = plainSeed({ model: bad, theme: 'dark' });
      expect(result.kept, JSON.stringify(bad).slice(0, 40)).toEqual({ theme: 'dark' });
      expect(result.leftOut).toBe(1); // the rejected model entry
    }
  });
});

// The hook is what Claude Code runs. These cases run the real script as a child process, with a workspace under a temp
// folder of its own, after planting a link at samples.jsonl.
describe('the actual E8 hook stays inside its temporary folder', () => {
  const INPUT = JSON.stringify({
    session_id: 'session-one',
    version: '2.1.0',
    rate_limits: {
      five_hour: { used_percentage: 12.5, resets_at: 1762432800 },
      seven_day: { used_percentage: 40, resets_at: 1762857600 },
    },
  });
  const OUTSIDE = 'not yours\n';

  function runHook(base: string, dir: string) {
    return spawnSync(
      process.execPath,
      [SCRIPT, '--hook', '--dir', dir, '--role', 'user', '--hold-ms', '0'],
      {
        cwd: ROOT,
        input: INPUT,
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', HOME: join(base, 'home'), TMPDIR: base },
        timeout: 30_000,
      },
    );
  }
  function setup() {
    const base = makeTmp('exp-e8-hook');
    const outside = join(base, 'outside.txt');
    writeFileSync(outside, OUTSIDE);
    const workspace = createTempWorkspace('crew-e8', base);
    return { base, outside, workspace };
  }

  it('control: with no link in the way, the hook appends a start and an end line', () => {
    const { base, workspace } = setup();
    const run = runHook(base, workspace.dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    const lines = readFileSync(join(workspace.dir, 'samples.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { phase: string }).phase)).toEqual(['start', 'end']);
  });

  it('a symlink to an existing file outside is not followed: exit 0, no output, the file is unchanged', () => {
    const { base, outside, workspace } = setup();
    symlinkSync(outside, join(workspace.dir, 'samples.jsonl'));
    const run = runHook(base, workspace.dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(readFileSync(outside, 'utf8')).toBe(OUTSIDE);
    expect(lstatSync(join(workspace.dir, 'samples.jsonl')).isSymbolicLink()).toBe(true);
  });

  it('a dangling symlink does not make the hook create a file at its target', () => {
    const { base, workspace } = setup();
    const target = join(base, 'created-by-the-hook.txt');
    symlinkSync(target, join(workspace.dir, 'samples.jsonl'));
    const run = runHook(base, workspace.dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(existsSync(target)).toBe(false);
  });

  it('a hard link to a file outside is not appended to', () => {
    const { base, outside, workspace } = setup();
    linkSync(outside, join(workspace.dir, 'samples.jsonl'));
    const run = runHook(base, workspace.dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(readFileSync(outside, 'utf8')).toBe(OUTSIDE);
  });
});
