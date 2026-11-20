import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAIN_TIMEOUT_MS,
  compactLine,
  mergeSnapshot,
  runHook,
  sanitizeSnapshot,
  type HookSnapshot,
} from '../../src/server/integrations/claudeCapture/assets/claude-statusline.mjs';
import {
  ASSET,
  SENTINEL,
  fixture,
  fixtureBytes,
  installHookFiles,
  modeOf,
  readSnapshotFile,
  rig,
  runChild,
  runHookScript,
  sleep,
  testSnapshotPath,
  writeSnapshotFile,
} from './helpers.ts';

// The hook script run the way Claude Code runs it: `node <script>` as a child process with fixture stdin, from a data folder whose
// path contains a space. The pure parts (merge, compact line) are also called in-process with an explicit clock, because only
// there can a test pick the second a run "started" in.

const FUTURE_5H = 4102441200;
const FUTURE_7D = 4102444800;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const snapshot = (over: Partial<HookSnapshot> = {}): HookSnapshot => ({
  v: 1,
  captured_at: 1_700_000_000,
  invoked_at: 1_700_000_000,
  claude_version: '2.0.0',
  five_hour: { used_percentage: 10, resets_at: FUTURE_5H },
  seven_day: { used_percentage: 20, resets_at: FUTURE_7D },
  ...over,
});

