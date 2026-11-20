import type {
  AdapterContext,
  AdapterReport,
  AttemptDetails,
  RefreshSourceId,
  SourceAdapter,
} from '../../../src/server/collectors/types.ts';

// Scripted source adapters: stand-ins for Codex, Claude Code, Paseo, GitHub and ChatGPT that do exactly what a test says,
// when the test says it. They exercise the refresh runner and the sources API without reading a log folder or the network.
// src/ never imports this folder (test/fixtures/scripted-adapters/scripted.test.ts checks), so nothing here can ship.
//
//   const codex = scriptedAdapter('codex', [fails(), succeeds({ imported: 4 })]);
//
// Each call to `refresh` plays the next step; the last step repeats once the script runs out. A step is a report, an Error
// (the adapter rejects, as a broken adapter would), or a function that gets the context and may wait on a `gate`.

export type Step =
  AdapterReport | Error | ((context: AdapterContext) => AdapterReport | Promise<AdapterReport>);

export const succeeds = (details: AttemptDetails = {}): AdapterReport => ({
  result: 'succeeded',
  ...details,
});
export const partial = (details: AttemptDetails = {}): AdapterReport => ({
  result: 'partial',
  unreadable: 1,
  ...details,
});
export const fails = (details: AttemptDetails = {}): AdapterReport => ({
  result: 'failed',
  errorCode: 'unrecognized_format',
  errorDetail: 'Couldn’t read 2 new session files (unrecognized format).',
  ...details,
});
export const skips = (message: string | null = null): AdapterReport => ({
  result: 'skipped',
  message,
});

/** A promise a test opens by hand: an adapter waits on `gate.promise` until the test calls `release()`. */
export interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}
export function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

/** A step that stays "running" until `held` opens, then reports `report`. */
export const holds =
  (held: Gate, report: AdapterReport): Step =>
  async () => {
    await held.promise;
    return report;
  };

export interface ScriptedAdapter extends SourceAdapter {
  /** How many times `refresh` has been called. */
  readonly calls: number;
  /** Resolves once `refresh` has been called `n` times (it is then running its step). */
  called(n?: number): Promise<void>;
}

export function scriptedAdapter(id: RefreshSourceId, steps: readonly Step[]): ScriptedAdapter {
  if (steps.length === 0) throw new Error('A scripted adapter needs at least one step.');
  let calls = 0;
  const waiting: Array<{ n: number; done: () => void }> = [];
  return {
    id,
    get calls() {
      return calls;
    },
    called(n = 1) {
      if (calls >= n) return Promise.resolve();
      return new Promise<void>((done) => waiting.push({ n, done }));
    },
    async refresh(context) {
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls += 1;
      for (let i = waiting.length - 1; i >= 0; i--) {
        if (waiting[i]!.n <= calls) waiting.splice(i, 1)[0]!.done();
      }
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(context) : step;
    },
  };
}
