import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, inTransaction } from './open.ts';

// Numbered SQL files (NNN_name.sql) run at boot inside ONE transaction, tracked in app_meta.schema_version. A failure
// rolls everything back and throws MigrationError naming the file, so boot can serve the recovery page; the database is
// never altered by a failed migration and never deleted.

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface Migration {
  version: number;
  file: string;
  path: string;
}

export class MigrationError extends Error {
  readonly file: string;
  readonly version: number | null;

  constructor(
    message: string,
    file: string,
    version: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MigrationError';
    this.file = file;
    this.version = version;
  }
}

/** The database was written by a newer version of the app. It is left alone. */
export class NewerSchemaError extends MigrationError {
  constructor(message: string, dir: string, version: number) {
    super(message, dir, version);
    this.name = 'NewerSchemaError';
  }
}

/** The migrations in `dir`, in order. Versions must start at 1 and have no gaps. */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const found = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match)
        throw new MigrationError(
          `Migration file name is not NNN_name.sql: ${file}`,
          join(dir, file),
          null,
        );
      return { version: Number(match[1]), file, path: join(dir, file) };
    });
  found.forEach((migration, i) => {
    if (migration.version !== i + 1) {
      throw new MigrationError(
        `Migration numbers must be 1, 2, 3 … with no gaps; found ${migration.file} at position ${i + 1}.`,
        migration.path,
        migration.version,
      );
    }
  });
  return found;
}

export function currentVersion(db: Db): number {
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'")
    .get();
  if (!table) return 0;
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

export function migrate(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
  const migrations = listMigrations(dir);
  const latest = migrations.length;
  const from = currentVersion(db);
  if (from > latest) {
    throw new NewerSchemaError(
      `This database is at schema version ${from}, newer than this app understands (${latest}). It was written by a newer version.`,
      dir,
      from,
    );
  }
  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from, applied: [] };

  let running: Migration | undefined;
  try {
    inTransaction(db, () => {
      for (const migration of pending) {
        running = migration;
        db.exec(readFileSync(migration.path, 'utf8'));
        db.prepare(
          "INSERT INTO app_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        ).run(String(migration.version));
      }
    });
  } catch (error) {
    const file = running?.path ?? dir;
    throw new MigrationError(
      `Migration ${running?.file ?? ''} failed: ${(error as Error).message.slice(0, 300)}`,
      file,
      running?.version ?? null,
      { cause: error },
    );
  }
  return { from, to: latest, applied: pending.map((m) => m.file) };
}
