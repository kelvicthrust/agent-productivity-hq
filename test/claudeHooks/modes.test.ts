import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import {
  removeIfMade,
  sealForRename,
  stageTemp,
} from '../../src/server/integrations/claudeHooks/fsguard.ts';
import { USER_SETTINGS, asText, read, rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): the whole permission word of the file (`mode & 0o7777`: setuid,
// setgid and sticky included) goes through replacement and roll-back, applied to the staged file immediately before the rename from the
// last observation. A bit the platform will not keep refuses the change; it is never dropped.

const original = asText(USER_SETTINGS);

/** Whether this file system lets the current user keep `mode` on a file of theirs (macOS refuses the sticky bit on a file, for one). */
function keeps(mode: number): boolean {
  const probe = rig({ settings: '{}' });
  try {
    chmodSync(probe.settings, mode);
  } catch {
    return false;
  }
  return (statSync(probe.settings).mode & 0o7777) === mode;
}

describe('the whole mode of a settings file is kept', () => {
  for (const mode of [0o2640, 0o1644, 0o4600, 0o600, 0o640, 0o664, 0o755, 0o400 | 0o200]) {
    const supported = keeps(mode);
    it.skipIf(!supported)(
      `${mode.toString(8)}: turning on, repair and turning off keep it`,
      async () => {
        const r = rig({ settings: original });
        chmodSync(r.settings, mode);
        await r.hooks.set(true);
        expect(statSync(r.settings).mode & 0o7777, 'on').toBe(mode);
        writeFileSync(r.settings, read(r.settings).replace('"timeout": 3', '"timeout": 9'));
        chmodSync(r.settings, mode);
        const status = await r.hooks.status();
        await r.hooks.set(true, { preview: status.plans.repair!.preview });
        expect(statSync(r.settings).mode & 0o7777, 'repair').toBe(mode);
        await r.hooks.set(false);
        expect(statSync(r.settings).mode & 0o7777, 'off').toBe(mode);
      },
    );

    it.skipIf(!supported)(`${mode.toString(8)}: a roll-back puts the file back in it`, async () => {
      const r = rig({ settings: original });
      chmodSync(r.settings, mode);
      const second = join(r.root, 'second');
      mkdirSync(second);
      writeFileSync(join(second, 'settings.json'), '{}', { mode: 0o600 });
      const hooks = r.another({
        env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` },
        onStep: (step, path) => {
          // The second file is made read-only just before its replace, so the first is rolled back.
          if (step === 'before_commit' && path === join(second, 'settings.json'))
            chmodSync(join(second, 'settings.json'), 0o400);
        },
      });
      await expect(hooks.set(true)).rejects.toBeInstanceOf(ClaudeHooksError);
      expect(read(r.settings)).toBe(original);
      expect(statSync(r.settings).mode & 0o7777).toBe(mode);
    });
  }
});

describe('a mode bit the platform will not keep refuses the change', () => {
  const root = process.getuid?.() === 0;
  it.skipIf(root)('setgid for a group the user is not in is refused, not dropped', () => {
    const dir = rig().config;
    const made = stageTemp(join(dir, 'settings.json'), Buffer.from('{}'));
    const mine = new Set([process.getgid?.(), ...(process.getgroups?.() ?? [])]);
    let foreign = 30_000;
    while (mine.has(foreign)) foreign += 1;
    expect(() => sealForRename(made, 0o2640, foreign)).toThrow(ClaudeHooksError);
    removeIfMade(made);
  });

  it('a staged file that is not owner-only any more is refused before the mode step', () => {
    const dir = rig().config;
    const made = stageTemp(join(dir, 'settings.json'), Buffer.from('{}'));
    chmodSync(made.path, 0o644);
    expect(() => sealForRename(made, 0o644, undefined)).toThrow(ClaudeHooksError);
    removeIfMade(made);
  });
});
