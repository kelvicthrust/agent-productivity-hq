import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { abortError } from '../../lib/abortable.ts';
import { HEAD_BYTES, LineReader, type ListedFile } from '../ingest/index.ts';
import { createOpenFiles, streamOf, type Guard, type OpenFiles } from './confined.ts';
import {
  LIVE_MAX_LINE_BYTES,
  MAX_BYTES_PER_FILE_PER_TICK,
  RESYNC_BEHIND_BYTES,
  TAIL_WINDOW_BYTES,
} from './heuristics.ts';

// Reading the end of a transcript, in memory (data-and-sources › Live roster (HQ) › Transcript feeds › Reading). Nothing is written.
//
//  - The first time a file is seen only its last `TAIL_WINDOW_BYTES` are read. Whether the window starts in the middle of a line is
//    decided by the byte before it (`alignedStart`): a newline there means the window starts on a line, and nothing is discarded;
//    anything else, and everything up to and including the first newline of the window is discarded. A window with no newline at all
//    consumes nothing and waits (`unaligned`). A file shorter than the window is read from its start. The first non-empty record is
//    never the signal: a window can start exactly at a newline, and its only complete record must be kept.
//  - Afterwards only what was appended is read, from the end of the last complete line. A trailing line with no newline is taken
//    only when it is complete JSON (`LineReader`); otherwise it is left for the next read.
//  - A file that is now shorter than what was read, or whose first bytes changed, was replaced (`planRead`): it is read again from
//    its end, and the caller starts the session over (`reset`). A file that has grown more than `RESYNC_BEHIND_BYTES` since the last read
//    is read from its end too, but its session carries on (`skipped`: it is told lines went unread, like a dropped long line): catching
//    up on a flood is not worth it, the recent end is what shows what the session is doing now.
//  - One read takes at most `MAX_BYTES_PER_FILE_PER_TICK` of the file, counted in bytes consumed: every complete line counts, whether it
//    was handed over, dropped for its length or empty (the reader's `stopAfterBytes`). It stops between lines (a line in progress is
//    finished), and the file is read only up to the size it had when it was looked at, so a file that keeps growing cannot hold the loop.
//  - The file is opened once per read, safely (`openWithin`: the containment rule of `confined.ts`, a regular file, the file that was
//    listed) and everything after, including the head hash, is read through that one handle. The handle is opened through the feed's
//    `OpenFiles`, so a stop can close it and wait for the close.
//  - A line longer than `LIVE_MAX_LINE_BYTES` is dropped by the reader without being held; `onOverlong` is told, in order, before the
//    next line.
// Errors are the file system's own and carry no text; this module logs nothing.

/** What is remembered about a file between reads: where the next read starts, and enough to tell it was replaced. */
export interface TailState {
  /** The byte after the last complete line read. */
  offset: number;
  size: number;
  mtimeMs: number;
  /** sha256 of the first `min(size, 4 KiB)` bytes the file had when it was read. */
  head: string;
  /** `offset` is in the middle of a line that has no newline yet (a first sight whose window held none): the next read aligns again. */
  unaligned?: true;
}

export interface TailOutcome {
  state: TailState;
  /** The file is new to the reader or was replaced: whatever was kept about the session before this read must be started over. */
  reset: boolean;
}

/** What the caller is told before the first line of a read. */
export interface TailStart {
  /** As `TailOutcome.reset`. */
  reset: boolean;
  /** The reader fell behind and jumped to the end of the file: lines were not read, so the session saw activity it knows nothing about. */
  skipped: boolean;
}

export interface TailHandlers {
  /** Called once before the first line, and not at all when the file is as it was. */
  begin(start: TailStart): void | Promise<void>;
  line(text: string): void;
  overlong(): void;
}

/** The first `min(size, HEAD_BYTES)` bytes' sha256, as `headHash` of the shared reader, but read through an open handle. */
async function headOf(handle: FileHandle, size: number): Promise<string> {
  const length = Math.min(size, HEAD_BYTES);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, 0);
  return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
}

/**
 * Where the first line to read starts, for a read that begins at `from` which may be in the middle of a line: `from` when the byte before
 * it is a newline (or `from` is 0), else the byte after the window's first newline; null when the window (up to `size`) has no newline.
 */
