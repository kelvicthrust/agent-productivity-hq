import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import type { Step } from '../../src/server/integrations/claudeHooks/write.ts';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import { USER_SETTINGS, asText, names, read, readJson, rig, type Rig } from './helpers.ts';

// The rules (data-and-sources › Claude Code hooks › Install and remove):
//   - a change is all or nothing across every settings file: if it cannot be applied to all of them, every file is byte for byte what it
//     was; a file that cannot be put back is named; what is reported is what is on disk;
//   - the compare-and-swap is the last thing before each rename: the owner's save at any step survives;
//   - "on" means deliverable.

const TOKEN = 'T'.repeat(43);
const failureOf = async (run: () => Promise<unknown>): Promise<ClaudeHooksError> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
    return error as ClaudeHooksError;
  }
  throw new Error('expected a failure');
};
const hasHq = (path: string): boolean => read(path).includes('agent-productivity-hq-hook');

/** Someone removes HQ's staged files from a folder, so the rename that would replace the settings file there fails. */
function loseStagedFiles(dir: string): void {
  for (const name of readdirSync(dir)) if (name.endsWith('.tmp')) rmSync(join(dir, name));
}

/** Two Claude Code folders, the second outside the home folder, each with a settings file. */
function twoFolders(extra: Parameters<Rig['another']>[0] = {}) {
  const r = rig({ settings: asText(USER_SETTINGS) });
  const second = join(r.root, 'second');
  const secondSettings = join(second, 'settings.json');
  mkdirSync(second);
  writeFileSync(secondSettings, asText({ b: 2 }), { mode: 0o600 });
  const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` }, ...extra });
  return { r, hooks, second, secondSettings };
}

describe('all or nothing across settings files', () => {
  it('does not replace settings with an edited staged update', async () => {
    const original = asText(USER_SETTINGS);
    const edited = asText({ note: 'edited update' });
    const r = rig({ settings: original });
    let update: string | undefined;
    const hooks = r.another({
      onStep: (step) => {
        if (step !== 'before_commit') return;
        update = names(r.config)
          .filter((name) => name.endsWith('.tmp'))
          .map((name) => join(r.config, name))
          .find(hasHq);
        writeFileSync(update!, edited);
      },
    });

    const preview = await hooks.status();
    await expect(hooks.set(true, { preview: preview.preview })).rejects.toMatchObject({
      left: expect.arrayContaining(['temp']),
    });
    expect(read(r.settings)).toBe(original);
    expect(read(update!)).toBe(edited);
  });

  it('puts the first file back when the second cannot be replaced, and says nothing changed', async () => {
    const world = twoFolders({
      onStep: (step: Step, path: string) => {
        if (step === 'before_commit' && path === world.secondSettings)
          loseStagedFiles(world.second);
      },
    });
    const before = [read(world.r.settings), read(world.secondSettings)];
    const error = await failureOf(() => world.hooks.set(true));
    expect(error.failure).toBe('not_writable');
    expect([read(world.r.settings), read(world.secondSettings)]).toEqual(before);
    expect(names(world.r.config)).toEqual(['settings.json']); // no temp file, no backup of a change that did not happen
    expect(names(world.second)).toEqual(['settings.json']);
    expect(existsSync(world.hooks.paths.script)).toBe(false);
    expect((await world.hooks.status()).state).toBe('off');
  });

  it('does the same turning off', async () => {
    const world = twoFolders();
    await world.hooks.set(true);
    const installed = [read(world.r.settings), read(world.secondSettings)];
    const stop = world.r.another({
      env: { CLAUDE_CONFIG_DIR: `${world.r.config},${world.second}` },
      onStep: (step, path) => {
        if (step === 'before_commit' && path === world.secondSettings)
          loseStagedFiles(world.second);
      },
    });
    const error = await failureOf(() => stop.set(false));
    expect(error.failure).toBe('not_writable');
    expect([read(world.r.settings), read(world.secondSettings)]).toEqual(installed);
    expect((await stop.status()).state).toBe('on');
  });

  it('names the file that needs attention, and keeps the backup, when a file cannot be put back', async () => {
    const world = twoFolders({
      onStep: (step: Step, path: string) => {
        if (step === 'before_commit' && path === world.secondSettings) {
          // The first file was replaced. The owner saves it again, and the second cannot be replaced.
          writeFileSync(world.r.settings, '{"theirs":"after HQ wrote it"}');
          loseStagedFiles(world.second);
        }
      },
    });
    const original = asText(USER_SETTINGS);
    const error = await failureOf(() => world.hooks.set(true));
    expect(error.failure).toBe('rollback_failed');
    expect(error.files).toEqual(['~/.claude/settings.json']);
    // The owner's save is not overwritten by the roll-back, the other file is as it was, the backup of the original stays.
    expect(read(world.r.settings)).toBe('{"theirs":"after HQ wrote it"}');
    expect(read(world.secondSettings)).toBe(asText({ b: 2 }));
    expect(read(`${world.r.settings}${BACKUP_SUFFIX}`)).toBe(original);
    expect(names(world.r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
    expect(names(world.second)).toEqual(['settings.json']); // (its copy was only for a change that did not happen)
  });

  it('does not replace settings with an edited rollback copy', async () => {
    const original = asText(USER_SETTINGS);
    const edited = asText({ note: 'edited copy' });
    let copy: string | undefined;
    const world = twoFolders({
      onStep: (step, path) => {
        if (step !== 'before_commit' || path !== world.secondSettings) return;
        copy = names(world.r.config)
          .filter((name) => name.endsWith('.tmp'))
          .map((name) => join(world.r.config, name))
          .find((candidate) => read(candidate) === original);
        writeFileSync(copy!, edited);
        loseStagedFiles(world.second);
      },
    });

    const error = await failureOf(() => world.hooks.set(true));
    const after = read(world.r.settings);
    expect(after).not.toBe(edited);
    expect(read(copy!)).toBe(edited);
    expect(error.left).toContain('temp');
    if (after !== original) {
      expect(error.failure).toBe('rollback_failed');
      expect(read(`${world.r.settings}${BACKUP_SUFFIX}`)).toBe(original);
    }
  });

  it('keeps the script and registry when a file could not be put back (it may hold HQ’s entries), and reports what is on disk', async () => {
    const world = twoFolders({
      onStep: (step: Step, path: string) => {
        if (step === 'before_commit' && path === world.secondSettings) {
          writeFileSync(world.r.settings, asText({ theirs: 1 }));
          loseStagedFiles(world.second);
        }
      },
    });
    await world.hooks.listening({ port: 4317, token: TOKEN });
    await failureOf(() => world.hooks.set(true));
    expect(existsSync(world.hooks.paths.script)).toBe(true);
    expect(existsSync(world.hooks.paths.registry)).toBe(true);
    expect((await world.hooks.status()).state).toBe('off');
  });

  it('keeps the owner’s replacement for a newly published script when enabling fails', async () => {
    const original = asText(USER_SETTINGS);
    const ownerScript = '// saved by the owner during the update\n';
    const r = rig({ settings: original });
    const hooks = r.another({
      onStep: (step) => {
        if (step !== 'before_commit') return;
        writeFileSync(r.hooks.paths.script, ownerScript);
        loseStagedFiles(r.config);
      },
    });
    const preview = await hooks.status();

    await expect(hooks.set(true, { preview: preview.preview })).rejects.toMatchObject({
      failure: 'not_writable',
    });
    expect(read(r.settings)).toBe(original);
    expect(read(r.hooks.paths.script)).toBe(ownerScript);
  });

  it('starts over from a fresh read when the owner saves the second file after the first was replaced, and loses nothing of theirs', async () => {
    let saved = false;
    const world = twoFolders({
      onStep: (step: Step, path: string) => {
        if (step === 'before_commit' && path === world.secondSettings && !saved) {
          saved = true;
          writeFileSync(world.secondSettings, asText({ b: 2, theirs: true }));
        }
      },
    });
    const status = await world.hooks.set(true);
    expect(status.state).toBe('on');
    expect(readJson(world.secondSettings)['theirs']).toBe(true);
    expect(readJson(world.r.settings)['model']).toBe('opus');
    expect(hasHq(world.r.settings) && hasHq(world.secondSettings)).toBe(true);
    expect(read(`${world.secondSettings}${BACKUP_SUFFIX}`)).toBe(asText({ b: 2, theirs: true }));
    expect(names(world.r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
  });

  it('gives up with a conflict when the second file keeps changing, with every file as it was', async () => {
    let n = 0;
    const world = twoFolders({
      onStep: (step: Step, path: string) => {
        if (step === 'before_commit' && path === world.secondSettings)
          writeFileSync(world.secondSettings, asText({ b: 2, saves: (n += 1) }));
      },
    });
    const first = read(world.r.settings);
    expect((await failureOf(() => world.hooks.set(true))).failure).toBe('conflict');
    expect(read(world.r.settings)).toBe(first);
    expect(readJson(world.secondSettings)['saves']).toBe(3);
    expect(names(world.r.config)).toEqual(['settings.json']);
    expect(names(world.second)).toEqual(['settings.json']);
    expect(existsSync(world.hooks.paths.script)).toBe(false);
  });

  it('is the same file twice when two Claude Code folders resolve to one (written once)', async () => {
    const r = rig({ settings: '{}' });
    const alias = join(r.root, 'alias');
    symlinkSync(r.config, alias);
    const hooks = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${alias}` } });
    expect((await hooks.status()).files).toHaveLength(1);
    expect((await hooks.set(true)).state).toBe('on');
  });
});

