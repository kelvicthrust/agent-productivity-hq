import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksStatus } from '../../src/shared/contracts/hq.ts';
import { USER_SETTINGS, asText, read, rig, type Rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): what a turn-off or a shutdown reports is what is on disk. If HQ's
// entries are gone from the settings but HQ's own files (the script, the registry that holds the run token) remain, the status is
// `off` with `reason: cleanup_incomplete` and `leftover` (the folder and which files); never a clean `off`. A registry that cannot be
// removed is neutralised where it can be rewritten (its token blanked), and the next start reports what is left.

const TOKEN = 'T'.repeat(43);
const original = asText(USER_SETTINGS);
const isRoot = process.getuid?.() === 0;

const dir = (r: Rig) => r.hooks.paths.dir;

/** HQ is on and listening; then its folder can no longer be written to (so nothing in it can be deleted). */
async function onAndStuck(): Promise<Rig> {
  const r = rig({ settings: original });
  await r.hooks.set(true);
  await r.hooks.listening({ port: 4317, token: TOKEN });
  chmodSync(dir(r), 0o500);
  return r;
}

describe.skipIf(isRoot)('turning off when HQ’s own files cannot be removed', () => {
  it('says so: off, cleanup_incomplete, and which files are left, in the answer and in the next read', async () => {
    const r = await onAndStuck();
    const preview = await r.hooks.status();
    const answer = await r.hooks.set(false, { preview: preview.plans.off!.preview });
    // The settings are clean, and the answer does not pretend the files went too.
    expect(read(r.settings)).toBe(original);
    expect(answer).toMatchObject({
      state: 'off',
      reason: 'cleanup_incomplete',
      leftover: { items: ['script', 'registry'] },
      ownFolder: expect.stringContaining('claude-hooks'),
    });
    expect(ClaudeHooksStatus.safeParse(answer).success).toBe(true);
    expect(existsSync(r.hooks.paths.script)).toBe(true);
    expect(existsSync(r.hooks.paths.registry)).toBe(true);
    // The next read says the same, from disk.
    expect(await r.hooks.status()).toMatchObject({
      state: 'off',
      reason: 'cleanup_incomplete',
      leftover: { items: ['script', 'registry'] },
    });
    expect(await r.hooks.state()).toBe('off');
    expect(r.logs.some((line) => line['code'] === 'cleanup_incomplete')).toBe(true);
  });

  it('blanks the token in a registry it cannot delete, because the file itself can be rewritten', async () => {
    const r = await onAndStuck();
    expect(read(r.hooks.paths.registry)).toContain(TOKEN);
    await r.hooks.set(false);
    const left = read(r.hooks.paths.registry);
    expect(left).not.toContain(TOKEN);
    expect(JSON.parse(left)).toMatchObject({ v: 1, port: 0, token: '' });
  });

  it('leaves an undeletable registry alone when rewriting it would also change another name', async () => {
    const r = await onAndStuck();
    const registry = r.hooks.paths.registry;
    const before = read(registry);
    const outside = join(r.root, 'registry-copy.json');
    linkSync(registry, outside);

    const preview = (await r.hooks.status()).plans.off!.preview;
    const result = await r.hooks.set(false, { preview });

    expect(result).toMatchObject({
      state: 'off',
      reason: 'cleanup_incomplete',
      leftover: { items: ['script', 'registry'] },
    });
    expect(read(r.settings)).toBe(original);
    expect(read(registry)).toBe(before);
    expect(read(outside)).toBe(before);
  });

  it('offers to try again, and finishes the removal once the folder can be written', async () => {
    const r = await onAndStuck();
    await r.hooks.set(false);
    const stuck = await r.hooks.status();
    expect(Object.keys(stuck.plans).sort()).toEqual(['off', 'on']);
    expect(stuck.plans.off).toMatchObject({ files: [], ownFiles: ['script', 'registry'] });
    chmodSync(dir(r), 0o700);
    const done = await r.hooks.set(false, { preview: stuck.plans.off!.preview });
    expect(done).toMatchObject({ state: 'off', reason: null, leftover: null });
    expect(existsSync(r.hooks.paths.script)).toBe(false);
    expect(existsSync(r.hooks.paths.registry)).toBe(false);
  });

  it('reports an undeletable script alone when the registry went', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    // No registry was published (the server never listened); only the script is HQ's file here.
    chmodSync(dir(r), 0o500);
    const answer = await r.hooks.set(false);
    expect(answer).toMatchObject({
      state: 'off',
      reason: 'cleanup_incomplete',
      leftover: { items: ['script'] },
    });
  });

  it('is a clean off when everything could be removed', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    const answer = await r.hooks.set(false);
    expect(answer).toMatchObject({ state: 'off', reason: null, leftover: null });
    expect(readdirSync(dir(r))).toEqual([]);
  });

  it('does not call a file that is not HQ’s a leftover, nor a registry of an app that is still running', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    await r.hooks.set(false);
    mkdirSync(dir(r), { recursive: true });
    writeFileSync(r.hooks.paths.script, '// the owner’s own script');
    writeFileSync(
      r.hooks.paths.registry,
      `${JSON.stringify({ v: 1, pid: process.ppid, port: 4317, token: TOKEN })}\n`,
    );
    expect(await r.hooks.status()).toMatchObject({ state: 'off', reason: null, leftover: null });
  });
});

describe.skipIf(isRoot)('shutdown when the registry cannot be removed', () => {
  it('blanks the token, logs it, and the next start publishes its own', async () => {
    const r = await onAndStuck();
    await r.hooks.close();
    const left = read(r.hooks.paths.registry);
    expect(left).not.toContain(TOKEN);
    expect(r.logs.some((line) => line['code'] === 'cleanup_incomplete')).toBe(true);

    // The next start, with the switch on, publishes its own registry again (HQ makes its own folder writable to itself).
    const next = r.another();
    await next.listening({ port: 4318, token: TOKEN });
    expect(await next.status()).toMatchObject({ state: 'on' });
    expect(JSON.parse(read(r.hooks.paths.registry))).toMatchObject({ port: 4318, token: TOKEN });
  });

  it('is reported at the next start with the switch off: off, cleanup_incomplete, the registry', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    // The owner took HQ's entries out by hand; the registry is HQ's, the folder cannot be written, the app shuts down.
    writeFileSync(r.settings, original);
    chmodSync(dir(r), 0o500);
    await r.hooks.close();
    const next = r.another();
    await next.listening({ port: 4318, token: TOKEN });
    expect(await next.status()).toMatchObject({
      state: 'off',
      reason: 'cleanup_incomplete',
      leftover: { items: expect.arrayContaining(['registry']) },
    });
    expect(r.logs.filter((line) => line['code'] === 'cleanup_incomplete').length).toBeGreaterThan(
      0,
    );
  });

  it('never throws, whatever state the folder is in', async () => {
    const r = await onAndStuck();
    await expect(r.hooks.close()).resolves.toBeUndefined();
    await expect(r.hooks.close()).resolves.toBeUndefined();
    chmodSync(dir(r), 0o000);
    try {
      await expect(r.another().close()).resolves.toBeUndefined();
    } finally {
      chmodSync(dir(r), 0o700);
    }
  });
});
