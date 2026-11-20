import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  MigrationError,
  NewerSchemaError,
  currentVersion,
  listMigrations,
  migrate,
} from '../../src/server/db/migrate.ts';
import { checkIntegrity, inTransaction, openDatabase } from '../../src/server/db/open.ts';
import {
  readLinkHealth,
  recordComputedLinksSuccess,
} from '../../src/server/db/queries/link-health.ts';
import { memoryDb, tempDir } from './helpers.ts';

const tables = (db: DatabaseSync) =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

function migrateV1(db: DatabaseSync): void {
  const dir = tempDir();
  writeFileSync(join(dir, '001_init.sql'), readFileSync(join(MIGRATIONS_DIR, '001_init.sql')));
  migrate(db, dir);
}

describe('migration 001', () => {
  it('creates every table in data-and-sources.md, all STRICT', () => {
    const doc = readFileSync(
      join(import.meta.dirname, '../../docs/tech/data-and-sources.md'),
      'utf8',
    );
    const sql = doc.slice(
      doc.indexOf('-- 001_init.sql'),
      doc.indexOf('**Field semantics and missingness:**'),
    );
    const documented = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]!).sort();
    expect(documented).toHaveLength(15);

    const db = new DatabaseSync(':memory:');
    migrateV1(db);
    expect(tables(db)).toEqual(documented);
    const strict = db.prepare('PRAGMA table_list').all() as { name: string; strict: number }[];
    for (const name of documented)
      expect(strict.find((t) => t.name === name)?.strict, name).toBe(1);
  });

  it('has the T5 columns: session.started_at/started_basis and source_state.consecutive_failures', () => {
    const db = memoryDb();
    const cols = (table: string) =>
      db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[];
    const session = cols('session');
    expect(session.find((c) => c.name === 'started_at')).toMatchObject({
      type: 'INTEGER',
      notnull: 1,
    });
    expect(session.find((c) => c.name === 'started_basis')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
    });
    expect(cols('source_state').find((c) => c.name === 'consecutive_failures')).toMatchObject({
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '0',
    });
  });

  it('enforces the documented constraints', () => {
    const db = memoryDb();
    const addSession = (basis: string, provider = 'codex') =>
      db
        .prepare(
          "INSERT INTO session (provider, provider_session_id, kind, started_at, started_basis) VALUES (?, 's1', 'root', 1, ?)",
        )
        .run(provider, basis);
    expect(() => addSession('guess')).toThrow(/CHECK/);
    expect(() => addSession('source_start', 'gemini')).toThrow(/CHECK/);
    addSession('first_event');
    expect(() => addSession('first_event')).toThrow(/UNIQUE/); // (provider, provider_session_id)
    expect(() =>
      db.prepare("INSERT INTO source_state (source_id, status) VALUES ('nope', 'ok')").run(),
    ).toThrow(/CHECK/);

    const event = (key: string) =>
      db
        .prepare(
          "INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total) VALUES ('codex', ?, 1, 5, 'm', 10)",
        )
        .run(key);
    event('k');
    expect(() => event('k')).toThrow(/UNIQUE/); // (provider, dedupe_key): re-import cannot duplicate
    expect(() =>
      db
        .prepare(
          "INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total) VALUES ('codex','z',999,1,'m',1)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO app_meta (key, value) VALUES ('x', NULL)").run()).toThrow(
      /NOT NULL/,
    );
  });

  it('records the version and is a no-op the second time', () => {
    const db = new DatabaseSync(':memory:');
    expect(currentVersion(db)).toBe(0);
    migrateV1(db);
    expect(currentVersion(db)).toBe(1);
    const migrations = listMigrations().map((item) => item.file);
    const latest = migrations.length;
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('keep', 'previously installed')").run();
    expect(migrate(db)).toEqual({ from: 1, to: latest, applied: migrations.slice(1) });
    expect(migrate(db)).toEqual({ from: latest, to: latest, applied: [] });
    expect(db.prepare("SELECT value FROM app_meta WHERE key = 'keep'").get()).toMatchObject({
      value: 'previously installed',
    });
    expect(
      db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get(),
    ).toMatchObject({ value: String(latest) });
  });
});

