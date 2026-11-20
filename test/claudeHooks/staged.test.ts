import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import { editSettingsText } from '../../src/server/integrations/claudeHooks/edit.ts';
import { watchMutations } from '../../src/server/integrations/claudeHooks/fsguard.ts';
import type { Step } from '../../src/server/integrations/claudeHooks/write.ts';
import { USER_SETTINGS, asText, read, rig, type Rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): every file HQ is about to rename into place (a staged update, a
// rollback copy) is checked immediately before the rename: the same file HQ created, a regular file, not a link, owner-only until the
// mode step, with one name, and its bytes exactly the bytes HQ computed. So whatever happens to a temp file between the steps (it is
// replaced, edited, deleted, swapped for a link, made wider, given a second name), the owner's settings are never replaced by
// anything but HQ's exact computed bytes or the exact original bytes.

const original = asText(USER_SETTINGS);
const tmpFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.tmp'))
    .map((name) => join(dir, name));

/** What can happen to a staged file, as the owner or another program could do it. `left` says whether HQ must report it as left behind. */
const TAMPERINGS: { name: string; act: (path: string) => void; left: boolean }[] = [
  {
    name: 'replaced by another file with the same bytes',
    act: (path) => {
      const bytes = readFileSync(path);
      writeFileSync(`${path}.other`, bytes, { mode: 0o600 });
      renameSync(`${path}.other`, path);
    },
    left: true,
  },
  {
    name: 'edited in place',
    act: (path) => appendFileSync(path, ' edited'),
    left: true,
  },
  { name: 'deleted', act: (path) => rmSync(path), left: false },
  {
    name: 'swapped for a link to a file with the same bytes',
    act: (path) => {
      const decoy = `${path}.decoy`;
      writeFileSync(decoy, readFileSync(path), { mode: 0o600 });
      rmSync(path);
      symlinkSync(decoy, path);
    },
    left: true,
  },
  { name: 'made group-readable (0644)', act: (path) => chmodSync(path, 0o644), left: false },
  { name: 'made read-only (0400)', act: (path) => chmodSync(path, 0o400), left: false },
  { name: 'made executable (0700)', act: (path) => chmodSync(path, 0o700), left: false },
  {
    name: 'given a second name (hard link)',
    act: (path) => linkSync(path, `${path}.hard`),
    left: false,
  },
];

async function failureOf(run: () => Promise<unknown>): Promise<ClaudeHooksError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
    return error as ClaudeHooksError;
  }
  throw new Error('expected a failure');
}

/** The staged file with the new content: the one that is not a copy of the file as it is now. */
const updateOf = (dir: string, settings: string): string | undefined =>
  tmpFiles(dir).find((path) => !path.endsWith('.other') && read(path) !== read(settings));
/** The staged copy of the original, for a rollback. */
const undoOf = (dir: string): string | undefined =>
  tmpFiles(dir).find((path) => !path.endsWith('.other') && read(path) === original);

/** A switch over `r` whose owner does `act` once, at `step`. */
function tampering(r: Rig, step: Step, act: () => void) {
  let done = false;
  return r.another({
    onStep: (at) => {
      if (at !== step || done) return;
      done = true;
      act();
    },
  });
}