describe('the hook as a child process', () => {
  it('saves the two windows and the version, prints the compact line, and exits 0', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    const before = nowSeconds();
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    const after = nowSeconds();

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    // 23.5 rounds to 24; the separator is a middle dot with a space either side.
    expect(run.stdout.toString('utf8')).toBe('5h 24% · 7d 41%\n');

    const saved = readSnapshotFile(dataDir);
    expect(saved).toMatchObject({
      v: 1,
      claude_version: '2.1.0',
      five_hour: { used_percentage: 23.5, resets_at: FUTURE_5H },
      seven_day: { used_percentage: 41.2, resets_at: FUTURE_7D },
    });
    expect(saved['captured_at']).toBeGreaterThanOrEqual(before);
    expect(saved['captured_at']).toBeLessThanOrEqual(after);
    expect(saved['invoked_at']).toBe(saved['captured_at']);
  });

  it('saves nothing but the two windows and the version, whatever else Claude Code sends', async () => {
    for (const name of [
      'full.json',
      'five-hour-only.json',
      'seven-day-only.json',
      'no-rate-limits.json',
    ]) {
      const { dataDir } = rig();
      installHookFiles(dataDir, null);
      await runHookScript(dataDir, fixtureBytes('stdin', name));
      const text = readFileSync(testSnapshotPath(dataDir), 'utf8');
      expect(text, name).not.toMatch(SENTINEL);
      const saved = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(saved).sort(), name).toEqual([
        'captured_at',
        'claude_version',
        'five_hour',
        'invoked_at',
        'seven_day',
        'v',
      ]);
      for (const key of ['five_hour', 'seven_day']) {
        const window = saved[key] as Record<string, unknown> | null;
        if (window !== null)
          expect(Object.keys(window).sort()).toEqual(['resets_at', 'used_percentage']);
      }
    }
  });

  it('keeps the snapshot owner-only and leaves no temp file behind', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(modeOf(testSnapshotPath(dataDir))).toBe(0o600);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps an old window that is absent from this update while it is still open, and replaces the one that is present', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'seven-day-only.json'));
    expect(readSnapshotFile(dataDir)).toMatchObject({
      five_hour: { used_percentage: 23.5, resets_at: FUTURE_5H },
      seven_day: { used_percentage: 55.5, resets_at: FUTURE_7D },
    });
    // The line comes from the merged snapshot, not only from this update's stdin.
    expect(run.stdout.toString('utf8')).toBe('5h 24% · 7d 56%\n');
  });

  it('drops an old window that is absent from this update once its reset time has passed', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    writeSnapshotFile(
      dataDir,
      snapshot({ five_hour: { used_percentage: 99, resets_at: 1_000_000_000 } }),
    );
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'seven-day-only.json'));
    expect(readSnapshotFile(dataDir)['five_hour']).toBeNull();
    expect(readSnapshotFile(dataDir)['seven_day']).toMatchObject({ used_percentage: 55.5 });
    // A dropped window is left out of the line, never shown as 0%.
    expect(run.stdout.toString('utf8')).toBe('7d 56%\n');
  });

  it('stores no window Claude Code reports as already reset, and prints nothing for it', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'reset-windows.json'));
    const saved = readSnapshotFile(dataDir);
    expect(saved).toMatchObject({ five_hour: null, seven_day: null, captured_at: null });
    expect(saved['invoked_at']).toEqual(expect.any(Number));
    expect(run.stdout.length).toBe(0);
  });

  it('records that the hook ran when Claude Code sends no rate limits (API-key and Console sign-ins)', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'no-rate-limits.json'));
    expect(readSnapshotFile(dataDir)).toMatchObject({
      captured_at: null,
      claude_version: '2.1.0',
      five_hour: null,
      seven_day: null,
    });
    expect(readSnapshotFile(dataDir)['invoked_at']).toEqual(expect.any(Number));
    expect(run.stdout.length).toBe(0);
  });

  it('treats a string or negative percentage and a version that is not a version as absent', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    await runHookScript(dataDir, fixtureBytes('stdin', 'invalid-windows.json'));
    const text = readFileSync(testSnapshotPath(dataDir), 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      five_hour: null,
      seven_day: null,
      claude_version: null,
      captured_at: null,
    });
    expect(text).not.toMatch(SENTINEL);
  });

  it('never lets a run that started before the file’s captured_at replace it (concurrent sessions)', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    // A newer snapshot is already there, as if another session wrote it a moment after this run started.
    const newer = snapshot({
      captured_at: nowSeconds() + 3600,
      invoked_at: nowSeconds() + 3600,
      five_hour: { used_percentage: 77, resets_at: FUTURE_5H },
    });
    writeSnapshotFile(dataDir, newer);
    const before = readFileSync(testSnapshotPath(dataDir));
    await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(readFileSync(testSnapshotPath(dataDir)).equals(before)).toBe(true);
  });

  it('replaces an older snapshot with a newer run', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    writeSnapshotFile(dataDir, snapshot());
    await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(readSnapshotFile(dataDir)).toMatchObject({
      five_hour: { used_percentage: 23.5 },
      claude_version: '2.1.0',
    });
  });

  it('works when the data folder is reached through a link (a temp folder often is)', async () => {
    const { dataDir, root } = rig();
    installHookFiles(dataDir, null);
    const link = join(root, 'linked data');
    symlinkSync(dataDir, link);
    const run = await runChild(process.execPath, [join(link, 'claude-statusline.mjs')], {
      stdin: fixtureBytes('stdin', 'full.json'),
    });
    expect(run.stdout.toString('utf8')).toBe('5h 24% · 7d 41%\n');
    expect(existsSync(testSnapshotPath(dataDir))).toBe(true);
  });
});

