import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AlreadyRunningError, boot, type ListenFn } from '../../src/server/boot.ts';
import { createRunner } from '../../src/server/collectors/runner.ts';
import type { SourceAdapter } from '../../src/server/collectors/types.ts';
import { MigrationError } from '../../src/server/db/migrate.ts';
import { getRun, getSourceState } from '../../src/server/db/queries/sources.ts';
import { DISK_FULL_IMPORT_MESSAGE, isDiskFull } from '../../src/server/lib/diskFull.ts';
import { loadConfig } from '../../src/server/lib/config.ts';
import { NOW, TZ, memoryDb, memoryLogger, tempConfig, tempDir } from './helpers.ts';

// The three recovery pages, wired (TECH › Failure modes): the database page (covered in boot.test.ts), the not-enough-disk page
// when the disk is full while the database is opened or prepared, and the already-running page when another copy holds the data
// folder and this process's own port is a different, free one. Every case checks that nothing was deleted, moved or rewritten, and
// that a copy that only points to another never opens the database. A run that meets a full disk fails with its own sentence.

// Fault injection for the two database calls boot makes: a flag makes the next open or migration throw the given error. Everything
// else is the real thing, so an unflagged boot is the same as in boot.test.ts.
const hooks = vi.hoisted(() => ({
  failOpen: null as Error | null,
  failMigrate: null as Error | null,
  opens: 0,
}));
vi.mock('../../src/server/db/open.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/db/open.ts')>();
  return {
    ...actual,
    openDatabase: (path: string) => {
      hooks.opens += 1;
      if (hooks.failOpen) throw hooks.failOpen;
      return actual.openDatabase(path);
    },
  };
});
vi.mock('../../src/server/db/migrate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/db/migrate.ts')>();
  return {
    ...actual,
    migrate: (...args: Parameters<typeof actual.migrate>) => {
      if (hooks.failMigrate) throw hooks.failMigrate;
      return actual.migrate(...args);
    },
  };
});

/** What SQLite's own driver throws when the disk is full (node:sqlite: ERR_SQLITE_ERROR with errcode 13). */
const sqliteFull = () =>
  Object.assign(new Error('database or disk is full'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 13,
    errstr: 'database or disk is full',
  });
const enospc = () => Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' });