describe('a staged update that is tampered with is never installed', () => {
  it('keeps a settings save made while the staged update receives its final mode', async () => {
    const r = rig({ settings: original });
    chmodSync(r.settings, 0o640);
    const preview = (await r.hooks.status()).plans.on?.preview;
    const ownerSave = asText({ ...USER_SETTINGS, model: 'sonnet' });
    let saved = false;
    const stop = watchMutations((mutation, phase) => {
      if (saved || phase !== 'before' || mutation.op !== 'chmod') return;
      if (!mutation.path.endsWith('.tmp') || !existsSync(mutation.path)) return;
      if (!read(mutation.path).includes('agent-productivity-hq-hook;')) return;
      writeFileSync(r.settings, ownerSave);
      saved = true;
    });
    try {
      await r.hooks.set(true, { preview }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(ClaudeHooksError);
      });
    } finally {
      stop();
    }

    expect(saved).toBe(true);
    expect(read(r.settings)).toBe(ownerSave);
  });

  const steps: Step[] = ['staged', 'before_backup', 'after_backup', 'before_commit'];

  for (const step of steps) {
    for (const tamper of TAMPERINGS) {
      it(`turning on: ${tamper.name} at ${step} refuses the change and leaves the settings as they were`, async () => {
        const r = rig({ settings: original });
        const modeBefore = statSync(r.settings).mode & 0o7777;
        const hooks = tampering(r, step, () => tamper.act(updateOf(r.config, r.settings)!));
        const preview = await hooks.status();
        const error = await failureOf(() => hooks.set(true, { preview: preview.preview }));
        expect(['not_writable']).toContain(error.failure);
        expect(read(r.settings)).toBe(original);
        expect(statSync(r.settings).mode & 0o7777).toBe(modeBefore);
        if (tamper.left) expect(error.left).toContain('temp');
        else expect(error.left).not.toContain('temp');
        // HQ's script and registry were taken back with the change.
        expect(existsSync(r.hooks.paths.script)).toBe(false);
      });
    }
  }

  for (const tamper of TAMPERINGS) {
    it(`repair: ${tamper.name} refuses the change and leaves the settings as they were`, async () => {
      const r = rig({ settings: original });
      await r.hooks.set(true);
      const edited = read(r.settings).replace('"timeout": 3', '"timeout": 9');
      writeFileSync(r.settings, edited);
      const hooks = tampering(r, 'before_commit', () =>
        tamper.act(updateOf(r.config, r.settings)!),
      );
      const status = await hooks.status();
      expect(status.state).toBe('needs_repair');
      const error = await failureOf(() =>
        hooks.set(true, { preview: status.plans.repair!.preview }),
      );
      expect(error.failure).toBe('not_writable');
      expect(read(r.settings)).toBe(edited);
    });

    it(`turning off: ${tamper.name} refuses the change and leaves the settings as they were`, async () => {
      const r = rig({ settings: original });
      await r.hooks.set(true);
      const on = read(r.settings);
      const hooks = tampering(r, 'before_commit', () =>
        tamper.act(updateOf(r.config, r.settings)!),
      );
      const status = await hooks.status();
      const error = await failureOf(() => hooks.set(false, { preview: status.plans.off!.preview }));
      expect(error.failure).toBe('not_writable');
      expect(read(r.settings)).toBe(on);
      // The registry and script stay: the entries are still there.
      expect(existsSync(r.hooks.paths.script)).toBe(true);
    });
  }

  it('a change nobody tampers with installs exactly the bytes that were computed', async () => {
    const r = rig({ settings: original });
    const status = await r.hooks.status();
    await r.hooks.set(true, { preview: status.preview });
    expect(read(r.settings)).toBe(editSettingsText(original, status.command, true));
    expect(tmpFiles(r.config)).toEqual([]);
  });
});

describe('a rollback copy that is tampered with is never installed', () => {
  /** Two Claude Code folders; the second one cannot be replaced (its staged files are lost), so the first is rolled back. */
  function twoFolders(act: (path: string) => void, mode?: number) {
    const r = rig({ settings: original });
    if (mode !== undefined) chmodSync(r.settings, mode);
    const second = join(r.root, 'second');
    const secondSettings = join(second, 'settings.json');
    mkdirSync(second);
    writeFileSync(secondSettings, asText({ b: 2 }), { mode: 0o600 });
    let done = false;
    const hooks = r.another({
      env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` },
      onStep: (step, path) => {
        if (step !== 'before_commit' || path !== secondSettings || done) return;
        done = true;
        act(undoOf(r.config)!);
        for (const name of tmpFiles(second)) rmSync(name);
      },
    });
    return { r, hooks, second, secondSettings };
  }

  for (const tamper of TAMPERINGS) {
    it(`${tamper.name}: the first file is put back from the original bytes HQ holds`, async () => {
      const world = twoFolders(tamper.act, 0o640);
      const error = await failureOf(() => world.hooks.set(true));
      expect(error.failure).toBe('not_writable');
      // Never the tampered copy, never HQ's entries: exactly the original bytes, in the original mode.
      expect(read(world.r.settings)).toBe(original);
      expect(statSync(world.r.settings).mode & 0o7777).toBe(0o640);
      expect(read(world.secondSettings)).toBe(asText({ b: 2 }));
      if (tamper.left) expect(error.left).toContain('temp');
      else expect(error.left).not.toContain('temp');
    });
  }

  it('a copy nobody touches is used, and is gone afterwards', async () => {
    const world = twoFolders(() => undefined, 0o640);
    const error = await failureOf(() => world.hooks.set(true));
    expect(read(world.r.settings)).toBe(original);
    expect(error.left).not.toContain('temp');
    expect(tmpFiles(world.r.config)).toEqual([]);
  });

  it('an owner who saves a different file after HQ wrote its update keeps it (rollback_failed names the file)', async () => {
    const world = twoFolders(() => undefined);
    const saved = asText({ saved: 'by the owner' });
    const hooks = world.r.another({
      env: { CLAUDE_CONFIG_DIR: `${world.r.config},${world.second}` },
      onStep: (step, path) => {
        if (step !== 'before_commit' || path !== world.secondSettings) return;
        writeFileSync(world.r.settings, saved);
        for (const name of tmpFiles(world.second)) rmSync(name);
      },
    });
    const error = await failureOf(() => hooks.set(true));
    expect(error.failure).toBe('rollback_failed');
    expect(read(world.r.settings)).toBe(saved);
  });
});
