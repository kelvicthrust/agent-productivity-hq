import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOOK_MARKER,
  HOOK_PATH_MAX,
  isHookCommand,
  isSupportedPath,
  parseHookCommand,
  renderHookCommand,
} from '../../src/server/integrations/claudeHooks/command.ts';
import { hooksApiError } from '../../src/server/http/routes/hqHooks.ts';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import { HOOK_SCRIPT } from '../../src/server/integrations/claudeHooks/paths.ts';
import { USER_SETTINGS, asText, names, read, rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): one module both builds and recognises the command, from the same
// description `{ node, script }`; `recognise(build(x)) = x` for every supported path. Supported: an absolute path (starts with `/`) of at
// most 1024 characters made of any characters EXCEPT control characters (U+0000-U+001F, U+007F-U+009F, which include a line break and
// NUL), the line and paragraph separators U+2028 and U+2029, and lone surrogates. Spaces, quotes, `$`, backticks, backslashes, `!`
// and unicode are supported and run correctly under a real `sh -c`. A path outside that is refused BEFORE anything is written
// (`unsupported_path`).

const SCRIPT = (dir: string) => `${dir}/claude-hooks/${HOOK_SCRIPT}`;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  ...'abcXYZ019 /._-',
  ...`'"$\`\\!#&;|<>()*?[]{}~%^=+,:@`,
  'é',
  '日',
  '😀',
  '\u00a0',
  '\u200b',
  '\u202e',
  '\ufeff',
  "'\\''",
  "\\'",
  '"\\"',
];
const supportedPath = (rand: () => number, suffix = ''): string => {
  const length = 1 + Math.floor(rand() * 60);
  let path = '/';
  for (let i = 0; i < length; i += 1) path += ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
  return path + suffix;
};

describe('build and recognise agree', () => {
  it('recognises what it builds, for arbitrary supported paths (property)', () => {
    for (let seed = 1; seed <= 3000; seed += 1) {
      const rand = random(seed);
      const node = supportedPath(rand);
      const script = supportedPath(rand, `/${HOOK_SCRIPT}`);
      expect(isSupportedPath(node) && isSupportedPath(script), `seed ${seed}`).toBe(true);
      const command = renderHookCommand({ node, script });
      expect(parseHookCommand(command), `seed ${seed}: ${JSON.stringify([node, script])}`).toEqual({
        node,
        script,
      });
      // and builds the same text again from what it read
      const found = parseHookCommand(command)!;
      expect(renderHookCommand(found)).toBe(command);
    }
  });

  it('recognises a command only if writing what it read gives the very same text (mutations are never half-recognised)', () => {
    const rand = random(99);
    let recognised = 0;
    for (let i = 0; i < 4000; i += 1) {
      const command = renderHookCommand({
        node: supportedPath(rand),
        script: supportedPath(rand, `/${HOOK_SCRIPT}`),
      });
      const at = Math.floor(rand() * command.length);
      const mutated =
        rand() < 0.5
          ? command.slice(0, at) + command.slice(at + 1)
          : command.slice(0, at) +
            ALPHABET[Math.floor(rand() * ALPHABET.length)] +
            command.slice(at);
      const found = parseHookCommand(mutated);
      if (found !== null) {
        recognised += 1;
        expect(renderHookCommand(found)).toBe(mutated);
      }
    }
    expect(recognised).toBeLessThan(4000);
  });

  it.each([
    ['a line break', '/data/it\nis/x'],
    ['a carriage return', '/data/a\rb'],
    ['NUL', '/data/a\u0000b'],
    ['a tab', '/data/a\tb'],
    ['an escape', '/data/a\u001bb'],
    ['DEL', '/data/a\u007fb'],
    ['a C1 control', '/data/a\u0085b'],
    ['a line separator', '/data/a\u2028b'],
    ['a paragraph separator', '/data/a\u2029b'],
    ['a lone surrogate', '/data/a\ud800b'],
    ['nothing', ''],
    ['a relative path', 'data/x'],
    ['a Windows path', 'C:\\data\\x'],
    ['an over-long path', `/${'x'.repeat(HOOK_PATH_MAX)}`],
  ])('does not support %s, and will not build a command for it', (_name, path) => {
    expect(isSupportedPath(path)).toBe(false);
    expect(() => renderHookCommand({ node: path, script: `/d/${HOOK_SCRIPT}` })).toThrow();
    expect(() => renderHookCommand({ node: '/n', script: path })).toThrow();
  });

  it('supports a path of exactly the longest length, and every quote-like character', () => {
    expect(isSupportedPath(`/${'x'.repeat(HOOK_PATH_MAX - 1)}`)).toBe(true);
    for (const path of [
      `/it's`,
      '/"q"',
      '/$HOME',
      '/`x`',
      '/a\\b',
      '/a!b',
      '/ spaces  ',
      '/😀/日本語',
    ]) {
      const command = renderHookCommand({ node: path, script: `${path}/${HOOK_SCRIPT}` });
      expect(parseHookCommand(command)).toEqual({ node: path, script: `${path}/${HOOK_SCRIPT}` });
    }
  });

  it('does not treat a command that names another script, or a hand edit, as HQ’s', () => {
    const own = renderHookCommand({ node: '/n', script: `/d/${HOOK_SCRIPT}` });
    expect(isHookCommand(own)).toBe(true);
    expect(isHookCommand(`${own} `)).toBe(false);
    expect(isHookCommand(`${own}\n`)).toBe(false);
    expect(isHookCommand(own.replace('/n', '/m'))).toBe(false);
    expect(isHookCommand(renderHookCommand({ node: '/n', script: '/d/other.mjs' }))).toBe(false);
    expect(isHookCommand(`${HOOK_MARKER} true`)).toBe(false);
  });
});

