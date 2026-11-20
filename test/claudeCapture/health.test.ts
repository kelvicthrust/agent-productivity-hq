import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAY,
  NOW,
  fixture,
  installByHand,
  rig,
  testSnapshotPath,
  writeSnapshotFile,
  type Rig,
} from './helpers.ts';

// Every capture health state is reachable, and the project-override count reads presence only.

const seconds = (ms: number): number => Math.floor(ms / 1000);
const install = installByHand;
const hookRan = (world: Rig, over: Record<string, unknown> = {}): void =>
  writeSnapshotFile(world.dataDir, {
    v: 1,
    captured_at: seconds(NOW) - 60,
    invoked_at: seconds(NOW) - 60,
    claude_version: '2.1.0',
    five_hour: { used_percentage: 20, resets_at: seconds(NOW) + 3600 },
    seven_day: { used_percentage: 40, resets_at: seconds(NOW) + 86_400 },
    ...over,
  });

describe('capture health states', () => {
  it('off: nothing installed', async () => {
    const world = rig({ settings: 'other-keys.json' });
    expect(await world.capture.health()).toEqual({
      state: 'off',
      phase: 'off',
      recorded: false,
      leftover: false,
      lastInvokedAt: null,
      capturedAt: null,
      settingsPath: null,
      projectOverrides: 0,
      backupPath: null,
    });
  });

  it('off: nothing installed and the settings file is not readable (it is not ours to complain about)', async () => {
    const world = rig({ rawSettings: fixture('settings', 'invalid-comments.txt') });
    expect((await world.capture.health()).state).toBe('off');
  });

  it('waiting: installed, and the hook has not run yet', async () => {
    const world = rig({ settings: 'other-keys.json' });
    install(world);
    const health = await world.capture.health();
    expect(health).toMatchObject({
      state: 'waiting',
      lastInvokedAt: null,
      capturedAt: null,
      settingsPath: world.settingsPath,
    });
    expect(health.backupPath).toBeNull();
  });

  it('ok: invoked, with windows', async () => {
    const world = rig({ settings: 'other-keys.json' });
    install(world);
    hookRan(world);
    const health = await world.capture.health();
    expect(health.state).toBe('ok');
    expect(health.lastInvokedAt).toBe((seconds(NOW) - 60) * 1000);
    expect(health.capturedAt).toBe((seconds(NOW) - 60) * 1000);
  });

  it('no_limits: invoked at least once but a window never arrived (API-key and Console sign-ins)', async () => {
    const world = rig({ settings: 'other-keys.json' });
    install(world);
    hookRan(world, { captured_at: null, five_hour: null, seven_day: null });
    const health = await world.capture.health();
    expect(health.state).toBe('no_limits');
    expect(health.capturedAt).toBeNull();
    expect(health.lastInvokedAt).toBe((seconds(NOW) - 60) * 1000);
  });

  it('idle: invoked, but not for more than 7 days', async () => {
    const world = rig({ settings: 'other-keys.json' });
    install(world);
    hookRan(world);
    world.clock.now = NOW + 7 * DAY - 120_000; // the hook ran 60 s before NOW: just under 7 days ago
    expect((await world.capture.health()).state).toBe('ok');
    world.clock.now = NOW + 7 * DAY + 120_000; // just over
    const health = await world.capture.health();
    expect(health.state).toBe('idle');
    expect(health.lastInvokedAt).toBe((seconds(NOW) - 60) * 1000);
  });

  it('no_limits outranks idle: it is a fact about the sign-in however long Claude Code has been quiet', async () => {
    const world = rig({ settings: 'other-keys.json' });
    install(world);
    hookRan(world, { captured_at: null, five_hour: null, seven_day: null });
    world.clock.now = NOW + 30 * DAY;
    expect((await world.capture.health()).state).toBe('no_limits');
  });

  it('replaced: another status line took the dashboard’s place', async () => {
    const world = rig({ settings: 'command-plain.json' });
    install(world);
    hookRan(world);
    world.writeSettings({ statusLine: { type: 'command', command: 'echo another tool' } });
    expect((await world.capture.health()).state).toBe('replaced');
    world.writeSettings({ theme: 'no status line at all' });
    expect((await world.capture.health()).state).toBe('replaced');
  });

  it('node_missing: the recorded Node is gone', async () => {
    const world = rig({ settings: 'command-plain.json', nodePath: '/no/such/dir/node' });
    world.capture.change({
      action: 'prepare_install',
      confirm: world.capture.plan().previewDigest,
    });
    hookRan(world);
    expect((await world.capture.health()).state).toBe('node_missing');
  });

  it('node_missing: the script is gone', async () => {
    const world = rig({ settings: 'command-plain.json' });
    install(world);
    hookRan(world);
    rmSync(world.capture.paths.script);
    const health = await world.capture.health();
    expect(health.state).toBe('node_missing');
    expect(health.leftover).toBe(false);
  });

  it('node_missing with a leftover hook: the data folder was deleted while the wrapper is still in the settings', async () => {
    const world = rig({ settings: 'command-plain.json' });
    install(world);
    rmSync(world.dataDir, { recursive: true, force: true });
    expect(await world.capture.health()).toMatchObject({
      state: 'node_missing',
      leftover: true,
      settingsPath: world.settingsPath,
      backupPath: null,
    });
  });

  it('settings_unreadable: installed, and the settings file now fails to parse', async () => {
    const world = rig({ settings: 'command-plain.json' });
    install(world);
    writeFileSync(world.settingsPath, fixture('settings', 'invalid-trailing-comma.txt'));
    const health = await world.capture.health();
    expect(health.state).toBe('settings_unreadable');
    expect(health.settingsPath).toBe(world.settingsPath);
  });

  it('treats a snapshot it cannot read as the hook not having run', async () => {
    const world = rig({ settings: 'other-keys.json' });
    install(world);
    writeFileSync(testSnapshotPath(world.dataDir), '{ not json');
    expect((await world.capture.health()).state).toBe('waiting');
    writeFileSync(testSnapshotPath(world.dataDir), JSON.stringify({ v: 9 }));
    expect((await world.capture.health()).state).toBe('waiting');
  });

  it('checks the wrapper before anything the hook wrote: a replaced line is replaced even when the snapshot is fresh', async () => {
    const world = rig({ settings: 'command-plain.json' });
    install(world);
    hookRan(world);
    world.writeSettings({ statusLine: { type: 'command', command: 'echo x' } });
    expect((await world.capture.health()).state).toBe('replaced');
  });
});

