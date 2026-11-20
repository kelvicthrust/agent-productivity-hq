import type { Logger } from '../lib/logger.ts';

// Runs recurring work while the server is up. In M2 the only task is the daily retention prune at 03:00 report time;
// the 15-minute refresh joins the same list when collectors land. Timers never keep the process alive (unref) and
// `stop()` clears them, so shutdown is not held up.

export interface ScheduledTask {
  name: string;
  /** Milliseconds from `nowMs` until the next run. */
  nextDelay(nowMs: number): number;
  run(): void | Promise<void>;
}

export type SetTimer = (fn: () => void, ms: number) => { unref?: () => unknown } | unknown;
export type ClearTimer = (handle: unknown) => void;

export interface Scheduler {
  stop(): void;
}

export function startScheduler(options: {
  tasks: ScheduledTask[];
  now: () => number;
  logger: Logger;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
}): Scheduler {
  const setTimer: SetTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: ClearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const handles = new Map<string, unknown>();
  let stopped = false;

  const arm = (task: ScheduledTask) => {
    if (stopped) return;
    // Node caps a timer at about 24.8 days; a daily or 15-minute delay is far below it.
    const delay = Math.max(1_000, task.nextDelay(options.now()));
    const handle = setTimer(() => {
      handles.delete(task.name);
      void Promise.resolve()
        .then(() => (stopped ? undefined : task.run()))
        .catch((error: unknown) =>
          options.logger.error('scheduled task failed', {
            source: 'scheduler',
            task: task.name,
            error,
          }),
        )
        .finally(() => arm(task));
    }, delay);
    (handle as { unref?: () => unknown } | undefined)?.unref?.();
    handles.set(task.name, handle);
  };

  options.tasks.forEach(arm);
  return {
    stop() {
      stopped = true;
      for (const handle of handles.values()) clearTimer(handle);
      handles.clear();
    },
  };
}

/** Milliseconds until the next `hour:minute` in `timeZone` strictly after `nowMs`. DST days are handled by Temporal. */
export function delayUntilLocalTime(
  nowMs: number,
  timeZone: string,
  hour: number,
  minute = 0,
): number {
  const now = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(timeZone);
  let next = now.with({ hour, minute, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  if (next.epochMilliseconds <= nowMs) {
    next = now
      .add({ days: 1 })
      .with({ hour, minute, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  }
  return next.epochMilliseconds - nowMs;
}
