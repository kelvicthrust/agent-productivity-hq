import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeMeta, runExperiment } from '../../../scripts/experiments/lib/cli.ts';
import type { Experiment, FindingsDoc } from '../../../scripts/experiments/lib/types.ts';
import { cleanupTmp, FIXED_NOW, makeTmp, ROOT, scanForSentinels } from '../harness.ts';
import { experiment as good } from './support/good.ts';
import { captureIo } from './support/io.ts';
import { experiment as leaky } from './support/leaky.ts';

afterAll(cleanupTmp);

function world() {
  const dir = makeTmp();
  const data = join(dir, 'data');
  const fake = join(dir, 'fake.mjs');
  const net = join(dir, 'net.json');
  const out = join(dir, 'out', 'E1.md');
  const json = join(dir, 'out', 'result.json');
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
  writeFileSync(join(dir, 'x'), '');
  for (const [name, text] of [
    [join(dir, 'fake.mjs'), 'process.stdout.write("fake 1.0");'],
    [
      net,
      JSON.stringify({
        requests: [
          {
            method: 'GET',
            url: 'https://api.example.test/ping',
            response: { status: 200, json: { ok: true } },
          },
        ],
      }),
    ],
  ] as const)
    writeFileSync(name, text);
  return { dir, data, fake, net, out, json, env };
}

async function makeData(dir: string): Promise<void> {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'a.jsonl'),
    '{"type":"assistant","message":{"usage":{"input_tokens":1}}}\nnot json SENTINEL_BAD_1\n{"type":"user"}\n',
  );
}

const standard = (w: ReturnType<typeof world>) => [
  '--out',
  w.out,
  '--json',
  w.json,
  '--now',
  FIXED_NOW,
  '--root',
  w.data,
];

async function run(exp: Experiment, argv: string[], env: Record<string, string> = {}) {
  const io = captureIo(env);
  const code = await runExperiment(exp, argv, io);
  return { code, out: io.stdoutText(), err: io.stderrText() };
}

describe('a normal run', () => {
  it('announces first, reads, writes the findings and exits 0', async () => {
    const w = world();
    await makeData(w.data);
    const { code, out, err } = await run(good, standard(w));
    expect(code).toBe(0);
    expect(err).toBe('');
    const lines = out.split('\n');
    expect(lines[0]).toBe('E1 · Support experiment');
    expect(lines[1]).toContain('Read-only and metadata-only');
    expect(lines[2]).toMatch(/^Will read: support folder: .*\/data$/);
    expect(out).toContain('PASS  reads-lines: 3 lines, 1 unreadable');
    expect(out).toContain('NOT RUN  program-ran: Not evaluated in this run.');
    expect(out).toContain('Result: PASS');
    expect(out).toContain(`Findings written to ${w.out}`);
    expect(out.indexOf('Will read:')).toBeLessThan(out.indexOf('Findings written'));

    const doc = JSON.parse(readFileSync(w.json, 'utf8')) as FindingsDoc;
    expect(doc.trace).toMatchObject({
      filesRead: 1,
      programsStarted: [],
      hostsContacted: [],
      workspaceFolders: 0,
    });
    expect(doc.ranAt).toBe('2026-11-08T12:00:00.000Z');
    const md = readFileSync(w.out, 'utf8');
    expect(md).toContain('- fields: message, message.usage, message.usage.input_tokens, type');
    expect(scanForSentinels(out, md, JSON.stringify(doc))).toEqual([]);
  });

  it('exits 1 when a criterion fails, and 0 when one is merely not run', async () => {
    const w = world();
    await makeData(w.data);
    expect((await run(good, [...standard(w), '--fail'])).code).toBe(1);
    expect((await run(good, standard(w))).code).toBe(0);
  });

  it('writes to <repo>/docs/implementation/experiments/<id>.md only when no --out is given', async () => {
    const before = readdirSync(join(ROOT, 'docs/implementation/experiments'));
    const w = world();
    await makeData(w.data);
    await run(good, standard(w));
    expect(readdirSync(join(ROOT, 'docs/implementation/experiments'))).toEqual(before);
    expect(existsSync(w.out)).toBe(true);
  });
});

