import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import { editSettingsFiles } from '../../src/server/integrations/claudeHooks/write.ts';
import { USER_SETTINGS, asText, names, read, rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): the settings target, its backup, every temp file and HQ's own
// files and folder are all different files, compared by resolved path AND device and inode. A coincidence (a link, a hard link, a `..`
// segment, a name in another case on a case-insensitive disk) refuses the change with a fixed code and writes nothing; two targeted
// paths that are one file are one target.

const original = asText(USER_SETTINGS);
const backupOf = (settings: string) => `${settings}${BACKUP_SUFFIX}`;

async function refusal(run: () => Promise<unknown>): Promise<ClaudeHooksError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
    return error as ClaudeHooksError;
  }
  throw new Error('expected a refusal');
}

/** The change as the page makes it: the preview, then the confirmed action. */
async function turnOn(hooks: ReturnType<typeof rig>['hooks']) {
  const status = await hooks.status();
  return hooks.set(true, { preview: status.preview });
}

describe('a backup that is not a file of its own', () => {
  it('the settings file is a link to its own backup path: refused, shown as blocked, and the only copy is untouched', async () => {
    const r = rig();
    writeFileSync(backupOf(r.settings), original, { mode: 0o600 });
    symlinkSync(backupOf(r.settings), r.settings);
    const status = await r.hooks.status();
    expect(status).toMatchObject({ state: 'unavailable', reason: 'settings_blocked' });
    expect(status.files[0]).toMatchObject({ state: 'blocked', reason: 'not_writable' });
    expect((await refusal(() => turnOn(r.hooks))).failure).toBe('not_writable');
    expect(read(backupOf(r.settings))).toBe(original);
    expect(lstatSync(r.settings).isSymbolicLink()).toBe(true);
    expect(existsSync(r.hooks.paths.script)).toBe(false);
  });

  it('the backup is a hard link to the settings file: refused, shown as blocked, nothing written (turning on and turning off)', async () => {
    const r = rig({ settings: original });
    linkSync(r.settings, backupOf(r.settings));
    expect((await r.hooks.status()).files[0]).toMatchObject({ state: 'blocked' });
    expect((await refusal(() => turnOn(r.hooks))).failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
    expect(read(backupOf(r.settings))).toBe(original);
    expect(names(r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);

    // And for a file that is on: turning it off replaces the file too, so it is refused the same way.
    rmSync(backupOf(r.settings));
    const again = rig({ settings: original });
    await turnOn(again.hooks);
    const on = read(again.settings);
    rmSync(backupOf(again.settings));
    linkSync(again.settings, backupOf(again.settings));
    expect((await refusal(() => again.hooks.set(false))).failure).toBe('not_writable');
    expect(read(again.settings)).toBe(on);
  });

  for (const which of ['registry', 'script'] as const) {
    it(`the backup is a hard link to HQ's own ${which}: refused, and that file is untouched`, async () => {
      const r = rig({ settings: original });
      await r.hooks.listening({ port: 4317, token: 'T'.repeat(43) });
      await r.hooks.set(true);
      rmSync(backupOf(r.settings));
      const ours = which === 'registry' ? r.hooks.paths.registry : r.hooks.paths.script;
      const before = read(ours);
      linkSync(ours, backupOf(r.settings));
      expect((await refusal(() => r.hooks.set(false))).failure).toBe('not_writable');
      expect(read(ours)).toBe(before);
      expect(read(r.settings)).toContain('agent-productivity-hq-hook');
    });
  }

  it('the settings file is a link to another target’s backup: both are refused, nothing is written', async () => {
    const r = rig({ settings: original });
    const second = join(r.root, 'second');
    mkdirSync(second);
    symlinkSync(backupOf(r.settings), join(second, 'settings.json'));
    writeFileSync(backupOf(r.settings), asText({ b: 1 }), { mode: 0o600 });
    const both = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` } });
    expect((await both.status()).state).toBe('unavailable');
    expect((await refusal(() => both.set(true))).failure).toBe('not_writable');
    expect(read(backupOf(r.settings))).toBe(asText({ b: 1 }));
    expect(read(r.settings)).toBe(original);
  });

  it('the backup would lie inside HQ’s own folder (the settings path is a link into it): refused', async () => {
    const r = rig();
    const elsewhere = join(r.root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'settings.json'), original);
    mkdirSync(join(r.data, 'claude-hooks'), { mode: 0o700 });
    const folder = join(r.root, 'linked config');
    symlinkSync(join(r.data, 'claude-hooks'), folder);
    symlinkSync(join(elsewhere, 'settings.json'), join(r.data, 'claude-hooks', 'settings.json'));
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: folder } });
    expect((await hooks.status()).state).toBe('unavailable');
    await refusal(() => hooks.set(true));
    expect(read(join(elsewhere, 'settings.json'))).toBe(original);
    expect(
      names(join(r.data, 'claude-hooks')).filter((name) => name.endsWith(BACKUP_SUFFIX)),
    ).toEqual([]);
  });

  it('the settings file itself lies inside HQ’s own folder: refused (unsupported_shape)', async () => {
    const r = rig();
    const folder = join(r.data, 'claude-hooks');
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, 'settings.json'), original);
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: folder } });
    const status = await hooks.status();
    expect(status).toMatchObject({ state: 'unavailable', reason: 'settings_blocked' });
    expect(status.files[0]).toMatchObject({ state: 'blocked', reason: 'unsupported_shape' });
    expect((await refusal(() => hooks.set(true))).failure).toBe('unsupported_shape');
    expect(read(join(folder, 'settings.json'))).toBe(original);
  });
});

describe('two targeted paths that are one file are one target', () => {
  const single = async (config: (r: ReturnType<typeof rig>) => string) => {
    const r = rig({ settings: original });
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: config(r) } });
    const status = await hooks.status();
    expect(status.files).toHaveLength(1);
    await hooks.set(true, { preview: status.preview });
    // Written once: one backup, one settings file with one set of entries.
    expect(read(r.settings).match(/agent-productivity-hq-hook/g)).toHaveLength(5);
    expect(names(r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
  };

  it('a `..` segment', () => single((r) => `${r.config},${r.config}/../.claude`));
  it('a link to the folder', () =>
    single((r) => {
      const link = join(r.root, 'link');
      symlinkSync(r.config, link);
      return `${r.config},${link}`;
    }));
  it('a settings file that is a link to the other', () =>
    single((r) => {
      const other = join(r.root, 'other');
      mkdirSync(other);
      symlinkSync(r.settings, join(other, 'settings.json'));
      return `${r.config},${other}`;
    }));
  it('a settings file that is a link to a link to the other', () =>
    single((r) => {
      const middle = join(r.root, 'middle');
      mkdirSync(middle);
      symlinkSync(r.settings, join(middle, 'settings.json'));
      const other = join(r.root, 'other');
      mkdirSync(other);
      symlinkSync(join(middle, 'settings.json'), join(other, 'settings.json'));
      return `${r.config},${middle},${other}`;
    }));

  it('removes the installed hooks from both config folders when their settings are hard links', async () => {
    const r = rig({ settings: original });
    await turnOn(r.hooks);
    const other = join(r.root, 'other');
    const otherSettings = join(other, 'settings.json');
    mkdirSync(other);
    linkSync(r.settings, otherSettings);

    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${other}` } });
    const preview = (await hooks.status()).plans.off?.preview;
    const result = await hooks.set(false, { preview });

    expect(read(r.settings)).toBe(original);
    expect(read(otherSettings)).toBe(original);
    expect(result.state).toBe('off');
  });

  // A disk that ignores case (the default on macOS) names one folder in two spellings: found by device and inode, not by name.
  const folded = (() => {
    const probe = rig();
    return existsSync(probe.config.replace('.claude', '.CLAUDE'));
  })();
  it.skipIf(!folded)('a name in another case on a case-insensitive disk', () =>
    single((r) => `${r.config},${r.config.replace('.claude', '.CLAUDE')}`),
  );

  it.skipIf(!folded)('a symlink with a differently cased target basename is the same entry', () =>
    single((r) => {
      const other = join(r.root, 'other');
      mkdirSync(other);
      symlinkSync(join(r.config, 'SETTINGS.JSON'), join(other, 'settings.json'));
      return `${r.config},${other}`;
    }),
  );

  it('handed to the writer twice, nothing is written', async () => {
    const r = rig({ settings: original });
    const link = join(r.root, 'link');
    symlinkSync(r.config, link);
    const error = await refusal(() =>
      editSettingsFiles(
        [
          { path: r.settings, backup: backupOf(r.settings) },
          { path: join(link, 'settings.json'), backup: backupOf(join(link, 'settings.json')) },
        ],
        () => ['{"a":1}', '{"a":1}'],
      ),
    );
    expect(error.failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
    expect(names(r.config)).toEqual(['settings.json']);
  });
});