describe('malformed and unexpected input', () => {
  const inputs: [string, Buffer | string][] = [
    ['empty stdin', ''],
    ['cut off mid-value', fixtureBytes('stdin', 'malformed.txt')],
    ['an array', fixtureBytes('stdin', 'not-an-object.json')],
    ['null', 'null'],
    ['a string', '"five_hour"'],
    ['a number', '12'],
    ['an empty object', '{}'],
    ['rate_limits as a number', '{"rate_limits": 5}'],
    ['windows as null', '{"rate_limits": {"five_hour": null, "seven_day": null}}'],
    ['windows as arrays', '{"rate_limits": {"five_hour": [1], "seven_day": []}}'],
    ['bytes that are not UTF-8', Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28])],
    ['deeply nested', `${'['.repeat(5000)}${']'.repeat(5000)}`],
    [
      'a huge percentage',
      '{"rate_limits": {"five_hour": {"used_percentage": 1e999, "resets_at": 4102441200}}}',
    ],
  ];

  it.each(inputs)(
    'exits 0 and prints nothing when it is the only status line: %s',
    async (_name, stdin) => {
      const { dataDir } = rig();
      installHookFiles(dataDir, null);
      const run = await runHookScript(dataDir, stdin);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout.length).toBe(0);
    },
  );

  it.each(inputs)('still prints the chained output and exits 0: %s', async (_name, stdin) => {
    const { dataDir } = rig();
    installHookFiles(dataDir, 'echo SENTINEL_CHAIN_OUTPUT');
    const run = await runHookScript(dataDir, stdin);
    expect(run.code).toBe(0);
    expect(run.stdout.toString('utf8')).toBe('SENTINEL_CHAIN_OUTPUT\n');
  });

  it('writes no snapshot for input it cannot parse, and leaves an existing one as it was', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    await runHookScript(dataDir, fixtureBytes('stdin', 'malformed.txt'));
    expect(existsSync(testSnapshotPath(dataDir))).toBe(false);

    writeSnapshotFile(dataDir, snapshot());
    const before = readFileSync(testSnapshotPath(dataDir));
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'malformed.txt'));
    expect(readFileSync(testSnapshotPath(dataDir)).equals(before)).toBe(true);
    // Step 4 is computed from the snapshot written in step 2; with no step 2 there is nothing to print.
    expect(run.stdout.length).toBe(0);
  });

  it('rewrites a snapshot that is corrupt or has an unknown version', async () => {
    for (const bad of ['{ not json', JSON.stringify({ v: 2, five_hour: null })]) {
      const { dataDir } = rig();
      installHookFiles(dataDir, null);
      writeFileSync(testSnapshotPath(dataDir), bad);
      await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
      expect(readSnapshotFile(dataDir)).toMatchObject({
        v: 1,
        five_hour: { used_percentage: 23.5 },
      });
    }
  });

  it('still exits 0 and chains when the snapshot cannot be written', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, 'echo SENTINEL_CHAIN_OUTPUT');
    // A folder where the snapshot file belongs: reading it and renaming a file over it both fail.
    mkdirSync(testSnapshotPath(dataDir));
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout.toString('utf8')).toBe('SENTINEL_CHAIN_OUTPUT\n');
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('chaining the owner’s own status line', () => {
  it('passes the same stdin through and copies stdout byte for byte (ANSI, OSC 8 links, several lines)', async () => {
    const { dataDir } = rig();
    const command =
      "printf '\\033[31mred\\033[0m\\n'; printf '\\033]8;;https://example.test/p\\033\\\\a link\\033]8;;\\033\\\\\\n'; printf 'last line\\n'";
    installHookFiles(dataDir, command);
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(run.stdout).toEqual(
      Buffer.from(
        '\u001b[31mred\u001b[0m\n\u001b]8;;https://example.test/p\u001b\\a link\u001b]8;;\u001b\\\nlast line\n',
        'utf8',
      ),
    );
    expect(run.code).toBe(0);
    expect(run.stdout.toString('utf8')).not.toContain('5h');
  });

  it('hands the owner’s command exactly the bytes Claude Code sent', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, 'cat');
    const stdin = fixtureBytes('stdin', 'full.json');
    const run = await runHookScript(dataDir, stdin);
    expect(run.stdout.equals(stdin)).toBe(true);
  });

  it('adds nothing of its own when a previous status line exists, even with both windows present', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, 'echo SENTINEL_CHAIN_OUTPUT');
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(run.stdout.toString('utf8')).toBe('SENTINEL_CHAIN_OUTPUT\n');
    expect(readSnapshotFile(dataDir)).toMatchObject({ five_hour: { used_percentage: 23.5 } });
  });

  // The hook always exits 0 (G9_6), whatever the owner's own command does. Its output still passes through untouched.
  it.each([
    ['exits with 3', 'echo partial; exit 3'],
    ['exits with 7', 'echo partial; exit 7'],
    ['is not found', 'echo partial; no-such-command-for-the-hook-test'],
    ['is killed by a signal', 'echo partial; kill -9 $$'],
  ])(
    'exits 0 and still passes the output through when the owner’s command %s',
    async (_name, command) => {
      const { dataDir } = rig();
      installHookFiles(dataDir, command);
      const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
      expect(run.code).toBe(0);
      expect(run.stdout.toString('utf8')).toBe('partial\n');
      expect(readSnapshotFile(dataDir)).toMatchObject({ five_hour: { used_percentage: 23.5 } });
    },
  );

  it('exits 0 when the owner’s command exits with an error and prints nothing', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, 'exit 9');
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(run.code).toBe(0);
    expect(run.stdout.length).toBe(0);
    expect(existsSync(testSnapshotPath(dataDir))).toBe(true);
  });

  it('forwards what the owner’s command writes to stderr, as it was', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, 'echo SENTINEL_OUT; echo SENTINEL_ERR >&2');
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(run.stdout.toString('utf8')).toBe('SENTINEL_OUT\n');
    expect(run.stderr).toBe('SENTINEL_ERR\n');
  });

  it('writes the snapshot BEFORE it chains, so it lands even when Claude Code cancels the script', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, 'sleep 3');
    const child = spawn(process.execPath, [join(dataDir, 'claude-statusline.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(fixtureBytes('stdin', 'full.json'));
    const exited = new Promise<void>((done) => child.on('close', () => done()));
    const snapshotPath = testSnapshotPath(dataDir);
    for (let waited = 0; !existsSync(snapshotPath) && waited < 5000; waited += 20) await sleep(20);
    // The chained command is still sleeping: this is the moment a newer update would cancel the script.
    expect(child.exitCode).toBeNull();
    child.kill('SIGKILL');
    await exited;
    expect(readSnapshotFile(dataDir)).toMatchObject({ five_hour: { used_percentage: 23.5 } });
  });

  it('stops a previous status line that is still running after its time limit and prints nothing for it', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, 'sleep 30; echo late');
    const input = fixtureBytes('stdin', 'full.json');
    const result = await runHook({
      dir: dataDir,
      stdin: input,
      now: nowSeconds(),
      chainTimeoutMs: 300,
    });
    expect(result.out.length).toBe(0);
    expect(result).not.toHaveProperty('code'); // no exit code leaves runHook: the script always exits 0
    expect(readSnapshotFile(dataDir)).toMatchObject({ five_hour: { used_percentage: 23.5 } });
  });

  it('uses a 4 second limit as the script runs', async () => {
    expect(CHAIN_TIMEOUT_MS).toBe(4000);
    const { dataDir } = rig();
    installHookFiles(dataDir, 'sleep 30; echo late');
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(run.stdout.length).toBe(0);
    expect(run.code).toBe(0);
    expect(run.ms).toBeGreaterThan(3500);
    expect(run.ms).toBeLessThan(8000);
  });
});

