import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeHooksAction } from '../../src/shared/contracts/hq.ts';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import { watchMutations } from '../../src/server/integrations/claudeHooks/fsguard.ts';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import { USER_SETTINGS, asText, read, rig, type Rig } from './helpers.ts';
import { describeStep, plannedRoles, recorded, rolesOf, type Step } from './mutations.ts';

// The rules (data-and-sources › Claude Code hooks › Install and remove):
//   - for every action, the set of files written, replaced or deleted is EXACTLY the plan the owner was shown: a file listed as unchanged
//     is not touched (not even rewritten with the same bytes), and nothing unlisted is made;
//   - the order of the steps is fixed, so that a process that dies after any one of them leaves a state the next status describes
//     honestly, and that either action can leave again.

const TOKEN = 'T'.repeat(43);
const PINNED: Record<'on' | 'off' | 'repairEntry' | 'repairScript', string[]> = {
  on: [
    'chmod data dir',
    'mkdir claude-hooks',
    'create tmp(agent-productivity-hook.mjs)',
    'chmod tmp(agent-productivity-hook.mjs)',
    'write tmp(agent-productivity-hook.mjs)',
    'chmod tmp(agent-productivity-hook.mjs)',
    'rename tmp(agent-productivity-hook.mjs) -> agent-productivity-hook.mjs',
    'chmod data dir',
    'create tmp(registry.json)',
    'chmod tmp(registry.json)',
    'write tmp(registry.json)',
    'chmod tmp(registry.json)',
    'rename tmp(registry.json) -> registry.json',
    'create tmp(settings.json)',
    'chmod tmp(settings.json)',
    'write tmp(settings.json)',
    'create tmp(settings.json)',
    'chmod tmp(settings.json)',
    'write tmp(settings.json)',
    'create tmp(settings.json.agent-productivity-backup)',
    'chmod tmp(settings.json.agent-productivity-backup)',
    'write tmp(settings.json.agent-productivity-backup)',
    'link tmp(settings.json.agent-productivity-backup) -> settings.json.agent-productivity-backup',
    'unlink tmp(settings.json.agent-productivity-backup)',
    'chmod tmp(settings.json)',
    'rename tmp(settings.json) -> settings.json',
    'unlink tmp(settings.json)',
  ],
  off: [
    'create tmp(settings.json)',
    'chmod tmp(settings.json)',
    'write tmp(settings.json)',
    'create tmp(settings.json)',
    'chmod tmp(settings.json)',
    'write tmp(settings.json)',
    'chmod tmp(settings.json)',
    'rename tmp(settings.json) -> settings.json',
    'unlink tmp(settings.json)',
    'unlink registry.json',
    'unlink agent-productivity-hook.mjs',
  ],
  repairEntry: [
    'create tmp(settings.json)',
    'chmod tmp(settings.json)',
    'write tmp(settings.json)',
    'create tmp(settings.json)',
    'chmod tmp(settings.json)',
    'write tmp(settings.json)',
    'chmod tmp(settings.json)',
    'rename tmp(settings.json) -> settings.json',
    'unlink tmp(settings.json)',
  ],
  repairScript: [
    'chmod data dir',
    'create tmp(agent-productivity-hook.mjs)',
    'chmod tmp(agent-productivity-hook.mjs)',
    'write tmp(agent-productivity-hook.mjs)',
    'chmod tmp(agent-productivity-hook.mjs)',
    'rename tmp(agent-productivity-hook.mjs) -> agent-productivity-hook.mjs',
  ],
};
const original = asText(USER_SETTINGS);

