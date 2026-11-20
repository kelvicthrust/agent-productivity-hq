/** Waits `ms`; resolves early when `signal` aborts. The timer never keeps the process alive. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal?.addEventListener('abort', done, { once: true });
  });