describe('help and list-reads', () => {
  it.each(['--help', '--list-reads'])(
    '%s prints the declaration and touches nothing',
    async (flag) => {
      const w = world();
      const { code, out } = await run(good, [
        flag,
        '--root',
        join(w.dir, 'does-not-exist'),
        '--out',
        w.out,
      ]);
      expect(code).toBe(0);
      expect(out).toContain(describeMeta(good.meta));
      expect(out).toContain('The folder given with --root');
      expect(out).toContain('api.example.test');
      expect(out).not.toContain('Will read:');
      expect(existsSync(w.out)).toBe(false);
      if (flag === '--help') expect(out).toContain('--net-fixture');
    },
  );
});

describe('usage mistakes', () => {
  it.each([
    [['file.jsonl'], /Use flags only/],
    [['--now', 'nonsense'], /--now must be an ISO time/],
    [['--bin', 'gh'], /--bin must look like name=path/],
  ])('%j stops with exit 2 and says why', async (argv, message) => {
    const { code, err, out } = await run(good, argv);
    expect(code).toBe(2);
    expect(err).toMatch(message);
    expect(out).not.toContain('Will read');
  });
});

describe('the guards, through the CLI', () => {
  it('starts an allowed program through --bin, announces it, and records it', async () => {
    const w = world();
    await makeData(w.data);
    const { code, out } = await run(good, [
      ...standard(w),
      '--with-program',
      '--bin',
      `fakeprog=${w.fake}`,
    ]);
    expect(code).toBe(0);
    expect(out).toContain('Will start: fakeprog --version x');
    expect(out).toContain('PASS  program-ran');
    expect((JSON.parse(readFileSync(w.json, 'utf8')) as FindingsDoc).trace.programsStarted).toEqual(
      ['fakeprog'],
    );
  });

  it('stops (exit 2) on a program the script did not list, and writes no findings', async () => {
    const w = world();
    await makeData(w.data);
    const { code, err } = await run(good, [...standard(w), '--with-program', 'curl']);
    expect(code).toBe(2);
    expect(err).toContain('ProgramNotAllowedError');
    expect(existsSync(w.out)).toBe(false);
  });

  it('reports a missing program as not run, not as a crash', async () => {
    const w = world();
    await makeData(w.data);
    const { code, out } = await run(good, [
      ...standard(w),
      '--with-program',
      '--bin',
      `fakeprog=${join(w.dir, 'nope')}`,
    ]);
    expect(code).toBe(0);
    expect(out).toContain('NOT RUN  program-ran');
  });

  it('answers a network request from the fixture, and records the host', async () => {
    const w = world();
    await makeData(w.data);
    const { code, out } = await run(good, [...standard(w), '--with-net', '--net-fixture', w.net]);
    expect(code).toBe(0);
    expect(out).toContain('Will contact: api.example.test');
    expect(out).toContain('PASS  host-answered');
    expect((JSON.parse(readFileSync(w.json, 'utf8')) as FindingsDoc).trace.hostsContacted).toEqual([
      'api.example.test',
    ]);
  });

  it('stops on a host the script did not list', async () => {
    const w = world();
    await makeData(w.data);
    const { code, err } = await run(good, [
      ...standard(w),
      '--with-net',
      'https://evil.example/x',
      '--net-fixture',
      w.net,
    ]);
    expect(code).toBe(2);
    expect(err).toContain('HostNotAllowedError');
    expect(existsSync(w.out)).toBe(false);
  });

  it('stops on a read outside the announced folder', async () => {
    const w = world();
    await makeData(w.data);
    const { code, err } = await run(good, [...standard(w), '--read-elsewhere', '/etc/hosts']);
    expect(code).toBe(2);
    expect(err).toContain('ReadOutsideDeclaredRootError');
    expect(existsSync(w.out)).toBe(false);
  });

  it('refuses a findings file with the wrong name', async () => {
    const w = world();
    await makeData(w.data);
    const { code, err } = await run(good, [
      '--root',
      w.data,
      '--out',
      join(w.dir, 'notes.md'),
      '--now',
      FIXED_NOW,
    ]);
    expect(code).toBe(2);
    expect(err).toContain('must be named E1.md');
  });
});

