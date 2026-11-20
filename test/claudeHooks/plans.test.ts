import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeHooksStatus } from '../../src/shared/contracts/hq.ts';
import { USER_SETTINGS, asText, read, rig, type Rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › The preview): the plan shown and the fingerprint sent are those of the ACTION being
// confirmed (turn on, repair, turn off), not of the state. GET returns one plan per offered action, each with its own files and its own
// fingerprint; PUT checks the fingerprint of the action the request is (`enabled: false` is off; `enabled: true` is on when no file
// holds HQ's entries, else repair). Every state offers the right actions, and a fingerprint of another action is stale.

const TOKEN = 'T'.repeat(43);
const original = asText(USER_SETTINGS);
const actionsOf = (status: ClaudeHooksStatus) => Object.keys(status.plans).sort();
const paths = (plan: { files: { path: string }[] } | undefined) => plan?.files.map((f) => f.path);

/** Two Claude Code folders; the second is outside the home folder. */
function twoFolders(): { r: Rig; both: Rig['hooks']; second: string; secondSettings: string } {
  const r = rig({ settings: original });
  const second = join(r.root, 'second');
  mkdirSync(second);
  const secondSettings = join(second, 'settings.json');
  writeFileSync(secondSettings, asText({ b: 2 }), { mode: 0o600 });
  return {
    r,
    both: r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` } }),
    second,
    secondSettings,
  };
}

describe('each state offers its own actions, each with its own plan', () => {
  it('off: turn on, listing every file that gets entries; the first fingerprint is that plan’s', async () => {
    const { both, second } = twoFolders();
    const status = await both.status();
    expect(status).toMatchObject({ state: 'off', reason: null, leftover: null });
    expect(actionsOf(status)).toEqual(['on']);
    expect(paths(status.plans.on)).toEqual([
      '~/.claude/settings.json',
      join(second, 'settings.json'),
    ]);
    expect(status.plans.on!.ownFiles).toEqual(['script']);
    expect(status.preview).toBe(status.plans.on!.preview);
  });

  it('on: turn off, listing only the files that hold entries', async () => {
    const { r, both, second } = twoFolders();
    await both.set(true);
    // The owner removes HQ's entries from the second file by hand: the first still holds them.
    writeFileSync(join(second, 'settings.json'), asText({ b: 2 }));
    const stillOn = await r.another({ env: { CLAUDE_CONFIG_DIR: r.config } }).status();
    expect(stillOn.state).toBe('on');
    expect(actionsOf(stillOn)).toEqual(['off']);
    expect(paths(stillOn.plans.off)).toEqual(['~/.claude/settings.json']);
    expect(stillOn.plans.off!.ownFiles).toEqual(['script']);
  });

  it('needs_repair (entries_changed): repair lists the files it changes, turn off lists only those holding entries, with different fingerprints', async () => {
    const { both, second } = twoFolders();
    await both.set(true);
    // One file lost its entries; the other still holds them exactly.
    writeFileSync(join(second, 'settings.json'), asText({ b: 2 }));
    const status = await both.status();
    expect(status).toMatchObject({ state: 'needs_repair', reason: 'entries_changed' });
    expect(actionsOf(status)).toEqual(['off', 'repair']);
    expect(paths(status.plans.repair)).toEqual([join(second, 'settings.json')]);
    expect(paths(status.plans.off)).toEqual(['~/.claude/settings.json']);
    expect(status.plans.repair!.preview).not.toBe(status.plans.off!.preview);
    expect(status.preview).toBe(status.plans.repair!.preview);
  });

  it.each([
    [
      'script_missing',
      (r: Rig) =>
        writeFileSync(
          r.hooks.paths.script,
          '// Agent Productivity: the Claude Code hook (older)\n',
        ),
      ['script'],
    ],
  ])(
    'needs_repair (%s): repair replaces HQ’s own files only, turn off still lists the files with entries',
    async (reason, damage, own) => {
      const r = rig({ settings: original });
      await r.hooks.set(true);
      damage(r);
      const status = await r.hooks.status();
      expect(status).toMatchObject({ state: 'needs_repair', reason });
      expect(status.plans.repair).toMatchObject({ files: [], ownFiles: own });
      expect(paths(status.plans.off)).toEqual(['~/.claude/settings.json']);
    },
  );

  it('needs_repair (registry_unpublished): repair writes the registry, turn off lists the file', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    writeFileSync(r.hooks.paths.registry, '{"v":1,"pid":1,"port":1,"token":""}\n', { mode: 0o600 });
    const status = await r.hooks.status();
    expect(status).toMatchObject({ state: 'needs_repair', reason: 'registry_unpublished' });
    expect(status.plans.repair).toMatchObject({ files: [], ownFiles: ['registry'] });
    expect(paths(status.plans.off)).toEqual(['~/.claude/settings.json']);
  });

  it('does not replace a working registry omitted from the repair plan', async () => {
    const { both, r, secondSettings } = twoFolders();
    await both.listening({ port: 4317, token: TOKEN });
    await both.set(true);
    writeFileSync(secondSettings, asText({ b: 2 }));
    const registry = r.hooks.paths.registry;
    const before = statSync(registry);
    const repair = (await both.status()).plans.repair!;
    expect(repair.ownFiles).not.toContain('registry');

    expect((await both.set(true, { preview: repair.preview })).state).toBe('on');
    expect(statSync(registry).ino).toBe(before.ino);
  });

  it('offers repair when the installed script cannot read a registry with loose permissions', async () => {
    const r = rig({ settings: original });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    await r.hooks.set(true);
    chmodSync(r.hooks.paths.registry, 0o644);

    const status = await r.hooks.status();
    expect(status).toMatchObject({ state: 'needs_repair', reason: 'registry_unpublished' });
    expect(status.plans.repair?.ownFiles).toContain('registry');
    await r.hooks.set(true, { preview: status.plans.repair!.preview });
    expect(statSync(r.hooks.paths.registry).mode & 0o777).toBe(0o600);
  });

  it('unavailable offers nothing, whatever the reason', async () => {
    const none = rig({ config: false });
    expect(await none.hooks.status()).toMatchObject({ state: 'unavailable', plans: {} });
    const blocked = rig({ settings: '{ not json' });
    expect(await blocked.hooks.status()).toMatchObject({
      state: 'unavailable',
      reason: 'settings_blocked',
      plans: {},
    });
    const layout = rig({ settings: `{"a":${'['.repeat(100)}${']'.repeat(100)}}` });
    const status = await layout.hooks.status();
    expect(status).toMatchObject({ state: 'unavailable', reason: 'settings_blocked', plans: {} });
    expect(status.files[0]).toMatchObject({ state: 'blocked', reason: 'unsupported_layout' });
  });

  it('a file nested deeper than HQ edits makes the switch unavailable even though it holds entries', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    const hooks = JSON.parse(read(r.settings)) as Record<string, unknown>;
    // Entries are there, and the file is then nested deeper than HQ edits.
    writeFileSync(
      r.settings,
      JSON.stringify({ ...hooks, deep: JSON.parse(`${'['.repeat(70)}${']'.repeat(70)}`) }),
    );
    const status = await r.hooks.status();
    expect(status.state).toBe('unavailable');
  });
});

describe('PUT checks the fingerprint of the action it is', () => {
  it('turn off refuses the repair fingerprint, and repair refuses the turn-off one; each accepts its own', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    writeFileSync(r.hooks.paths.script, '// Agent Productivity: the Claude Code hook (older)\n');
    const status = await r.hooks.status();
    await expect(
      r.hooks.set(false, { preview: status.plans.repair!.preview }),
    ).rejects.toMatchObject({
      failure: 'stale_preview',
    });
    await expect(r.hooks.set(true, { preview: status.plans.off!.preview })).rejects.toMatchObject({
      failure: 'stale_preview',
    });
    expect(read(r.settings)).toContain('agent-productivity-hq-hook');
    const repaired = await r.hooks.set(true, { preview: status.plans.repair!.preview });
    expect(repaired.state).toBe('on');
    const after = await r.hooks.status();
    const off = await r.hooks.set(false, { preview: after.plans.off!.preview });
    expect(off.state).toBe('off');
    expect(read(r.settings)).toBe(original);
  });

  it('turn on refuses a fingerprint taken for turning off elsewhere, and any fingerprint after the files changed', async () => {
    const r = rig({ settings: original });
    const other = rig({ settings: original });
    await other.hooks.set(true);
    const off = (await other.hooks.status()).plans.off!.preview;
    await expect(r.hooks.set(true, { preview: off })).rejects.toMatchObject({
      failure: 'stale_preview',
    });
    const on = (await r.hooks.status()).plans.on!.preview;
    writeFileSync(r.settings, `${original}\n`);
    await expect(r.hooks.set(true, { preview: on })).rejects.toMatchObject({
      failure: 'stale_preview',
    });
    expect(read(r.settings)).toBe(`${original}\n`);
  });

  it('no fingerprint is the same refusal', async () => {
    const r = rig({ settings: original });
    await expect(r.hooks.set(true, { preview: '' })).rejects.toMatchObject({
      failure: 'stale_preview',
    });
    await expect(r.hooks.set(false, { preview: '' })).rejects.toMatchObject({
      failure: 'stale_preview',
    });
  });
});
