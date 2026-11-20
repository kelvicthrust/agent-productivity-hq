import { describe, expect, it } from 'vitest';
import { readBootstrapRows } from '../../src/server/db/queries/bootstrap.ts';
import { getMeta, setMeta } from '../../src/server/db/queries/meta.ts';
import { completeSetup, readSetupState } from '../../src/server/db/queries/setup.ts';
import { memoryDb } from '../server/helpers.ts';

// The SQL half of first-launch setup (G10_1; TECH J1; local-api › POST /api/setup/complete): setup is done only when Finish says
// so, finishing with nothing connected and nothing tracked is allowed, the date and the report timezone are written together or
// not at all, and a repeat changes nothing. Nothing else is stored by setup.

const T0 = Date.parse('2026-11-04T17:42:00Z');
const TZ = 'America/Los_Angeles';

describe('reading the setup state', () => {
  it('is not complete on a fresh database, and the bootstrap rows agree', () => {
    const db = memoryDb();
    expect(readSetupState(db)).toEqual({ complete: false, completedAt: null });
    expect(readBootstrapRows(db).setupComplete).toBe(false);
  });

  it('is complete once the key holds a value, and reads the time when the value is a time', () => {
    const db = memoryDb();
    setMeta(db, 'setup_completed_at', String(T0));
    expect(readSetupState(db)).toEqual({ complete: true, completedAt: T0 });
    expect(readBootstrapRows(db).setupComplete).toBe(true);
  });

  it('still says complete when the stored value is not a time (a seeded world wrote one), with no time', () => {
    const db = memoryDb();
    setMeta(db, 'setup_completed_at', 'not-a-time');
    expect(readSetupState(db)).toEqual({ complete: true, completedAt: null });
    setMeta(db, 'setup_completed_at', '-5');
    expect(readSetupState(db)).toEqual({ complete: true, completedAt: null });
  });
});

describe('finishing setup', () => {
  it('marks it complete and stores the timezone, with nothing connected and nothing tracked', () => {
    const db = memoryDb();
    expect(completeSetup(db, { at: T0, timezone: TZ })).toEqual({ firstTime: true });
    expect(readSetupState(db)).toEqual({ complete: true, completedAt: T0 });
    expect(getMeta(db, 'report_timezone')).toBe(TZ);
    expect(readBootstrapRows(db).setupComplete).toBe(true);
    // Nothing else was needed or written: no repo, no source row, no run.
    expect(db.prepare('SELECT COUNT(*) AS n FROM repo').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM refresh_run').get()).toEqual({ n: 0 });
  });

  it('writes the date and the timezone together or not at all (one transaction)', () => {
    const db = memoryDb();
    // The timezone write fails, so the completion date written just before it must be rolled back with it.
    db.exec(
      "CREATE TRIGGER no_timezone BEFORE INSERT ON app_meta WHEN NEW.key = 'report_timezone' " +
        "BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    expect(() => completeSetup(db, { at: T0, timezone: TZ })).toThrow('refused');
    expect(readSetupState(db)).toEqual({ complete: false, completedAt: null });
    expect(getMeta(db, 'report_timezone')).toBeNull();
    expect(db.isTransaction).toBe(false);
  });

  it('is a repeat the second time: the date stays the first one, so the caller starts one run and no more', () => {
    const db = memoryDb();
    expect(completeSetup(db, { at: T0, timezone: TZ }).firstTime).toBe(true);
    expect(completeSetup(db, { at: T0 + 60_000, timezone: TZ })).toEqual({ firstTime: false });
    expect(readSetupState(db)).toEqual({ complete: true, completedAt: T0 });
  });

  it('keeps the timezone up to date on a repeat, because it is the machine’s own', () => {
    const db = memoryDb();
    completeSetup(db, { at: T0, timezone: TZ });
    expect(completeSetup(db, { at: T0 + 1, timezone: 'Europe/Berlin' }).firstTime).toBe(false);
    expect(getMeta(db, 'report_timezone')).toBe('Europe/Berlin');
    expect(readSetupState(db).completedAt).toBe(T0);
  });

  it('does not touch what the owner connected before finishing', () => {
    const db = memoryDb();
    setMeta(db, 'github_login', 'kelvin');
    setMeta(db, 'chatgpt_connected_at', String(T0));
    completeSetup(db, { at: T0, timezone: TZ });
    expect(getMeta(db, 'github_login')).toBe('kelvin');
    expect(getMeta(db, 'chatgpt_connected_at')).toBe(String(T0));
  });
});
