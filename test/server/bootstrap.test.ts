import { listMigrations } from '../../src/server/db/migrate.ts';
import { describe, expect, it } from 'vitest';
import { BootstrapResponse, HealthResponse } from '../../src/shared/contracts/bootstrap.ts';
import { HOST, NOW, TZ, call, memoryDb, testApp } from './helpers.ts';

describe('GET /api/health', () => {
  it('answers ok with the version and the schema version, as the contract says', async () => {
    const { app } = testApp();
    const res = await call(app, '/api/health', { headers: HOST });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(HealthResponse.parse(await res.json())).toEqual({
      status: 'ok',
      version: '0.0.0-test',
      schemaVersion: listMigrations().length,
    });
  });
});

describe('GET /api/bootstrap', () => {
  it('reports setup state, the report timezone, today from the injected clock and the lookback', async () => {
    const { app } = testApp();
    const body = BootstrapResponse.parse(
      await (await call(app, '/api/bootstrap', { headers: HOST })).json(),
    );
    expect(body).toEqual({
      setupComplete: false,
      timezone: TZ,
      today: '2026-11-04',
      lookbackStart: '2025-11-04',
      githubLogin: null,
      greetingName: null,
      issues: [],
    });
  });

  it('follows the clock: today is the date in the report timezone, not UTC', async () => {
    // 2026-11-05 03:30 UTC is still Nov 4 in Los Angeles (19:30 PST).
    const { app } = testApp();
    expect(NOW).toBeGreaterThan(0);
    const evening = Date.parse('2026-11-05T03:30:00Z');
    const { createApp } = await import('../../src/server/http/app.ts');
    const { memoryLogger } = await import('./helpers.ts');
    const { createRunner } = await import('../../src/server/collectors/runner.ts');
    const lateDb = memoryDb();
    const lateLogger = memoryLogger().logger;
    const late = createApp({
      db: lateDb,
      logger: lateLogger,
      runner: createRunner({ db: lateDb, now: () => evening, logger: lateLogger, adapters: [] }),
      port: 4317,
      now: () => evening,
      timezone: TZ,
      version: 'x',
      staticDir: null,
    });
    const body = BootstrapResponse.parse(
      await (await call(late as never, '/api/bootstrap', { headers: HOST })).json(),
    );
    expect(body.today).toBe('2026-11-04');
    const utcDb = memoryDb();
    const utcLogger = memoryLogger().logger;
    const utc = createApp({
      db: utcDb,
      logger: utcLogger,
      runner: createRunner({ db: utcDb, now: () => evening, logger: utcLogger, adapters: [] }),
      port: 4317,
      now: () => evening,
      timezone: 'UTC',
      version: 'x',
      staticDir: null,
    });
    expect(
      BootstrapResponse.parse(
        await (await call(utc as never, '/api/bootstrap', { headers: HOST })).json(),
      ).today,
    ).toBe('2026-11-05');
    void app;
  });

  it('reflects setup completion and the GitHub login', async () => {
    const db = memoryDb();
    db.exec(
      "INSERT INTO app_meta VALUES ('setup_completed_at', '1'), ('github_login', 'kelvin'), ('github_name', 'Kelvin')",
    );
    const body = BootstrapResponse.parse(
      await (await call(testApp({ db }).app, '/api/bootstrap', { headers: HOST })).json(),
    );
    expect(body).toMatchObject({
      setupComplete: true,
      githubLogin: 'kelvin',
      greetingName: 'Kelvin',
    });
  });

  it('lists what needs attention: failed or denied sources, and tracked repos GitHub no longer allows', async () => {
    const db = memoryDb();
    db.exec(`
      INSERT INTO source_state (source_id, status) VALUES ('codex', 'failed'), ('claude', 'ok'), ('paseo', 'denied'), ('chatgpt_account', 'failed');
      INSERT INTO repo (id, display_name, tracking_state, access_state, added_at) VALUES
        ('kelvin/archive-private', 'kelvin/archive-private', 'active', 'inaccessible', 1),
        ('kelvin/stopped', 'kelvin/stopped', 'stopped', 'inaccessible', 1),
        ('kelvin/fine', 'kelvin/fine', 'active', 'ok', 1);
    `);
    const body = BootstrapResponse.parse(
      await (await call(testApp({ db }).app, '/api/bootstrap', { headers: HOST })).json(),
    );
    expect(body.issues).toEqual([
      { kind: 'source', id: 'codex', label: 'Codex couldn’t be refreshed.' },
      { kind: 'source', id: 'paseo', label: 'Access to Paseo was denied.' },
      {
        kind: 'account',
        id: 'chatgpt_account',
        label: 'ChatGPT couldn’t be refreshed.',
      },
      {
        kind: 'repo',
        id: 'kelvin/archive-private',
        label: 'GitHub no longer grants access to kelvin/archive-private.',
      },
    ]);
  });

  it('never leaks anything beyond the contract', async () => {
    const db = memoryDb();
    db.exec("INSERT INTO app_meta VALUES ('install_id', 'secret-install-id')");
    const text = await (
      await call(testApp({ db }).app, '/api/bootstrap', { headers: HOST })
    ).text();
    expect(text).not.toContain('secret-install-id');
  });
});
