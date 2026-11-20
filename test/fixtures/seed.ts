import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/server/db/migrate.ts';
import { openDatabase } from '../../src/server/db/open.ts';
import { ensureDir } from '../../src/server/lib/fsModes.ts';
import { assignTypicalEventCounts } from './world/events.ts';
import { generateTypical } from './world/typical.ts';
import { generateYear } from './world/year.ts';
import { SCENARIOS, writeWorld, type Scenario } from './world/write.ts';
import type { World } from './world/types.ts';

// The D3/D4 fixture world written into a temporary SQLite database, deterministically: the same options always give the
// same rows. Everything here is synthetic. The clock is fixed and the zone is America/Los_Angeles, so a screen rendered
// from this database is the same on every machine and every day.
//
// This file lives under test/ and is never imported by src/. Run it directly:
//   node test/fixtures/seed.ts --db <file> [--scale typical|year] [--scenario typical|refresh-failed|no-repos|account-only|empty]

/** "Today, 9:42 AM" in Los Angeles on Wednesday 4 November 2026. */
export const FIXED_NOW = Date.parse('2026-11-04T17:42:00Z');
export const FIXED_TIMEZONE = 'America/Los_Angeles';
export const SEED_MARKER = 'synthetic-fixture-world';
/** The note the preview shows on every page. */
export const PREVIEW_LABEL = 'Synthetic preview data';

export type Scale = 'typical' | 'year';
export interface SeedOptions {
  scale?: Scale;
  scenario?: Scenario;
}
export interface SeedSummary {
  scale: Scale;
  scenario: Scenario;
  now: string;
  timezone: string;
  counts: Record<string, number>;
}

/** Builds the world in memory (no database). Exposed for the prototype-parity test. */
export function buildWorld(scale: Scale = 'typical'): World {
  const world = scale === 'year' ? generateYear() : generateTypical();
  if (scale === 'typical') assignTypicalEventCounts(world);
  return world;
}

/** Writes the world into a database that is already migrated and empty. */
export function seedDatabase(db: DatabaseSync, options: SeedOptions = {}): SeedSummary {
  const scale = options.scale ?? 'typical';
  const scenario = options.scenario ?? 'typical';
  const counts = writeWorld(db, buildWorld(scale), { scenario, now: FIXED_NOW });
  return {
    scale,
    scenario,
    now: new Date(FIXED_NOW).toISOString(),
    timezone: FIXED_TIMEZONE,
    counts,
  };
}

/** True when the file does not exist, or is a database this seed wrote earlier. A real database is never replaced. */
export function isReplaceable(path: string): boolean {
  if (!existsSync(path)) return true;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'seed_marker'").get() as
      { value: string } | undefined;
    return row?.value === SEED_MARKER;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Creates (or recreates) the database at `path` with the seeded world. Refuses to touch a file that is not a database this
 * seed wrote, so pointing it at real data fails instead of destroying it.
 */
export function seedFile(path: string, options: SeedOptions = {}): SeedSummary {
  const target = resolve(path);
  if (!isReplaceable(target)) {
    throw new Error(`Refusing to overwrite ${target}: it is not a database written by this seed.`);
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(target + suffix, { force: true });
  ensureDir(dirname(target));
  const db = openDatabase(target);
  try {
    migrate(db);
    return seedDatabase(db, options);
  } finally {
    db.close();
  }
}

function parseArgs(argv: string[]): { db?: string; scale?: Scale; scenario?: Scenario } {
  const out: { db?: string; scale?: Scale; scenario?: Scenario } = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split('=', 2) as [string, string | undefined];
    const value = () => inline ?? argv[++i];
    if (flag === '--db') out.db = value()!;
    else if (flag === '--scale') {
      const v = value();
      if (v !== 'typical' && v !== 'year')
        throw new Error(`--scale must be typical or year, got "${v}".`);
      out.scale = v;
    } else if (flag === '--scenario') {
      const v = value() as Scenario;
      if (!SCENARIOS.includes(v))
        throw new Error(`--scenario must be one of ${SCENARIOS.join(', ')}, got "${v}".`);
      out.scenario = v;
    } else throw new Error(`Unknown option ${flag}. Use --db, --scale or --scenario.`);
  }
  return out;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const dataDir = process.env['AGENT_PRODUCTIVITY_DATA_DIR'];
    const db = args.db ?? (dataDir ? resolve(dataDir, 'agent-productivity.db') : undefined);
    if (!db)
      throw new Error(
        'Give --db <file> (or set AGENT_PRODUCTIVITY_DATA_DIR). The seed never picks the real app data folder.',
      );
    const summary = seedFile(db, args);
    console.log(`Seeded ${db}\n${JSON.stringify(summary, null, 2)}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
