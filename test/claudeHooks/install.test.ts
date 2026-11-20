import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS } from '../../src/shared/contracts/hq.ts';
import { buildHookCommand } from '../../src/server/integrations/claudeHooks/command.ts';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import { MAX_SETTINGS_BYTES } from '../../src/server/integrations/claudeHooks/settings.ts';
import { ASSET, USER_SETTINGS, asText, names, read, readJson, rig } from './helpers.ts';

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
    return (error as ClaudeHooksError).failure;
  }
  return null;
};
const mode = (path: string) => statSync(path).mode & 0o777;
const stampOf = (path: string) => {
  const stat = statSync(path);
  return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
};
const hooksOf = (file: string, event: string) =>
  (
    (readJson(file)['hooks'] as Record<string, { hooks: { command: string }[] }[]>)[event] ?? []
  ).flatMap((group) => group.hooks);

describe('the preview', () => {
  it('shows the file, the events and the exact command, and writes nothing', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    const before = read(r.settings);
    const status = await r.hooks.status();
    expect(status).toMatchObject({
      state: 'off',
      reason: null,
      files: [{ path: '~/.claude/settings.json', exists: true, state: 'absent', reason: null }],
      events: [...CLAUDE_HOOK_EVENTS],
      command: buildHookCommand('/usr/local/bin/node', r.hooks.paths.script),
    });
    expect(read(r.settings)).toBe(before);
    expect(existsSync(r.hooks.paths.dir)).toBe(false);
    expect(names(r.config)).toEqual(['settings.json']);
  });

  it('shows a path outside the home folder as it is, and says so when a file does not exist yet', async () => {
    const r = rig({ settings: null, extra: {} });
    const outside = join(r.root, 'elsewhere');
    mkdirSync(outside);
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: outside } });
    expect((await hooks.status()).files).toEqual([
      { path: join(outside, 'settings.json'), exists: false, state: 'absent', reason: null },
    ]);
  });

  it('is unavailable without a Claude Code folder, and turning it on says so', async () => {
    const r = rig({ config: false });
    expect(await r.hooks.status()).toMatchObject({
      state: 'unavailable',
      reason: 'no_claude_folder',
      files: [],
    });
    expect(await failure(() => r.hooks.set(true))).toBe('no_folder');
    expect(existsSync(r.config)).toBe(false);
    expect(existsSync(r.hooks.paths.dir)).toBe(false);
  });

  it('looks only at the user-level settings of the folders that exist, never a project file', async () => {
    const r = rig({ settings: '{}' });
    const project = join(r.root, 'project', '.claude');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'settings.json'), '{}');
    writeFileSync(join(project, 'settings.local.json'), '{}');
    await r.hooks.set(true);
    expect(read(join(project, 'settings.json'))).toBe('{}');
    expect(read(join(project, 'settings.local.json'))).toBe('{}');
    expect(names(r.config)).toEqual([`settings.json`, `settings.json${BACKUP_SUFFIX}`].sort());
  });
});

