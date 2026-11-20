// The numbers behind the transcript feeds (data-and-sources › Live roster (HQ) › Transcript feeds). Every timer and bound is named
// here so the state machines, the file discovery and the documentation say the same thing. All times are milliseconds.

// ---- what an inferred state means (the state machines) ------------------------------------------------------------------------

/** A turn that ended shows as `finished` for this long, then as `idle`. */
export const FINISHED_VISIBLE_MS = 60_000;
/** A session whose conversation has been silent this long, with no tool call waiting, is `idle`. */
export const QUIET_IDLE_MS = 120_000;
/**
 * A tool call with no result after this long, that is not a kind that runs long (a shell command, a subagent, background output), is
 * "may be waiting for you" (`waiting`, wait reason `permission`, inferred). The transcript does not record a permission prompt, so
 * this is a guess from silence: a slow tool looks the same.
 */
export const PERMISSION_GUESS_MS = 10_000;
/** A session leaves the roster after this long without activity. Bookkeeping can extend a live turn but cannot bring it back. */
export const DROP_AFTER_MS = 15 * 60_000;
/** Tool calls remembered per session while they wait for a result; the oldest is forgotten beyond this. */
export const MAX_PENDING_TOOLS = 64;

// ---- finding and reading files (per tick bounds) ------------------------------------------------------------------------------

/** How often the files are looked at while someone is looking at HQ. */
export const TRANSCRIPT_POLL_MS = 2_000;
/**
 * A feed says `starting` until its first look has found the files and read each of them once. If that has not happened this long after
 * it started (a slow disk, many large files), it reports what it has read so far instead of staying `starting` for ever.
 */
export const FIRST_READ_DEADLINE_MS = 10_000;
/** The provider roots are listed in full at most this often; between listings only tracked files and the few folders a new one would appear in are looked at. */
export const FULL_LISTING_EVERY_MS = 60_000;
/** A file must have been written within this long to be followed. */
export const RECENT_WINDOW_MS = DROP_AFTER_MS;
/** At most this many files are followed (newest first), so a busy machine cannot make a tick unbounded. */
export const MAX_TRACKED_FILES = 48;
/** The first time a file is seen only this much of its end is read (the first, probably partial, line is discarded). */
export const TAIL_WINDOW_BYTES = 256 * 1024;
/** Behind by more than this since the last read, a file is read from its end again instead of catching up. */
export const RESYNC_BEHIND_BYTES = 4 * 1024 * 1024;
/** Reading one file stops, between lines, once it has taken this many bytes in a tick (a line in progress is finished first). */
export const MAX_BYTES_PER_FILE_PER_TICK = 1024 * 1024;
/** A line longer than this is dropped unread, never held. It counts as activity and clears the session's waiting tool calls. */
export const LIVE_MAX_LINE_BYTES = 512 * 1024;
/** Codex identity (`session_meta`) is the first line of a rollout; this much of the start of the file is looked at for it. */
export const CODEX_HEAD_BYTES = 256 * 1024;
