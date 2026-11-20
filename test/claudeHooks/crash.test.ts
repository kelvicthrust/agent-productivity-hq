import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import { ASSET, USER_SETTINGS, asText, read, rig, type Rig } from './helpers.ts';
import { crashedAfter, recorded } from './mutations.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): HQ's steps are in a fixed order, and a process that dies right
// after ANY one of them (here: every later step is refused before it happens, and nothing cleans up) leaves a disk that
//   - holds a settings file that is exactly the one before or the one after, never half of either (a valid JSON file in its own mode),
//   - the next status describes honestly (it never says "on" for entries that are not there, or "off" over entries that are), and
//   - either action can leave again: the opposite action succeeds from that state and ends in a clean "off" (or "on").

const TOKEN = 'T'.repeat(43);
const original = asText(USER_SETTINGS);
const MARKER = 'agent-productivity-hq-hook';
const entries = (text: string): number => text.split(MARKER).length - 1;

interface Scenario {
  name: string;
  /** The world before the action. */
  build: () => Promise<Rig>;
  action: 'on' | 'off' | 'repair';
}

const fresh = async (): Promise<Rig> => {
  const r = rig({ settings: original });
  await r.hooks.listening({ port: 4317, token: TOKEN });
  return r;
};
const on = async (): Promise<Rig> => {
  const r = await fresh();
  await r.hooks.set(true);
  return r;
};

const SCENARIOS: Scenario[] = [
  { name: 'turning on', build: fresh, action: 'on' },
  { name: 'turning off', build: on, action: 'off' },
  {
    name: 'repairing an entry',
    build: async () => {
      const r = await on();
      writeFileSync(r.settings, read(r.settings).replace('"timeout": 3', '"timeout": 9'));
      return r;
    },
    action: 'repair',
  },
  {
    name: 'repairing the registry and the script',
    build: async () => {
      const r = await on();
      chmodSync(r.hooks.paths.registry, 0o644);
      writeFileSync(r.hooks.paths.script, '// Agent Productivity: the Claude Code hook (edited)');
      return r;
    },
    action: 'repair',
  },
];

async function run(r: Rig, action: Scenario['action']): Promise<unknown> {
  const status = await r.hooks.status();
  return r.hooks.set(action !== 'off', { preview: status.plans[action]?.preview ?? '' });
}

