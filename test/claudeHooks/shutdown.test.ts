import { chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { USER_SETTINGS, asText, read, rig, type Rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › HQ's own files): what this process published is tracked through every write,
// replacement and restoration of the registry (it follows the file when a restoration gave it a new inode), so that after ANY failed
// change shutdown removes the registry this process published, or reports it, and leaves what is not this process's.

const TOKEN = 'T'.repeat(43);
const original = asText(USER_SETTINGS);

const lose = (dir: string): void => {
  for (const name of readdirSync(dir)) if (name.endsWith('.tmp')) rmSync(join(dir, name));
};

/** A switch whose settings change fails at its last moment (the staged update is lost) while `armed` is set. */
function breakable(r: Rig) {
  const state = { armed: false };
  const hooks = r.another({
    onStep: (step) => {
      if (state.armed && step === 'before_commit') lose(r.config);
    },
  });
  return { hooks, state };
}

const registryOf = (r: Rig) => r.hooks.paths.registry;
const reported = (r: Rig) => r.logs.some((line) => line['code'] === 'cleanup_incomplete');

describe('shutdown after a change that failed', () => {
  it('a failed turn-on: the registry and the script were taken back, so there is nothing left to remove', async () => {
    const r = rig({ settings: original });
    const { hooks, state } = breakable(r);
    await hooks.listening({ port: 4317, token: TOKEN });
    state.armed = true;
    await expect(hooks.set(true)).rejects.toMatchObject({ failure: 'not_writable' });
    expect(existsSync(registryOf(r))).toBe(false);
    expect(existsSync(r.hooks.paths.script)).toBe(false);
    await hooks.close();
    expect(existsSync(registryOf(r))).toBe(false);
    expect(read(r.settings)).toBe(original);
  });

  it('a failed turn-on whose registry the owner then replaced: the owner’s file is left, named, and shutdown does not remove it', async () => {
    const r = rig({ settings: original });
    const hooks = r.another({
      onStep: (step) => {
        if (step !== 'before_commit') return;
        writeFileSync(registryOf(r), '{"service":"the owner’s own"}');
        lose(r.config);
      },
    });
    await hooks.listening({ port: 4317, token: TOKEN });
    await expect(hooks.set(true)).rejects.toMatchObject({
      left: expect.arrayContaining(['registry']),
    });
    await hooks.close();
    expect(read(registryOf(r))).toBe('{"service":"the owner’s own"}');
  });

  it('a failed repair that rewrote the registry (open to others) and put it back by an atomic replacement: shutdown removes it', async () => {
    const r = rig({ settings: original });
    const { hooks, state } = breakable(r);
    await hooks.listening({ port: 4317, token: TOKEN });
    await hooks.set(true);
    const mine = read(registryOf(r));
    chmodSync(registryOf(r), 0o644);
    const status = await hooks.status();
    expect(status.plans.repair!.ownFiles).toContain('registry');
    state.armed = true;
    // A repair that rewrites the registry and then cannot replace the settings: the settings need a change as well.
    writeFileSync(r.settings, read(r.settings).replace('"timeout": 3', '"timeout": 9'));
    const again = await hooks.status();
    await expect(hooks.set(true, { preview: again.plans.repair!.preview })).rejects.toMatchObject({
      failure: 'not_writable',
    });
    // what was there before the repair is what is there now (the file was put back)
    expect(read(registryOf(r))).toBe(mine);
    await hooks.close();
    expect(existsSync(registryOf(r))).toBe(false);
    expect(reported(r)).toBe(false);
  });

  it('a failed turn-off: the entries are still there, so the script stays; the registry this process published is removed at shutdown', async () => {
    const r = rig({ settings: original });
    const { hooks, state } = breakable(r);
    await hooks.listening({ port: 4317, token: TOKEN });
    await hooks.set(true);
    state.armed = true;
    await expect(hooks.set(false)).rejects.toMatchObject({ failure: 'not_writable' });
    expect(existsSync(registryOf(r))).toBe(true);
    await hooks.close();
    expect(existsSync(registryOf(r))).toBe(false);
    expect(existsSync(r.hooks.paths.script)).toBe(true);
    expect(read(r.settings)).toContain('agent-productivity-hq-hook');
  });

  it('a failed turn-off after the owner replaced the registry with a file of the same bytes: left (it is not the file this process published)', async () => {
    const r = rig({ settings: original });
    const { hooks, state } = breakable(r);
    await hooks.listening({ port: 4317, token: TOKEN });
    await hooks.set(true);
    const bytes = read(registryOf(r));
    state.armed = true;
    await expect(hooks.set(false)).rejects.toBeDefined();
    rmSync(registryOf(r));
    writeFileSync(registryOf(r), bytes, { mode: 0o600 });
    await hooks.close();
    expect(read(registryOf(r))).toBe(bytes);
  });

  it('a change that succeeded, then shutdown: nothing of the registry is left', async () => {
    const r = rig({ settings: original });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    await r.hooks.set(true);
    await r.hooks.close();
    expect(existsSync(registryOf(r))).toBe(false);
  });
});
