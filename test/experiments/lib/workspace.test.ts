import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTempWorkspace,
  openTempWorkspace,
  WorkspaceError,
} from '../../../scripts/experiments/lib/workspace.ts';
import { cleanupTmp, makeTmp } from '../harness.ts';

afterAll(cleanupTmp);

// Some of these tests create a file with an explicit mode (0644, 0640) and read the mode back, so they need the usual umask: a shell
// with umask 077 would mask the group and other bits and the file would read back as 0600. The assertions are unchanged; only the
// process umask is fixed while this file runs (the same save-and-restore test/server/boot.test.ts uses).
let previousUmask = 0;
beforeAll(() => {
  previousUmask = process.umask(0o022);
});
afterAll(() => {
  process.umask(previousUmask);
});

describe('temporary workspace', () => {
  it('creates a private folder under the base and writes, appends, reads and lists inside it', () => {
    const base = makeTmp();
    const ws = createTempWorkspace('crew-test', base);
    expect(ws.dir.startsWith(base) || ws.dir.includes('crew-test-')).toBe(true);
    expect(statSync(ws.dir).mode & 0o777).toBe(0o700);
    const file = ws.write('data/a.json', '{"a":1}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    ws.append('data/a.json', '\n{"b":2}');
    expect(ws.read('data/a.json')).toBe('{"a":1}\n{"b":2}');
    ws.mkdir('empty');
    expect(ws.list()).toEqual(['data', 'empty']);
    expect(ws.list('data')).toEqual(['a.json']);
    expect(ws.list('nothing-here')).toEqual([]);
  });

  it('refuses absolute paths, .. and anything that would leave the folder, including through a symlink', () => {
    const base = makeTmp();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const ws = createTempWorkspace('crew-test', base);
    for (const bad of ['/etc/x', '../x', 'a/../../x', 'a/../..'])
      expect(() => ws.write(bad, 'x'), bad).toThrow(WorkspaceError);
    symlinkSync(outside, join(ws.dir, 'escape'));
    expect(() => ws.write('escape/file.txt', 'x')).toThrow(WorkspaceError);
    expect(() => ws.mkdir('escape/sub')).toThrow(WorkspaceError);
    expect(existsSync(join(outside, 'file.txt'))).toBe(false);
    expect(existsSync(join(outside, 'sub'))).toBe(false);
  });

  it('rejects a bad prefix', () => {
    expect(() => createTempWorkspace('../etc', makeTmp())).toThrow(WorkspaceError);
    expect(() => createTempWorkspace('Has Space', makeTmp())).toThrow(WorkspaceError);
  });

  it('lets the hook process reopen a workspace it was given, and no other folder', () => {
    const base = makeTmp();
    const ws = createTempWorkspace('crew-test', base);
    ws.write('seed.txt', 'x');
    const again = openTempWorkspace(ws.dir, base);
    again.append('samples.jsonl', '{}\n');
    expect(ws.list()).toEqual(['samples.jsonl', 'seed.txt']);

    const plain = join(base, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'x'), 'x');
    expect(() => openTempWorkspace(plain, base)).toThrow(/not created by an experiment/);
    expect(() => openTempWorkspace(base, base)).toThrow(WorkspaceError);
    expect(() => openTempWorkspace(join(base, 'missing'), base)).toThrow(/does not exist/);
    expect(() => openTempWorkspace(ws.dir, makeTmp())).toThrow(WorkspaceError);
    expect(() => openTempWorkspace('/', base)).toThrow(WorkspaceError);
  });
});

