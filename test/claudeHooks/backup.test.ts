import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import { USER_SETTINGS, asText, names, read, rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): before an existing settings file is replaced, a backup of it is
// PROVEN: either a regular file HQ created in this change (exclusive create, owner-only, read back equal to the original bytes), or an
// existing regular, non-link file at the backup path that HQ can read. Anything else at that path refuses the whole change with
// `not_writable`, writes nothing, and is itself left exactly as it is. An existing backup is never overwritten.

const original = asText(USER_SETTINGS);
const isRoot = process.getuid?.() === 0;

async function refusal(run: () => Promise<unknown>): Promise<ClaudeHooksError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
    return error as ClaudeHooksError;
  }
  throw new Error('expected the change to be refused');
}

describe('a backup that is made', () => {
  it('is created exclusively, owner-only, and holds exactly the original bytes before the file is replaced', async () => {
    const seen: { mode: number; text: string; settings: string }[] = [];
    const r = rig({ settings: original });
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    const hooks = r.another({
      onStep: (step) => {
        if (step !== 'before_commit') return;
        seen.push({
          mode: statSync(backup).mode & 0o777,
          text: read(backup),
          settings: read(r.settings),
        });
      },
    });
    const status = await hooks.status();
    await hooks.set(true, { preview: status.preview });
    // At the last moment before the replace, the copy was there, whole, and the file was still the original.
    expect(seen).toEqual([{ mode: 0o600, text: original, settings: original }]);
    expect(read(backup)).toBe(original);
  });

  it('is made by an exclusive create even under a permissive umask', async () => {
    const before = process.umask(0);
    try {
      const r = rig({ settings: original });
      await r.hooks.set(true);
      expect(statSync(`${r.settings}${BACKUP_SUFFIX}`).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(before);
    }
  });
});

describe('a backup that is already there', () => {
  it('stays exactly as it is when it is a regular file HQ can read, and the change goes ahead', async () => {
    const r = rig({ settings: original });
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    // (an older copy of a settings file: an empty or unreadable one is refused, below)
    const older = asText({ older: 'the owner’s older copy' });
    writeFileSync(backup, older, { mode: 0o640 });
    await r.hooks.set(true);
    await r.hooks.set(false);
    expect(read(backup)).toBe(older);
    expect(statSync(backup).mode & 0o777).toBe(0o640);
    expect(read(r.settings)).toBe(original);
  });

  it('refuses to overwrite the backup when it is also the settings symlink target', async () => {
    const r = rig();
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    writeFileSync(backup, original, { mode: 0o600 });
    symlinkSync(backup, r.settings);

    const status = await r.hooks.status();
    await expect(r.hooks.set(true, { preview: status.preview })).rejects.toMatchObject({
      failure: 'not_writable',
    });
    expect(read(backup)).toBe(original);
    expect(lstatSync(r.settings).isSymbolicLink()).toBe(true);
    expect(existsSync(r.hooks.paths.script)).toBe(false);
  });

  /** Each kind of thing that is not a usable backup, and what stands where the backup goes. */
  const kinds: [string, (backup: string, root: string) => void, (backup: string) => void][] = [
    [
      'a folder',
      (backup) => mkdirSync(backup),
      (backup) => expect(statSync(backup).isDirectory()).toBe(true),
    ],
    [
      'a link to a regular file',
      (backup, root) => {
        writeFileSync(join(root, 'elsewhere.txt'), 'elsewhere');
        symlinkSync(join(root, 'elsewhere.txt'), backup);
      },
      (backup) => {
        expect(lstatSync(backup).isSymbolicLink()).toBe(true);
        expect(readFileSync(backup, 'utf8')).toBe('elsewhere');
      },
    ],
    [
      'a link to nothing',
      (backup, root) => symlinkSync(join(root, 'nowhere'), backup),
      (backup) => {
        expect(lstatSync(backup).isSymbolicLink()).toBe(true);
        expect(existsSync(backup)).toBe(false);
      },
    ],
    [
      'a link to a folder',
      (backup, root) => {
        mkdirSync(join(root, 'a folder'));
        symlinkSync(join(root, 'a folder'), backup);
      },
      (backup) => expect(lstatSync(backup).isSymbolicLink()).toBe(true),
    ],
    [
      'a named pipe',
      (backup) => execFileSync('mkfifo', [backup]),
      (backup) => expect(lstatSync(backup).isFIFO()).toBe(true),
    ],
  ];
  if (!isRoot)
    kinds.push([
      'a file HQ cannot read',
      (backup) => {
        writeFileSync(backup, 'unreadable');
        chmodSync(backup, 0o000);
      },
      (backup) => expect(statSync(backup).mode & 0o777).toBe(0o000),
    ]);

  for (const [name, make, stillThere] of kinds) {
    for (const action of ['turning on', 'turning off'] as const) {
      it(`refuses the whole change, ${action}, with ${name} at the backup path, and writes nothing`, async () => {
        const r = rig({ settings: original });
        if (action === 'turning off') await r.hooks.set(true);
        const text = read(r.settings);
        const backup = `${r.settings}${BACKUP_SUFFIX}`;
        // (the backup of the first change is removed so that the blocker can stand where it goes)
        if (action === 'turning off') execFileSync('rm', ['-f', backup]);
        make(backup, r.root);
        const folderBefore = names(r.config);
        const preview = await r.hooks.status();
        const error = await refusal(() =>
          r.hooks.set(action === 'turning on', { preview: preview.preview }),
        );
        expect(error.failure).toBe('not_writable');
        expect(read(r.settings)).toBe(text);
        stillThere(backup);
        // Nothing else was written either: no temp file, and for turning on neither a script nor a registry.
        expect(names(r.config)).toEqual(folderBefore);
        if (action === 'turning on') expect(existsSync(r.hooks.paths.script)).toBe(false);
      });
    }
  }
});

describe('a backup that is there but is not a saved copy', () => {
  it('requires a fresh repair preview after a blocked backup is removed', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    const installed = read(r.settings);
    const second = join(r.root, 'second');
    mkdirSync(second);
    const settings = join(second, 'settings.json');
    const backup = `${settings}${BACKUP_SUFFIX}`;
    writeFileSync(settings, original);
    writeFileSync(backup, '');
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` } });
    const blocked = (await hooks.status()).plans.repair!;
    expect(blocked.files).toMatchObject([{ state: 'blocked', reason: 'backup_unusable' }]);

    rmSync(backup);
    await expect(hooks.set(true, { preview: blocked.preview })).rejects.toMatchObject({
      failure: 'stale_preview',
    });
    expect(read(settings)).toBe(original);
    expect(read(r.settings)).toBe(installed);
    expect(existsSync(backup)).toBe(false);

    const current = (await hooks.status()).plans.repair!;
    expect((await hooks.set(true, { preview: current.preview })).state).toBe('on');
    expect(read(backup)).toBe(original);
  });

  const kinds: [string, string][] = [
    ['empty (zero bytes)', ''],
    ['not JSON (a copy cut short)', '{"permissions": {"allow": ['],
    ['JSON that is not an object', '[1, 2]'],
    ['text only', 'the owner’s older copy'],
  ];
  for (const [name, content] of kinds) {
    for (const action of ['turning on', 'turning off'] as const) {
      it(`refuses the change, ${action}, with a backup that is ${name}, naming it; nothing is written or replaced`, async () => {
        const r = rig({ settings: original });
        if (action === 'turning off') await r.hooks.set(true);
        const text = read(r.settings);
        const backup = `${r.settings}${BACKUP_SUFFIX}`;
        writeFileSync(backup, content, { mode: 0o600 });
        const folderBefore = names(r.config);
        const status = await r.hooks.status();
        // The page says so before anything is pressed: the file is blocked, with the reason.
        const plan = status.plans[action === 'turning on' ? 'on' : 'off'];
        if (plan !== undefined)
          expect(plan.files[0]).toMatchObject({ state: 'blocked', reason: 'backup_unusable' });
        const error = await refusal(() =>
          r.hooks.set(action === 'turning on', { preview: plan?.preview }),
        );
        expect(error.failure).toBe('backup_unusable');
        // The owner is told which file to look at, home-relative.
        expect(error.files).toEqual([`~/.claude/settings.json${BACKUP_SUFFIX}`]);
        // Never trusted, never overwritten, never "repaired": the copy and the settings are as they were.
        expect(read(backup)).toBe(content);
        expect(read(r.settings)).toBe(text);
        expect(names(r.config)).toEqual(folderBefore);
        if (action === 'turning on') expect(existsSync(r.hooks.paths.script)).toBe(false);
      });
    }
  }

  it('does not block a file that needs no change (the copy is only needed to replace the file)', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    writeFileSync(`${r.settings}${BACKUP_SUFFIX}`, '');
    expect((await r.hooks.status()).state).toBe('on');
  });

  it('is accepted when it is a settings file HQ reads (a byte-order mark and spaces do not matter)', async () => {
    const r = rig({ settings: original });
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    writeFileSync(backup, '\uFEFF  {}\n');
    await r.hooks.set(true);
    expect(read(backup)).toBe('\uFEFF  {}\n');
  });
});

describe('a backup this change made and the change did not need', () => {
  it('is removed again when the change ends without replacing the file', async () => {
    const r = rig({ settings: original });
    const hooks = r.another({
      onStep: (step) => {
        if (step === 'before_commit') writeFileSync(r.settings, `${original}\n`);
      },
    });
    const preview = await hooks.status();
    await expect(hooks.set(true, { preview: preview.preview })).rejects.toMatchObject({
      failure: 'stale_preview',
    });
    expect(existsSync(`${r.settings}${BACKUP_SUFFIX}`)).toBe(false);
  });
});
