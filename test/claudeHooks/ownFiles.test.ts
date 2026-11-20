import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import { ASSET, asText, rig, type Rig } from './helpers.ts';

// The rule under test (data-and-sources › Claude Code hooks › HQ's own files): every create, write, read and delete of HQ's artifacts
// (the hook folder, the script, the registry) happens only when the hook folder is a real folder directly inside the data folder, and
// the artifact is a regular file in it; a delete also needs the file to be HQ's own by content. Whatever else is there is left alone,
// whichever operation is asked: shutdown, boot failure, turning off, repair, turning on.

const TOKEN = 'T'.repeat(43);
const HQ_REGISTRY = `${JSON.stringify({ v: 1, pid: process.pid, port: 4317, token: TOKEN })}\n`;

/** Every entry of a folder with what identifies it, to show that nothing at all was touched. */
const snapshot = (dir: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const stat = lstatSync(join(dir, name));
    found[name] =
      `${stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file'}:${stat.ino}:${stat.mtimeMs}:${stat.size}:${stat.isFile() ? readFileSync(join(dir, name)).toString('base64') : ''}`;
  }
  return found;
};

const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid;

type Operation = readonly [string, (hooks: Rig['hooks']) => Promise<unknown>];
const operations: Operation[] = [
  [
    'shutdown after listening',
    async (h) => {
      await h.listening({ port: 4317, token: TOKEN });
      await h.close();
    },
  ],
  ['boot failure (close without ever listening)', (h) => h.close()],
  ['turning off', (h) => h.set(false)],
  ['turning on', (h) => h.set(true)],
  [
    'turning on after listening, then off',
    async (h) => {
      await h.listening({ port: 4317, token: TOKEN });
      await h.set(true);
      await h.set(false);
    },
  ],
  [
    'repair (turning on over HQ’s entries)',
    async (h) => {
      await h.set(true);
      await h.set(true);
    },
  ],
  [
    'listening twice',
    async (h) => {
      await h.listening({ port: 1, token: TOKEN });
      await h.listening({ port: 2, token: TOKEN });
    },
  ],
];

const attempt = async (run: () => Promise<unknown>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
  }
};

