import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROGRESS_INTERVAL_MS,
  createRunner,
  progressMessage,
} from '../../../src/server/collectors/runner.ts';
import type { ImportProgress, SourceAdapter } from '../../../src/server/collectors/types.ts';
import { getRun } from '../../../src/server/db/queries/sources.ts';
import { memoryDb, memoryLogger } from '../helpers.ts';

// Import progress: an adapter says how far it has got and the run row shows it while the source runs (the first full import,
// G5_9), written at most a few times a second and gone when the attempt ends. It travels as the source's `message`, so the
// RefreshRun shape in docs/tech/local-api.md is unchanged.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('progressMessage', () => {
  it('says how many files of how many, in the singular for one', () => {
    expect(progressMessage({ done: 42, total: 380 })).toBe('Importing 42 of 380 files');
    expect(progressMessage({ done: 0, total: 1 })).toBe('Importing 0 of 1 file');
  });
});

describe('the run row while a source imports', () => {
  function setup(adapter: SourceAdapter) {
    const db = memoryDb();
    const runner = createRunner({
      db,
      now: () => 1_000,
      logger: memoryLogger().logger,
      adapters: [adapter],
    });
    return { db, runner };
  }

  it('shows the first figure at once, throttles the next ones and clears them when the source finishes', async () => {
    let clock = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let say!: (progress: ImportProgress) => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const adapter: SourceAdapter = {
      id: 'codex',
      async refresh(context) {
        say = context.progress;
        started();
        await held;
        return { result: 'succeeded', imported: 3 };
      },
    };
    const { db, runner } = setup(adapter);
    const start = runner.start({ trigger: 'manual', sources: ['codex'] });
    if (!start.started) throw new Error('no run');
    await running;
    const message = () => getRun(db, start.run.id)?.sources['codex']?.message;

    say({ done: 0, total: 3 });
    expect(message()).toBe('Importing 0 of 3 files');
    expect(getRun(db, start.run.id)?.sources['codex']?.state).toBe('running');

    clock += PROGRESS_INTERVAL_MS - 1; // too soon: the latest figure is kept in the adapter's hands, not written
    say({ done: 1, total: 3 });
    expect(message()).toBe('Importing 0 of 3 files');

    clock += 1;
    say({ done: 2, total: 3 });
    expect(message()).toBe('Importing 2 of 3 files');

    release();
    await runner.idle();
    const finished = getRun(db, start.run.id)!;
    expect(finished.sources['codex']).toEqual({ state: 'succeeded', imported: 3 });

    // A late call after the attempt has ended cannot bring the progress back.
    clock += 10_000;
    say({ done: 3, total: 3 });
    expect(getRun(db, start.run.id)?.sources['codex']).toEqual({ state: 'succeeded', imported: 3 });
  });

  it('lets an adapter that never reports progress run as before', async () => {
    const adapter: SourceAdapter = { id: 'codex', refresh: async () => ({ result: 'succeeded' }) };
    const { db, runner } = setup(adapter);
    const start = runner.start({ trigger: 'manual', sources: ['codex'] });
    if (!start.started) throw new Error('no run');
    await runner.idle();
    expect(getRun(db, start.run.id)?.sources['codex']).toEqual({ state: 'succeeded' });
  });

  it('does not stop an import when the progress write fails', async () => {
    const adapter: SourceAdapter = {
      id: 'codex',
      async refresh(context) {
        context.db.exec('DROP TABLE refresh_run'); // the run row can no longer be written
        context.progress({ done: 0, total: 1 });
        return { result: 'succeeded', imported: 1 };
      },
    };
    const db = memoryDb();
    const logs = memoryLogger();
    const runner = createRunner({ db, now: () => 1, logger: logs.logger, adapters: [adapter] });
    const start = runner.start({ trigger: 'manual', sources: ['codex'] });
    expect(start.started).toBe(true);
    await runner.idle();
    expect(logs.entries.some((entry) => entry['code'] === 'progress')).toBe(true);
  });
});
