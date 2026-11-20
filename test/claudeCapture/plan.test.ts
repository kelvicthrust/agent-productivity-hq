import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageCapturePreview } from '../../src/shared/contracts/accounts.ts';
import { ApiError } from '../../src/shared/contracts/errors.ts';
import {
  CaptureError,
  createClaudeCapture,
} from '../../src/server/integrations/claudeCapture/index.ts';
import { SAMPLE_STATUS_ROW } from '../../src/server/integrations/claudeCapture/plan.ts';
import { fixture, names, rig, tree } from './helpers.ts';

// Plan and preview: what turning capture on would change, computed with nothing written.

async function refusal(run: () => unknown): Promise<CaptureError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CaptureError);
    expect(error).toBeInstanceOf(ApiError);
    return error as CaptureError;
  }
  throw new Error('expected a refusal');
}

describe('which settings file is the target', () => {
  it('is $CLAUDE_CONFIG_DIR/settings.json when that is set', () => {
    const { capture, configDir } = rig();
    expect(capture.settingsPath).toBe(join(configDir, 'settings.json'));
    expect(capture.settingsPath).toContain(' '); // the folder name has a space
  });

  it('is ~/.claude/settings.json otherwise, and an empty variable counts as unset', () => {
    const { home, dataDir } = rig();
    for (const env of [{}, { CLAUDE_CONFIG_DIR: '' }]) {
      const capture = createClaudeCapture({ dataDir, env, home });
      expect(capture.settingsPath).toBe(join(home, '.claude', 'settings.json'));
    }
  });

  it('never targets a project or local settings file', () => {
    const { capture } = rig();
    expect(capture.settingsPath).toMatch(/settings\.json$/);
    expect(capture.settingsPath).not.toMatch(/settings\.local\.json/);
  });
});

