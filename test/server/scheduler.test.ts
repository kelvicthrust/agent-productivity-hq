import { describe, expect, it } from 'vitest';
import { delayUntilLocalTime, startScheduler } from '../../src/server/services/scheduler.ts';
import { memoryLogger } from './helpers.ts';

const LA = 'America/Los_Angeles';
const HOUR = 3_600_000;

describe('delayUntilLocalTime (retention runs daily at 03:00 report time)', () => {
  it('waits until the next 03:00, today or tomorrow', () => {
    expect(delayUntilLocalTime(Date.parse('2026-11-04T20:00:00Z'), LA, 3)).toBe(
      Date.parse('2026-11-05T11:00:00Z') - Date.parse('2026-11-04T20:00:00Z'),
    ); // noon PST -> 03:00 PST next day
    expect(delayUntilLocalTime(Date.parse('2026-11-04T09:00:00Z'), LA, 3)).toBe(2 * HOUR); // 01:00 PST -> 03:00 PST? (PST = UTC-8 on Nov 4)
  });

  it('is never zero: at exactly 03:00 it waits a full day', () => {
    const at3 = Date.parse('2026-11-04T11:00:00Z'); // 03:00 PST
    expect(delayUntilLocalTime(at3, LA, 3)).toBe(24 * HOUR);
  });

  it('follows the wall clock through daylight-saving changes', () => {
    // Spring forward 2026-03-08: from 03:00 PST on the 7th the next 03:00 (PDT) is 23 hours away.
    expect(delayUntilLocalTime(Date.parse('2026-03-07T11:00:00Z') + 1, LA, 3)).toBe(23 * HOUR - 1);
    // Fall back 2026-11-01: from 03:00 PDT on Oct 31 the next 03:00 (PST) is 25 hours away.
    expect(delayUntilLocalTime(Date.parse('2026-10-31T10:00:00Z') + 1, LA, 3)).toBe(25 * HOUR - 1);
  });
});

describe('scheduler', () => {
  const fakeTimers = () => {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    return {
      timers,
      setTimer: (fn: () => void, ms: number) => {
        const timer = { fn, ms, cleared: false, unref: () => undefined };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle: unknown) => void ((handle as { cleared: boolean }).cleared = true),
    };
  };

  it('runs a task when its timer fires, then arms the next run', async () => {
    const { timers, setTimer, clearTimer } = fakeTimers();
    let runs = 0;
    startScheduler({
      now: () => 0,
      logger: memoryLogger().logger,
      setTimer,
      clearTimer,
      tasks: [{ name: 'retention', nextDelay: () => 5_000, run: () => void runs++ }],
    });
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(5_000);
    timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toBe(1);
    expect(timers).toHaveLength(2);
  });

  it('keeps going after a task fails, and logs the failure', async () => {
    const { timers, setTimer, clearTimer } = fakeTimers();
    const { logger, entries } = memoryLogger();
    startScheduler({
      now: () => 0,
      logger,
      setTimer,
      clearTimer,
      tasks: [
        {
          name: 'boom',
          nextDelay: () => 1_000,
          run: () => {
            throw new Error('no');
          },
        },
      ],
    });
    timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(entries.find((e) => e['msg'] === 'scheduled task failed')).toMatchObject({
      task: 'boom',
      level: 'error',
    });
    expect(timers).toHaveLength(2);
  });

  it('stop clears the timers and arms nothing more', async () => {
    const { timers, setTimer, clearTimer } = fakeTimers();
    const scheduler = startScheduler({
      now: () => 0,
      logger: memoryLogger().logger,
      setTimer,
      clearTimer,
      tasks: [{ name: 'a', nextDelay: () => 1_000, run: () => undefined }],
    });
    scheduler.stop();
    expect(timers[0]!.cleared).toBe(true);
    timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(timers).toHaveLength(1);
  });
});
