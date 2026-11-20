import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createClaudeAccountCollector } from '../../src/server/collectors/claudeAccount/collector.ts';
import { readAccountSnapshot } from '../../src/server/db/queries/accounts.ts';
import { memoryDb, memoryLogger } from '../server/helpers.ts';
import { fixture, fixtureBytes, installByHand, removeByHand, rig, runChild } from './helpers.ts';

// The whole path in a temporary CLAUDE_CONFIG_DIR and data folder (both with a space): preview, turn on, Claude Code runs the
// status line, the collector reads the snapshot, the health follows, turn off.

/** Runs the installed status-line command the way Claude Code does: through a shell, JSON on stdin. */
const claudeRunsStatusLine = (command: string, stdin: Buffer) =>
  runChild('/bin/sh', ['-c', command], { stdin });

describe('from the toggle to the card', () => {
  it('with no status line today', async () => {
    const world = rig({ settings: 'other-keys.json' });
    const db = memoryDb();
    const logs = memoryLogger();
    const collector = createClaudeAccountCollector({
      snapshotPath: world.capture.activeSnapshotPath,
    });
    const context = { db, now: () => Date.now(), logger: logs.logger, progress: () => undefined };

    // Off: nothing to read, nothing installed.
    expect((await world.capture.health()).state).toBe('off');
    expect((await collector.refresh(context)).result).toBe('skipped');

    // The preview shows the change, the owner confirms its digest, and it is applied.
    const preview = await world.capture.preview('install');
    expect(preview.sampleStatusRow).toBe('5h 23% · 7d 41%');
    installByHand(world);
    expect((await world.capture.health()).state).toBe('waiting');

    // Claude Code runs the status line: the row shows the compact line and the snapshot lands.
    const command = (world.readSettingsJson()['statusLine'] as { command: string }).command;
    const run = await claudeRunsStatusLine(command, fixtureBytes('stdin', 'full.json'));
    expect(run.stdout.toString('utf8')).toBe('5h 24% · 7d 41%\n');
    expect((await world.capture.health()).state).toBe('ok');

    // The collector turns it into percent windows (reset times are year 2100, so no clock is needed).
    expect((await collector.refresh(context)).result).toBe('succeeded');
    expect(readAccountSnapshot(db, 'claude').rateLimits).toMatchObject([
      { limitId: 'five_hour', usedPercent: 23.5, windowMinutes: 300 },
      { limitId: 'seven_day', usedPercent: 41.2, windowMinutes: 10_080 },
    ]);

    // Turning it off restores the settings exactly and removes the hook's files.
    removeByHand(world, null);
    expect(world.readSettingsJson()).toEqual(JSON.parse(fixture('settings', 'other-keys.json')));
    expect(existsSync(world.capture.paths.snapshot)).toBe(false);
    expect((await world.capture.health()).state).toBe('off');
    expect((await collector.refresh(context)).result).toBe('skipped');
  });

  it('with a status line of the owner’s: it keeps rendering the same, and a failed hook never breaks it', async () => {
    const world = rig({ settings: 'command-with-padding.json' });
    const plan = installByHand(world);
    const command = (world.readSettingsJson()['statusLine'] as { command: string }).command;
    const expected = '\u001b[1mSENTINEL_LINE_ONE\u001b[0m\nSENTINEL_LINE_TWO\n';

    const normal = await claudeRunsStatusLine(command, fixtureBytes('stdin', 'full.json'));
    expect(normal.stdout.toString('utf8')).toBe(expected);
    const garbage = await claudeRunsStatusLine(command, fixtureBytes('stdin', 'malformed.txt'));
    expect(garbage.stdout.toString('utf8')).toBe(expected);
    expect(garbage.code).toBe(0);

    removeByHand(world, plan.previousStatusLine);
    expect(JSON.parse(readFileSync(world.settingsPath, 'utf8'))).toEqual(
      JSON.parse(fixture('settings', 'command-with-padding.json')),
    );
  });
});
