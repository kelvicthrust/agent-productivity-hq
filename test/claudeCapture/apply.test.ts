import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeCapture } from '../../src/server/integrations/claudeCapture/index.ts';
import { buildWrapper } from '../../src/server/integrations/claudeCapture/wrapper.ts';
import { ASSET, NOW, fixtureBytes, modeOf, names, rig, runChild, tree } from './helpers.ts';

function prepare(capture: ClaudeCapture, digest = capture.plan().previewDigest): void {
  capture.change({ action: 'prepare_install', confirm: digest });
}

function verify(capture: ClaudeCapture): void {
  capture.change({ action: 'verify_install' });
}

describe('preparing and verifying the manual settings edit', () => {
  it('leaves a missing profile untouched while preparing the private hook', async () => {
    const world = rig();
    const { capture, settingsPath } = world;
    const { paths } = capture;
    rmSync(world.configDir, { recursive: true });
    const preview = await capture.preview('install');
    prepare(capture, preview.previewDigest);
    expect(existsSync(world.configDir)).toBe(false);
    expect(await capture.health()).toMatchObject({ phase: 'awaiting_edit' });
    expect(capture.canCollect()).toBe(false);
    expect(() => verify(capture)).toThrow(
      expect.objectContaining({ code: 'claude_settings_conflict' }),
    );
    expect(existsSync(settingsPath)).toBe(false);
    expect(readFileSync(paths.script)).toEqual(readFileSync(ASSET));
    expect(modeOf(paths.captureDir)).toBe(0o700);
    expect(names(paths.captureDir)).toEqual([
      expect.stringMatching(/^snapshot\.[a-f0-9]+$/),
      'state.json',
    ]);
    for (const file of [paths.script, paths.config, paths.state]) expect(modeOf(file)).toBe(0o600);

    mkdirSync(world.configDir);
    world.writeSettings({ statusLine: preview.next });
    const edited = readFileSync(settingsPath);
    verify(capture);
    verify(capture);
    expect(readFileSync(settingsPath)).toEqual(edited);
    expect(await capture.health()).toMatchObject({ phase: 'active', state: 'waiting' });
    expect(capture.canCollect()).toBe(true);
  });

  it('preserves all file bytes and holds no unrelated settings or new backup', async () => {
    const world = rig({ rawSettings: '{"theme":"dark", "env":{"decoy":"SENTINEL_CREDENTIAL"}}' });
    const { capture } = world;
    const project = join(world.configDir, 'settings.local.json');
    writeFileSync(project, '{"statusLine":{"type":"command","command":"echo local"}}');
    const before = tree(world.configDir);
    const preview = await capture.preview('install');
    prepare(capture, preview.previewDigest);
    prepare(capture, preview.previewDigest);
    expect(tree(world.configDir)).toEqual(before);
    expect(readFileSync(capture.paths.state, 'utf8')).not.toContain('SENTINEL_CREDENTIAL');
    expect(names(capture.paths.captureDir)).toEqual([
      expect.stringMatching(/^snapshot\.[a-f0-9]+$/),
      'state.json',
    ]);
  });

  it('refuses a changed status line, but allows other keys to change after the preview', () => {
    const world = rig({ settings: 'command-with-padding.json' });
    const { capture } = world;
    const plan = capture.plan();
    const original = world.readSettingsJson();
    world.writeSettings({ ...original, statusLine: { type: 'command', command: 'echo changed' } });
    const afterOwnerEdit = tree(world.root);
    expect(() => prepare(capture, plan.previewDigest)).toThrow(
      expect.objectContaining({ code: 'claude_settings_conflict' }),
    );
    expect(tree(world.root)).toEqual(afterOwnerEdit);
    world.writeSettings({ ...original, theme: 'light', extra: 1 });
    const beforePrepare = world.readSettingsText();
    prepare(capture, plan.previewDigest);
    expect(world.readSettingsText()).toBe(beforePrepare);
    expect(plan.next).toMatchObject({ padding: 2 });
  });

  it('refuses stale consent when a symlink changes targets even with identical content', () => {
    const world = rig();
    const first = join(world.root, 'first.json');
    const second = join(world.root, 'second.json');
    writeFileSync(first, '{}');
    writeFileSync(second, '{}');
    symlinkSync(first, world.settingsPath);
    const preview = world.capture.plan();
    rmSync(world.settingsPath);
    symlinkSync(second, world.settingsPath);
    expect(() => prepare(world.capture, preview.previewDigest)).toThrow(
      expect.objectContaining({ code: 'claude_settings_conflict' }),
    );
    expect(existsSync(world.dataDir)).toBe(false);
    expect(readFileSync(first, 'utf8')).toBe('{}');
    expect(readFileSync(second, 'utf8')).toBe('{}');
  });

  it('refuses to prepare when Claude settings alias a Crew artifact', () => {
    const world = rig();
    const artifact = world.capture.paths.config;
    mkdirSync(world.dataDir, { recursive: true });
    writeFileSync(artifact, '{"theme":"keep these settings"}');
    symlinkSync(artifact, world.settingsPath);
    expect(() => prepare(world.capture, 'digest')).toThrow(
      expect.objectContaining({ code: 'claude_settings_conflict' }),
    );
    expect(world.readSettingsText()).toBe('{"theme":"keep these settings"}');
    expect(existsSync(world.capture.paths.state)).toBe(false);
  });

  it('keeps the original prepared edit across restart and refuses a wrong edit', async () => {
    const world = rig({ settings: 'command-plain.json' });
    const plan = world.capture.plan();
    prepare(world.capture);
    world.writeSettings({ statusLine: { type: 'command', command: 'echo something else' } });
    const restarted = world.another();
    expect((await restarted.preview('install')).next).toEqual(plan.next);
    expect(() => verify(restarted)).toThrow(
      expect.objectContaining({ code: 'claude_settings_conflict' }),
    );
    expect(await restarted.health()).toMatchObject({ phase: 'awaiting_edit' });
    world.writeSettings({ statusLine: plan.next });
    const run = await runChild('/bin/sh', ['-c', plan.wrapperCommand], {
      stdin: fixtureBytes('stdin', 'full.json'),
    });
    expect(run.stdout.toString()).toBe('SENTINEL_PLAIN_LINE\n');
    expect(existsSync(restarted.paths.snapshot)).toBe(false);
    verify(restarted);
    expect(restarted.canCollect()).toBe(true);
  });

  it.each(['script', 'state'] as const)(
    'keeps provider bytes when the selected profile aliases the legacy %s',
    (file) => {
      const world = rig();
      const { paths } = world.capture;
      const originalProfile = join(world.root, 'original profile');
      mkdirSync(originalProfile);
      const originalSettings = join(originalProfile, 'settings.json');
      const wrapper = buildWrapper({
        node: process.execPath,
        script: paths.script,
        previousCommand: null,
      });
      const current = { statusLine: { type: 'command', command: wrapper } };
      writeFileSync(originalSettings, JSON.stringify(current));
      mkdirSync(paths.captureDir, { recursive: true });
      writeFileSync(paths.script, JSON.stringify(current));
      writeFileSync(paths.config, JSON.stringify({ previousCommand: null }));
      writeFileSync(
        paths.state,
        JSON.stringify({
          v: 1,
          settingsPath: originalSettings,
          node: process.execPath,
          script: paths.script,
          wrapper,
          previousStatusLine: null,
          backupPath: null,
          installedAt: NOW,
          ...current,
        }),
      );
      symlinkSync(paths[file], world.settingsPath);
      const before = readFileSync(world.settingsPath);
      expect(() => world.capture.initialize()).toThrow(
        expect.objectContaining({ code: 'claude_settings_conflict' }),
      );
      expect(readFileSync(world.settingsPath)).toEqual(before);
    },
  );

  it.each(['script', 'state'] as const)(
    'keeps provider bytes when the recorded profile aliases the legacy %s',
    (file) => {
      const world = rig();
      const { paths } = world.capture;
      const wrapper = buildWrapper({
        node: process.execPath,
        script: paths.script,
        previousCommand: null,
      });
      const current = { statusLine: { type: 'command', command: wrapper } };
      mkdirSync(paths.captureDir, { recursive: true });
      writeFileSync(paths.script, JSON.stringify(current));
      writeFileSync(paths.config, JSON.stringify({ previousCommand: null }));
      writeFileSync(
        paths.state,
        JSON.stringify({
          v: 1,
          settingsPath: world.settingsPath,
          node: process.execPath,
          script: paths.script,
          wrapper,
          previousStatusLine: null,
          backupPath: null,
          installedAt: NOW,
          ...current,
        }),
      );
      symlinkSync(paths[file], world.settingsPath);
      const before = readFileSync(world.settingsPath);
      expect(() => world.capture.initialize()).toThrow(
        expect.objectContaining({ code: 'claude_settings_conflict' }),
      );
      expect(readFileSync(world.settingsPath)).toEqual(before);
    },
  );

  it('adopts a verified v1 hook at restart and keeps its original backup bytes', async () => {
    const world = rig({ settings: 'command-plain.json' });
    const { paths } = world.capture;
    const previousStatusLine = world.readSettingsJson()['statusLine'];
    const original = readFileSync(world.settingsPath);
    const backupPath = join(paths.captureDir, 'settings.legacy.json');
    const wrapper = buildWrapper({
      node: process.execPath,
      script: paths.script,
      previousCommand: 'echo SENTINEL_PLAIN_LINE',
    });
    mkdirSync(paths.captureDir, { recursive: true });
    writeFileSync(backupPath, original);
    writeFileSync(
      paths.snapshot,
      JSON.stringify({
        v: 1,
        captured_at: NOW / 1000,
        invoked_at: NOW / 1000,
        five_hour: { used_percentage: 23, resets_at: NOW / 1000 + 3600 },
      }),
    );
    writeFileSync(paths.script, 'legacy hook');
    writeFileSync(paths.config, JSON.stringify({ previousCommand: 'echo SENTINEL_PLAIN_LINE' }));
    writeFileSync(
      paths.state,
      JSON.stringify({
        v: 1,
        settingsPath: world.settingsPath,
        node: process.execPath,
        script: paths.script,
        wrapper,
        previousStatusLine,
        backupPath,
        installedAt: NOW,
      }),
    );
    const capture = world.another();
    capture.initialize();
    expect(capture.canCollect()).toBe(false);
    expect(await capture.health()).toMatchObject({ phase: 'needs_attention' });

    world.writeSettings({ statusLine: { type: 'command', command: wrapper } });
    const ownerEdited = world.readSettingsText();
    capture.initialize();
    expect(capture.canCollect()).toBe(true);
    expect(await capture.health()).toMatchObject({ phase: 'active', backupPath });
    expect(world.readSettingsText()).toBe(ownerEdited);
    expect(readFileSync(backupPath)).toEqual(original);
    expect(capture.snapshot()).toMatchObject({
      kind: 'ok',
      snapshot: { five_hour: { used_percentage: 23 } },
    });
    expect(existsSync(paths.snapshot)).toBe(false);
    writeFileSync(
      paths.snapshot,
      JSON.stringify({ v: 1, five_hour: { used_percentage: 99, resets_at: NOW / 1000 + 3600 } }),
    );
    expect(capture.snapshot()).toMatchObject({
      kind: 'ok',
      snapshot: { five_hour: { used_percentage: 23 } },
    });
    expect(readFileSync(paths.script)).toEqual(readFileSync(ASSET));
  });
});