describe('the plan for each kind of settings file', () => {
  it('with no settings file: starts from {} and the dashboard is the only status line', async () => {
    const { capture, configDir, dataDir } = rig();
    const before = tree(configDir);
    const preview = await capture.preview('install');
    expect(preview).toMatchObject({
      settingsPath: capture.settingsPath,
      settingsFileExists: false,
      current: null,
      sampleStatusRow: SAMPLE_STATUS_ROW,
    });
    expect(preview.next).toEqual({ type: 'command', command: preview.wrapperCommand });
    expect(preview.notes).toEqual([
      'footer_hints_hidden',
      'project_status_lines_override',
      'compact_usage_line_shown',
    ]);
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    // Nothing was written, not even the data folder.
    expect(tree(configDir)).toEqual(before);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('with other keys and no status line: current is none and the other keys are not part of the change', async () => {
    const { capture } = rig({ settings: 'other-keys.json' });
    const preview = await capture.preview('install');
    expect(preview.current).toBeNull();
    expect(preview.next).toEqual({ type: 'command', command: preview.wrapperCommand });
    expect(JSON.stringify(preview)).not.toMatch(/SENTINEL_/);
  });

  it('with an existing command status line: keeps it running and every sibling key (padding and the rest)', async () => {
    const { capture } = rig({ settings: 'command-with-padding.json' });
    const preview = await capture.preview('install');
    const original = JSON.parse(fixture('settings', 'command-with-padding.json')).statusLine;
    expect(preview.current).toEqual(original);
    expect(preview.next).toEqual({ ...original, command: preview.wrapperCommand });
    expect(Object.keys(preview.next)).toEqual(Object.keys(original));
    expect(preview.notes).toContain('previous_status_line_kept');
    expect(preview.notes).not.toContain('compact_usage_line_shown');
    expect(preview.sampleStatusRow).toBeNull();
    // The owner's original command text is in the wrapper's else branch, intact.
    expect(preview.wrapperCommand).toContain(original.command);
  });

  it('refuses a status line that is not a command, naming claude_statusline_unsupported (422) and writing nothing', async () => {
    const { capture, configDir } = rig({ settings: 'non-command.json' });
    const before = tree(configDir);
    const error = await refusal(() => capture.preview('install'));
    expect(error.code).toBe('claude_statusline_unsupported');
    expect(error.status).toBe(422);
    expect(error.message).toMatch(/Nothing was changed/);
    expect(tree(configDir)).toEqual(before);
  });

  it.each([
    ['a string', '{"statusLine": "echo hi"}'],
    ['null', '{"statusLine": null}'],
    ['a command type without a command', '{"statusLine": {"type": "command"}}'],
    ['a command that is not text', '{"statusLine": {"type": "command", "command": 5}}'],
  ])('refuses a status line that is %s', async (_name, raw) => {
    const { capture } = rig({ rawSettings: raw });
    expect((await refusal(() => capture.preview('install'))).code).toBe(
      'claude_statusline_unsupported',
    );
  });

  it.each([
    ['a comment (strict JSON has none)', fixture('settings', 'invalid-comments.txt')],
    ['a trailing comma', fixture('settings', 'invalid-trailing-comma.txt')],
    ['an array at the top', fixture('settings', 'not-an-object.json')],
    ['a cut-off file', '{ "theme": '],
    ['a byte-order mark', '﻿{}'],
    ['plain text', 'SENTINEL_not_json'],
  ])(
    'refuses %s, naming claude_settings_unreadable (422) and leaving the file as it is',
    async (_name, raw) => {
      const { capture, settingsPath, configDir } = rig({ rawSettings: raw });
      const before = tree(configDir);
      const error = await refusal(() => capture.preview('install'));
      expect(error.code).toBe('claude_settings_unreadable');
      expect(error.status).toBe(422);
      expect(error.message).toMatch(/can’t be read/);
      expect(error.details).toEqual({ settingsPath });
      expect(tree(configDir)).toEqual(before);
    },
  );

  it('refuses a settings path that is a folder, as unreadable', async () => {
    const { capture, settingsPath } = rig();
    mkdirSync(settingsPath);
    expect((await refusal(() => capture.preview('install'))).code).toBe(
      'claude_settings_unreadable',
    );
  });

  it('never puts file content in a refusal', async () => {
    const { capture } = rig({ rawSettings: '{ "theme": "SENTINEL_THEME_c0ffee", ' });
    const error = await refusal(() => capture.preview('install'));
    expect(JSON.stringify(error.toEnvelope())).not.toMatch(/SENTINEL_/);
  });
});

describe('the preview', () => {
  it('has the shape of the preview route (local-api › UsageCapturePreview)', async () => {
    for (const settings of [undefined, 'other-keys.json', 'command-with-padding.json']) {
      const { capture } = rig(settings === undefined ? {} : { settings });
      const parsed = UsageCapturePreview.safeParse(await capture.preview('remove'));
      expect(parsed.success, String(settings)).toBe(true);
    }
  });

  it('always carries the footer-hints and project-override notes (the two things to see before turning it on)', async () => {
    for (const settings of ['other-keys.json', 'command-plain.json']) {
      const { capture } = rig({ settings });
      const { notes } = await capture.preview('install');
      expect(notes).toContain('footer_hints_hidden');
      expect(notes).toContain('project_status_lines_override');
    }
  });

  it('counts project status lines (presence only) from the folders it is given', async () => {
    const world = rig({ projectDirs: () => [projectA, projectB, projectA] });
    const projectA = join(world.root, 'project a');
    const projectB = join(world.root, 'project b');
    mkdirSync(join(projectA, '.claude'), { recursive: true });
    mkdirSync(join(projectB, '.claude'), { recursive: true });
    writeFileSync(
      join(projectA, '.claude', 'settings.json'),
      fixture('project', 'with-status-line.json'),
    );
    writeFileSync(
      join(projectB, '.claude', 'settings.json'),
      fixture('project', 'without-status-line.json'),
    );
    const preview = await world.capture.preview('install');
    expect(preview.projectOverrides).toBe(1);
    expect(JSON.stringify(preview)).not.toMatch(/SENTINEL_PROJECT_STATUS_LINE/);
  });
});

describe('the preview digest', () => {
  it('is the same for the same file and Node, however often it is asked', () => {
    const { capture } = rig({ settings: 'command-with-padding.json' });
    expect(capture.plan().previewDigest).toBe(capture.plan().previewDigest);
  });

  it('changes when the status line changes', () => {
    const { capture, writeSettings } = rig({ settings: 'command-plain.json' });
    const before = capture.plan().previewDigest;
    writeSettings({ statusLine: { type: 'command', command: 'echo something else' } });
    expect(capture.plan().previewDigest).not.toBe(before);
  });

  it('changes when the status line is added or removed', () => {
    const { capture, writeSettings } = rig({ rawSettings: '{}' });
    const none = capture.plan().previewDigest;
    writeSettings({ statusLine: { type: 'command', command: 'echo x' } });
    expect(capture.plan().previewDigest).not.toBe(none);
  });

  it('does not change when only another key changes (consent is to the status line change alone)', () => {
    const world = rig({ settings: 'other-keys.json' });
    const before = world.capture.plan().previewDigest;
    world.writeSettings({ ...world.readSettingsJson(), theme: 'light', extra: true });
    expect(world.capture.plan().previewDigest).toBe(before);
  });

  it('changes with the Node the hook would run under, and with the settings file', () => {
    const world = rig({ settings: 'command-plain.json' });
    const other = world.another({ nodePath: '/somewhere/else/node' });
    expect(other.plan().previewDigest).not.toBe(world.capture.plan().previewDigest);
    const elsewhere = rig({ settings: 'command-plain.json' });
    expect(elsewhere.capture.plan().previewDigest).not.toBe(world.capture.plan().previewDigest);
  });
});

describe('what a plan never touches', () => {
  it('opens no credentials file and writes no project, local or other file', async () => {
    const world = rig({ settings: 'command-plain.json' });
    // A decoy that nothing may read: opening it would fail outright.
    const credentials = join(world.configDir, '.credentials.json');
    writeFileSync(credentials, 'SENTINEL_CREDENTIAL');
    chmodSync(credentials, 0o000);
    const local = join(world.configDir, 'settings.local.json');
    writeFileSync(local, fixture('project', 'with-status-line.json'));
    const before = tree(world.root);
    const mtime = statSync(credentials).mtimeMs;

    world.capture.plan();
    await world.capture.preview('install');
    await world.capture.health();
    world.capture.snapshot();

    expect(tree(world.root)).toEqual(before);
    expect(statSync(credentials).mtimeMs).toBe(mtime);
    expect(names(world.configDir)).toEqual([
      '.credentials.json',
      'settings.json',
      'settings.local.json',
    ]);
  });
});
