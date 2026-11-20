import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BootstrapResponse } from '../../../src/shared/contracts/bootstrap.ts';
import { ErrorEnvelope } from '../../../src/shared/contracts/errors.ts';
import { OverviewResponse } from '../../../src/shared/contracts/overview.ts';
import { RecordsResponse } from '../../../src/shared/contracts/prs.ts';
import { ReposResponse } from '../../../src/shared/contracts/repos.ts';
import { SeriesResponse } from '../../../src/shared/contracts/series.ts';
import { ModelsResponse } from '../../../src/shared/contracts/usage.ts';
import { discoverLocalSources } from '../../../src/server/collectors/discovery.ts';
import { readSetupState } from '../../../src/server/db/queries/setup.ts';
import { CAN_DENY } from './homes.ts';
import { answerApi, createWorld } from './world.ts';

// The bridge a browser spec relies on, checked without a browser: a request in, the app's own answer out.
const json = (answer: { body: Buffer }) => JSON.parse(answer.body.toString('utf8')) as unknown;

describe('the real-API world', () => {
  it('answers GET /api/bootstrap and /api/repos from the seeded database with the guards satisfied', async () => {
    const world = createWorld();
    try {
      const boot = await answerApi(world.app, {
        method: 'GET',
        path: '/api/bootstrap',
        // What a browser sends: a Host the guard would refuse, and headers that mean nothing to the app.
        headers: { host: 'crew.test', origin: 'http://crew.test', accept: '*/*' },
      });
      expect(boot.status).toBe(200);
      expect(boot.headers['cache-control']).toBe('no-store');
      expect(BootstrapResponse.parse(json(boot))).toMatchObject({
        today: '2026-11-04',
        timezone: 'America/Los_Angeles',
        setupComplete: true,
      });
      const repos = await answerApi(world.app, { method: 'GET', path: '/api/repos', headers: {} });
      expect(ReposResponse.parse(json(repos)).active?.length).toBeGreaterThan(0);
    } finally {
      world.close();
    }
  });

  it('serves the review routes over the seeded database, so a browser spec reads the real Overview, series, records and models', async () => {
    const world = createWorld();
    try {
      const get = async (path: string) => {
        const answer = await answerApi(world.app, { method: 'GET', path, headers: {} });
        expect(answer.status, path).toBe(200);
        return json(answer);
      };
      const range = 'start=2026-10-05&end=2026-11-04&author=all';
      const overview = OverviewResponse.parse(await get(`/api/overview?${range}`));
      expect(overview.scope.end).toBe('2026-11-04');
      expect(overview.kpis.mergedPrs?.value).toBeGreaterThan(0);
      expect(overview.coverage.sources?.length).toBeGreaterThan(0);
      const series = SeriesResponse.parse(await get(`/api/series?${range}&gran=week`));
      expect(series.buckets.length).toBeGreaterThan(3);
      const first = series.buckets[1]!;
      const records = RecordsResponse.parse(
        await get(`/api/records?start=${first.start}&end=${first.end}&author=all`),
      );
      expect(records.prTotal).toBe(first.prs);
      expect(
        Object.keys(ModelsResponse.parse(await get(`/api/models?${range}`))).length,
      ).toBeGreaterThan(0);
    } finally {
      world.close();
    }
  });

  it('keeps the CSRF guard: a write without the app header is refused, with it the route is reached', async () => {
    const world = createWorld();
    try {
      const refused = await answerApi(world.app, {
        method: 'POST',
        path: '/api/refresh',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}'),
      });
      expect(refused.status).toBe(403);
      expect(ErrorEnvelope.parse(json(refused)).error.code).toBe('forbidden_origin');
      const reached = await answerApi(world.app, {
        method: 'POST',
        path: '/api/refresh',
        headers: { 'content-type': 'application/json', 'x-agent-productivity-request': '1' },
        body: Buffer.from('{}'),
      });
      // Not served yet at this point in M4, so the guard let it through to the not-found envelope; later it is a 202.
      expect([202, 404]).toContain(reached.status);
    } finally {
      world.close();
    }
  });

  it('answers an unknown API path with the error envelope, never the app shell', async () => {
    const world = createWorld();
    try {
      const answer = await answerApi(world.app, { method: 'GET', path: '/api/nope', headers: {} });
      expect(answer.status).toBe(404);
      expect(ErrorEnvelope.parse(json(answer)).error.code).toBe('not_found');
    } finally {
      world.close();
    }
  });

  it('seeds the scenario it is asked for and moves its clock on request', async () => {
    const world = createWorld({ scenario: 'refresh-failed' });
    try {
      const boot = BootstrapResponse.parse(
        json(await answerApi(world.app, { method: 'GET', path: '/api/bootstrap', headers: {} })),
      );
      expect(boot.issues.map((i) => i.id)).toContain('codex');
      world.setNow(Date.parse('2026-11-05T20:00:00Z'));
      const later = BootstrapResponse.parse(
        json(await answerApi(world.app, { method: 'GET', path: '/api/bootstrap', headers: {} })),
      );
      expect(later.today).toBe('2026-11-05');
    } finally {
      world.close();
    }
  });

  it('removes its database and folder on close, and the empty scenario has no repos', async () => {
    const world = createWorld({ scenario: 'empty' });
    const path = world.db.location();
    expect(path && existsSync(path)).toBe(true);
    const repos = await answerApi(world.app, { method: 'GET', path: '/api/repos', headers: {} });
    expect(ReposResponse.parse(json(repos))).toEqual({ active: [], stopped: [] });
    world.close();
    expect(path && existsSync(path)).toBe(false);
  });
});

