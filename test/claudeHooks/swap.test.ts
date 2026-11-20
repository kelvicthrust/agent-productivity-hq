import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import type { Step } from '../../src/server/integrations/claudeHooks/write.ts';
import { USER_SETTINGS, asText, names, read, rig, type Rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): the last compare before each replace is of the whole identity of
// the file, not only its bytes: device, inode, size, modification time, MODE, OWNER and GROUP, and the folder it is in (identity and
// writability). A file that is not the owner's, that its owner cannot write at that moment (the owner made it read-only), or that is in
// a folder that cannot be written is refused (`not_writable`) for turning on, repair, turning off and a roll-back alike. A change of
// anything else starts the change over from a fresh read. The staged file takes its mode from that very observation.

const original = asText(USER_SETTINGS);

async function failureOf(run: () => Promise<unknown>): Promise<ClaudeHooksError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
    return error as ClaudeHooksError;
  }
  throw new Error('expected a failure');
}

/** A switch whose owner does `act` at `step` (once), as they would saving or changing the file at that moment. */
function withOwner(r: Rig, step: Step, act: () => void) {
  let done = false;
  return r.another({
    onStep: (at) => {
      if (at !== step || done) return;
      done = true;
      act();
    },
  });
}

/** The state the file is in after turning HQ on: for the repair and turn-off cases. */
async function installed() {
  const r = rig({ settings: original });
  await r.hooks.set(true);
  return r;
}

describe('a file the owner makes read-only just before the replace', () => {
  for (const mode of [0o400, 0o444]) {
    it(`is left alone when turning on (mode ${mode.toString(8)})`, async () => {
      const r = rig({ settings: original });
      const hooks = withOwner(r, 'before_commit', () => chmodSync(r.settings, mode));
      const preview = await hooks.status();
      const error = await failureOf(() => hooks.set(true, { preview: preview.preview }));
      expect(error.failure).toBe('not_writable');
      expect(read(r.settings)).toBe(original);
      expect(statSync(r.settings).mode & 0o777).toBe(mode);
      // Nothing of the refused change stays: no temp file, and no copy of a file that was never replaced.
      expect(names(r.config)).toEqual(['settings.json']);
    });
  }

  it('is left alone when repairing', async () => {
    const r = await installed();
    const edited = read(r.settings).replace('"timeout": 3', '"timeout": 9');
    writeFileSync(r.settings, edited);
    const hooks = withOwner(r, 'before_commit', () => chmodSync(r.settings, 0o400));
    const status = await hooks.status();
    expect(status.state).toBe('needs_repair');
    const error = await failureOf(() => hooks.set(true, { preview: status.plans.repair!.preview }));
    expect(error.failure).toBe('not_writable');
    expect(read(r.settings)).toBe(edited);
    expect(statSync(r.settings).mode & 0o777).toBe(0o400);
  });

  it('is left alone when turning off', async () => {
    const r = await installed();
    const text = read(r.settings);
    const hooks = withOwner(r, 'before_commit', () => chmodSync(r.settings, 0o400));
    const status = await hooks.status();
    const error = await failureOf(() => hooks.set(false, { preview: status.plans.off!.preview }));
    expect(error.failure).toBe('not_writable');
    expect(read(r.settings)).toBe(text);
    expect(statSync(r.settings).mode & 0o777).toBe(0o400);
  });

  it('is not made writable again by HQ at any step before the replace', async () => {
    for (const step of ['staged', 'before_backup', 'after_backup'] as const) {
      const r = rig({ settings: original });
      const hooks = withOwner(r, step, () => chmodSync(r.settings, 0o400));
      const preview = await hooks.status();
      const error = await failureOf(() => hooks.set(true, { preview: preview.preview }));
      expect(error.failure, step).toBe('not_writable');
      expect(read(r.settings), step).toBe(original);
      expect(statSync(r.settings).mode & 0o777, step).toBe(0o400);
    }
  });

  it('is not replaced when the owner makes it read-only after the first of two files was replaced, and the first is put back', async () => {
    const r = rig({ settings: original });
    const second = join(r.root, 'second');
    mkdirSync(second);
    const secondSettings = join(second, 'settings.json');
    writeFileSync(secondSettings, asText({ b: 2 }), { mode: 0o600 });
    const hooks = r.another({
      env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` },
      onStep: (step, path) => {
        if (step === 'before_commit' && path === secondSettings) chmodSync(secondSettings, 0o400);
      },
    });
    const error = await failureOf(() => hooks.set(true));
    expect(error.failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
    expect(read(secondSettings)).toBe(asText({ b: 2 }));
  });

  it('puts nothing back over a file the owner made read-only after HQ replaced it: the roll-back follows the same rule', async () => {
    const r = rig({ settings: original });
    const second = join(r.root, 'second');
    mkdirSync(second);
    const secondSettings = join(second, 'settings.json');
    writeFileSync(secondSettings, asText({ b: 2 }), { mode: 0o600 });
    const hooks = r.another({
      env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` },
      onStep: (step, path) => {
        if (step === 'before_commit' && path === secondSettings) {
          // The first file is HQ's now; the owner makes it read-only, and the second cannot be replaced.
          chmodSync(r.settings, 0o400);
          chmodSync(second, 0o500);
        }
      },
    });
    const error = await failureOf(() => hooks.set(true));
    expect(error.failure).toBe('rollback_failed');
    expect(error.files).toEqual(['~/.claude/settings.json']);
    expect(statSync(r.settings).mode & 0o777).toBe(0o400);
  });
});