const listenOk = () => {
  const calls: { port: number }[] = [];
  const listen: ListenFn = async ({ port }) => {
    calls.push({ port });
    return { close: (done) => done?.() };
  };
  return { listen, calls };
};

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const get = (
  app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> },
  port: number,
  path = '/',
) => app.request(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}` } });

describe('what counts as a full disk', () => {
  it('knows ENOSPC, SQLITE_FULL (extended codes too), its words, and a cause that carries either', () => {
    expect(isDiskFull(enospc())).toBe(true);
    expect(isDiskFull(sqliteFull())).toBe(true);
    expect(isDiskFull(Object.assign(new Error('x'), { errcode: 13 | (2 << 8) }))).toBe(true);
    expect(isDiskFull(new Error('No space left on device'))).toBe(true);
    expect(
      isDiskFull(new MigrationError('step failed', '002_x.sql', 2, { cause: sqliteFull() })),
    ).toBe(true);
  });
  it('says no to everything else', () => {
    for (const other of [
      new Error('database disk image is malformed'),
      Object.assign(new Error('busy'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }),
      Object.assign(new Error('denied'), { code: 'EACCES' }),
      'ENOSPC',
      null,
      undefined,
    ])
      expect(isDiskFull(other), String(other)).toBe(false);
  });
});

describe('the disk is full while the database is opened or prepared', () => {
  it('a failed open serves the not-enough-disk page and leaves the data folder alone', async () => {
    for (const error of [sqliteFull(), enospc()]) {
      const config = tempConfig(4431);
      const { listen } = listenOk();
      hooks.failOpen = error;
      let server;
      try {
        server = await boot(config, {
          logger: memoryLogger().logger,
          listen,
          now: () => NOW,
          timezone: TZ,
        });
      } finally {
        hooks.failOpen = null;
      }
      expect(server.mode).toBe('recovery');
      expect(server.recovery?.reason).toBe('disk_full');
      expect(server.db).toBeNull();
      const page = await get(server.app, 4431);
      expect(page.status).toBe(503);
      const html = await page.text();
      expect(html).toContain('There isn’t enough disk space');
      expect(html).toContain('Nothing was deleted or changed.');
      expect(html).toContain(config.dataDir);
      const api = await get(server.app, 4431, '/api/health');
      expect(api.status).toBe(503);
      expect(await api.json()).toMatchObject({
        error: { details: { recovery: true, reason: 'disk_full' } },
      });
      await server.shutdown();
      expect(existsSync(config.lockPath)).toBe(false); // the lock is let go like any other shutdown
    }
  });

  it('a migration that hits a full disk serves the same page, whatever wraps the error', async () => {
    for (const error of [
      sqliteFull(),
      new MigrationError('could not apply 002_x.sql', '002_x.sql', 2, { cause: sqliteFull() }),
    ]) {
      const config = tempConfig(4432);
      const { listen } = listenOk();
      hooks.failMigrate = error;
      let server;
      try {
        server = await boot(config, {
          logger: memoryLogger().logger,
          listen,
          now: () => NOW,
          timezone: TZ,
        });
      } finally {
        hooks.failMigrate = null;
      }
      expect(server.mode).toBe('recovery');
      expect(server.recovery?.reason).toBe('disk_full');
      expect(await (await get(server.app, 4432)).text()).toContain('There isn’t enough disk space');
      await server.shutdown();
    }
  });

  it('a migration that fails for another reason is still the database page, not the disk page', async () => {
    const config = tempConfig(4433);
    const { listen } = listenOk();
    hooks.failMigrate = new MigrationError('could not apply 002_x.sql', '002_x.sql', 2, {
      cause: new Error('syntax error'),
    });
    let server;
    try {
      server = await boot(config, {
        logger: memoryLogger().logger,
        listen,
        now: () => NOW,
        timezone: TZ,
      });
    } finally {
      hooks.failMigrate = null;
    }
    expect(server.recovery?.reason).toBe('migration_failed');
    const html = await (await get(server.app, 4433)).text();
    expect(html).toContain('Move it aside and start fresh');
    expect(html).not.toContain('enough disk space');
    await server.shutdown();
  });
});

describe('another copy already holds the data folder', () => {
  const second = (dataDir: string, port: number) =>
    loadConfig(
      { AGENT_PRODUCTIVITY_DATA_DIR: dataDir, AGENT_PRODUCTIVITY_PORT: String(port) },
      { staticDir: join(tempDir(), 'no-spa') },
    );

  it('on a different, free port, it serves the already-running page and never opens the database', async () => {
    const first = tempConfig(4441);
    const holder = await boot(first, {
      logger: memoryLogger().logger,
      listen: listenOk().listen,
      now: () => NOW,
      timezone: TZ,
    });
    const opensAfterFirst = hooks.opens;
    const dbBefore = sha(first.dbPath);
    const lockBefore = readFileSync(first.lockPath, 'utf8');

    const other = second(first.dataDir, 4442);
    const { listen, calls } = listenOk();
    const pointer = await boot(other, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });

    expect(pointer.mode).toBe('already_running');
    expect(pointer.db).toBeNull();
    expect(calls).toEqual([{ port: 4442 }]);
    expect(hooks.opens).toBe(opensAfterFirst); // the database was not opened by the second copy
    const page = await get(pointer.app, 4442);
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).toContain('Agent Productivity HQ is already running');
    expect(html).toContain('http://127.0.0.1:4441');
    expect(html).toContain(first.lockPath);
    expect(html).toContain('Nothing was deleted or changed.');
    const api = await get(pointer.app, 4442, '/api/overview');
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({
      error: { details: { alreadyRunning: true, url: 'http://127.0.0.1:4441' } },
    });
    // The guards are still on: a wrong Host is refused before the page.
    const wrongHost = await pointer.app.request('http://127.0.0.1:4442/', {
      headers: { host: 'evil.example' },
    });
    expect(wrongHost.status).toBe(421);

    await pointer.shutdown();
    // Stopping the pointer takes nothing from the copy that is really running.
    expect(readFileSync(first.lockPath, 'utf8')).toBe(lockBefore);
    expect(sha(first.dbPath)).toBe(dbBefore);
    await holder.shutdown();
    expect(existsSync(first.lockPath)).toBe(false);
  });

  it('on the same port there is nothing to serve: it says so and exits, without trying to listen', async () => {
    const first = tempConfig(4443);
    const holder = await boot(first, {
      logger: memoryLogger().logger,
      listen: listenOk().listen,
      now: () => NOW,
      timezone: TZ,
    });
    const { listen, calls } = listenOk();
    await expect(
      boot(first, { logger: memoryLogger().logger, listen, now: () => NOW, timezone: TZ }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);
    expect(calls).toEqual([]);
    await holder.shutdown();
  });

  it('on a different port that is also taken, it says so and exits', async () => {
    const first = tempConfig(4444);
    const holder = await boot(first, {
      logger: memoryLogger().logger,
      listen: listenOk().listen,
      now: () => NOW,
      timezone: TZ,
    });
    const taken: ListenFn = async () => {
      throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    };
    await expect(
      boot(second(first.dataDir, 4445), {
        logger: memoryLogger().logger,
        listen: taken,
        now: () => NOW,
        timezone: TZ,
      }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);
    expect(existsSync(first.lockPath)).toBe(true); // still the first copy's
    await holder.shutdown();
  });
});

describe('a refresh run that meets a full disk', () => {
  const adapter = (error: unknown): SourceAdapter => ({
    id: 'codex',
    refresh: async () => {
      throw error;
    },
  });

  it('fails with “Not enough disk space to import”, keeps what was committed, and can be retried', async () => {
    const db = memoryDb();
    const logs = memoryLogger();
    let failing: unknown = sqliteFull();
    const runner = createRunner({
      db,
      now: () => NOW,
      logger: logs.logger,
      adapters: [
        {
          id: 'codex',
          refresh: async () => {
            if (failing) throw failing;
            return { result: 'succeeded', imported: 2 };
          },
        },
      ],
    });
    const started = runner.start({ trigger: 'manual', sources: ['codex'] });
    if (!started.started) throw new Error('a run was already going');
    await runner.idle();

    const run = getRun(db, started.run.id)!;
    expect(DISK_FULL_IMPORT_MESSAGE).toBe('Not enough disk space to import');
    expect(run.state).toBe('failed');
    expect(run.sources['codex']).toMatchObject({
      state: 'failed',
      message: DISK_FULL_IMPORT_MESSAGE,
    });
    expect(getSourceState(db, 'codex')).toMatchObject({
      lastAttemptResult: 'failed',
      errorCode: 'disk_full',
      errorDetail: DISK_FULL_IMPORT_MESSAGE,
    });
    expect(
      logs.entries.some((entry) => entry['code'] === 'disk_full' && entry['source'] === 'codex'),
    ).toBe(true);

    // Retry is the same run again once there is room: the failed attempt is replaced by the new one, nothing else changes.
    failing = null;
    const again = runner.start({ trigger: 'manual', sources: ['codex'] });
    if (!again.started) throw new Error('a run was already going');
    await runner.idle();
    expect(getRun(db, again.run.id)!.sources['codex']).toMatchObject({
      state: 'succeeded',
      imported: 2,
    });
    expect(getSourceState(db, 'codex')).toMatchObject({ lastAttemptResult: 'succeeded' });
  });

  it('any other failure keeps the generic sentence', async () => {
    const db = memoryDb();
    const runner = createRunner({
      db,
      now: () => NOW,
      logger: memoryLogger().logger,
      adapters: [adapter(new Error('boom'))],
    });
    const started = runner.start({ trigger: 'manual', sources: ['codex'] });
    if (!started.started) throw new Error('a run was already going');
    await runner.idle();
    const entry = getRun(db, started.run.id)!.sources['codex'];
    expect(entry?.state).toBe('failed');
    expect(entry?.message).not.toBe(DISK_FULL_IMPORT_MESSAGE);
    expect(getSourceState(db, 'codex')).toMatchObject({ errorCode: 'unexpected_error' });
  });
});