describe('under a real sh', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const NAMES = [
    'plain',
    'with space',
    `it's`,
    '"double"',
    '$HOME',
    '$(echo pwned)',
    '`echo pwned`',
    'back\\slash',
    'ends with backslash\\',
    '!bang',
    'semi;colon & amp | pipe',
    'glob * ? [a-z] {x,y} ~',
    'quote\'s "mixed" $x `y` \\z',
    '日本語 😀 émoji',
    '  leading and trailing  ',
    '-dash',
  ];

  for (const name of NAMES) {
    it(`runs the command for a data folder named ${JSON.stringify(name)} exactly once, with the script as its one argument`, () => {
      const root = mkdtempSync(join(tmpdir(), 'hook sh-'));
      roots.push(root);
      const dir = join(root, name);
      mkdirSync(join(dir, 'claude-hooks'), { recursive: true });
      const script = SCRIPT(dir);
      writeFileSync(script, '// a harmless stand-in\n');
      // A harmless stand-in for Node, in a folder with an awkward name of its own: it records how it was called.
      const nodeDir = join(root, `node ${name}`);
      mkdirSync(nodeDir, { recursive: true });
      const node = join(nodeDir, 'node');
      const record = join(root, 'record.txt');
      writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$#" "$1" >> "${record}"\n`, { mode: 0o755 });
      chmodSync(node, 0o755);

      const command = renderHookCommand({ node, script });
      const out = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
      expect(out).toBe('');
      expect(readFileSync(record, 'utf8')).toBe(`1\n${script}\n`);
      expect(parseHookCommand(command)).toEqual({ node, script });
      // nothing else happened in the folder: the command did not run anything it was not asked to
      expect(readdirSync(root).sort()).toEqual([name, `node ${name}`, 'record.txt'].sort());
    });
  }

  it('does nothing, and says nothing, when the script or Node has gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook sh-'));
    roots.push(root);
    const command = renderHookCommand({
      node: `${root}/no node`,
      script: `${root}/x/${HOOK_SCRIPT}`,
    });
    expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })).toBe('');
  });
});

describe('a data folder HQ cannot quote', () => {
  it('is refused before anything is written, and turning off still works for entries that are already there', async () => {
    const withNewline = rig({ settings: asText(USER_SETTINGS) });
    // (the data folder of this switch has a line break in its name)
    const folder = join(withNewline.root, 'data\nfolder');
    mkdirSync(folder);
    const hooks = withNewline.another({ dataDir: folder });
    const status = await hooks.status();
    expect(status).toMatchObject({ state: 'unavailable', reason: 'unsupported_path', command: '' });
    expect(status.plans).toEqual({});
    const before = readdirSync(folder);
    for (const preview of [undefined, status.preview]) {
      await expect(hooks.set(true, { preview })).rejects.toMatchObject({
        failure: 'unsupported_path',
      });
    }
    // Nothing: no settings change, no backup, no script, no registry, no folder of HQ's.
    expect(read(withNewline.settings)).toBe(asText(USER_SETTINGS));
    expect(names(withNewline.config)).toEqual(['settings.json']);
    expect(readdirSync(folder)).toEqual(before);
    expect(existsSync(join(folder, 'claude-hooks'))).toBe(false);

    // Entries that an install in a good folder made are still removable from this one: removal recognises them by shape.
    await withNewline.hooks.set(true);
    const installed = read(withNewline.settings);
    expect(installed).toContain('agent-productivity-hq-hook');
    const stuck = await hooks.status();
    expect(stuck).toMatchObject({ state: 'needs_repair', reason: 'unsupported_path' });
    expect(Object.keys(stuck.plans)).toEqual(['off']);
    await expect(hooks.set(true, { preview: stuck.preview })).rejects.toMatchObject({
      failure: 'unsupported_path',
    });
    expect(read(withNewline.settings)).toBe(installed);
    await hooks.set(false, { preview: stuck.plans.off!.preview });
    expect(read(withNewline.settings)).toBe(asText(USER_SETTINGS));
  });

  it('is refused with a plain explanation that says exactly which characters work', () => {
    const api = hooksApiError(new ClaudeHooksError('unsupported_path'));
    expect(api).toMatchObject({
      code: 'claude_hooks_blocked',
      details: { reason: 'unsupported_path' },
    });
    expect(api.message).toMatch(/line break/);
    expect(api.message).toMatch(/1,024/);
    expect(api.message).toMatch(/Spaces, quotes, \$, backticks, backslashes/);
  });

  it('never writes a second entry beside one it did not recognise: whatever HQ writes, it recognises', async () => {
    for (const name of ['sp ace', `it's`, '$x', '`y`', 'back\\slash', '日本語']) {
      const r = rig({ settings: asText(USER_SETTINGS) });
      const folder = join(r.root, name);
      mkdirSync(folder);
      const hooks = r.another({ dataDir: folder });
      await hooks.set(true);
      expect((await hooks.status()).state, name).toBe('on');
      await hooks.set(true);
      const handlers = (
        JSON.parse(read(r.settings)) as {
          hooks: Record<string, { hooks: { command: string }[] }[]>;
        }
      ).hooks;
      for (const event of [
        'PermissionRequest',
        'Notification',
        'Stop',
        'SessionStart',
        'SessionEnd',
      ])
        expect(
          handlers[event]!.flatMap((group) => group.hooks).filter((h) => isHookCommand(h.command)),
          `${name} ${event}`,
        ).toHaveLength(1);
      await hooks.set(false);
      expect(read(r.settings), name).toBe(asText(USER_SETTINGS));
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