it('does not remove a script missing from the confirmed turn-off plan', async () => {
  const r = rig({ settings: original });
  await r.hooks.set(true);
  const script = read(r.hooks.paths.script);
  rmSync(r.hooks.paths.script);
  let restored = false;
  const hooks = r.another({
    onStep: (step) => {
      if (step !== 'after_commit') return;
      writeFileSync(r.hooks.paths.script, script, { mode: 0o600 });
      restored = true;
    },
  });
  const plan = (await hooks.status()).plans.off;
  expect(plan?.ownFiles).not.toContain('script');

  await hooks.set(false, { preview: plan?.preview }).catch((error: unknown) => {
    expect(error).toBeInstanceOf(ClaudeHooksError);
  });

  expect(restored).toBe(true);
  expect(read(r.hooks.paths.script)).toBe(script);
});

/** What the recorded steps deleted or renamed over in HQ's own folder (temp files are the means, not the end). */
const ownTouched = (steps: readonly Step[], r: Rig): { deleted: string[]; replaced: string[] } => {
  const hooksDir = realpathSync(r.hooks.paths.dir);
  const inside = (path: string) =>
    dirname(path) === hooksDir || dirname(path) === r.hooks.paths.dir;
  const named = (path: string) => !basename(path).endsWith('.tmp') && inside(path);
  return {
    deleted: steps
      .filter((step) => step.op === 'unlink' && named(step.path))
      .map((step) => basename(step.path)),
    replaced: steps
      .filter((step) => step.op === 'rename' && named(step.to!))
      .map((step) => basename(step.to!)),
  };
};
const HQ_SCRIPT_NAME = 'agent-productivity-hook.mjs';

