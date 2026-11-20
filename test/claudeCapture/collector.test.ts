import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_ACCOUNT_MESSAGE,
  createClaudeAccountCollector,
  limitsOf,
} from '../../src/server/collectors/claudeAccount/collector.ts';
import type { AdapterContext } from '../../src/server/collectors/types.ts';
import { readAccountSnapshot, replaceRateLimits } from '../../src/server/db/queries/accounts.ts';
import { memoryDb, memoryLogger } from '../server/helpers.ts';
import {
  fixtureBytes,
  installHookFiles,
  rig,
  runHookScript,
  testSnapshotPath,
  writeSnapshotFile,
} from './helpers.ts';

// The collector turns the hook's file into percent windows, through `replaceRateLimits` and nothing else.

const CAPTURED = 1_762_419_000;
const FIVE = { used_percentage: 23.5, resets_at: 1_762_432_800 };
const SEVEN = { used_percentage: 41.2, resets_at: 1_762_857_600 };
const snapshot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  captured_at: CAPTURED,
  invoked_at: CAPTURED + 5,
  claude_version: '2.1.0',
  five_hour: FIVE,
  seven_day: SEVEN,
  ...over,
});

function setup() {
  const world = rig();
  const db = memoryDb();
  const logs = memoryLogger('debug');
  const clock = { now: (CAPTURED + 100) * 1000 };
  const context: AdapterContext = {
    db,
    now: () => clock.now,
    logger: logs.logger,
    progress: () => undefined,
  };
  const collector = createClaudeAccountCollector({
    snapshotPath: () => testSnapshotPath(world.dataDir),
  });
  return { ...world, db, logs, clock, context, collector };
}

describe('a valid snapshot', () => {
  it('stores the two windows as percent, with their own length, reset time and the snapshot’s own time', async () => {
    const t = setup();
    writeSnapshotFile(t.dataDir, snapshot());
    expect(await t.collector.refresh(t.context)).toEqual({ result: 'succeeded' });

    const stored = readAccountSnapshot(t.db, 'claude');
    expect(stored.rateLimits).toEqual([
      {
        limitId: 'five_hour',
        usedPercent: 23.5,
        windowMinutes: 300,
        resetsAt: FIVE.resets_at * 1000,
        fetchedAt: CAPTURED * 1000,
      },
      {
        limitId: 'seven_day',
        usedPercent: 41.2,
        windowMinutes: 10_080,
        resetsAt: SEVEN.resets_at * 1000,
        fetchedAt: CAPTURED * 1000,
      },
    ]);
    expect(stored.fetchedAt).toBe(CAPTURED * 1000);
    // Percentages stay percentages: no token figure is stored for the account.
    expect(stored.lifetimeTokens).toBeNull();
  });

  it('keeps the percentage as received (a card clamps what it draws)', async () => {
    const t = setup();
    writeSnapshotFile(t.dataDir, snapshot({ five_hour: { ...FIVE, used_percentage: 104.2 } }));
    await t.collector.refresh(t.context);
    expect(readAccountSnapshot(t.db, 'claude').rateLimits[0]?.usedPercent).toBe(104.2);
  });

  it('replaces the stored windows with the newest report: a window the file no longer holds is removed', async () => {
    const t = setup();
    writeSnapshotFile(t.dataDir, snapshot());
    await t.collector.refresh(t.context);
    writeSnapshotFile(
      t.dataDir,
      snapshot({
        captured_at: CAPTURED + 60,
        five_hour: null,
        seven_day: { ...SEVEN, used_percentage: 50 },
      }),
    );
    expect(await t.collector.refresh(t.context)).toEqual({ result: 'succeeded' });
    const { rateLimits } = readAccountSnapshot(t.db, 'claude');
    expect(rateLimits.map((limit) => limit.limitId)).toEqual(['seven_day']);
    expect(rateLimits[0]).toMatchObject({ usedPercent: 50, fetchedAt: (CAPTURED + 60) * 1000 });
  });

  it('succeeds with no windows when the hook ran but Claude Code reported none (no_limits)', async () => {
    const t = setup();
    writeSnapshotFile(t.dataDir, snapshot({ captured_at: null, five_hour: null, seven_day: null }));
    expect(await t.collector.refresh(t.context)).toEqual({ result: 'succeeded' });
    expect(readAccountSnapshot(t.db, 'claude').rateLimits).toEqual([]);
  });

  it('stores a window whose reset time has passed as it is, for the card to say "Window reset"', async () => {
    const t = setup();
    writeSnapshotFile(
      t.dataDir,
      snapshot({ five_hour: { used_percentage: 90, resets_at: CAPTURED - 5 } }),
    );
    await t.collector.refresh(t.context);
    expect(readAccountSnapshot(t.db, 'claude').rateLimits[0]).toMatchObject({
      limitId: 'five_hour',
      usedPercent: 90,
      resetsAt: (CAPTURED - 5) * 1000,
    });
  });

  it('is repeatable: the same file twice leaves the same rows', async () => {
    const t = setup();
    writeSnapshotFile(t.dataDir, snapshot());
    await t.collector.refresh(t.context);
    const first = readAccountSnapshot(t.db, 'claude');
    await t.collector.refresh(t.context);
    expect(readAccountSnapshot(t.db, 'claude')).toEqual(first);
  });

  it('touches only the Claude account: ChatGPT’s windows are not disturbed', async () => {
    const t = setup();
    replaceRateLimits(
      t.db,
      'chatgpt',
      [{ limitId: 'primary', usedPercent: 12, windowMinutes: 300, resetsAt: 1_762_432_800_000 }],
      1_762_000_000_000,
    );
    const before = readAccountSnapshot(t.db, 'chatgpt');
    writeSnapshotFile(t.dataDir, snapshot());
    await t.collector.refresh(t.context);
    expect(readAccountSnapshot(t.db, 'chatgpt')).toEqual(before);
  });
});

