import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  BOOT_STEPS,
  PortInUseError,
  AlreadyRunningError,
  SHUTDOWN_TIMEOUT_MS,
  boot,
  type ListenFn,
  type ListeningServer,
} from '../../src/server/boot.ts';
import { MIGRATIONS_DIR, listMigrations, migrate } from '../../src/server/db/migrate.ts';
import { checkIntegrity, openDatabase } from '../../src/server/db/open.ts';
import { ErrorEnvelope } from '../../src/shared/contracts/errors.ts';
import { ensureDir, modeOf } from '../../src/server/lib/fsModes.ts';
import { capturePaths } from '../../src/server/integrations/claudeCapture/paths.ts';
import { buildWrapper } from '../../src/server/integrations/claudeCapture/wrapper.ts';
import { addDays } from '../../src/shared/domain/periods.ts';
import { utcBounds } from '../../src/shared/domain/periods.ts';
import { RefreshRun } from '../../src/shared/contracts/sources.ts';
import { createFakeGithub, createMemoryKeyring } from '../fixtures/github/scripted-github.ts';
import { gate, scriptedAdapter, succeeds } from '../fixtures/scripted-adapters/scripted.ts';
import { HOST, NOW, PORT, TZ, WRITE, call, memoryLogger, tempConfig, tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '../..');

/** A listener that records what it was asked to bind and never opens a socket. */
function fakeListen(server: Partial<ListeningServer> = {}) {
  const calls: { port: number; host: string }[] = [];
  const listen: ListenFn = async ({ port, host }) => {
    calls.push({ port, host });
    return { close: (cb) => cb?.(), ...server };
  };
  return { listen, calls };
}

const fingerprint = (path: string) => ({
  sha: createHash('sha256').update(readFileSync(path)).digest('hex'),
  size: statSync(path).size,
  mtimeMs: statSync(path).mtimeMs,
});

const stepsOf = (entries: Record<string, unknown>[]) =>
  entries
    .filter((e) => e['source'] === 'boot' && typeof e['step'] === 'string')
    .map((e) => e['step']);