async function alignedStart(
  handle: FileHandle,
  from: number,
  size: number,
): Promise<number | null> {
  if (from <= 0) return from;
  const chunk = Buffer.alloc(64 * 1024 + 1);
  let at = from - 1; // the byte before the window, then the window
  while (at < size) {
    const length = Math.min(chunk.length, size - at);
    const { bytesRead } = await handle.read(chunk, 0, length, at);
    if (bytesRead === 0) return null; // shorter than it was listed: nothing more to find
    const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
    if (newline !== -1) return at + newline + 1;
    at += bytesRead;
  }
  return null;
}

/** What `tailFile` reads: a file as just listed, with what is needed to open it safely (absent only in a test's own folder). */
export type TailTarget = ListedFile & { guard?: Guard | undefined };

/**
 * Reads what is new in `file` (as just listed) and hands each line to `handlers`. Returns the state to remember, or `null` when
 * nothing was read (the file is as it was). Rejects with the file system's error (`ENOENT` when the file has gone) or with an
 * AbortError when `signal` aborts; either way the stream is closed.
 */
export async function tailFile(
  file: TailTarget,
  prior: TailState | null,
  handlers: TailHandlers,
  signal: AbortSignal,
  files: OpenFiles = createOpenFiles(),
): Promise<TailOutcome | null> {
  // Unchanged and read to its end: nothing to do, and no reason to open it. Unchanged but not read to its end (the last read stopped at
  // its byte limit, or a trailing line was still being written): carry on from the offset.
  const unchanged = prior !== null && prior.size === file.size && prior.mtimeMs === file.mtimeMs;
  if (prior !== null && unchanged && prior.offset >= prior.size) return null;

  const opened = await files.open(file);
  const handle = opened.handle;
  try {
    let from: number;
    // Whether `from` may be in the middle of a line: a window cut from the end of a file, or a start that is still looking for its
    // first line. A resume from the end of a complete line never is.
    let mayBeCut = false;
    let reset = false;
    let skipped = false;
    const tailStart = Math.max(0, file.size - TAIL_WINDOW_BYTES);

    if (prior === null) {
      from = tailStart;
      mayBeCut = tailStart > 0;
      reset = true;
    } else {
      // Shorter than what was read, or the first bytes it had are different: replaced. Otherwise it was appended to.
      const replaced =
        !unchanged &&
        (file.size < prior.offset || (await headOf(handle, prior.size)) !== prior.head);
      const resume = replaced ? null : prior.offset;
      if (resume !== null && file.size - resume <= RESYNC_BEHIND_BYTES) {
        from = resume;
        mayBeCut = prior.unaligned === true;
      } else {
        from = tailStart;
        mayBeCut = tailStart > 0;
        // Behind (not replaced): the session carries on, told that lines went unread. Otherwise it is a new or replaced file.
        if (resume !== null) skipped = true;
        else reset = true;
      }
    }

    // Where the first complete line starts: decided by the byte before the window, not by what the first record looks like.
    const start = mayBeCut ? await alignedStart(handle, from, file.size) : from;
    await handlers.begin({ reset, skipped });
    let offset = start ?? from;
    if (start !== null && file.size > start) {
      // The handle stays open after the stream: it is read again for the head hash, and closed below.
      const { stream, release } = streamOf(
        handle,
        { start, end: file.size - 1, highWaterMark: 64 * 1024 },
        signal,
      );
      const reader = new LineReader(stream, {
        from: start,
        maxLineBytes: LIVE_MAX_LINE_BYTES,
        stopAfterBytes: MAX_BYTES_PER_FILE_PER_TICK,
      });
      let overlong = 0;
      try {
        for await (const text of reader.lines()) {
          // A chunk already read is handed over line by line: an abort ends the read at the next line, not at the end of the chunk.
          if (signal.aborted) throw abortError();
          while (overlong < reader.overlong) {
            overlong += 1;
            handlers.overlong();
          }
          handlers.line(text);
        }
      } finally {
        release();
      }
      while (overlong < reader.overlong) {
        overlong += 1;
        handlers.overlong();
      }
      offset = reader.endOffset;
    }

    return {
      reset,
      state: {
        offset,
        size: file.size,
        mtimeMs: file.mtimeMs,
        head: await headOf(handle, file.size),
        ...(start === null ? { unaligned: true as const } : {}),
      },
    };
  } finally {
    await opened.close();
  }
}