describe('turning it on', () => {
  it('does not install a settings file too large for HQ to read and remove its hooks', async () => {
    const empty = '{"note":""}';
    const settings = `{"note":"${'é'.repeat(Math.floor((MAX_SETTINGS_BYTES - empty.length) / 2))}"}`;
    const r = rig({ settings });
    const preview = await r.hooks.status();

    await expect(r.hooks.set(true, { preview: preview.preview })).rejects.toMatchObject({
      failure: 'unsupported_layout',
    });
    expect(statSync(r.settings).size).toBe(Buffer.byteLength(settings));
    expect(read(r.settings) === settings).toBe(true);
    expect(existsSync(r.hooks.paths.script)).toBe(false);
  });

  it('adds one entry for each event, keeps the user’s settings and hooks, and installs the script', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    const status = await r.hooks.set(true);
    expect(status.state).toBe('on');
    const after = readJson(r.settings);
    expect(after['permissions']).toEqual(USER_SETTINGS.permissions);
    expect(after['env']).toEqual(USER_SETTINGS.env);
    expect(after['model']).toBe('opus');
    expect(Object.keys(after)).toEqual(Object.keys(USER_SETTINGS));
    expect(hooksOf(r.settings, 'Stop').map((h) => h.command)).toEqual(['say done', status.command]);
    expect(hooksOf(r.settings, 'PreToolUse')).toEqual(USER_SETTINGS.hooks.PreToolUse[0]!.hooks);
    for (const event of CLAUDE_HOOK_EVENTS)
      expect(hooksOf(r.settings, event).filter((h) => h.command === status.command)).toHaveLength(
        1,
      );
    expect(readFileSync(r.hooks.paths.script).equals(readFileSync(ASSET))).toBe(true);
    expect(mode(r.hooks.paths.script)).toBe(0o600);
    expect(mode(r.hooks.paths.dir)).toBe(0o700);
  });

  it('writes the one-time backup before the first change and never overwrites it', async () => {
    const original = asText(USER_SETTINGS, 4);
    const r = rig({ settings: original });
    await r.hooks.set(true);
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    expect(read(backup)).toBe(original);
    expect(mode(backup)).toBe(0o600);
    await r.hooks.set(false);
    await r.hooks.set(true);
    expect(read(backup)).toBe(original);
  });

  it('keeps the file’s formatting and mode', async () => {
    const bom = '\uFEFF';
    const r = rig({ settings: `${bom}${asText(USER_SETTINGS, '\t')}` });
    chmodSync(r.settings, 0o640);
    await r.hooks.set(true);
    expect(read(r.settings).split('\n')[1]!.startsWith('\t"')).toBe(true);
    expect(read(r.settings).endsWith('\n')).toBe(true);
    expect(mode(r.settings)).toBe(0o640);
    expect(read(r.settings).startsWith(bom)).toBe(true);
  });

  it('creates a missing settings file (owner-only) when the folder exists', async () => {
    const r = rig({ settings: null });
    await r.hooks.set(true);
    expect(readJson(r.settings)['hooks']).toBeDefined();
    expect(mode(r.settings)).toBe(0o600);
    expect(existsSync(`${r.settings}${BACKUP_SUFFIX}`)).toBe(false); // there was nothing to back up
  });

  it('is idempotent: turning it on again writes nothing', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    await r.hooks.set(true);
    const before = { text: read(r.settings), stamp: stampOf(r.settings) };
    await r.hooks.set(true);
    expect(read(r.settings)).toBe(before.text);
    expect(stampOf(r.settings)).toBe(before.stamp);
    expect(readFileSync(r.hooks.paths.script).equals(readFileSync(ASSET))).toBe(true);
    expect(names(r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
  });

  it('changes every Claude Code folder that exists, and nothing for one that does not', async () => {
    const r = rig({ settings: asText({ a: 1 }) });
    const second = join(r.root, 'second');
    mkdirSync(second);
    writeFileSync(join(second, 'settings.json'), asText({ b: 2 }));
    const hooks = r.another({
      env: { CLAUDE_CONFIG_DIR: `${r.config}, ${second}, ${join(r.root, 'missing')}` },
    });
    const status = await hooks.set(true);
    expect(status.files).toHaveLength(2);
    expect(status.state).toBe('on');
    expect(hooksOf(r.settings, 'Stop')).toHaveLength(1);
    expect(hooksOf(join(second, 'settings.json'), 'Stop')).toHaveLength(1);
    expect(existsSync(join(r.root, 'missing'))).toBe(false);
  });

  it('repairs entries left by another data folder or an older version, and a missing or changed script', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    const other = r.another({ dataDir: join(r.root, 'old data') });
    await other.set(true);
    expect((await r.hooks.status()).state).toBe('needs_repair');
    expect((await r.hooks.set(true)).state).toBe('on');
    expect(JSON.stringify(readJson(r.settings))).not.toContain('old data');
    expect(hooksOf(r.settings, 'Stop').map((h) => h.command)).toHaveLength(2);

    writeFileSync(r.hooks.paths.script, '// changed');
    expect((await r.hooks.status()).state).toBe('needs_repair');
    expect((await r.hooks.set(true)).state).toBe('on');
    expect(readFileSync(r.hooks.paths.script).equals(readFileSync(ASSET))).toBe(true);
  });

  it('refuses entries of a half install (some events only) as needing repair, and completes them', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    await r.hooks.set(true);
    const value = readJson(r.settings) as { hooks: Record<string, unknown> };
    delete value.hooks['SessionEnd'];
    writeFileSync(r.settings, asText(value));
    expect((await r.hooks.status()).state).toBe('needs_repair');
    expect((await r.hooks.set(true)).state).toBe('on');
  });
});