describe('project status lines (project_override)', () => {
  /** A project folder with the given project settings files. */
  function project(world: Rig, name: string, files: Record<string, string>): string {
    const dir = join(world.root, name);
    mkdirSync(join(dir, '.claude'), { recursive: true });
    for (const [file, text] of Object.entries(files))
      writeFileSync(join(dir, '.claude', file), text);
    return dir;
  }
  const withLine = fixture('project', 'with-status-line.json');
  const withoutLine = fixture('project', 'without-status-line.json');

  it('counts a folder whose settings.json or settings.local.json holds a statusLine key, once', async () => {
    let dirs: string[] = [];
    const world = rig({ projectDirs: () => dirs });
    dirs = [
      project(world, 'shared line', { 'settings.json': withLine }),
      project(world, 'local line', { 'settings.local.json': withLine }),
      project(world, 'both', { 'settings.json': withLine, 'settings.local.json': withLine }),
      project(world, 'no line', { 'settings.json': withoutLine }),
      project(world, 'no settings', {}),
    ];
    dirs.push(dirs[0] as string); // the same folder twice counts once
    expect((await world.capture.health()).projectOverrides).toBe(3);
  });

  it('counts the repository root of a folder Claude Code ran in (it reads project settings from there too)', async () => {
    let dirs: string[] = [];
    const world = rig({ projectDirs: () => dirs });
    const root = project(world, 'repo', { 'settings.json': withLine });
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    dirs = [sub, root];
    expect((await world.capture.health()).projectOverrides).toBe(2);
    // A folder with no repository above it is checked on its own only.
    const lone = join(world.root, 'lone', 'child');
    mkdirSync(lone, { recursive: true });
    dirs = [lone];
    expect((await world.capture.health()).projectOverrides).toBe(0);
  });

  it('does not count the user-level settings file when Claude Code ran in the home folder', async () => {
    const world = rig({ homeDefault: true, projectDirs: () => [world.home] });
    world.writeSettings({ statusLine: { type: 'command', command: 'echo the user-level one' } });
    expect((await world.capture.health()).projectOverrides).toBe(0);
  });

  it('... even when the home folder is reached through a link', async () => {
    let link = '';
    const world = rig({ homeDefault: true, projectDirs: () => [link] });
    link = join(world.root, 'home link');
    symlinkSync(world.home, link);
    world.writeSettings({ statusLine: { type: 'command', command: 'echo the user-level one' } });
    expect((await world.capture.health()).projectOverrides).toBe(0);
  });

  it('ignores a project settings file that is not valid JSON, is not an object or is missing', async () => {
    let dirs: string[] = [];
    const world = rig({ projectDirs: () => dirs });
    dirs = [
      project(world, 'broken', { 'settings.json': fixture('settings', 'invalid-comments.txt') }),
      project(world, 'array', { 'settings.json': '[{"statusLine": 1}]' }),
      join(world.root, 'does not exist'),
    ];
    expect((await world.capture.health()).projectOverrides).toBe(0);
  });

  it('reads the presence of the key and nothing else: no value reaches the health or the preview', async () => {
    let dirs: string[] = [];
    const world = rig({ projectDirs: () => dirs });
    dirs = [project(world, 'one', { 'settings.json': withLine })];
    const health = await world.capture.health();
    const preview = await world.capture.preview('install');
    expect(health.projectOverrides).toBe(1);
    expect(preview.projectOverrides).toBe(1);
    expect(JSON.stringify([health, preview])).not.toMatch(/SENTINEL_/);
  });

  it('is shown alongside any state, the off state included', async () => {
    let dirs: string[] = [];
    const world = rig({ projectDirs: () => dirs });
    dirs = [project(world, 'one', { 'settings.local.json': withLine })];
    const health = await world.capture.health();
    expect(health.state).toBe('off');
    expect(health.projectOverrides).toBe(1);
  });
});