describe('boot order: migrate, mark interrupted runs, retention, scheduler, listen', () => {
  it('runs the steps in that order and then listens on 127.0.0.1', async () => {
    const config = tempConfig();
    const { logger, entries } = memoryLogger();
    const { listen, calls } = fakeListen();
    const server = await boot(config, {
      logger,
      listen,
      now: () => NOW,
      timezone: TZ,
      scheduler: true,
    });
    expect(stepsOf(entries)).toEqual([...BOOT_STEPS]);
    expect(calls).toEqual([{ port: PORT, host: '127.0.0.1' }]);
    expect(server.mode).toBe('normal');
    await server.shutdown();
  });

  it('applies the migration before anything reads the schema, and records the report timezone', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    const read = (key: string) =>
      (server.db!.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string })
        .value;
    expect(read('schema_version')).toBe(String(listMigrations().length));
    expect(read('report_timezone')).toBe(TZ);
    expect(read('install_id')).toMatch(/^[0-9a-f-]{36}$/);
    await server.shutdown();
  });

  it('boots and restarts a v1 install with usage, pending GitHub work, a decision and a capture hook', async () => {
    const config = tempConfig();
    ensureDir(config.dataDir);
    const migrationDir = tempDir();
    writeFileSync(
      join(migrationDir, '001_init.sql'),
      readFileSync(join(MIGRATIONS_DIR, '001_init.sql')),
    );
    const old = openDatabase(config.dbPath);
    try {
      migrate(old, migrationDir);
      old.exec(`
        INSERT INTO repo (id, github_node_id, display_name, tracking_state, access_state, added_at)
          VALUES ('owner/repo', 'R1', 'Owner/Repo', 'active', 'ok', ${NOW});
        INSERT INTO pull_request (node_id, repo_id, number, title, url, merged_at)
          VALUES ('PR1', 'owner/repo', 1, 'title', 'https://github.com/owner/repo/pull/1', ${NOW});
        INSERT INTO session (id, provider, provider_session_id, kind, repo_id, started_at, started_basis)
          VALUES (7, 'claude', 's1', 'root', 'owner/repo', ${NOW}, 'source_start');
        INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total)
          VALUES ('claude', 'message:request', 7, ${NOW}, 'fixture', 10);
        INSERT INTO owner_link_decision (pr_node_id, session_id, decision, decided_at)
          VALUES ('PR1', 7, 'confirmed', ${NOW});
      `);
    } finally {
      old.close();
    }
    const profile = tempDir();
    const settingsPath = join(profile, 'settings.json');
    const paths = capturePaths(config.dataDir);
    const wrapper = buildWrapper({
      node: process.execPath,
      script: paths.script,
      previousCommand: null,
    });
    const providerSettings = JSON.stringify({ statusLine: { type: 'command', command: wrapper } });
    writeFileSync(settingsPath, providerSettings);
    ensureDir(paths.captureDir);
    writeFileSync(paths.script, 'legacy hook');
    writeFileSync(paths.config, JSON.stringify({ previousCommand: null }));
    writeFileSync(
      paths.state,
      JSON.stringify({
        v: 1,
        settingsPath,
        node: process.execPath,
        script: paths.script,
        wrapper,
        previousStatusLine: null,
        backupPath: null,
        installedAt: NOW,
      }),
    );

    for (const offset of [0, 1_000]) {
      const server = await boot(config, {
        logger: memoryLogger().logger,
        listen: fakeListen().listen,
        now: () => NOW + offset,
        timezone: TZ,
        scheduler: false,
        claude: { env: { CLAUDE_CONFIG_DIR: profile }, home: profile },
      });
      try {
        expect(server.mode).toBe('normal');
        expect(
          server.db!.prepare('SELECT session_id, provider_total FROM usage_event').get(),
        ).toMatchObject({ session_id: 7, provider_total: 10 });
        expect(
          server.db!.prepare('SELECT session_id, decision FROM owner_link_decision').get(),
        ).toMatchObject({ session_id: 7, decision: 'confirmed' });
        expect(server.db!.prepare('SELECT id, backfill_complete FROM repo').get()).toMatchObject({
          id: 'owner/repo',
          backfill_complete: 0,
        });
        const sources = await call(server.app as never, '/api/sources', { headers: HOST });
        expect(await sources.json()).toMatchObject({
          accounts: [
            { id: 'claude', captureEnabled: false, captureHealth: { phase: 'awaiting_removal' } },
          ],
        });
        expect(readFileSync(settingsPath, 'utf8')).toBe(providerSettings);
      } finally {
        await server.shutdown();
      }
    }
  });

  it('marks a run left `running` by a dead process as interrupted, before it listens', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    const first = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    first
      .db!.prepare(
        "INSERT INTO refresh_run (id, trigger, started_at, state, per_source_json) VALUES (7, 'schedule', ?, 'running', ?)",
      )
      .run(
        NOW - 60_000,
        JSON.stringify({
          codex: { state: 'running' },
          claude: { state: 'succeeded', imported: 4 },
          paseo: { state: 'queued' },
        }),
      );
    await first.shutdown();

    const later = NOW + 5 * 60_000;
    const { logger, entries } = memoryLogger();
    const second = await boot(config, { logger, listen, now: () => later, timezone: TZ });
    const run = second
      .db!.prepare('SELECT state, finished_at, per_source_json FROM refresh_run WHERE id = 7')
      .get() as {
      state: string;
      finished_at: number;
      per_source_json: string;
    };
    expect(run.state).toBe('interrupted');
    expect(run.finished_at).toBe(later);
    const sources = JSON.parse(run.per_source_json) as Record<
      string,
      { state: string; message?: string }
    >;
    expect(sources['codex']!.state).toBe('failed');
    expect(sources['paseo']!.state).toBe('failed');
    expect(sources['claude']).toEqual({ state: 'succeeded', imported: 4 }); // finished work is left alone
    expect(entries.find((e) => e['step'] === 'interrupted')).toMatchObject({ runs: 1 });
    await second.shutdown();
  });

  it('prunes what is older than today minus 366 days at boot, and never the repo list or meta', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    const seedServer = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    const db = seedServer.db!;
    const cutoff = utcBounds(addDays('2026-11-04', -366), TZ).start;
    db.exec(`
      INSERT INTO repo (id, display_name, tracking_state, access_state, added_at) VALUES ('kelvin/old', 'kelvin/old', 'stopped', 'ok', 1);
      INSERT INTO session (id, provider, provider_session_id, kind, started_at, started_basis) VALUES
        (1, 'codex', 'old-only', 'root', 1, 'source_start'), (2, 'codex', 'straddles', 'root', 1, 'source_start'),
        (3, 'claude', 'recent', 'root', ${cutoff}, 'first_event');
      INSERT INTO session_ref (session_id, kind, value, observed_at) VALUES (1, 'branch', 'main', 1), (3, 'branch', 'main', ${cutoff});
      INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total) VALUES
        ('codex', 'a', 1, ${cutoff - 1}, 'm', 5), ('codex', 'b', 2, ${cutoff - 1}, 'm', 5), ('codex', 'c', 2, ${cutoff}, 'm', 7),
        ('claude', 'd', 3, ${cutoff + 1000}, 'm', 9);
      INSERT INTO pull_request (node_id, repo_id, number, title, url, merged_at) VALUES
        ('old', 'kelvin/old', 1, 't', 'https://x.test/1', ${cutoff - 1}), ('new', 'kelvin/old', 2, 't', 'https://x.test/2', ${cutoff});
      INSERT INTO pr_commit (pr_node_id, sha) VALUES ('old', 'aaa'), ('new', 'bbb');
      INSERT INTO pr_session_link (pr_node_id, session_id, class, basis, computed_at) VALUES ('old', 1, 'evidence', 'x', 1), ('new', 2, 'suggested', 'x', 1);
      INSERT INTO owner_link_decision (pr_node_id, session_id, decision, decided_at) VALUES ('old', 1, 'confirmed', 1), ('new', 2, 'rejected', 1);
    `);
    await seedServer.shutdown();

    const second = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    const all = (sql: string) => second.db!.prepare(sql).all();
    expect(all('SELECT dedupe_key FROM usage_event ORDER BY dedupe_key')).toEqual([
      { dedupe_key: 'c' },
      { dedupe_key: 'd' },
    ]);
    expect(all('SELECT id FROM session ORDER BY id')).toEqual([{ id: 2 }, { id: 3 }]); // session 1 had only pruned events
    expect(all('SELECT session_id FROM session_ref')).toEqual([{ session_id: 3 }]);
    expect(all('SELECT node_id FROM pull_request')).toEqual([{ node_id: 'new' }]);
    expect(all('SELECT sha FROM pr_commit')).toEqual([{ sha: 'bbb' }]);
    expect(all('SELECT pr_node_id FROM pr_session_link')).toEqual([{ pr_node_id: 'new' }]);
    expect(all('SELECT pr_node_id FROM owner_link_decision')).toEqual([{ pr_node_id: 'new' }]); // decisions go only with their PR
    expect(all('SELECT id FROM repo')).toEqual([{ id: 'kelvin/old' }]); // stopped repos are kept
    expect(all("SELECT key FROM app_meta WHERE key = 'install_id'")).toHaveLength(1);
    await second.shutdown();
  });
});