describe('no file, or a file that is not a snapshot', () => {
  it('skips when there is no snapshot, and records nothing', async () => {
    const t = setup();
    expect(await t.collector.refresh(t.context)).toEqual({
      result: 'skipped',
      message: CLAUDE_ACCOUNT_MESSAGE.noSnapshot,
    });
    expect(readAccountSnapshot(t.db, 'claude').rateLimits).toEqual([]);
  });

  it.each([
    ['not JSON', '{ nope'],
    ['an unknown version', JSON.stringify(snapshot({ v: 2 }))],
    [
      'the wrong shape',
      JSON.stringify(snapshot({ five_hour: { used_percentage: 'a lot', resets_at: 1 } })),
    ],
    ['an array', '[]'],
  ])(
    'fails with "Couldn’t read the Claude snapshot" for %s, and keeps the previous percentages',
    async (_name, text) => {
      const t = setup();
      writeSnapshotFile(t.dataDir, snapshot());
      await t.collector.refresh(t.context);
      const kept = readAccountSnapshot(t.db, 'claude');

      writeFileSync(t.capture.paths.snapshot, text);
      const report = await t.collector.refresh(t.context);
      expect(report).toMatchObject({
        result: 'failed',
        errorCode: 'snapshot_unreadable',
        errorDetail: 'Couldn’t read the Claude snapshot',
      });
      expect(readAccountSnapshot(t.db, 'claude')).toEqual(kept);
    },
  );

  it('recovers on the next valid file (the next hook run rewrites it)', async () => {
    const t = setup();
    mkdirSync(t.dataDir, { recursive: true });
    writeFileSync(t.capture.paths.snapshot, '{ nope');
    expect((await t.collector.refresh(t.context)).result).toBe('failed');
    writeSnapshotFile(t.dataDir, snapshot());
    expect((await t.collector.refresh(t.context)).result).toBe('succeeded');
    expect(readAccountSnapshot(t.db, 'claude').rateLimits).toHaveLength(2);
  });
});

describe('what a run and the log may carry', () => {
  it('no sentinel text from the file, the path or Claude’s version reaches a report or a log line', async () => {
    const t = setup();
    writeSnapshotFile(
      t.dataDir,
      snapshot({ session_id: 'SENTINEL_SESSION', cwd: 'SENTINEL_PATH' }),
    );
    const ok = await t.collector.refresh(t.context);
    writeFileSync(t.capture.paths.snapshot, '{ SENTINEL_BROKEN');
    const bad = await t.collector.refresh(t.context);
    expect(JSON.stringify([ok, bad, t.logs.entries])).not.toMatch(/SENTINEL_/);
    expect(JSON.stringify(t.logs.entries)).not.toContain(t.dataDir);
  });
});

describe('the collector’s id and change stamp', () => {
  it('reports under claude_account', () => {
    expect(setup().collector.id).toBe('claude_account');
  });

  it('has a stamp that changes when the hook replaces the file, so the service can run it again', async () => {
    const t = setup();
    expect(t.collector.stamp()).toBeNull();
    installHookFiles(t.dataDir, null);
    await runHookScript(t.dataDir, fixtureBytes('stdin', 'full.json'));
    const first = t.collector.stamp();
    expect(first).not.toBeNull();
    await runHookScript(t.dataDir, fixtureBytes('stdin', 'five-hour-only.json'));
    expect(t.collector.stamp()).not.toBe(first);
  });
});

describe('limitsOf', () => {
  it('maps the five-hour window to 300 minutes and the seven-day window to 10080, reset times to milliseconds', () => {
    expect(
      limitsOf({
        v: 1,
        captured_at: 1,
        invoked_at: 1,
        claude_version: null,
        five_hour: FIVE,
        seven_day: null,
      }),
    ).toEqual([
      { limitId: 'five_hour', usedPercent: 23.5, windowMinutes: 300, resetsAt: 1_762_432_800_000 },
    ]);
  });
});
