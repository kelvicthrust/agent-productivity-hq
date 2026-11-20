import type { Db } from '../db/open.ts';
import type { Logger } from '../lib/logger.ts';

// What a source adapter looks like to the refresh runner (TECH › Refresh run state machine). The runner decides WHEN and
// in what order a source runs and what the run shows; an adapter decides WHAT happened to its source. The real adapters
// (Codex, Claude Code, Paseo, GitHub, ChatGPT) implement this in their own folders; tests use the scripted adapters under
// test/fixtures/scripted-adapters, which src/ never imports.

/**
 * The stages of a run, in order. Sources inside a stage run in parallel; a stage starts when the one before it has
 * finished, because Paseo enrichment needs the sessions Codex and Claude Code just imported, and so on down the list.
 * The ids are the ones `POST /api/refresh` accepts (`RefreshRequest` in shared/contracts/sources.ts).
 */
export const REFRESH_STAGES = [
  ['codex', 'claude'],
  ['paseo'],
  ['github'],
  ['chatgpt_account'],
] as const;

export type RefreshSourceId = (typeof REFRESH_STAGES)[number][number];

export const REFRESH_SOURCE_IDS: readonly RefreshSourceId[] = REFRESH_STAGES.flat();

/** Why a run started: the Refresh or Retry button, the 15-minute timer, or the end of setup. */
export type RefreshTrigger = 'manual' | 'scheduler' | 'setup';

/** How far an import has got: `done` of `total` files (a file counts once it is committed). */
export interface ImportProgress {
  done: number;
  total: number;
}

/** What an adapter is given for one attempt. */
export interface AdapterContext {
  db: Db;
  /** The app's clock (epoch ms), so a fixed clock in tests and the seeded preview reaches the adapter too. */
  now: () => number;
  logger: Logger;
  /**
   * Tells the run how far this attempt has got (the first full import shows "Importing 42 of 380 files" on Sources).
   * Cheap to call after every file: the runner keeps the latest figure and writes the run row at most a few times a second.
   * Call it once with `done: 0` as soon as the number of files to read is known; nothing needs to be said when there is
   * nothing to read. The run shows the figure only while the source is running.
   */
  progress: (progress: ImportProgress) => void;
}

/** Counts and facts an attempt reports, whatever its result. All optional: an adapter reports what it knows. */
export interface AttemptDetails {
  /** New records written. Shown as "N new sessions imported". */
  imported?: number;
  /** Records seen again and skipped by their dedupe key. */
  duplicatesSkipped?: number;
  /** Records that could not be read (the "Partial · N unreadable" tally). */
  unreadable?: number;
  /** Records in a shape this adapter does not support. */
  unsupported?: number;
  /**
   * One plain sentence about the attempt, shown on the run and, after a failure, on Sources. Never file content, a path
   * you did not choose, a token or a prompt (P-31): the runner stores it as given.
   */
  message?: string | null;
  /**
   * The status the source has after this attempt: ok, partial, failed, notfound, denied, notrunning or needspassword.
   * Defaults to ok, partial or failed from the result. A failed attempt can say why more precisely (for example `denied`).
   */
  status?: string;
  /** Where the source was found (a path or URL shown in mono). */
  location?: string | null;
  /** The oldest event the source holds (epoch ms). */
  oldestEventAt?: number | null;
  /** A short machine code for a failure, for example `unrecognized_format`. */
  errorCode?: string | null;
  /** The plain sentence Sources shows under a failed source. */
  errorDetail?: string | null;
  adapterVersion?: string | null;
}

/**
 * How an attempt ended.
 *   succeeded / partial / failed  the attempt ran; the runner records it (last_attempt_*, consecutive_failures) in one
 *                                 transaction.
 *   skipped                       there was nothing to attempt: not found, not connected, not running. Nothing is
 *                                 recorded, so a skipped source never changes `consecutive_failures`.
 */
export type AdapterReport =
  | ({ result: 'succeeded' | 'partial' | 'failed' } & AttemptDetails)
  | { result: 'skipped'; message?: string | null };

export interface SourceAdapter {
  readonly id: RefreshSourceId;
  /**
   * One incremental refresh. Imports are incremental and deduplicated, so running again after a failure is safe. A
   * rejection is treated as a failed attempt with a generic message (the error itself is logged, redacted), so an
   * adapter should classify what it can and return a report instead of throwing.
   */
  refresh(context: AdapterContext): Promise<AdapterReport>;
}