describe('a hook folder that is not a real folder inside the data folder', () => {
  const stands: [string, (r: Rig, elsewhere: string) => void][] = [
    ['a link to another folder', (r, elsewhere) => symlinkSync(elsewhere, r.hooks.paths.dir)],
    [
      'a link to a folder that does not exist',
      (r, elsewhere) => symlinkSync(join(elsewhere, 'nowhere'), r.hooks.paths.dir),
    ],
    ['a plain file', (r) => writeFileSync(r.hooks.paths.dir, 'not a folder')],
  ];

  for (const [stand, build] of stands) {
    for (const [name, run] of operations) {
      it(`leaves everything alone for ${name}, with ${stand} where the folder goes`, async () => {
        const r = rig({ settings: '{"a":1}' });
        const elsewhere = join(r.root, 'elsewhere');
        mkdirSync(elsewhere);
        // What a careless clean-up would delete: an HQ-shaped registry and the exact script, in the link's target.
        writeFileSync(join(elsewhere, 'registry.json'), HQ_REGISTRY);
        copyFileSync(ASSET, join(elsewhere, 'agent-productivity-hook.mjs'));
        writeFileSync(join(elsewhere, 'another app.txt'), 'theirs');
        build(r, elsewhere);
        const before = snapshot(elsewhere);
        const dataBefore = snapshot(r.data);
        const mode = statSync(elsewhere).mode & 0o777;

        await attempt(() => run(r.hooks));

        expect(snapshot(elsewhere)).toEqual(before);
        expect(snapshot(r.data)).toEqual(dataBefore);
        expect(statSync(elsewhere).mode & 0o777).toBe(mode);
        expect(readFileSync(r.settings, 'utf8')).toBe('{"a":1}');
      });
    }
  }

  it('also refuses a hook folder that is a link when only the registry is asked for (status stays honest)', async () => {
    const r = rig({ settings: '{}' });
    const elsewhere = join(r.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, r.hooks.paths.dir);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    expect((await r.hooks.status()).state).not.toBe('on');
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe('an artifact in the real folder', () => {
  const folder = (r: Rig) => {
    mkdirSync(r.hooks.paths.dir, { recursive: true, mode: 0o700 });
    return r.hooks.paths.dir;
  };

  it('is never followed when it is a link: a link to a file elsewhere is left alone by shutdown and turning off', async () => {
    const r = rig({ settings: '{}' });
    const dir = folder(r);
    const outside = join(r.root, 'outside registry.json');
    writeFileSync(outside, HQ_REGISTRY);
    symlinkSync(outside, join(dir, 'registry.json'));
    const outsideScript = join(r.root, 'outside script.mjs');
    copyFileSync(ASSET, outsideScript);
    symlinkSync(outsideScript, join(dir, 'agent-productivity-hook.mjs'));
    const before = [readFileSync(outside, 'utf8'), readFileSync(outsideScript, 'utf8')];

    await r.hooks.close();
    await r.hooks.set(false).catch(() => undefined);

    expect([readFileSync(outside, 'utf8'), readFileSync(outsideScript, 'utf8')]).toEqual(before);
    expect(lstatSync(join(dir, 'registry.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'agent-productivity-hook.mjs')).isSymbolicLink()).toBe(true);
  });

  it('is not deleted at shutdown when this process never published it, even if it is shaped like HQ’s', async () => {
    const r = rig({ settings: '{}' });
    writeFileSync(join(folder(r), 'registry.json'), HQ_REGISTRY);
    const second = r.another();
    await second.listening({ port: 4317, token: TOKEN }); // off: nothing is published
    await second.close();
    expect(readFileSync(r.hooks.paths.registry, 'utf8')).toBe(HQ_REGISTRY);
  });

  it('is deleted at shutdown only while it is still exactly what this process published', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.set(true);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    const mine = readFileSync(r.hooks.paths.registry, 'utf8');
    // Another instance (another port) took the registry over: it is not this process's any more.
    writeFileSync(r.hooks.paths.registry, mine.replace('4317', '5000'));
    await r.hooks.close();
    expect(readFileSync(r.hooks.paths.registry, 'utf8')).toBe(mine.replace('4317', '5000'));
  });

  it('is not deleted by turning off when it is not shaped like HQ’s, or belongs to an app that is still running', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.set(true);
    writeFileSync(r.hooks.paths.registry, '{"service":"another app"}');
    await r.hooks.set(false);
    expect(readFileSync(r.hooks.paths.registry, 'utf8')).toBe('{"service":"another app"}');

    await r.hooks.set(true);
    const live = `${JSON.stringify({ v: 1, pid: process.ppid, port: 4317, token: TOKEN })}\n`;
    writeFileSync(r.hooks.paths.registry, live); // the parent of this process: alive, and not us
    await r.hooks.set(false);
    expect(readFileSync(r.hooks.paths.registry, 'utf8')).toBe(live);
  });

  it('is deleted by turning off when it is HQ’s and its app is gone', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.set(true);
    writeFileSync(
      r.hooks.paths.registry,
      `${JSON.stringify({ v: 1, pid: deadPid(), port: 4317, token: TOKEN })}\n`,
    );
    await r.hooks.set(false);
    expect(() => lstatSync(r.hooks.paths.registry)).toThrow();
  });

  it('keeps a script that is not exactly the one this app ships when turning off', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.set(true);
    writeFileSync(r.hooks.paths.script, '// the owner changed this');
    await r.hooks.set(false);
    expect(readFileSync(r.hooks.paths.script, 'utf8')).toBe('// the owner changed this');
  });

  it('is refused when it is a folder, and the folder is not touched', async () => {
    const r = rig({ settings: '{}' });
    const dir = folder(r);
    mkdirSync(join(dir, 'agent-productivity-hook.mjs'));
    writeFileSync(join(dir, 'agent-productivity-hook.mjs', 'inner.txt'), 'x');
    await expect(r.hooks.set(true)).rejects.toMatchObject({ failure: 'not_writable' });
    expect(readdirSync(join(dir, 'agent-productivity-hook.mjs'))).toEqual(['inner.txt']);
    await r.hooks.set(false);
    expect(readdirSync(join(dir, 'agent-productivity-hook.mjs'))).toEqual(['inner.txt']);
  });

  it('is written with a temp file made beside it, owner-only, and no temp file is left on any path', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    await r.hooks.set(true);
    expect(readdirSync(r.hooks.paths.dir).sort()).toEqual([
      'agent-productivity-hook.mjs',
      'registry.json',
    ]);
    for (const name of readdirSync(r.hooks.paths.dir))
      expect(statSync(join(r.hooks.paths.dir, name)).mode & 0o777).toBe(0o600);
    await r.hooks.close();
    expect(readdirSync(r.hooks.paths.dir)).toEqual(['agent-productivity-hook.mjs']);
  });

  it('is made owner-only again when the folder had been left open to others', async () => {
    const r = rig({ settings: '{}' });
    const dir = folder(r);
    chmodSync(dir, 0o777);
    await r.hooks.set(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('temp files left by a process that was killed', () => {
  it('are removed, when their maker is gone, by the next write; a live process’s and other names are left alone', async () => {
    const r = rig({ settings: asText({ a: 1 }) });
    const dead = deadPid();
    mkdirSync(r.hooks.paths.dir, { recursive: true, mode: 0o700 });
    const leftover = join(r.hooks.paths.dir, `.registry.json.${dead}-0123abcd.tmp`);
    const alive = join(r.hooks.paths.dir, `.registry.json.${process.ppid}-0123abcd.tmp`);
    const other = join(r.hooks.paths.dir, `.notes.txt.${dead}-0123abcd.tmp`);
    for (const path of [leftover, alive, other]) writeFileSync(path, 'TOKEN', { mode: 0o600 });
    const settingsLeft = join(r.config, `.settings.json.${dead}-0123abcd.tmp`);
    writeFileSync(settingsLeft, '{"copy":"of the owner’s settings"}');
    await r.hooks.listening({ port: 4317, token: TOKEN });
    await r.hooks.set(true);
    expect(readdirSync(r.hooks.paths.dir).sort()).toEqual(
      [
        `.notes.txt.${dead}-0123abcd.tmp`,
        `.registry.json.${process.ppid}-0123abcd.tmp`,
        'agent-productivity-hook.mjs',
        'registry.json',
      ].sort(),
    );
    expect(readdirSync(r.config)).not.toContain(`.settings.json.${dead}-0123abcd.tmp`);
  });
});
