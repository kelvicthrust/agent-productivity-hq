import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import { watchMutations } from '../../src/server/integrations/claudeHooks/fsguard.ts';
import type { Step } from '../../src/server/integrations/claudeHooks/write.ts';
import { USER_SETTINGS, asText, names, read, rig, type Rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): for EVERY replacement, the commit and the rollback alike, the
// order is: (1) the staged file is sealed completely (identity, bytes, final mode and group, read back); (2) the destination is observed
// and compared with what the change was computed from; (3) the rename, with nothing between (2) and (3) but the comparison. A save the
// owner makes while HQ is sealing is therefore seen by (2): it is kept (the attempt starts over, or is refused), never overwritten. A
// save in the instant between (2) and (3) is the one residual no program can close without a lock the owner's editor would have to take
// too; one written into the file in place is found afterwards (through the handle that observed it) and put back.

const original = asText(USER_SETTINGS);
const ownerSave = asText({ ...USER_SETTINGS, model: 'sonnet' });

async function failureOf(run: () => Promise<unknown>): Promise<ClaudeHooksError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
    return error as ClaudeHooksError;
  }
  throw new Error('expected a failure');
}

/** A switch whose owner does `act` once, at `step` for `path` (any path when omitted). */
function withOwner(r: Rig, step: Step, act: () => void, only?: string) {
  let done = false;
  return r.another({
    onStep: (at, path) => {
      if (at !== step || done || (only !== undefined && path !== only)) return;
      done = true;
      act();
    },
  });
}

const inPlace = (path: string, text: string) => () => writeFileSync(path, text);
const byRename = (path: string, text: string) => () => {
  writeFileSync(`${path}.editor`, text, { mode: 0o600 });
  renameSync(`${path}.editor`, path);
};
const leftTemps = (dir: string): string[] => names(dir).filter((name) => name.endsWith('.tmp'));

describe('the order of every replacement: seal, observe, rename', () => {
  it('commit: the mode is applied before the destination is observed, and nothing is made between the observation and the rename', async () => {
    const r = rig({ settings: original });
    chmodSync(r.settings, 0o640);
    const events: string[] = [];
    const stop = watchMutations((mutation, phase) => {
      if (phase !== 'before') return;
      const to = mutation.to === undefined ? '' : ` -> ${mutation.to.split('/').at(-1)}`;
      events.push(`${mutation.op} ${mutation.path.split('/').at(-1)}${to}`);
    });
    try {
      const hooks = r.another({
        onStep: (step) => {
          if (['before_commit', 'sealed', 'observed', 'after_commit'].includes(step))
            events.push(`step ${step}`);
        },
      });
      await hooks.set(true, { preview: (await hooks.status()).plans.on?.preview });
    } finally {
      stop();
    }
    const at = (prefix: string): number => events.findIndex((line) => line.startsWith(prefix));
    const rename = events.findIndex((line) =>
      /^rename \.settings\.json\..*\.tmp -> settings\.json$/.test(line),
    );
    const lastChmod = events
      .map((line, i) => (/^chmod \.settings\.json\..*\.tmp$/.test(line) ? i : -1))
      .filter((i) => i >= 0)
      .at(-1)!;
    expect(at('step before_commit')).toBeGreaterThan(-1);
    // sealed (including the chmod to the final mode) -> observed -> the rename, directly
    expect(lastChmod).toBeGreaterThan(at('step before_commit'));
    expect(lastChmod).toBeLessThan(at('step sealed'));
    expect(at('step sealed')).toBeLessThan(at('step observed'));
    expect(rename).toBe(at('step observed') + 1);
    expect(statSync(r.settings).mode & 0o7777).toBe(0o640);
  });
});

