import type { Db } from '../open.ts';

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Sets a key only when it has no value yet; returns the value now stored. */
export function setMetaIfMissing(db: Db, key: string, value: string): string {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(
    key,
    value,
  );
  return getMeta(db, key) ?? value;
}

export const getSchemaVersion = (db: Db): number => Number(getMeta(db, 'schema_version') ?? 0);