describe('whether the dashboard is the only status line', () => {
  it('prints the compact line when the config says there is no previous command, or has none', async () => {
    for (const previous of [null, 'omit'] as const) {
      const { dataDir } = rig();
      installHookFiles(dataDir, previous);
      const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
      expect(run.stdout.toString('utf8'), String(previous)).toBe('5h 24% · 7d 41%\n');
    }
  });

  it('prints nothing when the config exists but cannot be read, rather than a line that might replace the owner’s', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, 'omit');
    writeFileSync(join(dataDir, 'claude-statusline.config.json'), '{ not json');
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(run.stdout.length).toBe(0);
    expect(run.code).toBe(0);
    expect(readSnapshotFile(dataDir)).toMatchObject({ five_hour: { used_percentage: 23.5 } });
  });
});

describe('the script itself', () => {
  const source = readFileSync(ASSET, 'utf8');

  it('imports only Node built-ins for processes, files, paths and URLs: no dependency and no network module', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['node:child_process', 'node:fs', 'node:path', 'node:url']);
    expect(source).not.toMatch(
      /\bfetch\s*\(|node:https?|node:net|node:dgram|node:tls|XMLHttpRequest|WebSocket/,
    );
    expect(source).not.toMatch(/process\.env/);
  });

  it('adds well under the 100 ms budget in-process (Node start-up is the rest of the cost)', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    const input = fixtureBytes('stdin', 'full.json');
    const times: number[] = [];
    for (let run = 0; run < 60; run += 1) {
      const started = performance.now();
      await runHook({ dir: dataDir, stdin: input, now: nowSeconds() });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] ?? Infinity;
    expect(p95).toBeLessThan(100);
  });

  it('records the cost of a real child run, Node start-up included (reported, not asserted tightly)', async () => {
    const { dataDir } = rig();
    installHookFiles(dataDir, null);
    const run = await runHookScript(dataDir, fixtureBytes('stdin', 'full.json'));
    expect(run.ms).toBeLessThan(3000);
  });
});