describe('a save made after the staged file is sealed and before the destination is observed is kept', () => {
  for (const [how, save] of [
    ['in place', inPlace],
    ['by replacing the file (an editor’s atomic save)', byRename],
  ] as const) {
    it(`turning on, saved ${how}: refused as stale with the owner's file untouched`, async () => {
      const r = rig({ settings: original });
      const hooks = withOwner(r, 'sealed', save(r.settings, ownerSave));
      const preview = (await hooks.status()).plans.on?.preview;
      const error = await failureOf(() => hooks.set(true, { preview }));
      expect(error.failure).toBe('stale_preview');
      expect(read(r.settings)).toBe(ownerSave);
      expect(leftTemps(r.config)).toEqual([]);
    });

    it(`turning on without a preview, saved ${how}: the change is made again on top of their save`, async () => {
      const r = rig({ settings: original });
      const hooks = withOwner(r, 'sealed', save(r.settings, ownerSave));
      await hooks.set(true);
      expect(read(r.settings)).toContain('"model": "sonnet"');
      expect(read(r.settings)).toContain('agent-productivity-hq-hook');
    });
  }

  it('a change of mode at that moment starts the change over, and the new file has the mode the file has now', async () => {
    const r = rig({ settings: original });
    chmodSync(r.settings, 0o640);
    const hooks = withOwner(r, 'sealed', () => chmodSync(r.settings, 0o600));
    await hooks.set(true);
    expect(statSync(r.settings).mode & 0o7777).toBe(0o600);
    expect(read(r.settings)).toContain('agent-productivity-hq-hook');
  });

  it('turning off and repairing are the same', async () => {
    for (const action of ['off', 'repair'] as const) {
      const r = rig({ settings: original });
      await r.hooks.set(true);
      if (action === 'repair')
        writeFileSync(r.settings, read(r.settings).replace('"timeout": 3', '"timeout": 9'));
      const base = read(r.settings);
      const save = base.replace('"model": "opus"', '"model": "sonnet"');
      const hooks = withOwner(r, 'sealed', inPlace(r.settings, save));
      const preview = (await hooks.status()).plans[action]?.preview;
      const error = await failureOf(() => hooks.set(action === 'repair', { preview }));
      expect(error.failure, action).toBe('stale_preview');
      expect(read(r.settings), action).toBe(save);
    }
  });
});

describe('a save made after the destination was observed, before the rename (the residual)', () => {
  it('written into the file in place: found afterwards and put back, and the change is refused as stale', async () => {
    const r = rig({ settings: original });
    const hooks = withOwner(r, 'observed', inPlace(r.settings, ownerSave));
    const preview = (await hooks.status()).plans.on?.preview;
    const error = await failureOf(() => hooks.set(true, { preview }));
    expect(error.failure).toBe('stale_preview');
    expect(read(r.settings)).toBe(ownerSave);
    expect(leftTemps(r.config)).toEqual([]);
  });

  it('written in place, without a preview: put back, then the change is made again on top of it', async () => {
    const r = rig({ settings: original });
    const hooks = withOwner(r, 'observed', inPlace(r.settings, ownerSave));
    await hooks.set(true);
    expect(read(r.settings)).toContain('"model": "sonnet"');
    expect(read(r.settings)).toContain('agent-productivity-hq-hook');
  });

  it('written in place into a file that is turned off: the same', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    const save = read(r.settings).replace('"model": "opus"', '"model": "sonnet"');
    const hooks = withOwner(r, 'observed', inPlace(r.settings, save));
    const preview = (await hooks.status()).plans.off?.preview;
    const error = await failureOf(() => hooks.set(false, { preview }));
    expect(error.failure).toBe('stale_preview');
    expect(read(r.settings)).toBe(save);
  });
});

describe('the rollback follows the same order', () => {
  /** Two folders; the second cannot be replaced, so the first (replaced already) is put back. */
  function twoFolders(act: (first: string) => void, step: Step) {
    const r = rig({ settings: original });
    const second = join(r.root, 'second');
    const secondSettings = join(second, 'settings.json');
    mkdirSync(second);
    writeFileSync(secondSettings, asText({ b: 2 }), { mode: 0o600 });
    let done = false;
    const hooks = r.another({
      env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` },
      onStep: (at, path) => {
        if (at === 'before_commit' && path === secondSettings) chmodSync(second, 0o500);
        if (at === step && path === r.settings && !done) {
          done = true;
          act(r.settings);
        }
      },
    });
    return { r, hooks, second };
  }

  it('a save while the copy is sealed is kept, and the file is named', async () => {
    const world = twoFolders((first) => writeFileSync(first, ownerSave), 'restore_sealed');
    const error = await failureOf(() => world.hooks.set(true));
    expect(error.failure).toBe('rollback_failed');
    expect(error.files).toEqual(['~/.claude/settings.json']);
    expect(read(world.r.settings)).toBe(ownerSave);
  });

  it('a save in the instant before the rename is found afterwards and put back, and the file is named', async () => {
    const world = twoFolders((first) => writeFileSync(first, ownerSave), 'restore_observed');
    const error = await failureOf(() => world.hooks.set(true));
    expect(error.failure).toBe('rollback_failed');
    expect(error.files).toEqual(['~/.claude/settings.json']);
    expect(read(world.r.settings)).toBe(ownerSave);
  });
});
