import type { Bucket } from '../../../shared/contracts/series';

// The chart's keyboard model (ported from app.js's keydown handler). The chart is one tab stop; a cursor moves along its
// buckets and the readout follows it. The cursor stops at the ends rather than wrapping, as in the prototype. Nothing here
// animates: the cursor jumps, and the picture moves with it.

/** Keys that move the cursor. Anything else is left to the browser (Tab, Up, Down and the page's own scrolling). */
export type MoveKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export function isMoveKey(key: string): key is MoveKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End';
}

/** Enter opens the cursor's bucket, and so does Space, as the prototype did. */
export const isSelectKey = (key: string): boolean => key === 'Enter' || key === ' ';

/** Where the cursor goes from `from` among `count` buckets. Stays inside 0..count-1. */
export function moveCursor(key: MoveKey, from: number, count: number): number {
  if (count <= 0) return 0;
  const last = count - 1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowLeft':
      return Math.max(0, Math.min(last, from) - 1);
    case 'ArrowRight':
      return Math.min(last, Math.max(0, from) + 1);
  }
}

/**
 * Where the cursor starts when the chart takes focus: the selected bucket, else the newest one that has started (the prototype's
 * `defaultBucket`), else the first.
 */
export function startingCursor(buckets: readonly Bucket[], selectedIndex: number | null): number {
  if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < buckets.length) {
    return selectedIndex;
  }
  for (let i = buckets.length - 1; i >= 0; i -= 1) {
    if (buckets[i]!.delivery !== 'future') return i;
  }
  return 0;
}
