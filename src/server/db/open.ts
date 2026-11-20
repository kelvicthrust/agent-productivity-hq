import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, basename } from 'node:path';
import { ensureFile, hardenFiles } from '../lib/fsModes.ts';

// The only place a SQLite connection is opened. `node:sqlite` is imported only inside src/server/db (ESLint enforces it,
// and the HTTP, service and lifecycle layers call typed functions from ./queries). One writer: this process.

export type Db = DatabaseSync;

export const BUSY_TIMEOUT_MS = 5000;

/** A separate database whose uncommitted write transaction grants ownership of the data directory. */
export function tryDirectoryLock(path: string): Db | null {
  ensureFile(path);
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec('BEGIN IMMEDIATE');
    return db;
  } catch (error) {
    db.close();
    // SQLite BUSY is the only error that establishes contention.
    const code = (error as { errcode?: number }).errcode;
    if (code !== undefined && (code & 0xff) === 5) return null;
    throw error;
  }
}

/**
 * Opens the database for writing: creates the file owner-only first (SQLite gives its -wal and -shm files the same mode),
 * then sets WAL, the busy timeout and foreign keys. Call `checkIntegrity` first on an existing file: this function
 * writes (it switches the journal mode), and a damaged file must never be written.
 */
export function openDatabase(path: string): Db {
  ensureFile(path);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  hardenFiles(dirname(path), basename(path));
  return db;
}

export type IntegrityResult = { ok: true } | { ok: false; reason: string };

/**
 * Read-only `PRAGMA quick_check` on an existing file, through a connection that cannot write, so a corrupt database is
 * left byte for byte as it was. A missing or empty file is fine: it is a new database.
 */
export function checkIntegrity(path: string): IntegrityResult {
  if (!existsSync(path)) return { ok: true };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    const first = rows[0]?.quick_check;
    return first === 'ok'
      ? { ok: true }
      : { ok: false, reason: `quick_check: ${String(first ?? 'no result').slice(0, 200)}` };
  } catch (error) {
    return { ok: false, reason: (error as Error).message.slice(0, 200) };
  } finally {
    try {
      db?.close();
    } catch {
      // nothing to close
    }
  }
}

/** Runs `fn` in one IMMEDIATE transaction: committed if it returns, rolled back if it throws. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
