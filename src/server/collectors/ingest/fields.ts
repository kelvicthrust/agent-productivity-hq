// Small readers for the fields the adapters take from a parsed line. They return null for anything that is not what the field
// should be, so an adapter can count the line as unreadable instead of storing a guess ("a record with a missing expected field
// is counted as unreadable and not stored", data-and-sources › Field semantics).

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** A token count: a finite whole number, zero or more. Anything else (missing, negative, fractional, text) is null. */
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * A timestamp as epoch milliseconds: an ISO 8601 string with an offset, or a number (seconds when it is below 1e11, which is
 * before 1973 in milliseconds and after 5138 in seconds, so the two cannot be confused). Null when it is neither.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value < 1e11 ? value * 1000 : value);
  }
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The start an adapter gives `upsertSession` (data-and-sources › Session start time): the source's own start record when it
 * has one (basis `source_start`), otherwise the first usage event (`first_event`). Null when the session has neither.
 */
export function sessionStart(
  sourceStartMs: number | null,
  firstUsageMs: number | null,
): { startedAt: number; startedBasis: 'source_start' | 'first_event' } | null {
  if (sourceStartMs !== null) return { startedAt: sourceStartMs, startedBasis: 'source_start' };
  if (firstUsageMs !== null) return { startedAt: firstUsageMs, startedBasis: 'first_event' };
  return null;
}