describe('turning it off', () => {
  it('removes only HQ’s entries, the script and the registry, and leaves the backup', async () => {
    const original = asText(USER_SETTINGS);
    const r = rig({ settings: original });
    await r.hooks.listening({ port: 4317, token: 'x'.repeat(43) });
    await r.hooks.set(true);
    expect(existsSync(r.hooks.paths.registry)).toBe(true);
    const status = await r.hooks.set(false);
    expect(status.state).toBe('off');
    expect(readJson(r.settings)).toEqual(USER_SETTINGS);
    expect(existsSync(r.hooks.paths.script)).toBe(false);
    expect(existsSync(r.hooks.paths.registry)).toBe(false);
    expect(read(`${r.settings}${BACKUP_SUFFIX}`)).toBe(original);
  });

  it('when it was never on, changes nothing and creates nothing', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    const stamp = stampOf(r.settings);
    expect((await r.hooks.set(false)).state).toBe('off');
    expect(stampOf(r.settings)).toBe(stamp);
    expect(names(r.config)).toEqual(['settings.json']);
    const missing = rig({ settings: null });
    expect((await missing.hooks.set(false)).state).toBe('off');
    expect(existsSync(missing.settings)).toBe(false);
  });

  it('also removes entries from an older data folder', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    await r.another({ dataDir: join(r.root, 'old data') }).set(true);
    await r.hooks.set(false);
    expect(readJson(r.settings)).toEqual(USER_SETTINGS);
  });
});

describe('a settings file it must not change', () => {
  it.each([
    ['not JSON', '{ "hooks": ', 'not_json'],
    ['a comment', '// mine\n{}', 'not_json'],
    ['an array', '[]', 'not_an_object'],
    ['an empty file', '', 'not_json'],
    ['a hooks list that is not a list', '{"hooks": {"Stop": 5}}', 'unsupported_shape'],
    ['a hooks section that is not an object', '{"hooks": []}', 'unsupported_shape'],
  ])('refuses %s, writes nothing and creates nothing', async (_name, text, reason) => {
    const r = rig({ settings: text });
    const stamp = stampOf(r.settings);
    const status = await r.hooks.status();
    expect(status).toMatchObject({ state: 'unavailable', reason: 'settings_blocked' });
    expect(status.files[0]).toMatchObject({ state: 'blocked', reason });
    expect(await failure(() => r.hooks.set(true))).toBe(reason);
    expect(await failure(() => r.hooks.set(false))).toBe(reason);
    expect(read(r.settings)).toBe(text);
    expect(stampOf(r.settings)).toBe(stamp);
    expect(names(r.config)).toEqual(['settings.json']);
    expect(existsSync(r.hooks.paths.dir)).toBe(false);
  });

  it('refuses invalid UTF-8 and a file that is not a regular file', async () => {
    const r = rig({ settings: null });
    writeFileSync(r.settings, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    // Bytes that are not text are `unreadable`, never `not_json` and never rewritten (fidelity rule: data-and-sources › Claude Code hooks).
    expect(await failure(() => r.hooks.set(true))).toBe('unreadable');
    expect(readFileSync(r.settings)).toEqual(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    const dir = rig({ settings: null });
    mkdirSync(dir.settings);
    expect(await failure(() => dir.hooks.set(true))).toBe('unreadable');
  });

  it('refuses a read-only file, though the folder would let a rename replace it', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    chmodSync(r.settings, 0o444);
    expect((await r.hooks.status()).files[0]).toMatchObject({
      state: 'blocked',
      reason: 'not_writable',
    });
    expect(await failure(() => r.hooks.set(true))).toBe('not_writable');
    expect(read(r.settings)).toBe(asText(USER_SETTINGS));
    expect(names(r.config)).toEqual(['settings.json']);
  });

  it('refuses a folder it cannot write into, and leaves no temp file', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    chmodSync(r.config, 0o500);
    try {
      expect(await failure(() => r.hooks.set(true))).toBe('not_writable');
    } finally {
      chmodSync(r.config, 0o700);
    }
    expect(names(r.config)).toEqual(['settings.json']);
  });

  it('stops the whole change before writing anything when one of two files is blocked', async () => {
    const r = rig({ settings: asText({ a: 1 }) });
    const second = join(r.root, 'second');
    mkdirSync(second);
    writeFileSync(join(second, 'settings.json'), 'not json');
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` } });
    expect(await failure(() => hooks.set(true))).toBe('not_json');
    expect(read(r.settings)).toBe(asText({ a: 1 }));
    expect(existsSync(hooks.paths.script)).toBe(false);
  });

  it('leaves both files untouched when only the second folder cannot take an atomic write', async () => {
    const original = asText(USER_SETTINGS);
    const r = rig({ settings: original });
    const second = join(r.root, 'second');
    const secondSettings = join(second, 'settings.json');
    mkdirSync(second);
    writeFileSync(secondSettings, original, { mode: 0o600 });
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` } });
    chmodSync(second, 0o500);
    try {
      expect(await failure(() => hooks.set(true))).toBe('not_writable');
    } finally {
      chmodSync(second, 0o700);
    }
    expect(read(r.settings)).toBe(original);
    expect(read(secondSettings)).toBe(original);
    expect(names(r.config)).toEqual(['settings.json']);
    expect(names(second)).toEqual(['settings.json']);
    expect(existsSync(hooks.paths.script)).toBe(false);
    expect(existsSync(hooks.paths.registry)).toBe(false);
  });

  it('refuses a settings link that points at HQ’s own script', async () => {
    const r = rig({ settings: null });
    mkdirSync(r.hooks.paths.dir, { recursive: true });
    writeFileSync(r.hooks.paths.script, 'x');
    symlinkSync(r.hooks.paths.script, r.settings);
    expect(await failure(() => r.hooks.set(true))).toBe('unsupported_shape');
    expect(read(r.hooks.paths.script)).toBe('x');
  });
});

