// The demand gate: the live feeds run only while someone is looking. Every request touches the gate; the first touch starts the
// feeds, and when no request has come for `idleMs` they are stopped, so no socket or file polling runs while nobody has HQ open.
// A touch while the feeds are stopping queues a restart for when they have stopped. Nothing here knows what a feed is.

export interface DemandGate {
  /** Notes that someone is looking now: starts the feeds if they are stopped, and restarts the idle countdown. */
  touch(): void;
  /** True while the feeds are started or being stopped. */
  active(): boolean;
  /** Stops the feeds and ends the countdown until the next touch. */
  stop(): Promise<void>;
  /** Stops the feeds and ends the countdown; later touches do nothing. Safe to call more than once. */
  close(): Promise<void>;
}

export interface DemandGateOptions {
  start: () => void;
  stop: () => Promise<void>;
  idleMs: number;
}

export function createDemandGate(options: DemandGateOptions): DemandGate {
  let state: 'stopped' | 'running' | 'stopping' = 'stopped';
  let restart = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping: Promise<void> = Promise.resolve();

  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    disarm();
    // Unref'd: an idle countdown never keeps the process alive.
    timer = setTimeout(stopNow, options.idleMs);
    timer.unref();
  };
  function stopNow(): void {
    disarm();
    if (state !== 'running') return;
    state = 'stopping';
    stopping = options
      .stop()
      .catch(() => undefined)
      .then(() => {
        state = 'stopped';
        if (restart && !closed) {
          restart = false;
          state = 'running';
          options.start();
          arm();
        }
        restart = false;
      });
  }

  async function stop() {
    restart = false;
    stopNow();
    await stopping;
  }

  return {
    stop,
    touch() {
      if (closed) return;
      if (state === 'stopping') {
        restart = true;
        return;
      }
      if (state === 'stopped') {
        state = 'running';
        options.start();
      }
      arm();
    },
    active: () => state !== 'stopped',
    async close() {
      closed = true;
      await stop();
    },
  };
}