describe('leaks', () => {
  const TOKEN = `ghp_${'A'.repeat(36)}`;

  it.each(['out-token', 'finding-token'])(
    'a token-shaped value (%s) stops the run and appears nowhere',
    async (how) => {
      const w = world();
      const { code, out, err } = await run(leaky, [
        '--leak',
        how,
        '--out',
        w.out,
        '--json',
        w.json,
      ]);
      expect(code).toBe(2);
      expect(out + err).not.toContain(TOKEN);
      expect(err).toContain('looks like a token or credential');
      expect(existsSync(w.out)).toBe(false);
      expect(existsSync(w.json)).toBe(false);
    },
  );

  it('a token-shaped fact value is withheld as a marker', async () => {
    const w = world();
    const { code } = await run(leaky, ['--leak', 'finding-field', '--out', w.out]);
    expect(code).toBe(0);
    const md = readFileSync(w.out, 'utf8');
    expect(md).not.toContain(TOKEN);
    expect(md).toContain('- token: [string:40]');
  });

  it('a sentinel that bypasses the guards is caught by the scan (negative control for the sentinel test)', async () => {
    const stdoutRun = spawnSync(process.execPath, ['-e', "console.log('SENTINEL_X_1')"], {
      encoding: 'utf8',
    });
    expect(scanForSentinels(stdoutRun.stdout)).toEqual(['SENTINEL_X_1']);
    for (const how of ['finding-sentinel']) {
      const w = world();
      const { code, out } = await run(leaky, ['--leak', how, '--out', w.out, '--json', w.json]);
      expect(code).toBe(0);
      expect(
        scanForSentinels(out, readFileSync(w.out, 'utf8'), readFileSync(w.json, 'utf8')).length,
      ).toBeGreaterThan(0);
    }
  });

  it('console.log and stderr writes by a script are visible to the scan when the script runs as a real process', () => {
    const dir = makeTmp();
    for (const how of ['console', 'stderr']) {
      const script = join(dir, `${how}.ts`);
      writeFileSync(
        script,
        `import { runIfMain } from '${join(ROOT, 'scripts/experiments/lib/cli.ts')}';\nimport { experiment } from '${join(ROOT, 'test/experiments/lib/support/leaky.ts')}';\nrunIfMain(import.meta, experiment);\n`,
      );
      const result = spawnSync(
        process.execPath,
        [script, '--leak', how, '--out', join(dir, 'E1.md')],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(scanForSentinels(result.stdout, result.stderr)).toEqual(['SENTINEL_LEAK_0a1b2c3d']);
    }
  });
});

describe('started directly, as an owner would', () => {
  it('runs through runIfMain with the right exit code, and is silent when only imported', async () => {
    const w = world();
    await makeData(w.data);
    const script = join(ROOT, 'test/experiments/lib/support/run-good.ts');
    const ok = spawnSync(process.execPath, [script, ...standard(w)], { encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('Result: PASS');
    const failing = spawnSync(process.execPath, [script, ...standard(w), '--fail'], {
      encoding: 'utf8',
    });
    expect(failing.status).toBe(1);
    const broken = spawnSync(process.execPath, [script, '--bogus-positional'.slice(2)], {
      encoding: 'utf8',
    });
    expect(broken.status).toBe(2);
    const help = spawnSync(process.execPath, [script, '--list-reads'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Starts programs:');
    // Importing the module (as this test file does) printed nothing and wrote nothing.
    expect(good.meta.id).toBe('E1');
  });
});

describe('a hook (E8 runs inside another program)', () => {
  const hook = join(ROOT, 'test/experiments/lib/support/hook.ts');

  it('records into its workspace, prints nothing and exits 0', async () => {
    const { createTempWorkspace } = await import('../../../scripts/experiments/lib/workspace.ts');
    const ws = createTempWorkspace('crew-hook', makeTmp());
    const result = spawnSync(process.execPath, [hook, '--hook', '--dir', ws.dir], {
      input: '{"hello":"world"}',
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: join(ws.dir, '..') },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(ws.read('samples.jsonl')).toBe('{"bytes":17}\n');
  });

  it('exits 0 and prints nothing even when the handler throws or the folder is not a workspace', () => {
    const dir = makeTmp();
    const boom = spawnSync(process.execPath, [hook, '--hook', '--dir', dir, '--boom'], {
      input: '{}',
      encoding: 'utf8',
    });
    expect([boom.status, boom.stdout, boom.stderr]).toEqual([0, '', '']);
    const bad = spawnSync(process.execPath, [hook, '--hook', '--dir', dir], {
      input: '{}',
      encoding: 'utf8',
    });
    expect([bad.status, bad.stdout, bad.stderr]).toEqual([0, '', '']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is skipped by runIfMain, so a hook start never prints the experiment header', () => {
    const w = world();
    const script = join(ROOT, 'test/experiments/lib/support/run-good.ts');
    const result = spawnSync(process.execPath, [script, '--hook', '--root', w.data], {
      input: '',
      encoding: 'utf8',
    });
    expect(result.stdout).toBe('');
  });
});