describe('a process that dies after any step', () => {
  it('keeps a complete original backup when enable is retried after interrupted backup creation', async () => {
    const probe = await fresh();
    const { steps } = await recorded(() => run(probe, 'on'));
    const backup = `${probe.settings}${BACKUP_SUFFIX}`;
    // (the copy is made in a temp beside the final name and published whole: its first step is the create of that temp)
    const createdAt = steps.findIndex(
      (step) =>
        step.op === 'create' &&
        (step.path === backup || basename(step.path).startsWith(`.${basename(backup)}.`)),
    );
    expect(createdAt).toBeGreaterThanOrEqual(0);

    const r = await fresh();
    const { crashed } = await crashedAfter(createdAt + 1, () => run(r, 'on'));
    expect(crashed).toBe(true);
    expect(read(r.settings)).toBe(original);

    const next = r.another();
    const preview = (await next.status()).plans.on?.preview;
    const result = await next.set(true, { preview });
    expect(result.state).toBe('on');
    expect(read(`${r.settings}${BACKUP_SUFFIX}`)).toBe(original);
  });

  /** The steps that make the one-time copy: its temp and its publication under the final name. */
  const backupSteps = (
    steps: { op: string; path: string; to?: string | undefined }[],
    name: string,
  ) =>
    steps.flatMap((step, i) =>
      [step.path, step.to].some((path) => path !== undefined && basename(path).includes(name))
        ? [i + 1]
        : [],
    );

  it('never has the final backup name in an incomplete state, after any step of making it', async () => {
    const probe = await fresh();
    const name = basename(`${probe.settings}${BACKUP_SUFFIX}`);
    const { steps } = await recorded(() => run(probe, 'on'));
    const ours = backupSteps(steps, name);
    // create, chmod, write of the temp; the link; the removal of the temp
    expect(ours.length).toBeGreaterThanOrEqual(5);

    for (const after of ours) {
      const r = await fresh();
      const backup = `${r.settings}${BACKUP_SUFFIX}`;
      const { crashed } = await crashedAfter(after, () => run(r, 'on'));
      expect(crashed, `step ${after}`).toBe(true);
      // The final name is absent, or holds the whole original: never empty, never part of it.
      if (existsSync(backup)) expect(read(backup), `step ${after}`).toBe(original);
      expect(read(r.settings), `step ${after}`).toBe(original);

      // A fresh instance finishes the job (a complete copy), or refuses; here it must finish.
      const next = r.another();
      const preview = (await next.status()).plans.on?.preview;
      expect((await next.set(true, { preview })).state, `step ${after}`).toBe('on');
      expect(read(backup), `step ${after}`).toBe(original);
      expect(entries(read(r.settings)), `step ${after}`).toBe(5);
    }
  });

  it('sweeps the backup temps of processes that are gone, and only those', async () => {
    const r = await fresh();
    const dead = `${r.config}/.settings.json${BACKUP_SUFFIX}.99999999-deadbeef.tmp`;
    const mine = `${r.config}/.settings.json${BACKUP_SUFFIX}.${process.pid}-deadbeef.tmp`;
    writeFileSync(dead, '{"partial":');
    writeFileSync(mine, '{"partial":');
    await r.hooks.set(true);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(readdirSync(r.config).filter((name) => name.endsWith('.tmp'))).toEqual([basename(mine)]);
    expect(read(`${r.settings}${BACKUP_SUFFIX}`)).toBe(original);
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: no file HQ made ever stands under its final name incomplete, after any step`, async () => {
      const probe = await scenario.build();
      const { steps } = await recorded(() => run(probe, scenario.action));
      const shipped = readFileSync(ASSET, 'utf8');
      for (let after = 1; after <= steps.length; after += 1) {
        const r = await scenario.build();
        await crashedAfter(after, () => run(r, scenario.action));
        const where = `${scenario.name}, after step ${after} of ${steps.length}`;
        const backup = `${r.settings}${BACKUP_SUFFIX}`;
        // the copy: whole or absent
        if (existsSync(backup)) expect(read(backup), where).toBe(original);
        // the script: the shipped bytes, or (while it is being repaired) the bytes it had; never part of either
        if (existsSync(r.hooks.paths.script)) {
          const script = read(r.hooks.paths.script);
          expect(
            script === shipped || script.startsWith('// Agent Productivity: the Claude Code hook'),
            where,
          ).toBe(true);
          if (script !== shipped) expect(script, where).toContain('(edited)');
        }
        // the registry: one whole record
        if (existsSync(r.hooks.paths.registry))
          expect(JSON.parse(read(r.hooks.paths.registry)), where).toMatchObject({ v: 1 });
        // the settings: whole JSON, with none or all of HQ's entries
        expect([0, 5], where).toContain(entries(read(r.settings)));
        expect(() => JSON.parse(read(r.settings)), where).not.toThrow();
      }
    });
  }

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: the next status is honest and the opposite action leaves it clean`, async () => {
      const probe = await scenario.build();
      const { steps } = await recorded(() => run(probe, scenario.action) as Promise<unknown>);
      expect(steps.length).toBeGreaterThan(3);

      for (let after = 1; after <= steps.length; after += 1) {
        const r = await scenario.build();
        const mode = statSync(r.settings).mode & 0o7777;
        const { crashed } = await crashedAfter(after, () => run(r, scenario.action));
        expect(crashed, `step ${after}`).toBe(true);

        // A restarted process: a new instance over the same folders, not yet listening.
        const next = r.another();
        const text = read(r.settings);
        const where = `${scenario.name}, after step ${after} of ${steps.length}`;
        expect(() => JSON.parse(text), where).not.toThrow();
        expect([0, 5], where).toContain(entries(text));
        expect(statSync(r.settings).mode & 0o7777, where).toBe(mode);

        const status = await next.status();
        expect(status.state, where).not.toBe('unavailable');
        if (status.state === 'on') {
          expect(entries(text), where).toBe(5);
          expect(existsSync(r.hooks.paths.script), where).toBe(true);
        }
        if (status.state === 'off') expect(entries(text), where).toBe(0);
        if (status.state === 'needs_repair') expect(entries(text), where).toBeGreaterThan(0);
        if (status.state === 'off' && existsSync(r.hooks.paths.script))
          expect(status.leftover?.items, where).toContain('script');

        // The opposite action (turning off, or turning on again after a removal) leaves it clean.
        if (scenario.action === 'off') {
          const back = await next.set(true);
          expect(back.state, where).toBe('on');
          expect(entries(read(r.settings)), where).toBe(5);
        } else {
          const back = await next.set(false);
          expect(back, where).toMatchObject({ state: 'off', reason: null, leftover: null });
          expect(read(r.settings), where).toBe(original);
          expect(existsSync(r.hooks.paths.script), where).toBe(false);
          expect(existsSync(r.hooks.paths.registry), where).toBe(false);
        }
      }
    });
  }
});