describe('a change of the file’s mode that leaves it writable', () => {
  it('starts the change over from a fresh read, and the new file has the mode the file has now', async () => {
    const r = rig({ settings: original });
    chmodSync(r.settings, 0o644);
    const hooks = withOwner(r, 'before_commit', () => chmodSync(r.settings, 0o600));
    const preview = await hooks.status();
    await hooks.set(true, { preview: preview.preview });
    expect(statSync(r.settings).mode & 0o777).toBe(0o600);
    expect(read(r.settings)).toContain('agent-productivity-hq-hook');
  });

  it('keeps the mode of the file for every kind of change', async () => {
    for (const mode of [0o600, 0o640, 0o664, 0o755, 0o2640]) {
      const r = rig({ settings: original });
      chmodSync(r.settings, mode);
      await r.hooks.set(true);
      expect(statSync(r.settings).mode & 0o7777, `on ${mode.toString(8)}`).toBe(mode);
      await r.hooks.set(false);
      expect(statSync(r.settings).mode & 0o7777, `off ${mode.toString(8)}`).toBe(mode);
    }
  });
});

describe('a file that is not the owner’s', () => {
  it('is refused before anything is staged, whatever its mode says', async () => {
    const r = rig({ settings: original });
    const other = (process.getuid?.() ?? 1000) + 1;
    const hooks = r.another({ uid: other });
    const status = await hooks.status();
    expect(status.files[0]).toMatchObject({ state: 'blocked', reason: 'not_writable' });
    const error = await failureOf(() => hooks.set(true));
    expect(error.failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
    expect(names(r.config)).toEqual(['settings.json']);
  });
});

describe('the folder the file is in', () => {
  it('is checked at the last moment: a folder that can no longer be written refuses the change, and what HQ staged there is reported', async () => {
    const r = rig({ settings: original });
    const hooks = withOwner(r, 'before_commit', () => chmodSync(r.config, 0o500));
    const preview = await hooks.status();
    const error = await failureOf(() => hooks.set(true, { preview: preview.preview }));
    expect(error.failure).toBe('not_writable');
    expect(read(r.settings)).toBe(original);
    // HQ's temp files and its copy are in a folder it can no longer write to: they stay, and the error says so.
    expect(error.left).toEqual(expect.arrayContaining(['temp', 'backup']));
  });

  it('is the same folder at the replace as when the file was read: a folder swapped in between starts the change over', async () => {
    const r = rig({ settings: original });
    const moved = `${r.config}.moved`;
    const hooks = withOwner(r, 'before_commit', () => {
      renameSync(r.config, moved);
      mkdirSync(r.config);
      writeFileSync(r.settings, original, { mode: 0o600 });
    });
    const preview = await hooks.status();
    // The preview was of the first folder's bytes; the new folder's file has the same bytes, so the plan is still the one shown.
    await hooks.set(true, { preview: preview.preview });
    expect(read(r.settings)).toContain('agent-productivity-hq-hook');
    // The old folder's file was never overwritten.
    expect(read(join(moved, 'settings.json'))).toBe(original);
  });
});