describe('mergeSnapshot', () => {
  const input = (rate: unknown, version?: unknown): Record<string, unknown> => ({
    rate_limits: rate,
    ...(version === undefined ? {} : { version }),
  });
  const NOW_S = 1_800_000_000;

  it('replaces a present window and moves captured_at and invoked_at to this run', () => {
    const merged = mergeSnapshot(
      snapshot(),
      input({ five_hour: { used_percentage: 33, resets_at: FUTURE_5H } }),
      NOW_S,
    );
    expect(merged.five_hour).toEqual({ used_percentage: 33, resets_at: FUTURE_5H });
    expect(merged.seven_day).toEqual({ used_percentage: 20, resets_at: FUTURE_7D });
    expect(merged.captured_at).toBe(NOW_S);
    expect(merged.invoked_at).toBe(NOW_S);
  });

  it('moves only invoked_at when no window arrives', () => {
    const merged = mergeSnapshot(snapshot(), input(undefined, '2.2.0'), NOW_S);
    expect(merged.captured_at).toBe(1_700_000_000);
    expect(merged.invoked_at).toBe(NOW_S);
    expect(merged.claude_version).toBe('2.2.0');
  });

  it('keeps the old version when this update has none or has one that is not a version', () => {
    expect(mergeSnapshot(snapshot(), input(undefined), NOW_S).claude_version).toBe('2.0.0');
    expect(mergeSnapshot(snapshot(), input(undefined, 'SENTINEL_x'), NOW_S).claude_version).toBe(
      '2.0.0',
    );
    expect(mergeSnapshot(snapshot(), input(undefined, 5), NOW_S).claude_version).toBe('2.0.0');
  });

  it('keeps an absent window only while its reset time is after now (equal counts as reset)', () => {
    const open = mergeSnapshot(
      snapshot({ five_hour: { used_percentage: 5, resets_at: NOW_S + 1 } }),
      input(undefined),
      NOW_S,
    );
    expect(open.five_hour).toEqual({ used_percentage: 5, resets_at: NOW_S + 1 });
    const equal = mergeSnapshot(
      snapshot({ five_hour: { used_percentage: 5, resets_at: NOW_S } }),
      input(undefined),
      NOW_S,
    );
    expect(equal.five_hour).toBeNull();
  });

  it('returns the existing snapshot untouched when this run started before its captured_at', () => {
    const existing = snapshot({ captured_at: NOW_S + 1 });
    expect(
      mergeSnapshot(
        existing,
        input({ five_hour: { used_percentage: 99, resets_at: FUTURE_5H } }),
        NOW_S,
      ),
    ).toBe(existing);
  });

  it('lets a run in the same second as captured_at through (it cannot be told apart, and is not older)', () => {
    const merged = mergeSnapshot(
      snapshot({ captured_at: NOW_S }),
      input({ five_hour: { used_percentage: 99, resets_at: FUTURE_5H } }),
      NOW_S,
    );
    expect(merged.five_hour?.used_percentage).toBe(99);
  });

  it('never moves invoked_at backwards', () => {
    const merged = mergeSnapshot(
      snapshot({ invoked_at: NOW_S + 500, captured_at: null }),
      input(undefined),
      NOW_S,
    );
    expect(merged.invoked_at).toBe(NOW_S + 500);
  });

  it('starts from nothing when there is no usable snapshot', () => {
    const merged = mergeSnapshot(null, input(undefined), NOW_S);
    expect(merged).toEqual({
      v: 1,
      captured_at: null,
      invoked_at: NOW_S,
      claude_version: null,
      five_hour: null,
      seven_day: null,
    });
  });

  it('rounds a fractional reset time to whole seconds and keeps the percentage as received', () => {
    const merged = mergeSnapshot(
      null,
      input({ five_hour: { used_percentage: 12.345, resets_at: FUTURE_5H + 0.4 } }),
      NOW_S,
    );
    expect(merged.five_hour).toEqual({ used_percentage: 12.345, resets_at: FUTURE_5H });
  });

  it('refuses a reset time beyond the year 9999 (not epoch seconds)', () => {
    const merged = mergeSnapshot(
      null,
      input({ five_hour: { used_percentage: 5, resets_at: 4_102_444_800_000 } }),
      NOW_S,
    );
    expect(merged.five_hour).toBeNull();
  });
});

