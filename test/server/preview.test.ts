import { listMigrations } from '../../src/server/db/migrate.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boot, type ListenFn } from '../../src/server/boot.ts';
import { BootstrapResponse, HealthResponse } from '../../src/shared/contracts/bootstrap.ts';
import { FIXED_NOW, FIXED_TIMEZONE, PREVIEW_LABEL, seedFile } from '../fixtures/seed.ts';
import { HOST, PORT, memoryLogger, tempConfig, tempDir } from './helpers.ts';

const listen: ListenFn = async () => ({ close: (cb) => cb?.() });
const INDEX =
  '<!doctype html><html lang="en"><head><title>Agent Productivity HQ</title></head><body><div id="root"></div></body></html>';

function spa() {
  const dir = join(tempDir(), 'client');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), INDEX);
  return dir;
}

describe('the seeded preview server', () => {
  it('serves the seeded world with a fixed clock and zone, and the "Synthetic preview data" label', async () => {
    const config = tempConfig();
    const summary = seedFile(config.dbPath);
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => FIXED_NOW,
      timezone: FIXED_TIMEZONE,
      previewLabel: PREVIEW_LABEL,
      scheduler: false,
      staticDir: spa(),
    });
    expect(server.mode).toBe('normal');

    const bootstrap = BootstrapResponse.parse(
      await (
        await server.app.request(`http://127.0.0.1:${PORT}/api/bootstrap`, { headers: HOST })
      ).json(),
    );
    expect(bootstrap).toEqual({
      setupComplete: true,
      timezone: 'America/Los_Angeles',
      today: '2026-11-04',
      lookbackStart: '2025-11-04',
      githubLogin: 'kelvin',
      greetingName: null,
      issues: [
        {
          kind: 'repo',
          id: 'kelvin/archive-private',
          label: 'GitHub no longer grants access to kelvin/archive-private.',
        },
      ],
    });
    const health = HealthResponse.parse(
      await (
        await server.app.request(`http://127.0.0.1:${PORT}/api/health`, { headers: HOST })
      ).json(),
    );
    expect(health.schemaVersion).toBe(listMigrations().length);

    const page = await (
      await server.app.request(`http://127.0.0.1:${PORT}/`, { headers: HOST })
    ).text();
    expect(page).toContain(`>${PREVIEW_LABEL}</aside>`);
    expect(page).toContain(`${PREVIEW_LABEL}</title>`);

    // Boot's retention uses the fixed clock, so it keeps the whole synthetic year.
    const count = (table: string) =>
      (server.db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('session')).toBe(summary.counts['sessions']);
    expect(count('usage_event')).toBe(summary.counts['events']);
    expect(count('pull_request')).toBe(summary.counts['pullRequests']);
    await server.shutdown();
  });

  it('does not show the label on the real server, which never sets it', async () => {
    const config = tempConfig();
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      scheduler: false,
      staticDir: spa(),
    });
    const page = await (
      await server.app.request(`http://127.0.0.1:${PORT}/`, { headers: HOST })
    ).text();
    expect(page).not.toContain(PREVIEW_LABEL);
    await server.shutdown();
  });

  it('reflects the scenario: a failed Codex refresh shows up as an issue', async () => {
    const config = tempConfig();
    seedFile(config.dbPath, { scenario: 'refresh-failed' });
    const server = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => FIXED_NOW,
      timezone: FIXED_TIMEZONE,
      scheduler: false,
      staticDir: null,
    });
    const body = BootstrapResponse.parse(
      await (
        await server.app.request(`http://127.0.0.1:${PORT}/api/bootstrap`, { headers: HOST })
      ).json(),
    );
    expect(body.issues.map((i) => i.id)).toEqual([
      'codex',
      'claude_account',
      'kelvin/archive-private',
    ]);
    await server.shutdown();
  });
});