describe('the owner saving while HQ writes: nothing of theirs is ever overwritten', () => {
  it('leaves an existing settings file alone if the owner makes it read-only before replacement', async () => {
    const original = asText(USER_SETTINGS);
    const r = rig({ settings: original });
    const hooks = r.another({
      onStep: (step) => {
        if (step === 'before_commit') chmodSync(r.settings, 0o400);
      },
    });
    const preview = await hooks.status();

    await expect(hooks.set(true, { preview: preview.preview })).rejects.toBeInstanceOf(
      ClaudeHooksError,
    );
    expect(read(r.settings)).toBe(original);
    expect(statSync(r.settings).mode & 0o777).toBe(0o400);
  });

  const steps: Step[] = ['staged', 'before_backup', 'after_backup', 'before_commit'];
  for (const step of steps) {
    it(`survives a save at ${step}: the change is computed again from their file`, async () => {
      let saved = false;
      const r = rig({
        settings: asText(USER_SETTINGS),
        extra: {
          onStep: (at: Step) => {
            if (at === step && !saved) {
              saved = true;
              writeFileSync(r.settings, asText({ ...USER_SETTINGS, theirs: 'saved at ' + step }));
            }
          },
        },
      });
      const status = await r.hooks.set(true);
      expect(status.state).toBe('on');
      const after = readJson(r.settings);
      expect(after['theirs']).toBe('saved at ' + step);
      expect(after['model']).toBe('opus');
      expect(hasHq(r.settings)).toBe(true);
      // The one-time copy is of the file HQ actually changed, theirs included, and nothing else is left.
      expect(JSON.parse(read(`${r.settings}${BACKUP_SUFFIX}`))['theirs']).toBe('saved at ' + step);
      expect(names(r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
    });

    it(`survives a save at ${step} on every attempt: it is never overwritten, and HQ says it gave up`, async () => {
      let n = 0;
      const r = rig({
        settings: asText(USER_SETTINGS),
        extra: {
          onStep: (at: Step) => {
            if (at === step) writeFileSync(r.settings, asText({ saves: (n += 1) }));
          },
        },
      });
      const error = await failureOf(() => r.hooks.set(true));
      expect(error.failure).toBe('conflict');
      expect(readJson(r.settings)).toEqual({ saves: 3 });
      expect(names(r.config)).toEqual(['settings.json']);
      expect(existsSync(r.hooks.paths.script)).toBe(false);
    });
  }

  it('notices a file replaced by another file with the same bytes (another inode)', async () => {
    let swapped = false;
    const r = rig({
      settings: asText(USER_SETTINGS),
      extra: {
        onStep: (at: Step) => {
          if (at === 'before_commit' && !swapped) {
            swapped = true;
            const bytes = readFileSync(r.settings);
            const aside = join(r.config, 'settings.new');
            writeFileSync(aside, bytes);
            renameSync(aside, r.settings);
          }
        },
      },
    });
    expect((await r.hooks.set(true)).state).toBe('on');
    expect(swapped).toBe(true);
    expect(names(r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
  });

  it('notices a file rewritten in place with the same bytes and size (another modification time)', async () => {
    let touched = false;
    const r = rig({
      settings: asText(USER_SETTINGS),
      extra: {
        onStep: (at: Step) => {
          if (at === 'before_commit' && !touched) {
            touched = true;
            utimesSync(r.settings, new Date(1_000), new Date(2_000));
          }
        },
      },
    });
    expect((await r.hooks.set(true)).state).toBe('on');
    expect(touched).toBe(true);
  });

  it('notices a settings link that is pointed somewhere else, and writes the file it points at now, not the one it pointed at', async () => {
    const r = rig({ settings: null });
    const a = join(r.root, 'a.json');
    const b = join(r.root, 'b.json');
    writeFileSync(a, asText({ which: 'a' }));
    writeFileSync(b, asText({ which: 'b' }));
    symlinkSync(a, r.settings);
    let moved = false;
    const hooks = r.another({
      onStep: (at: Step) => {
        if (at === 'before_commit' && !moved) {
          moved = true;
          renameSync(r.settings, `${r.settings}.old`);
          symlinkSync(b, r.settings);
        }
      },
    });
    expect((await hooks.set(true)).state).toBe('on');
    expect(read(a)).toBe(asText({ which: 'a' }));
    expect(readJson(b)['which']).toBe('b');
    expect(hasHq(b)).toBe(true);
  });

  it('creates a missing file only if it is still missing at the last moment', async () => {
    let created = false;
    const r = rig({
      settings: null,
      extra: {
        onStep: (at: Step) => {
          if (at === 'before_commit' && !created) {
            created = true;
            writeFileSync(r.settings, asText({ theirs: true }));
          }
        },
      },
    });
    expect((await r.hooks.set(true)).state).toBe('on');
    expect(readJson(r.settings)['theirs']).toBe(true);
  });
});

describe('the staged files', () => {
  it('leaves settings unchanged when a directory occupies the required backup path', async () => {
    const original = asText(USER_SETTINGS);
    const r = rig({ settings: original });
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    mkdirSync(backup);
    const preview = await r.hooks.status();

    await expect(r.hooks.set(true, { preview: preview.preview })).rejects.toMatchObject({
      failure: 'not_writable',
    });
    expect(read(r.settings)).toBe(original);
    expect(statSync(backup).isDirectory()).toBe(true);
  });

  it('are owner-only until they are the file, and are gone after success, a conflict and a refusal', async () => {
    const seen: string[] = [];
    const r = rig({
      settings: asText(USER_SETTINGS),
      extra: {
        onStep: (at: Step) => {
          if (at === 'before_backup')
            for (const name of names(r.config))
              if (name.endsWith('.tmp'))
                seen.push(`${name}:${(statSync(join(r.config, name)).mode & 0o777).toString(8)}`);
        },
      },
    });
    chmodSync(r.settings, 0o644);
    await r.hooks.set(true);
    expect(seen).toHaveLength(2); // the new content and the copy for a roll-back
    // Owner-only until they are the file: the file's mode (644 here) is given in the step right before the rename, from the last look.
    for (const entry of seen) expect(entry.endsWith(':600')).toBe(true);
    expect(statSync(r.settings).mode & 0o777).toBe(0o644);
    expect(names(r.config)).toEqual(['settings.json', `settings.json${BACKUP_SUFFIX}`]);
  });

  it('never overwrite a backup that exists', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    // (a copy of a settings file: an empty or unreadable one is not taken for a saved copy, see backup.test.ts)
    const first = asText({ firstCopy: 'the owner’s first copy' });
    writeFileSync(`${r.settings}${BACKUP_SUFFIX}`, first);
    await r.hooks.set(true);
    await r.hooks.set(false);
    await r.hooks.set(true);
    expect(read(`${r.settings}${BACKUP_SUFFIX}`)).toBe(first);
  });
});

describe('the preview the owner confirmed', () => {
  it('is required for the write to be the one that was shown: a stale or missing one writes nothing at all', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    const shown = (await r.hooks.status()).preview;
    expect(shown).toMatch(/^[0-9a-f]{64}$/);
    expect((await r.hooks.status()).preview).toBe(shown);
    writeFileSync(r.settings, asText({ ...USER_SETTINGS, edited: true }));
    expect((await failureOf(() => r.hooks.set(true, { preview: shown }))).failure).toBe(
      'stale_preview',
    );
    expect((await failureOf(() => r.hooks.set(true, { preview: '' }))).failure).toBe(
      'stale_preview',
    );
    expect(readJson(r.settings)['edited']).toBe(true);
    expect(hasHq(r.settings)).toBe(false);
    expect(existsSync(r.hooks.paths.dir)).toBe(false); // not even the script was installed
    const fresh = (await r.hooks.status()).preview;
    expect(fresh).not.toBe(shown);
    expect((await r.hooks.set(true, { preview: fresh })).state).toBe('on');
  });

  it('is checked again on the very bytes the change is computed from: a save after the preview is refused, not merged in', async () => {
    let saved = false;
    const r = rig({
      settings: asText(USER_SETTINGS),
      extra: {
        onStep: (at: Step) => {
          if (at === 'before_backup' && !saved) {
            saved = true;
            writeFileSync(r.settings, asText({ ...USER_SETTINGS, late: true }));
          }
        },
      },
    });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    const shown = (await r.hooks.status()).preview;
    expect((await failureOf(() => r.hooks.set(true, { preview: shown }))).failure).toBe(
      'stale_preview',
    );
    expect(readJson(r.settings)['late']).toBe(true);
    expect(hasHq(r.settings)).toBe(false);
    expect(names(r.config)).toEqual(['settings.json']);
    expect(names(r.hooks.paths.dir)).toEqual([]); // the script and the registry were undone
  });

  it('changes with each file’s bytes, which files there are, the script, the registry’s condition and the state, but not with time', async () => {
    let now = 1_000;
    const r = rig({ settings: '{}', extra: { now: () => now } });
    const first = (await r.hooks.status()).preview;
    now += 3_600_000;
    expect((await r.hooks.status()).preview).toBe(first);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    // Once the server listens, turning on also publishes the registry, so the plan that is shown lists a write it did not list before:
    // the fingerprint covers the registry's condition (and stays the same while nothing changes).
    const listening = (await r.hooks.status()).preview;
    expect(listening).not.toBe(first);
    expect((await r.hooks.status()).preview).toBe(listening);
    writeFileSync(r.settings, '{ }');
    const edited = (await r.hooks.status()).preview;
    expect(edited).not.toBe(listening);
    const two = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${join(r.root, 'x')}` } });
    mkdirSync(join(r.root, 'x'));
    expect((await two.status()).preview).not.toBe(edited);
    await r.hooks.set(true);
    const on = (await r.hooks.status()).preview;
    expect(on).not.toBe(edited);
    writeFileSync(r.hooks.paths.script, '// changed');
    expect((await r.hooks.status()).preview).not.toBe(on);
  });

  it('also guards turning off', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.set(true);
    const shown = (await r.hooks.status()).preview;
    const text = read(r.settings);
    writeFileSync(r.settings, text.replace('"hooks"', '"extra": 1,\n  "hooks"'));
    expect((await failureOf(() => r.hooks.set(false, { preview: shown }))).failure).toBe(
      'stale_preview',
    );
    expect(hasHq(r.settings)).toBe(true);
  });
});

describe('“on” means deliverable', () => {
  const listening = async (r: Rig) => {
    await r.hooks.set(true);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    expect(await r.hooks.status()).toMatchObject({ state: 'on', reason: null });
  };

  it('needs the registry published and readable back with this process’s pid, port and token', async () => {
    const r = rig({ settings: '{}' });
    await listening(r);
    const registry = read(r.hooks.paths.registry);
    const wrong: [string, string][] = [
      ['another port', registry.replace('4317', '5000')],
      ['another token', registry.replace(TOKEN, 'U'.repeat(43))],
      ['another process', registry.replace(`"pid":${process.pid}`, `"pid":${process.pid + 1}`)],
      ['something that is not a registry', 'nope'],
    ];
    for (const [name, text] of wrong) {
      writeFileSync(r.hooks.paths.registry, text);
      expect(await r.hooks.status(), name).toMatchObject({
        state: 'needs_repair',
        reason: 'registry_unpublished',
      });
    }
    rmSync(r.hooks.paths.registry);
    expect(await r.hooks.status()).toMatchObject({
      state: 'needs_repair',
      reason: 'registry_unpublished',
    });
    // Repairing publishes it again, and touches no settings file.
    const stamp = read(r.settings);
    expect((await r.hooks.set(true)).state).toBe('on');
    expect(read(r.settings)).toBe(stamp);
  });

  it('needs every settings file complete and unfiltered, and the script as shipped', async () => {
    const r = rig({ settings: '{}' });
    await listening(r);
    const good = read(r.settings);
    const value = readJson(r.settings) as { hooks: Record<string, { matcher?: string }[]> };
    value.hooks['Stop']![0]!.matcher = 'Bash';
    writeFileSync(r.settings, asText(value));
    expect(await r.hooks.status()).toMatchObject({
      state: 'needs_repair',
      reason: 'entries_changed',
    });
    writeFileSync(r.settings, good);
    expect((await r.hooks.status()).state).toBe('on');
    writeFileSync(r.hooks.paths.script, '// changed');
    expect(await r.hooks.status()).toMatchObject({
      state: 'needs_repair',
      reason: 'script_missing',
    });
    rmSync(r.hooks.paths.script);
    expect(await r.hooks.status()).toMatchObject({
      state: 'needs_repair',
      reason: 'script_missing',
    });
  });

  it('fails the action, and leaves nothing half done, when the registry cannot be published', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    mkdirSync(r.hooks.paths.registry, { recursive: true });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    const error = await failureOf(() => r.hooks.set(true));
    expect(error.failure).toBe('registry_failed');
    expect(read(r.settings)).toBe(asText(USER_SETTINGS));
    expect(names(r.config)).toEqual(['settings.json']);
    expect(existsSync(r.hooks.paths.script)).toBe(false);
    expect((await r.hooks.status()).state).toBe('off');
    expect(JSON.stringify(r.logs)).not.toContain(TOKEN);
  });

  it('is needs_repair when the registry cannot be rewritten at the next start, whatever the settings say', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.set(true);
    const restarted = r.another();
    mkdirSync(r.hooks.paths.registry);
    await restarted.listening({ port: 5000, token: TOKEN });
    expect(await restarted.status()).toMatchObject({
      state: 'needs_repair',
      reason: 'registry_unpublished',
    });
    expect(r.logs.some((line) => line['code'] === 'registry_failed')).toBe(true);
  });

  it('is rewritten at the next start with the new port and token, over what a killed app left behind', async () => {
    const r = rig({ settings: '{}' });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    await r.hooks.set(true);
    // The app is killed: no close(). Another start, on another port, finds the stale registry and replaces it.
    const next = r.another();
    await next.listening({ port: 6000, token: 'V'.repeat(43) });
    expect(JSON.parse(read(r.hooks.paths.registry))).toEqual({
      v: 1,
      pid: process.pid,
      port: 6000,
      token: 'V'.repeat(43),
    });
    expect((await next.status()).state).toBe('on');
    // The first process is not "on" any more: the registry points at the other one.
    expect(await r.hooks.status()).toMatchObject({
      state: 'needs_repair',
      reason: 'registry_unpublished',
    });
  });

  it('holds the token in the registry only: not in the settings, the backup, the script, the command, the status or the log', async () => {
    const r = rig({ settings: asText(USER_SETTINGS) });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    const status = await r.hooks.set(true);
    expect(read(r.hooks.paths.registry)).toContain(TOKEN);
    for (const text of [
      read(r.settings),
      read(`${r.settings}${BACKUP_SUFFIX}`),
      read(r.hooks.paths.script),
      status.command,
      JSON.stringify(status),
      JSON.stringify(r.logs),
    ])
      expect(text).not.toContain(TOKEN);
  });

  it('does not require a registry before the server listens', async () => {
    const r = rig({ settings: '{}' });
    expect((await r.hooks.set(true)).state).toBe('on');
  });

  it('is not published when the switch is off, nor when a file is blocked', async () => {
    const off = rig({ settings: '{}' });
    await off.hooks.listening({ port: 4317, token: TOKEN });
    expect(existsSync(off.hooks.paths.registry)).toBe(false);
    const blocked = rig({ settings: '{}' });
    await blocked.hooks.set(true);
    writeFileSync(blocked.settings, 'broken');
    const again = blocked.another();
    await again.listening({ port: 4317, token: TOKEN });
    expect(existsSync(blocked.hooks.paths.registry)).toBe(false);
  });
});
