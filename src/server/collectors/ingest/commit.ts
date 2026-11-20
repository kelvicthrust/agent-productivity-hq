import { inTransaction, type Db } from '../../db/open.ts';
import {
  putSourceFile,
  type SourceFileRow,
  type SourceFileState,
} from '../../db/queries/ingest.ts';
import type { ListedFile } from './files.ts';

// Committing one file (TECH › Persistence: per-file transactions). Everything a file contributes, and the offset that says it
// has been read, are written in ONE transaction, so a crash or a failure leaves the file exactly as it was and the next refresh
// reads it again from the same place; dedupe keys make the repeat harmless (P-08). The adapter parses the file first (it may
// take many turns of the event loop, and yields between batches of lines), then calls this once, synchronously.

export interface FileCommit {
  sourceId: string;
  file: ListedFile;
  /** sha256 of the file's first bytes (`headHash(path, file.size)`). */
  headHash: string;
  /** Where this read started: 0 for a new or replaced file, the stored offset for an append. */
  from: number;
  /** `LineReader.endOffset` after the read. */
  endOffset: number;
  /** The row stored before this read, if any. */
  tracked: SourceFileRow | null;
  /** Unreadable lines found in THIS read (including lines the reader dropped for being too long). */
  unreadableLines: number;
  now: number;
}

/**
 * Runs `write` (sessions and events, pointing at the file's id) and stores the file's new state in one transaction.
 * The unreadable count is the file's total: an append adds to what was stored, a read from the start replaces it.
 * `write` must not open a transaction of its own.
 */
export function commitFile(db: Db, commit: FileCommit, write: (fileId: number) => void): void {
  inTransaction(db, () => {
    const carried = commit.from > 0 ? (commit.tracked?.unreadableLines ?? 0) : 0;
    const unreadableLines = carried + commit.unreadableLines;
    const fileId = putSourceFile(db, {
      sourceId: commit.sourceId,
      path: commit.file.path,
      size: commit.file.size,
      mtimeMs: commit.file.mtimeMs,
      headHash: commit.headHash,
      readOffset: commit.endOffset,
      state: unreadableLines > 0 ? 'partial' : 'ok',
      unreadableLines,
      lastReadAt: commit.now,
    });
    write(fileId);
  });
}

/**
 * Records a file that could not be read (`unreadable`: a permission or read error, tried again next refresh) or is not in a
 * format this adapter reads (`unsupported`: skipped until it changes). Nothing else about the file is touched, so what an
 * earlier read imported stays.
 */
export function markFile(
  db: Db,
  input: {
    sourceId: string;
    file: ListedFile;
    state: Extract<SourceFileState, 'unreadable' | 'unsupported'>;
    now: number;
    tracked: SourceFileRow | null;
  },
): void {
  putSourceFile(db, {
    sourceId: input.sourceId,
    path: input.file.path,
    size: input.file.size,
    mtimeMs: input.file.mtimeMs,
    headHash: input.tracked?.headHash ?? '',
    readOffset: input.tracked?.readOffset ?? 0,
    state: input.state,
    unreadableLines: input.tracked?.unreadableLines ?? 0,
    lastReadAt: input.now,
  });
}