describe('a corrupt or unusable database serves the recovery page and is never touched', () => {
  const recoveryChecks = async (config: ReturnType<typeof tempConfig>, reason: string) => {
    const before = fingerprint(config.dbPath);
    const { logger } = memoryLogger();
    const { listen, calls } = fakeListen();
    const server = await boot(config, { logger, listen, now: () => NOW, timezone: TZ });
    expect(server.mode).toBe('recovery');
    expect(server.recovery?.reason).toBe(reason);
    expect(calls).toHaveLength(1); // it still listens, to show the page

    const page = await server.app.request(`http://127.0.0.1:${PORT}/`, { headers: HOST });
    expect(page.status).toBe(503);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain(config.dbPath);
    expect(html).toContain('Move it aside and start fresh');
    expect(html).toContain('Nothing was deleted');

    const deep = await server.app.request(`http://127.0.0.1:${PORT}/delivery`, { headers: HOST });
    expect(deep.status).toBe(503);
    const api = await server.app.request(`http://127.0.0.1:${PORT}/api/health`, { headers: HOST });
    expect(api.status).toBe(503);
    expect(ErrorEnvelope.parse(await api.json()).error.details).toMatchObject({
      recovery: true,
      reason,
      dbPath: config.dbPath,
    });
    // The guards still apply on the recovery app.
    expect(
      (await server.app.request(`http://127.0.0.1:${PORT}/`, { headers: { host: 'evil.example' } }))
        .status,
    ).toBe(421);
    expect(
      (
        await server.app.request(`http://127.0.0.1:${PORT}/api/refresh`, {
          method: 'POST',
          headers: HOST,
        })
      ).status,
    ).toBe(403);

    await server.shutdown();
    expect(fingerprint(config.dbPath)).toEqual(before); // same bytes, same size, same modified time
    return { html, server };
  };

  it('a file that is not a database', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    // Create the data dir through a first boot, then replace the database with junk.
    await (
      await boot(config, { logger: memoryLogger().logger, listen, now: () => NOW, timezone: TZ })
    ).shutdown();
    for (const suffix of ['-wal', '-shm'])
      if (existsSync(config.dbPath + suffix)) writeFileSync(config.dbPath + suffix, '');
    writeFileSync(config.dbPath, 'not a database '.repeat(200));
    const { html } = await recoveryChecks(config, 'corrupt');
    expect(html).toContain('can’t be read');
    expect(
      readdirSync(join(config.dataDir))
        .filter((name) => name.startsWith('agent-productivity.db'))
        .sort(),
    ).toEqual(
      ['agent-productivity.db', 'agent-productivity.db-shm', 'agent-productivity.db-wal']
        .filter((name) => existsSync(join(config.dataDir, name)))
        .sort(),
    );
  });

  it('a real database with a damaged page', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    const first = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    first.db!.exec('CREATE TABLE IF NOT EXISTS filler (a TEXT) STRICT');
    const insert = first.db!.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)');
    for (let i = 0; i < 600; i++) insert.run(`k${i}`, 'x'.repeat(200));
    first.db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await first.shutdown();
    // Overwrite page 3 with noise: the b-tree page header is no longer valid.
    const fd = openSync(config.dbPath, 'r+');
    writeSync(fd, Buffer.alloc(4096, 0xa7), 0, 4096, 2 * 4096);
    closeSync(fd);
    expect(checkIntegrity(config.dbPath).ok).toBe(false);
    await recoveryChecks(config, 'corrupt');
  });

  it('a migration that fails: the file is rolled back and left as it was', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    await (
      await boot(config, { logger: memoryLogger().logger, listen, now: () => NOW, timezone: TZ })
    ).shutdown();
    // An `app_meta` table with no schema_version makes migration 001's CREATE TABLE fail.
    const db = new DatabaseSync(config.dbPath);
    db.exec("DROP TABLE refresh_run; DELETE FROM app_meta WHERE key = 'schema_version';");
    db.close();
    const { html } = await recoveryChecks(config, 'migration_failed');
    expect(html).toContain(join(MIGRATIONS_DIR, '001_init.sql'));
  });

  it('a database from a newer version', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    await (
      await boot(config, { logger: memoryLogger().logger, listen, now: () => NOW, timezone: TZ })
    ).shutdown();
    const db = new DatabaseSync(config.dbPath);
    db.exec("UPDATE app_meta SET value = '9' WHERE key = 'schema_version';");
    db.close();
    const { html } = await recoveryChecks(config, 'newer_schema');
    expect(html).toContain('newer version');
  });

  it('a healthy database leaves recovery out of it', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    ensureDir(config.dataDir);
    const db = openDatabase(config.dbPath);
    migrate(db);
    db.close();
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    expect(server.mode).toBe('normal');
    expect(server.recovery).toBeNull();
    await server.shutdown();
  });
});