// Two pathnames that are distinct directory entries of one inode (hard links) are each a target: a rename updates one entry only, so
// each is written (its own temp, backup, rename and plan line) and, after any action, every configured pathname holds the intended
// content. A symlink chain is one target. A file with a name HQ was not given (a link count above the targeted names) is refused.
describe('hard links are targets of their own', () => {
  const MARKER = 'agent-productivity-hq-hook';
  const entries = (path: string): number => read(path).split(MARKER).length - 1;

  /** The first folder holds the file; the second holds a hard link of it; the switch targets both. */
  function pair() {
    const r = rig({ settings: original });
    const other = join(r.root, 'other');
    const otherSettings = join(other, 'settings.json');
    mkdirSync(other);
    linkSync(r.settings, otherSettings);
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${other}` } });
    return { r, other, otherSettings, hooks };
  }

  it('turning on writes both entries: each has the entries, its own backup, and a line in the plan', async () => {
    const { r, other, otherSettings, hooks } = pair();
    const status = await hooks.status();
    expect(status.files.map((file) => file.path)).toEqual([
      '~/.claude/settings.json',
      `${other}/settings.json`,
    ]);
    const plan = status.plans.on!;
    expect(plan.files.map((file) => file.path)).toEqual(status.files.map((file) => file.path));
    await hooks.set(true, { preview: plan.preview });
    expect(entries(r.settings)).toBe(5);
    expect(entries(otherSettings)).toBe(5);
    expect(read(backupOf(r.settings))).toBe(original);
    expect(read(backupOf(otherSettings))).toBe(original);
    expect(names(r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
    expect(names(other)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
    expect((await hooks.status()).state).toBe('on');
  });

  it('turning off removes both, and is exact for a pair that only one folder turned on', async () => {
    const { r, otherSettings, hooks } = pair();
    await hooks.set(true);
    const preview = (await hooks.status()).plans.off?.preview;
    await hooks.set(false, { preview });
    expect(read(r.settings)).toBe(original);
    expect(read(otherSettings)).toBe(original);
    expect((await hooks.status()).state).toBe('off');
  });

  it('repair rewrites both', async () => {
    const { r, otherSettings, hooks } = pair();
    await hooks.set(true);
    // (the writes made the two names two files; the owner edits both)
    for (const path of [r.settings, otherSettings])
      writeFileSync(path, read(path).replace('"timeout": 3', '"timeout": 9'));
    const status = await hooks.status();
    expect(status.state).toBe('needs_repair');
    expect(status.plans.repair?.files).toHaveLength(2);
    await hooks.set(true, { preview: status.plans.repair!.preview });
    expect((await hooks.status()).state).toBe('on');
    expect(read(r.settings)).not.toContain('"timeout": 9');
    expect(read(otherSettings)).not.toContain('"timeout": 9');
  });

  it('a failure on the second puts the first back: both names hold the original', async () => {
    const { r, other, otherSettings, hooks } = pair();
    const failing = r.another({
      env: { CLAUDE_CONFIG_DIR: `${r.config},${other}` },
      onStep: (step, path) => {
        if (step === 'before_commit' && path === otherSettings) chmodSync(other, 0o500);
      },
    });
    expect((await refusal(() => failing.set(true))).failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
    expect(read(otherSettings)).toBe(original);
    chmodSync(other, 0o700);
    expect(names(r.config)).toEqual(['settings.json']);
    // and it can be done afterwards
    await hooks.set(true);
    expect(entries(r.settings)).toBe(5);
    expect(entries(otherSettings)).toBe(5);
  });

  it('a symlink to one of them is the same target (written once, still a link); a hard link beside it is a target', async () => {
    const { r, other, otherSettings } = pair();
    const third = join(r.root, 'third');
    mkdirSync(third);
    symlinkSync(r.settings, join(third, 'settings.json'));
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${other},${third}` } });
    const status = await hooks.status();
    expect(status.files).toHaveLength(2);
    await hooks.set(true, { preview: status.plans.on!.preview });
    expect(entries(r.settings)).toBe(5);
    expect(entries(otherSettings)).toBe(5);
    expect(lstatSync(join(third, 'settings.json')).isSymbolicLink()).toBe(true);
    expect(read(join(third, 'settings.json'))).toBe(read(r.settings));
    expect(names(third)).toEqual(['settings.json']);
    expect(read(backupOf(r.settings))).toBe(original);
  });

  it('refuses a file that has a name HQ was not given (a link count above the targeted names), and writes nothing', async () => {
    const { r, otherSettings, hooks } = pair();
    const outside = join(r.root, 'outside.json');
    linkSync(r.settings, outside);
    const status = await hooks.status();
    expect(status).toMatchObject({ state: 'unavailable', reason: 'settings_blocked' });
    expect(status.files.map((file) => [file.state, file.reason])).toEqual([
      ['blocked', 'not_writable'],
      ['blocked', 'not_writable'],
    ]);
    expect((await refusal(() => hooks.set(true))).failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
    expect(read(otherSettings)).toBe(original);
    expect(read(outside)).toBe(original);
    expect(names(r.config)).toEqual(['settings.json']);
  });

  it('refuses a single settings file that has a second name outside the targeted folders', async () => {
    const r = rig({ settings: original });
    linkSync(r.settings, join(r.root, 'elsewhere.json'));
    expect((await r.hooks.status()).files[0]).toMatchObject({
      state: 'blocked',
      reason: 'not_writable',
    });
    expect((await refusal(() => r.hooks.set(true))).failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
  });

  it('a name added while the change is made (after it was read) refuses it and leaves the files as they were', async () => {
    const { r, otherSettings } = pair();
    let done = false;
    const hooks = r.another({
      env: { CLAUDE_CONFIG_DIR: `${r.config},${join(r.root, 'other')}` },
      onStep: (step, path) => {
        if (step !== 'before_commit' || path !== r.settings || done) return;
        done = true;
        linkSync(r.settings, join(r.root, 'late.json'));
      },
    });
    expect((await refusal(() => hooks.set(true))).failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
    expect(read(otherSettings)).toBe(original);
  });

  it('refuses an unlisted alias added to the original inode after the first replacement', async () => {
    const { r, other, otherSettings } = pair();
    const outside = join(r.root, 'outside.json');
    const hooks = r.another({
      env: { CLAUDE_CONFIG_DIR: `${r.config},${other}` },
      onStep: (step, path) => {
        if (step === 'after_commit' && path === r.settings) linkSync(otherSettings, outside);
      },
    });

    expect((await refusal(() => turnOn(hooks))).failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
    expect(read(otherSettings)).toBe(original);
    expect(read(outside)).toBe(original);
    expect(names(r.config)).toEqual(['settings.json']);
    expect(names(other)).toEqual(['settings.json']);
  });
});
