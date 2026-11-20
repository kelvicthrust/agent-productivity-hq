import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runHook } from '../../src/server/integrations/claudeCapture/assets/claude-statusline.mjs';
import { describe, expect, it } from 'vitest';
import { fixtureBytes, installByHand, rig, runChild } from './helpers.ts';

describe('manual removal', () => {
  it('pauses collection while keeping the hook usable and the settings bytes unchanged', async () => {
    const world = rig({ settings: 'command-plain.json' });
    const plan = installByHand(world);
    const { capture } = world;
    const before = world.readSettingsText();
    const preview = await capture.preview('remove');
    expect(preview.files[0]).toMatchObject({
      current: plan.next,
      next: plan.previousStatusLine,
      hookReferenced: true,
    });
    expect(capture.canCollect()).toBe(true);
    expect(() => capture.change({ action: 'verify_remove' })).toThrow(
      expect.objectContaining({ code: 'claude_settings_conflict' }),
    );
    capture.change({ action: 'begin_remove' });
    capture.change({ action: 'begin_remove' });
    expect((await world.another().health()).phase).toBe('awaiting_removal');
    expect(capture.canCollect()).toBe(false);
    expect(world.readSettingsText()).toBe(before);

    await expect(
      runChild('/bin/sh', ['-c', plan.wrapperCommand], {
        stdin: fixtureBytes('stdin', 'full.json'),
      }),
    ).resolves.toMatchObject({ stdout: Buffer.from('SENTINEL_PLAIN_LINE\n') });
    expect(existsSync(capture.paths.snapshot)).toBe(false);
    expect(() => capture.change({ action: 'verify_remove' })).toThrow(
      expect.objectContaining({ code: 'claude_settings_conflict' }),
    );
    expect(existsSync(capture.paths.script)).toBe(true);
    world.writeSettings({ theme: 'light', statusLine: plan.previousStatusLine });
    const edited = world.readSettingsText();
    capture.change({ action: 'verify_remove' });
    capture.change({ action: 'verify_remove' });
    expect(world.readSettingsText()).toBe(edited);
    for (const file of [capture.paths.state, capture.paths.script, capture.paths.config]) {
      expect(existsSync(file)).toBe(false);
    }
  });

  it('cannot publish a retired in-flight snapshot into a later installation', async () => {
    const world = rig();
    const { capture } = world;
    installByHand(world);
    const snapshotPath = capture.activeSnapshotPath();
    if (snapshotPath === null) throw new Error('capture should be active');
    const staged = `${snapshotPath}.staged`;
    writeFileSync(staged, '{"v":1,"five_hour":{"used_percentage":12,"resets_at":4102441200}}');
    capture.change({ action: 'begin_remove' });
    world.writeSettings('{}');
    capture.change({ action: 'verify_remove' });

    installByHand(world);
    expect(capture.activeSnapshotPath()).not.toBe(snapshotPath);
    expect(() => renameSync(staged, snapshotPath)).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
    await runHook({
      dir: world.dataDir,
      snapshotPath,
      stdin: fixtureBytes('stdin', 'full.json'),
      now: Math.floor(Date.now() / 1000),
    });
    expect(existsSync(snapshotPath)).toBe(false);
    expect(capture.snapshot()).toEqual({ kind: 'absent' });
  });

  it('continues checking the original profile after the configured profile changes', async () => {
    const world = rig();
    installByHand(world);
    const alternateDir = join(world.root, 'another profile');
    mkdirSync(alternateDir);
    const alternate = join(alternateDir, 'settings.json');
    writeFileSync(alternate, '{"theme":"other profile"}\n');
    const switched = world.another({ env: { CLAUDE_CONFIG_DIR: alternateDir } });
    const original = world.readSettingsText();
    expect((await switched.health()).state).toBe('profile_changed');
    expect(() => switched.plan()).toThrow(
      expect.objectContaining({ code: 'claude_settings_conflict' }),
    );
    expect((await switched.preview('remove')).settingsPath).toBe(world.settingsPath);
    switched.change({ action: 'begin_remove' });
    expect(() => switched.change({ action: 'verify_remove' })).toThrow(
      expect.objectContaining({ code: 'claude_settings_conflict' }),
    );
    expect(world.readSettingsText()).toBe(original);
    expect(existsSync(switched.paths.script)).toBe(true);
    world.writeSettings(
      '{"theme":"original profile", "statusLine":{"type":"command","command":"echo my-new-line"}}\n',
    );
    const edited = world.readSettingsText();
    switched.change({ action: 'verify_remove' });
    expect(world.readSettingsText()).toBe(edited);
    expect(readFileSync(alternate, 'utf8')).toBe('{"theme":"other profile"}\n');
  });

  it('checks both files when a dotfile symlink was retargeted and protects an edited hook command', async () => {
    const world = rig();
    const first = join(world.root, 'first.json');
    const second = join(world.root, 'second.json');
    writeFileSync(first, '{}');
    writeFileSync(second, '{}');
    symlinkSync(first, world.settingsPath);
    installByHand(world);
    rmSync(world.settingsPath);
    symlinkSync(second, world.settingsPath);
    world.capture.change({ action: 'begin_remove' });
    const { capture } = world;
    const preview = await capture.preview('remove');
    expect(preview.files.map((file) => file.hookReferenced)).toEqual([true, false]);
    expect(preview.files[0]?.path).toMatch(/first\.json$/);
    expect(preview.files[1]?.path).toMatch(/second\.json$/);
    expect(() => capture.change({ action: 'verify_remove' })).toThrow();
    writeFileSync(first, '{}');
    world.writeSettings({
      statusLine: { type: 'command', command: `node '${capture.paths.script}'` },
    });
    expect(() => capture.change({ action: 'verify_remove' })).toThrow();
    world.writeSettings('{}');
    capture.change({ action: 'verify_remove' });
    expect(readFileSync(first, 'utf8')).toBe('{}');
    expect(readFileSync(second, 'utf8')).toBe('{}');
  });

  it('keeps the paused hook on unreadable settings and accepts a later retry', () => {
    const world = rig();
    installByHand(world);
    world.writeSettings('{');
    world.capture.change({ action: 'begin_remove' });
    expect(() => world.capture.change({ action: 'verify_remove' })).toThrow(
      expect.objectContaining({ code: 'claude_settings_unreadable' }),
    );
    expect(world.readSettingsText()).toBe('{');
    expect(existsSync(world.capture.paths.script)).toBe(true);
    world.writeSettings('{}');
    world.capture.change({ action: 'verify_remove' });
    expect(world.readSettingsText()).toBe('{}');
    expect(existsSync(world.capture.paths.script)).toBe(false);
  });
});
