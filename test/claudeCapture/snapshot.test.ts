import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_EPOCH_SECONDS,
  readSnapshot,
  snapshotStamp,
} from '../../src/server/integrations/claudeCapture/snapshot.ts';
import { fixtureBytes, installHookFiles, rig, runHookScript, testSnapshotPath } from './helpers.ts';

// The one reader of the hook's file: valid v1 files come back typed, everything else is refused, and nothing is guessed.

const GOOD = {
  v: 1,
  captured_at: 1762419000,
  invoked_at: 1762419005,
  claude_version: '2.1.0',
  five_hour: { used_percentage: 23.5, resets_at: 1762432800 },
  seven_day: { used_percentage: 41.2, resets_at: 1762857600 },
};

function readFrom(content: unknown): ReturnType<typeof readSnapshot> {
  const world = rig();
  installHookFiles(world.dataDir, 'omit');
  writeFileSync(
    testSnapshotPath(world.dataDir),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  return world.capture.snapshot();
}

describe('reading the snapshot', () => {
  it('returns a valid v1 file as it is (the percentage as received, times in epoch seconds)', () => {
    expect(readFrom(GOOD)).toEqual({ kind: 'ok', snapshot: GOOD });
  });

  it('reads a window that is null as null, and tolerates a field the hook left out', () => {
    const result = readFrom({ v: 1, captured_at: null, invoked_at: 5, five_hour: null });
    expect(result).toEqual({
      kind: 'ok',
      snapshot: {
        v: 1,
        captured_at: null,
        invoked_at: 5,
        claude_version: null,
        five_hour: null,
        seven_day: null,
      },
    });
  });

  it('drops a field it does not know (only the schema’s fields come out)', () => {
    const result = readFrom({ ...GOOD, session_id: 'SENTINEL_SESSION', cwd: 'SENTINEL_PATH' });
    expect(result).toEqual({ kind: 'ok', snapshot: GOOD });
  });

  it('says absent when there is no file', () => {
    const world = rig();
    expect(world.capture.snapshot()).toEqual({ kind: 'absent' });
  });

  it.each([
    ['not JSON', '{ nope'],
    ['empty', ''],
    ['an array', '[]'],
    ['null', 'null'],
    ['an unknown version', JSON.stringify({ ...GOOD, v: 2 })],
    ['no version', JSON.stringify({ ...GOOD, v: undefined })],
    [
      'a string percentage',
      JSON.stringify({ ...GOOD, five_hour: { used_percentage: '23', resets_at: 1 } }),
    ],
    [
      'a negative percentage',
      JSON.stringify({ ...GOOD, five_hour: { used_percentage: -1, resets_at: 1 } }),
    ],
    [
      'a window without a reset time',
      JSON.stringify({ ...GOOD, five_hour: { used_percentage: 1 } }),
    ],
    [
      'a fractional reset time',
      JSON.stringify({ ...GOOD, seven_day: { used_percentage: 1, resets_at: 1.5 } }),
    ],
    [
      'a reset time in milliseconds',
      JSON.stringify({
        ...GOOD,
        seven_day: { used_percentage: 1, resets_at: MAX_EPOCH_SECONDS + 1 },
      }),
    ],
    ['a window that is a number', JSON.stringify({ ...GOOD, five_hour: 5 })],
    ['a captured_at that is text', JSON.stringify({ ...GOOD, captured_at: 'yesterday' })],
    ['a negative captured_at', JSON.stringify({ ...GOOD, captured_at: -5 })],
    ['a version that is not text', JSON.stringify({ ...GOOD, claude_version: 2 })],
  ])('refuses %s as invalid', (_name, content) => {
    expect(readFrom(content)).toEqual({ kind: 'invalid' });
  });

  it('refuses a snapshot path that is a folder, as invalid', () => {
    const world = rig();
    installHookFiles(world.dataDir, 'omit');
    mkdirSync(testSnapshotPath(world.dataDir), { recursive: true });
    expect(world.capture.snapshot()).toEqual({ kind: 'invalid' });
  });
});

describe('what the hook writes is what the reader accepts', () => {
  it('reads back a file the hook wrote, for every shape of input', async () => {
    for (const name of [
      'full.json',
      'five-hour-only.json',
      'seven-day-only.json',
      'no-rate-limits.json',
      'reset-windows.json',
      'invalid-windows.json',
    ]) {
      const world = rig();
      installHookFiles(world.dataDir, null);
      await runHookScript(world.dataDir, fixtureBytes('stdin', name));
      expect(world.capture.snapshot().kind, name).toBe('ok');
    }
  });
});

describe('snapshotStamp', () => {
  it('is null with no file and changes whenever the file is replaced', async () => {
    const world = rig();
    installHookFiles(world.dataDir, null);
    expect(world.capture.snapshotStamp()).toBeNull();
    await runHookScript(world.dataDir, fixtureBytes('stdin', 'full.json'));
    const first = world.capture.snapshotStamp();
    expect(first).toEqual(expect.any(String));
    expect(world.capture.snapshotStamp()).toBe(first);
    await runHookScript(world.dataDir, fixtureBytes('stdin', 'five-hour-only.json'));
    expect(world.capture.snapshotStamp()).not.toBe(first);
    expect(snapshotStamp(join(world.dataDir, 'nothing-here'))).toBeNull();
  });
});