describe('sanitizeSnapshot', () => {
  it('accepts only a v1 object and cleans each field to its type', () => {
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot([])).toBeNull();
    expect(sanitizeSnapshot({ v: 2 })).toBeNull();
    expect(
      sanitizeSnapshot({
        v: 1,
        captured_at: '5',
        invoked_at: 1.5,
        claude_version: 3,
        five_hour: { used_percentage: 'x', resets_at: 1 },
        seven_day: { used_percentage: 4, resets_at: FUTURE_7D },
        extra: 'SENTINEL_extra',
      }),
    ).toEqual({
      v: 1,
      captured_at: null,
      invoked_at: null,
      claude_version: null,
      five_hour: null,
      seven_day: { used_percentage: 4, resets_at: FUTURE_7D },
    });
  });
});

describe('compactLine (owner choice P6)', () => {
  const NOW_S = 1_800_000_000;
  const both = snapshot({
    five_hour: { used_percentage: 23.4, resets_at: NOW_S + 100 },
    seven_day: { used_percentage: 41.6, resets_at: NOW_S + 100 },
  });

  it('is the five-hour window first, then the seven-day, rounded, joined by " · " (U+00B7)', () => {
    expect(compactLine(both, NOW_S)).toBe('5h 23% · 7d 42%');
    expect(compactLine(both, NOW_S)).toContain(' \u00b7 ');
  });

  it('clamps to 0 to 100', () => {
    const line = compactLine(
      snapshot({
        five_hour: { used_percentage: 100.4, resets_at: NOW_S + 1 },
        seven_day: { used_percentage: 0.2, resets_at: NOW_S + 1 },
      }),
      NOW_S,
    );
    expect(line).toBe('5h 100% · 7d 0%');
    expect(
      compactLine(
        snapshot({ five_hour: { used_percentage: 250, resets_at: NOW_S + 1 }, seven_day: null }),
        NOW_S,
      ),
    ).toBe('5h 100%');
  });

  it('leaves out a window that is null, reset or not a finite number, and shows no 0% in its place', () => {
    expect(compactLine({ ...both, five_hour: null }, NOW_S)).toBe('7d 42%');
    expect(compactLine({ ...both, seven_day: null }, NOW_S)).toBe('5h 23%');
    expect(
      compactLine({ ...both, five_hour: { used_percentage: 5, resets_at: NOW_S } }, NOW_S),
    ).toBe('7d 42%');
    expect(
      compactLine({ ...both, seven_day: { used_percentage: NaN, resets_at: NOW_S + 5 } }, NOW_S),
    ).toBe('5h 23%');
    expect(compactLine({ ...both, five_hour: null, seven_day: null }, NOW_S)).toBe('');
  });

  it('is plain text: no escape codes and no links', () => {
    // eslint-disable-next-line no-control-regex
    expect(compactLine(both, NOW_S)).not.toMatch(/[\u0000-\u001f]/);
  });

  it('stays short enough to never need truncating (17 characters at the very most)', () => {
    const widest = compactLine(
      snapshot({
        five_hour: { used_percentage: 100, resets_at: NOW_S + 1 },
        seven_day: { used_percentage: 100, resets_at: NOW_S + 1 },
      }),
      NOW_S,
    );
    expect(widest).toBe('5h 100% · 7d 100%');
    expect(widest.length).toBeLessThanOrEqual(17);
  });
});

// A fixture left unused by the cases above still has to parse, so a typo in it cannot hide.
describe('the fixtures the hook tests rely on', () => {
  it.each([
    'full',
    'five-hour-only',
    'seven-day-only',
    'no-rate-limits',
    'reset-windows',
    'invalid-windows',
    'over-100',
  ])('%s.json is valid JSON', (name) => {
    expect(() => JSON.parse(fixture('stdin', `${name}.json`))).not.toThrow();
  });
});