describe('a settings file that is a symlink (a dotfiles setup)', () => {
  it('is written through to its target, and the link stays a link', async () => {
    const r = rig({ settings: null });
    const dotfiles = join(r.root, 'dotfiles');
    mkdirSync(dotfiles);
    const target = join(dotfiles, 'claude-settings.json');
    writeFileSync(target, asText(USER_SETTINGS));
    chmodSync(target, 0o640);
    symlinkSync(target, r.settings);
    await r.hooks.set(true);
    expect(lstatSync(r.settings).isSymbolicLink()).toBe(true);
    expect(readlinkSync(r.settings)).toBe(target);
    expect(readJson(target)['hooks']).toBeDefined();
    expect(mode(target)).toBe(0o640);
    expect(readJson(r.settings)).toEqual(readJson(target));
    // Nothing is left in the dotfiles folder but the target; the backup is beside the link the owner knows.
    expect(names(dotfiles)).toEqual(['claude-settings.json']);
    expect(read(`${r.settings}${BACKUP_SUFFIX}`)).toBe(asText(USER_SETTINGS));
    await r.hooks.set(false);
    expect(readJson(target)).toEqual(USER_SETTINGS);
    expect(lstatSync(r.settings).isSymbolicLink()).toBe(true);
  });

  it('refuses a link that points nowhere', async () => {
    const r = rig({ settings: null });
    symlinkSync(join(r.root, 'nowhere.json'), r.settings);
    expect(await failure(() => r.hooks.set(true))).toBe('unreadable');
    expect(existsSync(join(r.root, 'nowhere.json'))).toBe(false);
  });
});

describe('two changes at once', () => {
  it('are made one at a time, whatever order they finish in, and leave no temp file', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    const results = await Promise.all([
      r.hooks.set(true),
      r.hooks.set(false),
      r.hooks.set(true),
      r.hooks.set(true),
      r.hooks.set(false),
    ]);
    expect(results.map((status) => status.state)).toEqual(['on', 'off', 'on', 'on', 'off']);
    expect(readJson(r.settings)).toEqual(USER_SETTINGS);
    expect(names(r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
    // And a failed one does not stop the next.
    const bad = rig({ settings: 'nope' });
    const outcomes = await Promise.allSettled([bad.hooks.set(true), bad.hooks.set(false)]);
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
  });
});

describe('the registry the hook script reads', () => {
  const TOKEN = 'T'.repeat(43);
  const registry = (r: ReturnType<typeof rig>) =>
    JSON.parse(read(r.hooks.paths.registry)) as Record<string, unknown>;

  it('is written (owner-only) once the server listens and the switch is on, and removed at shutdown', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    expect(existsSync(r.hooks.paths.registry)).toBe(false); // off: nothing for a script to find
    await r.hooks.set(true);
    expect(registry(r)).toEqual({ v: 1, pid: process.pid, port: 4317, token: TOKEN });
    expect(mode(r.hooks.paths.registry)).toBe(0o600);
    expect(mode(r.hooks.paths.dir)).toBe(0o700);
    await r.hooks.close();
    expect(existsSync(r.hooks.paths.registry)).toBe(false);
    expect(names(r.hooks.paths.dir)).toEqual(['agent-productivity-hook.mjs']);
  });

  it('is written at listen when the switch was already on (a restart)', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.set(true);
    const restarted = r.another();
    await restarted.listening({ port: 5000, token: TOKEN });
    expect(registry(r)).toMatchObject({ port: 5000 });
    await restarted.close();
    expect(existsSync(r.hooks.paths.registry)).toBe(false);
  });

  it('does not report the switch on when the registry cannot be published', async () => {
    const r = rig({ settings: '{}' });
    mkdirSync(r.hooks.paths.registry, { recursive: true });
    await r.hooks.listening({ port: 4317, token: TOKEN });

    const result = await r.hooks.set(true).then(
      (status) => status.state,
      (error: unknown) => {
        expect(error).toBeInstanceOf(ClaudeHooksError);
        return (error as ClaudeHooksError).failure;
      },
    );

    expect(result).not.toBe('on');
    expect((await r.hooks.status()).state).not.toBe('on');
  });

  it('is not written after shutdown, and a change after shutdown is refused', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.close();
    expect(await failure(() => r.hooks.set(true))).toBe('no_folder');
    await r.hooks.listening({ port: 1, token: TOKEN });
    expect(existsSync(r.hooks.paths.registry)).toBe(false);
    await r.hooks.close(); // twice is fine
  });

  it('turning it on waits for the first listening call, and never puts the token in the status', async () => {
    const r = rig({ settings: '{}' });
    const status = await r.hooks.set(true);
    expect(existsSync(r.hooks.paths.registry)).toBe(false);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    expect(existsSync(r.hooks.paths.registry)).toBe(true);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(await r.hooks.status())).not.toContain(TOKEN);
  });
});