describe('a cleanup deletes only what the confirmed plan lists, and only while it is still what the plan recorded', () => {
  /** On, listening; the plan to turn off lists the script and the registry. `act` runs once, right after the settings were changed. */
  async function off(act: (r: Rig) => void, listening = true) {
    const r = rig({ settings: original });
    if (listening) await r.hooks.listening({ port: 4317, token: TOKEN });
    await r.hooks.set(true);
    let done = false;
    const hooks = r.another({
      onStep: (step) => {
        if (step !== 'after_commit' || done) return;
        done = true;
        act(r);
      },
    });
    if (listening) await hooks.listening({ port: 4317, token: TOKEN });
    const plan = (await hooks.status()).plans.off!;
    const run = await recorded(() => hooks.set(false, { preview: plan.preview }));
    return { r, plan, steps: run.steps, result: run.result };
  }

  it('a script the owner replaced after the plan was confirmed is left and reported, the registry the plan listed is removed', async () => {
    const edited = '// Agent Productivity: the Claude Code hook (the owner’s own edit)';
    const { r, plan, steps, result } = await off((world) =>
      writeFileSync(world.hooks.paths.script, edited, { mode: 0o600 }),
    );
    expect(plan.ownFiles).toEqual(['script', 'registry']);
    expect(read(r.hooks.paths.script)).toBe(edited);
    expect(existsSync(r.hooks.paths.registry)).toBe(false);
    expect(ownTouched(steps, r).deleted).toEqual(['registry.json']);
    // said, never a clean removal
    expect(result).toMatchObject({ state: 'off', reason: 'cleanup_incomplete' });
    expect(result.leftover?.items).toEqual(['script']);
    expect(r.logs.some((line) => line['code'] === 'cleanup_incomplete')).toBe(true);
  });

  it('a registry the owner replaced after the plan was confirmed is left and reported', async () => {
    const theirs = `${JSON.stringify({ v: 1, pid: process.pid, port: 1, token: 'N'.repeat(43) })}\n`;
    const { r, steps, result } = await off((world) =>
      writeFileSync(world.hooks.paths.registry, theirs, { mode: 0o600 }),
    );
    expect(read(r.hooks.paths.registry)).toBe(theirs);
    expect(ownTouched(steps, r).deleted).toEqual([HQ_SCRIPT_NAME]);
    expect(result).toMatchObject({ state: 'off', reason: 'cleanup_incomplete' });
    expect(result.leftover?.items).toEqual(['registry']);
  });

  it('a script that was missing when the plan was confirmed and came back is left and reported', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    const script = read(r.hooks.paths.script);
    rmSync(r.hooks.paths.script);
    const hooks = r.another({
      onStep: (step) => {
        if (step === 'after_commit') writeFileSync(r.hooks.paths.script, script, { mode: 0o600 });
      },
    });
    const plan = (await hooks.status()).plans.off!;
    expect(plan.ownFiles).toEqual([]);
    const { steps, result } = await recorded(() => hooks.set(false, { preview: plan.preview }));
    expect(ownTouched(steps, r)).toEqual({ deleted: [], replaced: [] });
    expect(read(r.hooks.paths.script)).toBe(script);
    expect(result).toMatchObject({ state: 'off', reason: 'cleanup_incomplete' });
    expect(result.leftover?.items).toEqual(['script']);
  });

  it('a registry that was missing when the plan was confirmed and appeared (another app’s dead run) is left', async () => {
    const stale = `${JSON.stringify({ v: 1, pid: 99999999, port: 1, token: 'S'.repeat(43) })}\n`;
    const r = rig({ settings: original });
    await r.hooks.set(true);
    const hooks = r.another({
      onStep: (step) => {
        if (step === 'after_commit') writeFileSync(r.hooks.paths.registry, stale, { mode: 0o600 });
      },
    });
    const plan = (await hooks.status()).plans.off!;
    expect(plan.ownFiles).toEqual(['script']);
    const { steps } = await recorded(() => hooks.set(false, { preview: plan.preview }));
    expect(ownTouched(steps, r).deleted).toEqual([HQ_SCRIPT_NAME]);
    expect(read(r.hooks.paths.registry)).toBe(stale);
  });

  it('the retry action (“Remove HQ’s files”) has its own plan, and deletes only what that plan lists, as recorded', async () => {
    // off, with the script and the registry left behind
    const r = rig({ settings: original });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    await r.hooks.set(true);
    writeFileSync(r.settings, original);
    const status = await r.hooks.status();
    expect(status).toMatchObject({ state: 'off', reason: 'cleanup_incomplete' });
    const plan = status.plans.off!;
    expect(plan.files).toEqual([]);
    expect(plan.ownFiles).toEqual(['script', 'registry']);
    expect(plan.preview).not.toBe(status.plans.on!.preview);
    // the owner changes the script (and only the script) after the plan was shown: it is another plan
    const edited = '// Agent Productivity: the Claude Code hook (the owner’s own edit)';
    writeFileSync(r.hooks.paths.script, edited, { mode: 0o600 });
    const stale = await recorded(async () => {
      await expect(r.hooks.set(false, { preview: plan.preview })).rejects.toMatchObject({
        failure: 'stale_preview',
      });
    });
    expect(stale.steps).toEqual([]);
    expect(read(r.hooks.paths.script)).toBe(edited);

    // and the owner changes it in the instant between the confirmation and the first deletion: left and reported
    const again = (await r.hooks.status()).plans.off!;
    // (one listener both records the steps and acts as the owner: there is only one at a time)
    const steps: Step[] = [];
    const stop = watchMutations((mutation, phase) => {
      if (phase === 'after') steps.push({ op: mutation.op, path: mutation.path, to: mutation.to });
      else if (mutation.op === 'unlink' && mutation.path.endsWith('registry.json'))
        writeFileSync(r.hooks.paths.script, `${edited} again`, { mode: 0o600 });
    });
    let result;
    try {
      result = await r.hooks.set(false, { preview: again.preview });
    } finally {
      stop();
    }
    expect(ownTouched(steps, r).deleted).toEqual(['registry.json']);
    expect(read(r.hooks.paths.script)).toBe(`${edited} again`);
    expect(result).toMatchObject({ state: 'off', reason: 'cleanup_incomplete' });
    expect(result.leftover?.items).toEqual(['script']);
  });

  it('a failed turn-on takes back only what its plan listed, and never an own file it did not write', async () => {
    const r = rig({ settings: original });
    await r.hooks.listening({ port: 4317, token: TOKEN });
    // the script is current and left; the plan to turn on lists the registry only if it is unaccepted: make the plan list the script
    const hooks = r.another({
      onStep: (step) => {
        if (step !== 'before_commit') return;
        for (const name of readdirSync(r.config))
          if (name.endsWith('.tmp')) rmSync(join(r.config, name));
      },
    });
    await hooks.listening({ port: 4317, token: TOKEN });
    const plan = (await hooks.status()).plans.on!;
    const planned = plan.ownFiles
      .map((own) => (own === 'script' ? HQ_SCRIPT_NAME : 'registry.json'))
      .sort();
    const { steps } = await recorded(async () => {
      await expect(hooks.set(true, { preview: plan.preview })).rejects.toBeInstanceOf(
        ClaudeHooksError,
      );
    });
    const touched = ownTouched(steps, r);
    for (const name of [...touched.deleted, ...touched.replaced]) expect(planned).toContain(name);
    expect(existsSync(r.hooks.paths.script)).toBe(false);
    expect(existsSync(r.hooks.paths.registry)).toBe(false);
  });

  it('shutdown removes only the registry this process published', async () => {
    const r = rig({ settings: original });
    await r.hooks.set(true);
    await r.hooks.listening({ port: 4317, token: TOKEN });
    // somebody else's registry now stands where this process published
    const theirs = `${JSON.stringify({ v: 1, pid: 99999999, port: 1, token: 'S'.repeat(43) })}\n`;
    writeFileSync(r.hooks.paths.registry, theirs, { mode: 0o600 });
    const { steps } = await recorded(() => r.hooks.close());
    expect(ownTouched(steps, r)).toEqual({ deleted: [], replaced: [] });
    expect(read(r.hooks.paths.registry)).toBe(theirs);
    expect(read(r.hooks.paths.script)).toContain('Agent Productivity');
  });
});