describe('one instance per data directory', () => {
  async function contender(dataDir: string, port: number, children: ChildProcess[]) {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { AlreadyRunningError, boot } from './src/server/boot.ts';
         import { loadConfig } from './src/server/lib/config.ts';
         process.on('message', async (message) => {
           if (message !== 'start') return;
           try {
             const running = await boot(loadConfig(), { listen: async () => ({ close() {} }) });
             process.send(running.db ? 'owner' : 'pointer');
           } catch (error) {
             process.send(error instanceof AlreadyRunningError ? 'busy' : String(error));
           }
         });
         process.send('ready');`,
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          AGENT_PRODUCTIVITY_DATA_DIR: dataDir,
          AGENT_PRODUCTIVITY_PORT: String(port),
        },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      },
    );
    children.push(child);
    const exited = once(child, 'exit');
    expect((await Promise.race([once(child, 'message'), exited]))[0]).toBe('ready');
    return { child, exited };
  }

  it.each([PORT, PORT + 1])(
    'elects one owner across processes with contender port %i and recovers after abrupt exit',
    async (otherPort) => {
      const config = tempConfig();
      const children: ChildProcess[] = [];
      try {
        const contenders = await Promise.all([
          contender(config.dataDir, PORT, children),
          contender(config.dataDir, otherPort, children),
        ]);
        const results = contenders.map(({ child, exited }) => {
          const result = Promise.race([once(child, 'message'), exited]);
          child.send('start');
          return result;
        });
        const modes = (await Promise.all(results)).map(([mode]) => mode);
        expect(modes.filter((mode) => mode === 'owner')).toHaveLength(1);
        const ownerIndex = modes.indexOf('owner');
        expect(modes[1 - ownerIndex]).toMatch(otherPort === PORT ? /^busy$/ : /^(busy|pointer)$/);
        const owner = contenders[ownerIndex]!;
        const diagnostic = readFileSync(config.lockPath);
        owner.child.kill('SIGKILL');
        await owner.exited;
        expect(readFileSync(config.lockPath)).toEqual(diagnostic);

        const next = await contender(config.dataDir, PORT, children);
        const result = Promise.race([once(next.child, 'message'), next.exited]);
        next.child.send('start');
        expect((await result)[0]).toBe('owner');
        expect(modeOf(join(config.dataDir, 'agent-productivity-lock.sqlite'))).toBe(0o600);
      } finally {
        await Promise.all(
          children.map(async (child) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
          }),
        );
      }
    },
  );

  it('refuses to open the application database while a contender holds the SQLite lock before publication', async () => {
    const config = tempConfig();
    const { listen, calls } = fakeListen();
    ensureDir(config.dataDir);
    const sidecar = new DatabaseSync(join(config.dataDir, 'agent-productivity-lock.sqlite'));
    sidecar.exec('BEGIN IMMEDIATE');
    try {
      await expect(boot(config, { logger: memoryLogger().logger, listen })).rejects.toBeInstanceOf(
        AlreadyRunningError,
      );
      expect(existsSync(config.dbPath)).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      sidecar.close();
    }
  });

  it('leaves an in-flight legacy claim in place when its owner record is not yet available', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    ensureDir(config.dataDir);
    const legacy = openSync(config.lockPath, 'wx', 0o600);
    try {
      await expect(boot(config, { logger: memoryLogger().logger, listen })).rejects.toBeInstanceOf(
        AlreadyRunningError,
      );
      expect(statSync(config.lockPath).size).toBe(0);
      expect(existsSync(config.dbPath)).toBe(false);
    } finally {
      closeSync(legacy);
    }
  });

  it('a second boot is refused while the first holds the lock, and a stale lock is replaced', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    const first = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    await expect(
      boot(config, { logger: memoryLogger().logger, listen, now: () => NOW, timezone: TZ }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);
    await first.shutdown();
    expect(existsSync(config.lockPath)).toBe(false); // released on shutdown

    writeFileSync(
      config.lockPath,
      JSON.stringify({ pid: 2 ** 31 - 2, port: PORT, startedAt: 'long ago' }),
    ); // no such process
    const again = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    expect(again.mode).toBe('normal');
    await again.shutdown();
  });

  it('replaces stale v2 diagnostics when the PID is live and the SQLite lease is free', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    ensureDir(config.dataDir);
    writeFileSync(
      config.lockPath,
      JSON.stringify({ pid: process.pid, port: PORT + 1, startedAt: 'old', version: 2 }),
    );
    const server = await boot(config, { logger: memoryLogger().logger, listen });
    try {
      expect(server.mode).toBe('normal');
      expect(JSON.parse(readFileSync(config.lockPath, 'utf8'))).toMatchObject({
        port: config.port,
      });
    } finally {
      await server.shutdown();
    }
  });

  it('a second process prints "already running" and exits without starting', async () => {
    const config = tempConfig(4411);
    const { listen } = fakeListen();
    const first = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    const before = fingerprint(config.dbPath);

    const second = spawnSync(process.execPath, ['src/server/main.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        AGENT_PRODUCTIVITY_DATA_DIR: config.dataDir,
        AGENT_PRODUCTIVITY_PORT: '4411',
        NODE_ENV: 'production',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(second.stdout.split('\n')[0]).toBe(
      'Agent Productivity HQ is already running at http://127.0.0.1:4411',
    );
    expect(second.stdout).toContain(config.lockPath);
    expect(second.status).toBe(0);
    expect(fingerprint(config.dbPath).sha).toBe(before.sha);
    await first.shutdown();
  });

  it('releases the lock and the database when the port is taken', async () => {
    const config = tempConfig();
    const listen: ListenFn = async () => {
      throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    };
    await expect(
      boot(config, { logger: memoryLogger().logger, listen, now: () => NOW, timezone: TZ }),
    ).rejects.toBeInstanceOf(PortInUseError);
    expect(existsSync(config.lockPath)).toBe(false);
  });
});

describe('loopback only', () => {
  it('main refuses a non-loopback host setting before it touches anything', () => {
    for (const host of ['0.0.0.0', '::', '::1', 'localhost', '192.168.1.5']) {
      const config = tempConfig();
      const run = spawnSync(process.execPath, ['src/server/main.ts'], {
        cwd: ROOT,
        env: {
          ...process.env,
          AGENT_PRODUCTIVITY_HOST: host,
          AGENT_PRODUCTIVITY_DATA_DIR: config.dataDir,
          AGENT_PRODUCTIVITY_PORT: '4412',
        },
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(run.status, host).toBe(1);
      expect(run.stderr, host).toContain('only listens on 127.0.0.1');
      expect(existsSync(config.dataDir), host).toBe(false);
    }
  });

  it('always asks the listener for 127.0.0.1', async () => {
    const config = tempConfig();
    const { listen, calls } = fakeListen();
    await (
      await boot(config, { logger: memoryLogger().logger, listen, now: () => NOW, timezone: TZ })
    ).shutdown();
    expect(calls.map((c) => c.host)).toEqual(['127.0.0.1']);
  });
});

describe('graceful shutdown waits at most 5 seconds', () => {
  it.each([1, 2])(
    'cancels %i overlapping GitHub sign-ins during identity checks',
    async (count) => {
      const config = tempConfig();
      const github = createFakeGithub({ now: () => NOW });
      github.signOutGh();
      github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
      const keyring = createMemoryKeyring();
      const responses = Array.from({ length: count }, () => ({ code: gate(), identity: gate() }));
      const finishIdentity = gate();
      let deviceRequests = 0;
      let identityRequests = 0;
      const server = await boot(config, {
        listen: fakeListen().listen,
        logger: memoryLogger().logger,
        now: () => NOW,
        scheduler: false,
        github: {
          gh: github.gh,
          keyring,
          sleep: async () => {},
          net: async (url, init) => {
            if (url === 'https://github.com/login/device/code') {
              await responses[deviceRequests++]!.code.promise;
            }
            if (url === 'https://api.github.com/user') {
              responses[identityRequests++]!.identity.release();
              await finishIdentity.promise;
            }
            return github.net(url, init);
          },
        },
      });
      try {
        server
          .db!.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
          .run('github_app_client_id', 'Iv1.testclient');
        const requests = responses.map(() =>
          call(server.app as never, '/api/accounts/github/connect', {
            method: 'POST',
            headers: WRITE,
            body: '{}',
          }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(deviceRequests).toBe(count);
        for (const [index, response] of responses.entries()) {
          response.code.release();
          const started = await requests[index]!;
          expect(started.status).toBe(200);
          expect(await started.json()).toMatchObject({ mode: 'device' });
          await response.identity.promise;
        }
        await server.shutdown();
        finishIdentity.release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(keyring.snapshot()).toHaveLength(0);
      } finally {
        for (const response of responses) response.code.release();
        finishIdentity.release();
        await server.shutdown();
      }
    },
  );

  it('is five seconds by default', () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(5000);
  });

  it('returns promptly when the server closes, and releases everything', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
    });
    const started = Date.now();
    await server.shutdown();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(() => server.db!.prepare('SELECT 1').get()).toThrow(/not open/i);
    expect(existsSync(config.lockPath)).toBe(false);
  });

  it('drains an accepted HTTP write and the refresh it starts before releasing ownership', async () => {
    const config = tempConfig();
    let fetchRequest!: Parameters<ListenFn>[0]['fetch'];
    let finishRefresh!: (result: { result: 'succeeded' }) => void;
    const refresh = new Promise<{ result: 'succeeded' }>((resolve) => {
      finishRefresh = resolve;
    });
    const { listen } = fakeListen();
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen: async (options) => {
        fetchRequest = options.fetch;
        return listen(options);
      },
      adapters: [{ id: 'codex', refresh: () => refresh }],
    });
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const request = fetchRequest(
      new Request(`http://127.0.0.1:${PORT}/api/refresh`, {
        method: 'POST',
        headers: WRITE,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
        }),
        duplex: 'half',
      } as RequestInit),
    );
    const stopping = server.shutdown();
    body.enqueue(new TextEncoder().encode('{}'));
    body.close();
    expect((await request).status).toBe(202);
    try {
      await expect(boot(config, { logger: memoryLogger().logger, listen })).rejects.toBeInstanceOf(
        AlreadyRunningError,
      );
    } finally {
      finishRefresh({ result: 'succeeded' });
      await stopping;
    }
    expect(existsSync(config.lockPath)).toBe(false);
  });

  it('cuts a request that will not finish once the grace period is up', async () => {
    const config = tempConfig();
    let cut = 0;
    const { listen } = fakeListen({
      close: () => undefined,
      closeAllConnections: () => void cut++,
    });
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
      shutdownTimeoutMs: 150,
    });
    const started = Date.now();
    await server.shutdown();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(2000);
    expect(cut).toBe(1);
    expect(existsSync(config.lockPath)).toBe(false);
    await server.shutdown(); // idempotent
  });
});