// Repair: a symlink (or hard link) already sitting at the final name used to be followed out of the folder, because only
// the parent was checked. Each case plants the link, asks the workspace to use it, and shows the outside file was not
// touched by a single byte.
describe('a link at the final name', () => {
  const OUTSIDE = 'outside content\n';
  function setup() {
    const base = makeTmp();
    const outside = join(base, 'outside.txt');
    writeFileSync(outside, OUTSIDE, { mode: 0o640 });
    const ws = createTempWorkspace('crew-test', base);
    return { base, outside, ws };
  }
  const untouched = (outside: string) => {
    expect(readFileSync(outside, 'utf8')).toBe(OUTSIDE);
    expect(statSync(outside).mode & 0o777).toBe(0o640);
  };

  it('refuses write, append and read through a symlink to an existing file outside', () => {
    const { outside, ws } = setup();
    symlinkSync(outside, join(ws.dir, 'samples.jsonl'));
    expect(() => ws.write('samples.jsonl', 'x')).toThrow(WorkspaceError);
    expect(() => ws.append('samples.jsonl', 'x')).toThrow(WorkspaceError);
    expect(() => ws.read('samples.jsonl')).toThrow(WorkspaceError);
    untouched(outside);
  });

  it('refuses a symlink to a file inside the folder as well, so no link is ever followed', () => {
    const { ws } = setup();
    ws.write('real.txt', 'real');
    symlinkSync(join(ws.dir, 'real.txt'), join(ws.dir, 'alias.txt'));
    expect(() => ws.append('alias.txt', 'x')).toThrow(/symbolic link/);
    expect(ws.read('real.txt')).toBe('real');
  });

  it('refuses a dangling symlink and creates nothing at its target', () => {
    const { base, ws } = setup();
    const target = join(base, 'not-yet-there.txt');
    symlinkSync(target, join(ws.dir, 'samples.jsonl'));
    expect(() => ws.write('samples.jsonl', 'x')).toThrow(WorkspaceError);
    expect(() => ws.append('samples.jsonl', 'x')).toThrow(WorkspaceError);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a hard link to an outside file and does not truncate it first', () => {
    const { outside, ws } = setup();
    linkSync(outside, join(ws.dir, 'samples.jsonl'));
    expect(() => ws.write('samples.jsonl', 'x')).toThrow(/hard link/);
    expect(() => ws.append('samples.jsonl', 'x')).toThrow(/hard link/);
    expect(() => ws.read('samples.jsonl')).toThrow(/hard link/);
    untouched(outside);
  });

  it('refuses a directory at the name, and says a read of one is not a regular file', () => {
    const { ws } = setup();
    ws.mkdir('samples.jsonl');
    expect(() => ws.write('samples.jsonl', 'x')).toThrow();
    expect(() => ws.append('samples.jsonl', 'x')).toThrow();
    expect(() => ws.read('samples.jsonl')).toThrow(/regular file/);
  });

  it('does not wait on a named pipe at the name (run in a child with a time limit)', () => {
    const { base, ws } = setup();
    const made = spawnSync('mkfifo', [join(ws.dir, 'samples.jsonl')]);
    if (made.status !== 0) return; // no mkfifo on this machine
    const module = pathToFileURL(
      join(import.meta.dirname, '../../../scripts/experiments/lib/workspace.ts'),
    ).href;
    const code = `import { openTempWorkspace } from ${JSON.stringify(module)};
const ws = openTempWorkspace(process.argv[1]);
const names = [];
for (const act of [() => ws.write('samples.jsonl', 'x'), () => ws.append('samples.jsonl', 'x'), () => ws.read('samples.jsonl')]) {
  try { act(); names.push('no error'); } catch (error) { names.push(error.name); }
}
console.log(names.join(','));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code, ws.dir], {
      env: { PATH: process.env['PATH'] ?? '', TMPDIR: base },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(run.error, 'the child must not hang').toBeUndefined();
    expect(run.status).toBe(0);
    const names = run.stdout.trim().split(',');
    expect(names).toHaveLength(3);
    expect(names).not.toContain('no error');
    expect(names[2]).toBe('WorkspaceError');
  });

  it('still refuses a symlinked folder in the path for read and list, not only for write', () => {
    const { base, ws } = setup();
    const folder = join(base, 'outside-folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'secret.txt'), 'secret');
    symlinkSync(folder, join(ws.dir, 'escape'));
    expect(() => ws.read('escape/secret.txt')).toThrow(WorkspaceError);
    expect(() => ws.list('escape')).toThrow(WorkspaceError);
  });

  it('keeps ordinary files working after the repair: create, replace, append, mode 0600', () => {
    const { ws } = setup();
    const file = ws.write('a/b.txt', 'first');
    ws.write('a/b.txt', 'second');
    ws.append('a/b.txt', '+more');
    expect(ws.read('a/b.txt')).toBe('second+more');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    ws.write('empty.txt', '');
    expect(ws.read('empty.txt')).toBe('');
    ws.write('bytes.bin', new Uint8Array([104, 105]));
    expect(ws.read('bytes.bin')).toBe('hi');
  });
});
