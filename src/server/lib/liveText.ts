// How long a piece of text from a transcript or the daemon may be before HQ keeps it (data-and-sources › Live roster (HQ) › What is
// read from a line). A working directory in a transcript line, a title or a session id is arbitrary text from outside, and a line can be
// half a megabyte: unbounded, it would be held for every followed file and sent in every poll's answer.

/** A provider session id, an agent id or a parent's id: longer than this is not one. */
export const MAX_LIVE_ID_CHARS = 256;
/** A working directory (`PATH_MAX` is 4096 on the systems HQ runs on). */
export const MAX_LIVE_PATH_CHARS = 4096;
/** A title, a workspace name or a provider name, as shown. */
export const MAX_LIVE_TITLE_CHARS = 1000;

/** `value`, or null when it is longer than `max` (an id or a path that long is not one, and cutting it would name something else). */
export const fits = (value: string | null, max: number): string | null =>
  value !== null && value.length <= max ? value : null;

/** `value` cut to `max` characters (a title or a name, which are only shown). */
export const clipped = (value: string | null, max: number): string | null =>
  value !== null && value.length > max ? value.slice(0, max) : value;

/** A recorded label from provider metadata. */
export function liveTitle(value: unknown): string | null {
  return typeof value === 'string' ? clipped(value.trim() || null, MAX_LIVE_TITLE_CHARS) : null;
}