describe('private files', () => {
  it('data dir 0700 and every file 0600, even under a wide-open umask', async () => {
    const previous = process.umask(0);
    try {
      const config = tempConfig();
      const { listen } = fakeListen();
      const server = await boot(config, { listen, now: () => NOW, timezone: TZ }); // default logger: <data>/logs/agent-productivity.log
      server.db!.prepare("INSERT INTO app_meta (key, value) VALUES ('probe', '1')").run(); // makes sure -wal exists
      expect(modeOf(config.dataDir)).toBe(0o700);
      expect(modeOf(config.logDir)).toBe(0o700);
      const files = readdirSync(config.dataDir).filter(
        (n) => n.startsWith('agent-productivity.db') || n === 'agent-productivity.lock',
      );
      expect(files).toEqual(
        expect.arrayContaining(['agent-productivity.db', 'agent-productivity.lock']),
      );
      for (const name of files) expect(modeOf(join(config.dataDir, name)), name).toBe(0o600);
      expect(modeOf(join(config.logDir, 'agent-productivity.log'))).toBe(0o600);
      await server.shutdown();
    } finally {
      process.umask(previous);
    }
  });

  it('tightens a data directory that already exists with loose modes', async () => {
    const config = tempConfig();
    const { listen } = fakeListen();
    await (await boot(config, { listen, now: () => NOW, timezone: TZ })).shutdown();
    execFileSync('chmod', ['755', config.dataDir]);
    execFileSync('chmod', ['644', config.dbPath]);
    await (await boot(config, { listen, now: () => NOW, timezone: TZ })).shutdown();
    expect(modeOf(config.dataDir)).toBe(0o700);
    expect(modeOf(config.dbPath)).toBe(0o600);
  });
});