interface World {
  r: Rig;
  /** More Claude Code folders than the first. */
  extra: string[];
}

type Build = () => Promise<World>;

async function installed(options: { listening: boolean; two?: boolean }): Promise<World> {
  const r = rig({ settings: original });
  const extra: string[] = [];
  let hooks = r.hooks;
  if (options.two) {
    const second = join(r.root, 'second');
    mkdirSync(second);
    writeFileSync(join(second, 'settings.json'), asText({ b: 2 }), { mode: 0o600 });
    extra.push(join(second, 'settings.json'));
    hooks = r.another({ env: { CLAUDE_CONFIG_DIR: `${r.config},${second}` } });
    // The world's one switch is the one with both folders.
    (r as { hooks: typeof hooks }).hooks = hooks;
  }
  if (options.listening) await r.hooks.listening({ port: 4317, token: TOKEN });
  await r.hooks.set(true);
  return { r, extra };
}

const fresh =
  (listening: boolean): Build =>
  async () => {
    const r = rig({ settings: original });
    if (listening) await r.hooks.listening({ port: 4317, token: TOKEN });
    return { r, extra: [] };
  };

/** Every state the switch can be in, with what turns it into it, and the actions it offers. */
const STATES: { name: string; build: Build; actions: ClaudeHooksAction[] }[] = [
  { name: 'off, the server listening', build: fresh(true), actions: ['on'] },
  { name: 'off, the server not listening yet', build: fresh(false), actions: ['on'] },
  {
    name: 'on, the server listening',
    build: () => installed({ listening: true }),
    actions: ['off'],
  },
  {
    name: 'on, the server not listening yet',
    build: () => installed({ listening: false }),
    actions: ['off'],
  },
  {
    name: 'needs repair: an entry was changed',
    build: async () => {
      const w = await installed({ listening: true });
      writeFileSync(w.r.settings, read(w.r.settings).replace('"timeout": 3', '"timeout": 9'));
      return w;
    },
    actions: ['repair', 'off'],
  },
  {
    name: 'needs repair: the script is missing',
    build: async () => {
      const w = await installed({ listening: true });
      rmSync(w.r.hooks.paths.script);
      return w;
    },
    actions: ['repair', 'off'],
  },
  {
    name: 'needs repair: the script was edited',
    build: async () => {
      const w = await installed({ listening: true });
      writeFileSync(w.r.hooks.paths.script, '// Agent Productivity: the Claude Code hook (edited)');
      return w;
    },
    actions: ['repair', 'off'],
  },
  {
    name: 'needs repair: the script can be written by others',
    build: async () => {
      const w = await installed({ listening: true });
      chmodSync(w.r.hooks.paths.script, 0o666);
      return w;
    },
    actions: ['repair', 'off'],
  },
  {
    name: 'needs repair: the registry is missing',
    build: async () => {
      const w = await installed({ listening: true });
      rmSync(w.r.hooks.paths.registry);
      return w;
    },
    actions: ['repair', 'off'],
  },
  {
    name: 'needs repair: the registry is open to others',
    build: async () => {
      const w = await installed({ listening: true });
      chmodSync(w.r.hooks.paths.registry, 0o644);
      return w;
    },
    actions: ['repair', 'off'],
  },
  {
    name: 'needs repair: the registry names another port',
    build: async () => {
      const w = await installed({ listening: true });
      writeFileSync(
        w.r.hooks.paths.registry,
        read(w.r.hooks.paths.registry).replace('4317', '5000'),
        { mode: 0o600 },
      );
      return w;
    },
    actions: ['repair', 'off'],
  },
  {
    name: 'needs repair: only one of two settings files holds the entries',
    build: async () => {
      const w = await installed({ listening: true, two: true });
      writeFileSync(w.extra[0]!, asText({ b: 2 }));
      return w;
    },
    actions: ['repair', 'off'],
  },
  {
    name: 'off with HQ’s script and registry left behind',
    build: async () => {
      const w = await installed({ listening: true });
      writeFileSync(w.r.settings, original);
      return w;
    },
    actions: ['on', 'off'],
  },
  {
    name: 'off with only the script left behind',
    build: async () => {
      const w = await installed({ listening: true });
      writeFileSync(w.r.settings, original);
      rmSync(w.r.hooks.paths.registry);
      return w;
    },
    actions: ['on', 'off'],
  },
];

