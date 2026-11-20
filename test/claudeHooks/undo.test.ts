import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeHooksError,
  type LeftBehind,
} from '../../src/server/integrations/claudeHooks/index.ts';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import { hooksApiError } from '../../src/server/http/routes/hqHooks.ts';
import { USER_SETTINGS, asText, read, rig, type Rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): every undo step (the script, the registry, each settings file,
// the backup, temp files) is conditional on the artifact still being what THIS change wrote, byte for byte and the same file (inode).
// Anything the owner saved over, replaced or deleted in the meantime is not touched: it stays where it is and the failure names it
// (`left`, and `details.left` on the wire), never silently. This holds for a failed turn-on, a failed repair and a failed turn-off, and at
// shutdown.

const TOKEN = 'T'.repeat(43);
const original = asText(USER_SETTINGS);

/** Someone removes HQ's staged files from a folder, so the rename that would replace the settings file there fails. */
function loseStagedFiles(dir: string): void {
  for (const name of readdirSync(dir)) if (name.endsWith('.tmp')) rmSync(join(dir, name));
}

async function failureOf(run: () => Promise<unknown>): Promise<ClaudeHooksError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
    return error as ClaudeHooksError;
  }
  throw new Error('expected a failure');
}

/** A switch over `r` that fails at the last moment of turning on, after `owner` did something to HQ's files. */
function failing(r: Rig, owner: () => void) {
  return r.another({
    onStep: (step) => {
      if (step !== 'before_commit') return;
      owner();
      loseStagedFiles(r.config);
    },
  });
}

const script = (r: Rig) => r.hooks.paths.script;
const registry = (r: Rig) => r.hooks.paths.registry;

