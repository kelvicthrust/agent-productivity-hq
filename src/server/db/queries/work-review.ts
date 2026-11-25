import type { WorkReviewVersion } from '../../../shared/contracts/work-review.ts';
import type { Db } from '../open.ts';

export interface CachedNote {
  kind: 'progress' | 'open';
  text: string;
}

export interface CachedNoteState {
  hash: string;
  sourceHash: string | null;
  partial: boolean;
}

export function readWorkNoteStates(db: Db, keys: readonly string[]): Map<string, CachedNoteState> {
  if (keys.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT unit_key, evidence_hash, source_hash, partial FROM work_review_note
      WHERE unit_key IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(keys)) as unknown as {
    unit_key: string;
    evidence_hash: string;
    source_hash: string | null;
    partial: number;
  }[];
  return new Map(
    rows.map((row) => [
      row.unit_key,
      { hash: row.evidence_hash, sourceHash: row.source_hash, partial: row.partial === 1 },
    ]),
  );
}

export function readWorkNotes(db: Db, key: string, hash: string, sourceHash: string | null) {
  const row = db
    .prepare(
      'SELECT notes_json, partial FROM work_review_note WHERE unit_key = ? AND evidence_hash = ? AND source_hash IS ?',
    )
    .get(key, hash, sourceHash);
  return row
    ? {
        notes: JSON.parse(String(row['notes_json'])) as CachedNote[],
        partial: Boolean(row['partial']),
      }
    : null;
}

export function saveWorkNotes(
  db: Db,
  key: string,
  hash: string,
  sourceHash: string | null,
  dayStart: number,
  notes: CachedNote[],
  partial: boolean,
) {
  db.prepare(
    `INSERT INTO work_review_note (unit_key, evidence_hash, source_hash, day_start, notes_json, partial)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(unit_key) DO UPDATE SET
    evidence_hash=excluded.evidence_hash, source_hash=excluded.source_hash, notes_json=excluded.notes_json,
    partial=excluded.partial, day_start=excluded.day_start`,
  ).run(key, hash, sourceHash, dayStart, JSON.stringify(notes), Number(partial));
}

export function reviewVersions(db: Db, key: string): number[] {
  return db
    .prepare('SELECT version FROM work_review_version WHERE scope_key = ? ORDER BY version DESC')
    .all(key)
    .map((row) => Number(row['version']));
}

export function readVersion(db: Db, key: string, version: number) {
  const row = db
    .prepare(
      'SELECT review_json, evidence_hash FROM work_review_version WHERE scope_key = ? AND version = ?',
    )
    .get(key, version);
  return row
    ? {
        review: JSON.parse(String(row['review_json'])) as WorkReviewVersion,
        hash: String(row['evidence_hash']),
      }
    : null;
}

export function saveVersion(
  db: Db,
  key: string,
  periodStart: number,
  hash: string,
  review: WorkReviewVersion,
) {
  db.prepare('INSERT INTO work_review_version VALUES (?, ?, ?, ?, ?)').run(
    key,
    review.version,
    periodStart,
    hash,
    JSON.stringify(review),
  );
}