describe('every action writes exactly the plan it showed', () => {
  for (const state of STATES) {
    for (const action of state.actions) {
      it(`${state.name}: ${action}`, async () => {
        const { r } = await state.build();
        const status = await r.hooks.status();
        const plan = status.plans[action];
        expect(plan, 'the state offers this action').toBeDefined();
        const planned = plannedRoles(plan!, r, (settings) =>
          existsSync(`${settings}${BACKUP_SUFFIX}`),
        );
        const before = new Map<string, string>();
        for (const path of [r.hooks.paths.script, r.hooks.paths.registry])
          if (existsSync(path)) before.set(path, read(path));
        const { steps, result } = await recorded(() =>
          r.hooks.set(action !== 'off', { preview: plan!.preview }),
        );
        expect(rolesOf(steps, r)).toEqual(planned);
        // And the answer is what is on disk: turned on and deliverable, or off with nothing left.
        if (action === 'off')
          expect(result).toMatchObject({ state: 'off', reason: null, leftover: null });
        else expect(result.state).toBe('on');
        // A file the plan did not list keeps its inode's bytes (nothing rewrote it with the same bytes either: it is not in the steps).
        for (const [path, text] of before)
          if (!planned.includes(`own:${path.split('/').at(-1)}`) && existsSync(path))
            expect(read(path)).toBe(text);
      });
    }
  }
});