describe('a failed turn-on takes back only what it wrote', () => {
  it('removes the script and the registry it wrote when nobody touched them', async () => {
    const r = rig({ settings: original });
    const hooks = failing(r, () => undefined);
    await hooks.listening({ port: 4317, token: TOKEN });
    const error = await failureOf(() => hooks.set(true));
    expect(error.failure).toBe('not_writable');
    expect(error.left).toEqual([]);
    expect(existsSync(script(r))).toBe(false);
    expect(existsSync(registry(r))).toBe(false);
    expect(read(r.settings)).toBe(original);
    expect(existsSync(`${r.settings}${BACKUP_SUFFIX}`)).toBe(false);
  });

  const owners: [string, (path: string) => void, 'kept' | 'gone'][] = [
    [
      'saves their own content over it',
      (path) => writeFileSync(path, '// the owner’s own file\n'),
      'kept',
    ],
    ['appends to it', (path) => appendFileSync(path, '\n// a note\n'), 'kept'],
    [
      'replaces it with a file of the very same bytes (another file)',
      (path) => {
        copyFileSync(path, `${path}.copy`);
        renameSync(`${path}.copy`, path);
      },
      'kept',
    ],
    ['deletes it', (path) => rmSync(path), 'gone'],
  ];

  for (const [what, act, outcome] of owners) {
    it(`leaves the script alone when the owner ${what}, and says so`, async () => {
      const r = rig({ settings: original });
      let after = '';
      const hooks = failing(r, () => {
        act(script(r));
        after = existsSync(script(r)) ? read(script(r)) : '';
      });
      const error = await failureOf(() => hooks.set(true));
      expect(error.failure).toBe('not_writable');
      if (outcome === 'kept') {
        expect(existsSync(script(r))).toBe(true);
        expect(read(script(r))).toBe(after);
        expect(error.left).toContain('script');
      } else {
        expect(existsSync(script(r))).toBe(false);
        expect(error.left).toEqual([]);
      }
      expect(read(r.settings)).toBe(original);
    });

    it(`leaves the registry alone when the owner ${what}, and says so`, async () => {
      const r = rig({ settings: original });
      let after = '';
      const hooks = failing(r, () => {
        act(registry(r));
        after = existsSync(registry(r)) ? read(registry(r)) : '';
      });
      await hooks.listening({ port: 4317, token: TOKEN });
      const error = await failureOf(() => hooks.set(true));
      if (outcome === 'kept') {
        expect(read(registry(r))).toBe(after);
        expect(error.left).toContain('registry');
      } else {
        expect(existsSync(registry(r))).toBe(false);
        expect(error.left).toEqual([]);
      }
      // (the script was not touched by the owner, so it is taken back)
      expect(existsSync(script(r))).toBe(false);
    });
  }

  it('restores the script that was there before only while the new one is still what it wrote', async () => {
    const older = '// Agent Productivity: the Claude Code hook (an older version)\n';
    // untouched: the older one comes back
    const a = rig({ settings: original });
    mkdirSync(a.hooks.paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(script(a), older, { mode: 0o600 });
    await failureOf(() => failing(a, () => undefined).set(true));
    expect(read(script(a))).toBe(older);
    // the owner saved over the new one: theirs stays
    const b = rig({ settings: original });
    mkdirSync(b.hooks.paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(script(b), older, { mode: 0o600 });
    const error = await failureOf(() =>
      failing(b, () => writeFileSync(script(b), '// theirs\n')).set(true),
    );
    expect(read(script(b))).toBe('// theirs\n');
    expect(error.left).toContain('script');
  });

  it('keeps the owner’s edit of the backup HQ made, and says so', async () => {
    const r = rig({ settings: original });
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    const hooks = r.another({
      onStep: (step) => {
        if (step === 'after_backup') writeFileSync(backup, 'the owner edited the copy');
        if (step === 'before_commit') loseStagedFiles(r.config);
      },
    });
    const error = await failureOf(() => hooks.set(true));
    expect(read(backup)).toBe('the owner edited the copy');
    expect(error.left).toContain('backup');
    expect(read(r.settings)).toBe(original);
  });

  it('puts the failure and what was left on the wire in fixed words, never a path', async () => {
    const r = rig({ settings: original });
    const hooks = failing(r, () => writeFileSync(script(r), '// theirs\n'));
    const error = await failureOf(() => hooks.set(true));
    const api = hooksApiError(error);
    expect(api.code).toBe('claude_hooks_blocked');
    expect(api.details).toMatchObject({ reason: 'not_writable', left: ['script'] });
    expect(api.message).toContain('its hook script');
    expect(api.message).not.toContain(r.root);
    const labels: LeftBehind[] = ['script', 'registry', 'backup', 'temp'];
    for (const label of labels)
      expect(hooksApiError(new ClaudeHooksError('conflict', [], [label])).details).toMatchObject({
        left: [label],
      });
  });

  it('reports a backup left behind when an owner save makes the confirmed plan stale', async () => {
    const r = rig({ settings: original });
    const ownerSettings = asText({ note: 'saved during update' });
    const ownerBackup = asText({ note: 'saved copy' });
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    const hooks = r.another({
      onStep: (step) => {
        if (step !== 'after_backup') return;
        writeFileSync(r.settings, ownerSettings);
        writeFileSync(backup, ownerBackup);
      },
    });
    const preview = await hooks.status();

    const error = await failureOf(() => hooks.set(true, { preview: preview.preview }));
    expect(read(r.settings)).toBe(ownerSettings);
    expect(read(backup)).toBe(ownerBackup);
    const api = hooksApiError(error);
    expect(api.code).toBe('claude_hooks_stale');
    expect(api.details).toMatchObject({ left: ['backup'] });
    expect(api.message).toContain('copy of your settings');
    expect(api.message).not.toContain(r.root);
  });
});

describe('a failed repair takes back only what it wrote', () => {
  it('removes this run’s registry at shutdown even after a repair was rolled back', async () => {
    const r = rig({ settings: original });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    await r.hooks.set(true);
    const active = read(registry(r));
    writeFileSync(r.settings, read(r.settings).replace('"timeout": 3', '"timeout": 9'));
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    rmSync(backup);
    mkdirSync(backup);
    const status = await r.hooks.status();

    await expect(
      r.hooks.set(true, { preview: status.plans.repair!.preview }),
    ).rejects.toMatchObject({
      failure: 'not_writable',
    });
    expect(read(registry(r))).toBe(active);
    await r.hooks.close();
    expect(existsSync(registry(r))).toBe(false);
  });

  it('leaves the owner’s script, written over the one the repair wrote', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    // The script is out of date: the state is needs_repair, and a repair rewrites it.
    writeFileSync(script(r), '// Agent Productivity: the Claude Code hook (an older version)\n');
    const hooks = failing(r, () => writeFileSync(script(r), '// theirs\n'));
    const status = await hooks.status();
    expect(status).toMatchObject({ state: 'needs_repair', reason: 'script_missing' });
    // The settings need no change for this repair, so nothing fails; make the settings need one as well.
    writeFileSync(r.settings, read(r.settings).replace('"timeout": 3', '"timeout": 9'));
    const again = await hooks.status();
    const error = await failureOf(() => hooks.set(true, { preview: again.plans.repair!.preview }));
    expect(error.left).toContain('script');
    expect(read(script(r))).toBe('// theirs\n');
  });
});

describe('a failed turn-off', () => {
  it('puts back the settings it replaced only while they are still what it wrote, and touches neither the script nor the registry', async () => {
    const r = rig({ settings: original });
    const second = join(r.root, 'second');
    mkdirSync(second);
    const secondSettings = join(second, 'settings.json');
    writeFileSync(secondSettings, asText({ b: 2 }), { mode: 0o600 });
    const env = { CLAUDE_CONFIG_DIR: `${r.config},${second}` };
    const both = r.another({ env });
    await both.listening({ port: 4317, token: TOKEN });
    await both.set(true);
    const scriptBefore = read(script(r));
    const registryBefore = read(registry(r));
    const off = r.another({
      env,
      onStep: (step, path) => {
        if (step !== 'before_commit' || path !== secondSettings) return;
        // The first file is replaced already; the owner saves it, and the second cannot be replaced.
        writeFileSync(r.settings, asText({ saved: 'by the owner' }));
        loseStagedFiles(second);
      },
    });
    await off.listening({ port: 4317, token: TOKEN });
    const error = await failureOf(() => off.set(false));
    expect(error.failure).toBe('rollback_failed');
    expect(error.files).toEqual(['~/.claude/settings.json']);
    expect(read(r.settings)).toBe(asText({ saved: 'by the owner' }));
    expect(read(script(r))).toBe(scriptBefore);
    expect(read(registry(r))).toBe(registryBefore);
  });
});

describe('shutdown', () => {
  it('leaves a registry the owner replaced, and logs that it did', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    writeFileSync(registry(r), '{"service":"the owner’s own"}');
    await r.hooks.close();
    expect(read(registry(r))).toBe('{"service":"the owner’s own"}');
    expect(r.logs.some((line) => line['code'] === 'cleanup_incomplete')).toBe(true);
  });

  it('leaves a registry replaced by a file of the same bytes (another file)', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    const bytes = read(registry(r));
    rmSync(registry(r));
    writeFileSync(registry(r), bytes, { mode: 0o600 });
    await r.hooks.close();
    expect(read(registry(r))).toBe(bytes);
  });
});