describe('the refresh runner in boot', () => {
  const finished = async (app: Parameters<typeof call>[0], id: number) => {
    for (let i = 0; i < 200; i += 1) {
      const run = RefreshRun.parse(
        await (await call(app, `/api/refresh/${id}`, { headers: HOST })).json(),
      );
      if (run.state !== 'running') return run;
      await new Promise((done) => setTimeout(done, 5));
    }
    throw new Error('the run did not finish');
  };

  it('serves the refresh routes, and with no adapters a run skips every source and records nothing', async () => {
    const { listen } = fakeListen();
    const server = await boot(tempConfig(), {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
    });
    const started = await call(server.app, '/api/refresh', {
      method: 'POST',
      headers: WRITE,
      body: '{}',
    });
    expect(started.status).toBe(202);
    const run = await finished(server.app, RefreshRun.parse(await started.json()).id);
    expect(run.state).toBe('succeeded');
    expect(Object.values(run.sources ?? {}).every((s) => s.state === 'skipped')).toBe(true);
    expect(server.db!.prepare('SELECT COUNT(*) AS n FROM source_state').get()).toEqual({ n: 0 });
    await server.shutdown();
  });

  it('runs the adapters it is given, and the answer to GET /api/sources shows what they found', async () => {
    const { listen } = fakeListen();
    const server = await boot(tempConfig(), {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
      adapters: [
        scriptedAdapter('codex', [succeeds({ imported: 2, location: '~/.codex/sessions' })]),
      ],
    });
    const started = await call(server.app, '/api/refresh', {
      method: 'POST',
      headers: WRITE,
      body: '{}',
    });
    expect((await finished(server.app, RefreshRun.parse(await started.json()).id)).state).toBe(
      'succeeded',
    );
    const sources = (await (await call(server.app, '/api/sources', { headers: HOST })).json()) as {
      sources: { id: string; location: string | null }[];
    };
    expect(sources.sources.map((s) => [s.id, s.location])).toEqual([
      ['codex', '~/.codex/sessions'],
    ]);
    await server.shutdown();
  });
});