describe('migration 005', () => {
  it('preserves history and owner decisions, then invalidates links with the input transaction', () => {
    const dir = tempDir();
    for (const file of listMigrations().filter((migration) => migration.version <= 4)) {
      writeFileSync(join(dir, file.file), readFileSync(file.path));
    }
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, dir);
      db.exec(`
        INSERT INTO repo (id, display_name, tracking_state, access_state, added_at)
          VALUES ('owner/repo', 'owner/repo', 'active', 'ok', 0);
        INSERT INTO pull_request (node_id, repo_id, number, title, url, merged_at, head_ref)
          VALUES ('p', 'owner/repo', 1, 'One', 'https://github.com/owner/repo/pull/1', 50, 'before');
        INSERT INTO session (id, provider, provider_session_id, kind, repo_id, started_at, started_basis, last_event_at)
          VALUES (7, 'codex', 'session', 'root', 'owner/repo', 1, 'source_start', 40);
        INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total)
          VALUES ('codex', 'u', 7, 40, 'fixture', 25);
        INSERT INTO pr_session_link (pr_node_id, session_id, class, basis, computed_at)
          VALUES ('p', 7, 'suggested', 'same_repo_window', 60);
        INSERT INTO owner_link_decision (pr_node_id, session_id, decision, decided_at)
          VALUES ('p', 7, 'confirmed', 61);
      `);
      recordComputedLinksSuccess(db, 60);
      const linkInputs = listMigrations().find((migration) => migration.version === 5)!;
      writeFileSync(join(dir, linkInputs.file), readFileSync(linkInputs.path));
      expect(migrate(db, dir)).toEqual({ from: 4, to: 5, applied: ['005_link_inputs.sql'] });
      expect(readLinkHealth(db)).toEqual({
        state: 'stale',
        lastSuccessfulAt: new Date(60).toISOString(),
      });
      expect(db.prepare('SELECT provider_total FROM usage_event').get()).toEqual({
        provider_total: 25,
      });
      expect(db.prepare('SELECT number FROM pull_request').get()).toEqual({ number: 1 });
      expect(db.prepare('SELECT decision FROM owner_link_decision').get()).toEqual({
        decision: 'confirmed',
      });
      expect(db.prepare('SELECT session_id FROM pr_session_link').get()).toEqual({ session_id: 7 });

      recordComputedLinksSuccess(db, 70);
      db.exec(`
        UPDATE pull_request SET title = 'Renamed', head_ref = head_ref WHERE node_id = 'p';
        UPDATE session SET recorded_name = 'Renamed', started_at = 2 WHERE id = 7;
      `);
      expect(readLinkHealth(db).state).toBe('fresh');
      expect(() =>
        inTransaction(db, () => {
          db.exec('UPDATE session SET last_event_at = NULL WHERE id = 7');
          expect(readLinkHealth(db).state).toBe('stale');
          throw new Error('rolled back');
        }),
      ).toThrow('rolled back');
      expect(readLinkHealth(db).state).toBe('fresh');

      for (const statement of [
        "UPDATE session SET git_branch = 'changed' WHERE id = 7",
        "UPDATE pull_request SET head_ref = NULL WHERE node_id = 'p'",
        "INSERT INTO pr_commit VALUES ('p', 'abcde12')",
        "INSERT INTO session_ref VALUES (7, 'pr_url', 'owner/old#1', 20)",
        "INSERT INTO github_repo_slug VALUES ('owner/old', 'owner/repo', NULL)",
        "UPDATE github_repo_slug SET conflicted_at = 21 WHERE slug = 'owner/old'",
        'UPDATE session_ref SET observed_at = 22 WHERE session_id = 7',
        "DELETE FROM pr_commit WHERE pr_node_id = 'p'",
      ]) {
        db.exec(statement);
        expect(readLinkHealth(db).state, statement).toBe('stale');
        recordComputedLinksSuccess(db, 70);
      }
    } finally {
      db.close();
    }
  });
});

