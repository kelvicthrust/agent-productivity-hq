// A time HQ will keep (data-and-sources › Live roster (HQ) › Times). Every time that enters HQ's kept state (a transcript line's
// `timestamp`, a file's modified time, Paseo's `updatedAt`, `createdAt`, `attentionTimestamp` and `activeTurn.startedAt`) passes through
// `liveTime` first. A finite number is not enough: a JavaScript `Date` holds only +/-8.64e15 ms, a value outside that makes
// `toISOString()` throw, and a value a day or more ahead of the clock would keep an agent on the roster for ever.

/** The earliest time HQ believes: 2000-01-01T00:00:00Z. A coding agent did not exist before it, and a time of 0 or 1 is a missing one. */
export const EARLIEST_LIVE_MS = Date.UTC(2000, 0, 1);
/** How far ahead of the clock a time may be (clock skew between the writer and this process). */
export const FUTURE_SKEW_MS = 24 * 60 * 60_000;

/** `ms` when it is a whole number of milliseconds within the window HQ accepts at `now`, else null. */
export function liveTime(ms: number | null | undefined, now: number): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return ms >= EARLIEST_LIVE_MS && ms <= now + FUTURE_SKEW_MS ? Math.round(ms) : null;
}
