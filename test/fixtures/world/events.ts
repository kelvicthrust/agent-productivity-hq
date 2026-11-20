import { rng } from './rng.ts';
import type { World, WorldSession } from './types.ts';

/** Gives each session of the typical world 2 to 7 events, from a stream of its own so the world itself is untouched. */
export function assignTypicalEventCounts(world: World): void {
  const r = rng(424242);
  for (const session of world.sessions) session.events = 2 + Math.floor(r() * 6);
}

/**
 * Splits `x` into `n` non-negative integer parts that add up to `x`, in shares given by `cumulative` (rising from 0 to 1).
 * Using one cumulative shape for every category keeps related categories (input and cached input) in proportion.
 */
export function splitInteger(x: number, cumulative: readonly number[]): number[] {
  const parts: number[] = [];
  let before = 0;
  for (const c of cumulative) {
    const upto = Math.round(x * c);
    parts.push(upto - before);
    before = upto;
  }
  return parts;
}

/** Cumulative shares for `n` events with random positive weights. */
export function shares(n: number, r: () => number): number[] {
  const weights = Array.from({ length: n }, () => 0.2 + r());
  const sum = weights.reduce((a, b) => a + b, 0);
  let run = 0;
  const out = weights.map((w) => (run += w / sum));
  out[n - 1] = 1;
  return out;
}

/** True when a session carries Codex categories. */
export const isCodex = (s: WorldSession): boolean => s.provider === 'codex';