// A first launch and the homes Setup's discovery looks at (G10_1; P-39, P-40): a spec asks for a brand-new install, or for a home where
// Claude Code and Codex are found, absent or denied, at their default folders or at the override variables' ones.
describe('the first-launch world', () => {
  const setupComplete = async (world: ReturnType<typeof createWorld>) => {
    const boot = await answerApi(world.app, { method: 'GET', path: '/api/bootstrap', headers: {} });
    return BootstrapResponse.parse(json(boot)).setupComplete;
  };

  it('has not finished setup, and has no repos and no sources: a brand-new install', async () => {
    const world = createWorld({ firstLaunch: true });
    try {
      expect(await setupComplete(world)).toBe(false);
      expect(readSetupState(world.db).complete).toBe(false);
      const repos = await answerApi(world.app, { method: 'GET', path: '/api/repos', headers: {} });
      expect(ReposResponse.parse(json(repos))).toEqual({ active: [], stopped: [] });
    } finally {
      world.close();
    }
  });

  it('is the only world that has not: the default one and the empty scenario have finished setup', async () => {
    for (const options of [{}, { scenario: 'empty' as const }, { scenario: 'no-repos' as const }]) {
      const world = createWorld(options);
      try {
        expect(await setupComplete(world), JSON.stringify(options)).toBe(true);
      } finally {
        world.close();
      }
    }
  });

  it('keeps a first launch first-launch even when a scenario is named: it is always the empty world', async () => {
    const world = createWorld({ firstLaunch: true, scenario: 'typical' });
    try {
      expect(await setupComplete(world)).toBe(false);
      const repos = await answerApi(world.app, { method: 'GET', path: '/api/repos', headers: {} });
      expect(ReposResponse.parse(json(repos))).toEqual({ active: [], stopped: [] });
    } finally {
      world.close();
    }
  });
});

describe('the homes for Setup', () => {
  it('finds Claude Code and Codex at their default folders, with no variable set', async () => {
    const world = createWorld({ firstLaunch: true });
    try {
      const { home, env } = world.homes.make();
      expect(env).toEqual({});
      const report = await discoverLocalSources({ env, home });
      expect(report.claude).toMatchObject({ status: 'ok' });
      expect(report.claude.files).toBeGreaterThan(0);
      expect(report.codex).toMatchObject({ status: 'ok' });
      expect(report.codex.files).toBeGreaterThan(0);
    } finally {
      world.close();
    }
  });

  it('says not found for a provider that is absent, and one provider’s absence is not the other’s', async () => {
    const world = createWorld({ firstLaunch: true });
    try {
      const { home, env } = world.homes.make({ claude: 'absent' });
      const report = await discoverLocalSources({ env, home });
      expect(report.claude).toMatchObject({ status: 'notfound', files: 0 });
      expect(report.codex.status).toBe('ok');
      const none = world.homes.make({ claude: 'absent', codex: 'absent' });
      const nothing = await discoverLocalSources({ env: none.env, home: none.home });
      expect(nothing.claude.status).toBe('notfound');
      expect(nothing.codex.status).toBe('notfound');
    } finally {
      world.close();
    }
  });

  it('finds a provider at the override variable’s folder, and says not found when the variable points at nothing', async () => {
    const world = createWorld({ firstLaunch: true });
    try {
      const there = world.homes.make({ claudeAt: 'override', codexAt: 'override' });
      expect(Object.keys(there.env).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
      const found = await discoverLocalSources({ env: there.env, home: there.home });
      expect(found.claude.status).toBe('ok');
      expect(found.codex.status).toBe('ok');
      expect(found.claude.location).toContain('elsewhere');
      // Nothing at the default place either, so what was found came from the variable.
      expect(existsSync(join(there.home, '.claude'))).toBe(false);
      expect(existsSync(join(there.home, '.codex'))).toBe(false);
      const missing = world.homes.make({
        claude: 'absent',
        codex: 'absent',
        claudeAt: 'override',
        codexAt: 'override',
      });
      const nothing = await discoverLocalSources({ env: missing.env, home: missing.home });
      expect(nothing.claude.status).toBe('notfound');
      expect(nothing.codex.status).toBe('notfound');
    } finally {
      world.close();
    }
  });

  it.skipIf(!CAN_DENY)(
    'says access denied for a folder that is there and cannot be read',
    async () => {
      const world = createWorld({ firstLaunch: true });
      try {
        const { home, env, denied } = world.homes.make({ claude: 'denied', codex: 'denied' });
        expect(denied).toHaveLength(2);
        const report = await discoverLocalSources({ env, home });
        expect(report.claude.status).toBe('denied');
        expect(report.codex.status).toBe('denied');
      } finally {
        world.close();
      }
    },
  );

  it.skipIf(!CAN_DENY)('removes every home when the world closes, permissions and all', () => {
    const world = createWorld({ firstLaunch: true });
    const a = world.homes.make({ claude: 'denied', codex: 'denied' });
    const b = world.homes.make();
    expect(existsSync(a.home) && existsSync(b.home)).toBe(true);
    world.close();
    expect(existsSync(a.home)).toBe(false);
    expect(existsSync(b.home)).toBe(false);
    a.close(); // closing again is harmless
  });

  it('copies the invented fixtures only: a found home holds provider folders and nothing else', () => {
    const world = createWorld({ firstLaunch: true });
    try {
      const { home } = world.homes.make();
      expect(readdirSync(home).sort()).toEqual(['.claude', '.codex']);
      expect(statSync(join(home, '.claude/projects')).isDirectory()).toBe(true);
    } finally {
      world.close();
    }
  });
});