/** The steps of each action, in order, with a temp file named by what it is beside. */
describe('the order of the steps is fixed', () => {
  const steps = async (build: Build, action: ClaudeHooksAction): Promise<string[]> => {
    const { r } = await build();
    const plan = (await r.hooks.status()).plans[action]!;
    const run = await recorded(() => r.hooks.set(action !== 'off', { preview: plan.preview }));
    return run.steps.map(describeStep);
  };

  it('turning on: HQ’s files first (the folder, the script, the registry), then the settings (staged, the copy, the rename)', async () => {
    expect(await steps(fresh(true), 'on')).toEqual(PINNED.on);
  });

  it('turning off: the settings first, then the registry, then the script', async () => {
    expect(await steps(() => installed({ listening: true }), 'off')).toEqual(PINNED.off);
  });

  it('repair of an entry: only the settings; of the script and registry: only those, before any settings', async () => {
    const entry = STATES.find((state) => state.name.endsWith('an entry was changed'))!;
    expect(await steps(entry.build, 'repair')).toEqual(PINNED.repairEntry);
    const script = STATES.find((state) => state.name.endsWith('the script is missing'))!;
    expect(await steps(script.build, 'repair')).toEqual(PINNED.repairScript);
  });
});

describe('the fingerprint covers every input of the plan, and the plan is derived again before anything is written', () => {
  it('the registry’s and the script’s observed condition change the fingerprint of the action', async () => {
    const { r } = await installed({ listening: true });
    writeFileSync(r.settings, read(r.settings).replace('"timeout": 3', '"timeout": 9'));
    const plain = (await r.hooks.status()).plans.repair!;
    chmodSync(r.hooks.paths.registry, 0o644);
    const loose = (await r.hooks.status()).plans.repair!;
    expect(loose.preview).not.toBe(plain.preview);
    expect(loose.ownFiles).toEqual(['registry']);
    chmodSync(r.hooks.paths.script, 0o666);
    const both = (await r.hooks.status()).plans.repair!;
    expect(both.preview).not.toBe(loose.preview);
    // a plan confirmed before the registry changed is stale for what is there now, and nothing is written
    const { steps } = await recorded(async () => {
      await expect(r.hooks.set(true, { preview: plain.preview })).rejects.toMatchObject({
        failure: 'stale_preview',
      });
    });
    expect(steps).toEqual([]);
  });

  it('an own file that changes between the read and the first write makes the action stale, with nothing written', async () => {
    const { r } = await installed({ listening: true });
    writeFileSync(r.settings, read(r.settings).replace('"timeout": 3', '"timeout": 9'));
    let calls = 0;
    const flipping = r.another({
      nodeUsable: () => {
        calls += 1;
        // the second read of the disk (the one just before the writes): somebody opens the registry to others
        if (calls === 2) chmodSync(r.hooks.paths.registry, 0o644);
        return true;
      },
    });
    await flipping.listening({ port: 4317, token: TOKEN });
    calls = 0;
    const plan = (await flipping.status()).plans.repair!;
    calls = 0;
    const { steps } = await recorded(async () => {
      await expect(flipping.set(true, { preview: plan.preview })).rejects.toMatchObject({
        failure: 'stale_preview',
      });
    });
    expect(steps).toEqual([]);
  });

  it('an own file that changes after HQ wrote its part makes the action stale, and what HQ wrote is taken back', async () => {
    const r = rig({ settings: original });
    let calls = 0;
    const flipping = r.another({
      nodeUsable: () => {
        calls += 1;
        // the read, the read again, then the look after the script was written: the script is made writable by others right after it
        if (calls === 3) chmodSync(r.hooks.paths.script, 0o666);
        return true;
      },
    });
    const plan = (await flipping.status()).plans.on!;
    calls = 0;
    await expect(flipping.set(true, { preview: plan.preview })).rejects.toMatchObject({
      failure: 'stale_preview',
    });
    expect(existsSync(r.hooks.paths.script)).toBe(false);
    expect(read(r.settings)).toBe(original);
  });
});
