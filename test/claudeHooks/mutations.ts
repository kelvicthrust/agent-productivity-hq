import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  watchMutations,
  type Mutation,
} from '../../src/server/integrations/claudeHooks/fsguard.ts';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import type { ClaudeHooksPlan } from '../../src/shared/contracts/hq.ts';
import type { Rig } from './helpers.ts';

// A recorder of every step the hook integration makes on the file system (fsguard.ts is the only module that does), and a crash: after a
// chosen step the "process" is dead, so that every later step throws before it touches anything and nothing cleans up after it.

export interface Step {
  op: Mutation['op'];
  path: string;
  to?: string | undefined;
}

export async function recorded<T>(run: () => Promise<T>): Promise<{ steps: Step[]; result: T }> {
  const steps: Step[] = [];
  const stop = watchMutations((mutation, phase) => {
    if (phase === 'after') steps.push({ op: mutation.op, path: mutation.path, to: mutation.to });
  });
  try {
    return { steps, result: await run() };
  } finally {
    stop();
  }
}

/** Runs `run` and ends the "process" right after step number `after` (1-based): every later step throws before it happens. */
export async function crashedAfter(
  after: number,
  run: () => Promise<unknown>,
): Promise<{ steps: number; crashed: boolean }> {
  let count = 0;
  let dead = false;
  const stop = watchMutations((_, phase) => {
    if (phase === 'before' && dead) throw new Error('the process is dead');
    if (phase === 'after') {
      count += 1;
      if (count === after) dead = true;
    }
  });
  try {
    await run();
  } catch {
    // whatever the code made of the dead process, the disk is what it is
  } finally {
    stop();
  }
  return { steps: count, crashed: dead };
}

/** A path as the plan names it (`~/…` under the home folder), on disk. */
const expand = (path: string, rig: Rig): string => {
  const full = path.startsWith('~') ? join(rig.home, path.slice(1)) : path;
  return join(realpathSync(dirname(full)), basename(full));
};

/** The path with its folder resolved (a path the app made from the data folder, and one it resolved, are then the same). */
const canon = (path: string): string => {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
};

const isTemp = (path: string): boolean => /^\.(.+)\.\d+-[0-9a-f]{8}\.tmp$/.test(basename(path));

/** What a step is, for comparing with a plan: the file that ends up written, replaced or deleted. Temp files are the means, not the end. */
export function rolesOf(steps: readonly Step[], rig: Rig): string[] {
  const data = realpathSync(rig.data);
  const hooksDir = join(data, 'claude-hooks');
  const roles = new Set<string>();
  const name = (path: string): string | null => {
    if (isTemp(path)) return null;
    if (path.endsWith(BACKUP_SUFFIX)) return `backup:${path}`;
    if (dirname(path) === hooksDir) return `own:${basename(path)}`;
    if (path === data || path === hooksDir) return null;
    return `settings:${path}`;
  };
  for (const step of steps) {
    // For a rename or a link the end is the destination; for the rest it is the path itself.
    const end = canon(step.op === 'rename' || step.op === 'link' ? step.to! : step.path);
    const role = name(end);
    if (role === null) continue;
    if (step.op === 'create' || step.op === 'write' || step.op === 'chmod') {
      // a create or write of a non-temp path: a backup copy, or a file written in place
      if (role.startsWith('backup:') || role.startsWith('settings:') || role.startsWith('own:'))
        roles.add(role);
    } else roles.add(role);
  }
  return [...roles].sort();
}

/** What a plan says is written: its settings files, the one-time copies it makes, and HQ's own files. */
export function plannedRoles(
  plan: ClaudeHooksPlan,
  rig: Rig,
  backupsExisting: (settings: string) => boolean,
): string[] {
  const roles = new Set<string>();
  for (const file of plan.files) {
    const target = expand(file.path, rig);
    roles.add(`settings:${target}`);
    if (file.exists && !backupsExisting(target)) roles.add(`backup:${target}${BACKUP_SUFFIX}`);
  }
  for (const own of plan.ownFiles)
    roles.add(`own:${own === 'script' ? 'agent-productivity-hook.mjs' : 'registry.json'}`);
  return [...roles].sort();
}

/** One step as a short line, with temp files named by what they are beside: for pinning an order. */
export function describeStep(step: Step): string {
  const label = (path: string): string => {
    const match = basename(path).match(/^\.(.+)\.\d+-[0-9a-f]{8}\.tmp$/);
    return match ? `tmp(${match[1]})` : basename(path);
  };
  return step.to === undefined
    ? `${step.op} ${label(step.path)}`
    : `${step.op} ${label(step.path)} -> ${label(step.to)}`;
}