describe('migration failures never alter the database', () => {
  const withBad = (second: string) => {
    const dir = join(tempDir(), 'migrations');
    mkdirSync(dir);
    writeFileSync(join(dir, '001_init.sql'), readFileSync(join(MIGRATIONS_DIR, '001_init.sql')));
    writeFileSync(join(dir, '002_more.sql'), second);
    return dir;
  };

  it('rolls everything back and names the failing file', () => {
    const dir = withBad(
      'CREATE TABLE extra (a INTEGER) STRICT;\nINSERT INTO no_such_table VALUES (1);',
    );
    const db = new DatabaseSync(':memory:');
    let error: unknown;
    try {
      migrate(db, dir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).file).toBe(join(dir, '002_more.sql'));
    expect((error as MigrationError).version).toBe(2);
    // One transaction: even migration 001, which ran first, is not left behind.
    expect(tables(db)).toEqual([]);
    expect(currentVersion(db)).toBe(0);
  });

  it('keeps an already-migrated database intact when the next migration fails', () => {
    const dir = withBad('CREATE TABLE extra (a INTEGER) STRICT; SELECT * FROM nope;');
    const db = new DatabaseSync(':memory:');
    migrateV1(db);
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('github_login', 'kelvin')").run();
    expect(() => migrate(db, dir)).toThrow(MigrationError);
    expect(tables(db)).toContain('owner_link_decision');
    expect(tables(db)).not.toContain('extra');
    expect(currentVersion(db)).toBe(1);
    expect(db.prepare("SELECT value FROM app_meta WHERE key = 'github_login'").get()).toMatchObject(
      { value: 'kelvin' },
    );
  });

  it('applies a good second migration and records version 2', () => {
    const db = new DatabaseSync(':memory:');
    const dir = withBad('CREATE TABLE extra (a INTEGER) STRICT;');
    expect(migrate(db, dir)).toEqual({ from: 0, to: 2, applied: ['001_init.sql', '002_more.sql'] });
    expect(currentVersion(db)).toBe(2);
  });

  it('refuses a database from a newer version, without changing it', () => {
    const db = memoryDb();
    db.prepare("UPDATE app_meta SET value = '9' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).toThrow(NewerSchemaError);
    expect(currentVersion(db)).toBe(9);
  });

  it('rejects badly named or gapped migration folders', () => {
    const gap = join(tempDir(), 'm');
    mkdirSync(gap);
    writeFileSync(join(gap, '001_a.sql'), 'SELECT 1;');
    writeFileSync(join(gap, '003_c.sql'), 'SELECT 1;');
    expect(() => listMigrations(gap)).toThrow(/no gaps/);
    const named = join(tempDir(), 'm');
    mkdirSync(named);
    writeFileSync(join(named, 'init.sql'), 'SELECT 1;');
    expect(() => listMigrations(named)).toThrow(/NNN_name\.sql/);
    expect(listMigrations()[0]?.file).toBe('001_init.sql');
  });
});

describe('the database module', () => {
  it('opens in WAL with the 5 s busy timeout and foreign keys on', () => {
    const path = join(tempDir(), 'agent-productivity.db');
    const db = openDatabase(path);
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    db.close();
  });

  it('commits a transaction, and rolls one back when it throws', () => {
    const db = memoryDb();
    inTransaction(db, () => db.prepare("INSERT INTO app_meta VALUES ('a', '1')").run());
    expect(() =>
      inTransaction(db, () => {
        db.prepare("INSERT INTO app_meta VALUES ('b', '2')").run();
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(
      db.prepare('SELECT key FROM app_meta WHERE key IN (?, ?) ORDER BY key').all('a', 'b'),
    ).toEqual([{ key: 'a' }]);
  });

  it('reports a file that is not a database as damaged, and a missing or healthy one as fine', () => {
    const dir = tempDir();
    expect(checkIntegrity(join(dir, 'missing.db'))).toEqual({ ok: true });
    const good = join(dir, 'good.db');
    openDatabase(good).close();
    expect(checkIntegrity(good)).toEqual({ ok: true });
    const bad = join(dir, 'bad.db');
    writeFileSync(bad, 'this is not a sqlite database, it is just some text '.repeat(40));
    expect(checkIntegrity(bad)).toMatchObject({ ok: false });
  });
});

describe('SQL stays inside src/server/db', () => {
  it('has no database access, node:sqlite import or SQL statement outside that folder', () => {
    const root = join(import.meta.dirname, '../../src/server');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (path !== join(root, 'db')) walk(path);
        } else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(path, 'utf8');
          if (
            /node:sqlite|\.prepare\(|\.exec\(|\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b\s+[\w*(]/.test(
              text,
            )
          ) {
            offenders.push(path.slice(root.length + 1));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