describe('the state the HQ poll reads', () => {
  it('is reused for a few seconds, and fresh after a change', async () => {
    let now = 1_000_000;
    const r = rig({ settings: '{}', extra: { now: () => now } });
    expect(await r.hooks.state()).toBe('off');
    writeFileSync(r.settings, 'broken');
    expect(await r.hooks.state()).toBe('off'); // cached
    now += 6_000;
    expect(await r.hooks.state()).toBe('unavailable');
    writeFileSync(r.settings, '{}');
    utimesSync(r.settings, 1, 1);
    expect(await r.hooks.set(true).then((s) => s.state)).toBe('on');
    expect(await r.hooks.state()).toBe('on');
  });
});

describe('a change that fails part-way', () => {
  it('leaves no script behind when no file got HQ’s entries', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    chmodSync(r.config, 0o500); // the folder cannot take a temp file: the first write fails
    try {
      expect(await failure(() => r.hooks.set(true))).toBe('not_writable');
    } finally {
      chmodSync(r.config, 0o700);
    }
    expect(existsSync(r.hooks.paths.script)).toBe(false);
    expect(read(r.settings)).toBe(asText(USER_SETTINGS));
  });
});

describe('HQ’s own folder', () => {
  it('never removes a registry outside HQ’s folder at shutdown', async () => {
    const r = rig({ settings: '{}' });
    const elsewhere = join(r.root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'registry.json'), '{"service":"another app"}');
    symlinkSync(elsewhere, r.hooks.paths.dir);

    await r.hooks.listening({ port: 4317, token: 'T'.repeat(43) });
    await r.hooks.close();

    expect(read(join(elsewhere, 'registry.json'))).toBe('{"service":"another app"}');
  });

  it('is never a link: a link where the folder goes is refused, and what it points at is not touched', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    const elsewhere = join(r.root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o755 });
    chmodSync(elsewhere, 0o755);
    symlinkSync(elsewhere, r.hooks.paths.dir);
    expect(await failure(() => r.hooks.set(true))).toBe('not_writable');
    expect(mode(elsewhere)).toBe(0o755);
    expect(names(elsewhere)).toEqual([]);
    expect(read(r.settings)).toBe(asText(USER_SETTINGS));
    // The registry is not written through it either.
    await r.hooks.listening({ port: 1, token: 'T'.repeat(43) });
    expect(names(elsewhere)).toEqual([]);
  });

  it('replaces a script that is a link, rather than writing through it', async () => {
    const r = rig({ settings: '{}' });
    mkdirSync(r.hooks.paths.dir, { recursive: true, mode: 0o700 });
    const victim = join(r.root, 'victim.txt');
    writeFileSync(victim, 'mine');
    symlinkSync(victim, r.hooks.paths.script);
    await r.hooks.set(true);
    expect(read(victim)).toBe('mine');
    expect(lstatSync(r.hooks.paths.script).isSymbolicLink()).toBe(false);
  });
});
