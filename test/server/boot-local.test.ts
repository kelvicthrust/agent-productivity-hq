import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { boot, type ListenFn, type RunningServer } from '../../src/server/boot.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { openDatabase } from '../../src/server/db/open.ts';
import { completeSetup } from '../../src/server/db/queries/setup.ts';
import { SourcesResponse } from '../../src/shared/contracts/sources.ts';
import { T0, makeHome } from '../integration/import/helpers.ts';
import { HOST, PORT, TZ, memoryLogger, tempConfig, tempDir } from './helpers.ts';

// `pnpm start` reads this machine for real: boot is given `local` (the environment and the home folder) and builds the two real
// adapters, takes a look at their folders before every run, and starts a first run when it is listening, so a first launch imports
// without a click, once first-launch Setup has been finished (before that, Finish starts it: test/server/setup-wire.test.ts). The
// preview command and the other tests never pass `local`, so they never read a real folder. Here the "machine" is a temp HOME with
// INVENTED fixture logs.

const fakeListen: ListenFn = async () => ({ close: (callback) => callback?.() });
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;

const runs = (server: RunningServer) =>
  server.db!.prepare('SELECT state FROM refresh_run ORDER BY id').all() as unknown as {
    state: string;
  }[];

async function firstRunOver(server: RunningServer): Promise<void> {
  for (let waited = 0; waited < 20_000; waited += 10) {
    const all = runs(server);
    if (all.length > 0 && all.every((run) => run.state !== 'running')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the first run did not end');
}

const sourcesOf = async (server: RunningServer) =>
  SourcesResponse.parse(
    await (await server.app.request(url('/api/sources'), { headers: HOST })).json(),
  );

/** A data folder whose owner has already been through Setup, as on any launch after the first. */
function finishedSetup() {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.dbPath);
  migrate(db);
  completeSetup(db, { at: T0, timezone: TZ });
  db.close();
  return config;
}

function start(home: string, extra: { scheduler?: boolean } = {}) {
  const logs = memoryLogger();
  const promise = boot(finishedSetup(), {
    logger: logs.logger,
    listen: fakeListen,
    now: () => T0,
    timezone: TZ,
    local: { env: {}, home },
    ...extra,
  });
  return { promise, logs };
}

describe('boot on a machine (local)', () => {
  it('imports the history by itself when it starts: both sources found, with their sessions, and no click', async () => {
    const { promise, logs } = start(makeHome());
    const server = await promise;
    try {
      await firstRunOver(server);
      expect(runs(server)).toEqual([{ state: 'succeeded' }]);
      const sources = await sourcesOf(server);
      expect(sources.sources?.map((s) => [s.id, s.status, s.sessions])).toEqual([
        ['codex', 'ok', 3],
        ['claude', 'ok', 6],
      ]);
      // The run was the timer's, not a button's.
      const trigger = server.db!.prepare('SELECT trigger FROM refresh_run').get() as {
        trigger: string;
      };
      expect(trigger.trigger).toBe('scheduler');
      expect(JSON.stringify(logs.entries)).not.toMatch(/SENTINEL/);
    } finally {
      await server.shutdown();
    }
  });

  it('on a machine with neither Codex nor Claude Code, says Not found for each and counts no failure', async () => {
    const { promise } = start(tempDir());
    const server = await promise;
    try {
      await firstRunOver(server);
      const sources = await sourcesOf(server);
      expect(sources.sources?.map((s) => [s.id, s.status])).toEqual([
        ['codex', 'notfound'],
        ['claude', 'notfound'],
      ]);
      for (const source of sources.sources ?? []) {
        expect(source).toMatchObject({ lastAttemptResult: null, consecutiveFailures: 0 });
      }
    } finally {
      await server.shutdown();
    }
  });

  it('starts no run when the scheduler is off, so a test or a script decides when', async () => {
    const { promise } = start(makeHome(), { scheduler: false });
    const server = await promise;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs(server)).toEqual([]);
    } finally {
      await server.shutdown();
    }
  });

  it('starts no run, and reads no folder, when it is given no machine', async () => {
    const server = await boot(tempConfig(), {
      logger: memoryLogger().logger,
      listen: fakeListen,
      now: () => T0,
      timezone: TZ,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs(server)).toEqual([]);
      expect((await sourcesOf(server)).sources).toEqual([]);
    } finally {
      await server.shutdown();
    }
  });
});
