// "The disk is full", as the two places that can meet it need to know (TECH › Failure modes: Disk full — SQLITE_FULL / ENOSPC).
// Boot serves the not-enough-disk page when it cannot open or prepare the database for that reason; a refresh run that hits it fails
// with a plain sentence and Retry. Nothing is deleted to make room, and nothing here retries in a loop.

/** What a run says when the disk filled up while it was importing (TECH › Failure modes). */
export const DISK_FULL_IMPORT_MESSAGE = 'Not enough disk space to import';

/** SQLITE_FULL; extended result codes keep it in the low byte. */
const SQLITE_FULL = 13;

const FULL_WORDS = /database or disk is full|SQLITE_FULL|no space left on device|ENOSPC/i;

/** True for ENOSPC from the file system and for SQLITE_FULL from SQLite, on the error or anything it was caused by. */
export function isDiskFull(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const { code, errcode, errstr, message, cause } = current as {
      code?: unknown;
      errcode?: unknown;
      errstr?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (code === 'ENOSPC' || code === 'SQLITE_FULL') return true;
    if (typeof errcode === 'number' && (errcode & 0xff) === SQLITE_FULL) return true;
    if (typeof errstr === 'string' && FULL_WORDS.test(errstr)) return true;
    if (typeof message === 'string' && FULL_WORDS.test(message)) return true;
    current = cause;
  }
  return false;
}
