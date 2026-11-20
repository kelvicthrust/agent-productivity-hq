import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createRunner, type Runner } from '../../../src/server/collectors/runner.ts';
import type { SourceAdapter } from '../../../src/server/collectors/types.ts';
import { correlation, errorHandler, type HttpEnv } from '../../../src/server/http/errors.ts';
import { csrfGuard, hostGuard } from '../../../src/server/http/guards.ts';
import { bootstrapRoutes } from '../../../src/server/http/routes/bootstrap.ts';
import { refreshRoutes } from '../../../src/server/http/routes/refresh.ts';
import { sourcesRoutes } from '../../../src/server/http/routes/sources.ts';
import { ErrorEnvelope } from '../../../src/shared/contracts/errors.ts';
import { RefreshRun, SourcesResponse } from '../../../src/shared/contracts/sources.ts';
import { HOST, NOW, PORT, TZ, WRITE, memoryDb, memoryLogger } from '../../server/helpers.ts';
import { seedDatabase, FIXED_NOW } from '../seed.ts';
import { fails, gate, holds, partial, scriptedAdapter, succeeds } from './scripted.ts';

// GET /api/sources, POST /api/refresh and GET /api/refresh/{id}, through their own Hono app (the guards and the error
// handler as createApp installs them, then only these routes), over a real schema, the seeded world and scripted adapters.

function appFor(
  options: { db?: DatabaseSync; adapters?: readonly SourceAdapter[]; now?: () => number } = {},
) {
  const db = options.db ?? memoryDb();
  const logs = memoryLogger();
  const now = options.now ?? (() => FIXED_NOW);
  const runner: Runner = createRunner({
    db,
    now,
    logger: logs.logger,
    adapters: options.adapters ?? [],
  });
  const app = new Hono<HttpEnv>();
  app.use('*', correlation());
  app.use('*', hostGuard(PORT, logs.logger));
  app.use('*', csrfGuard(logs.logger));
  app.onError(errorHandler(logs.logger));
  app.route('/', bootstrapRoutes({ db, now: () => NOW, timezone: TZ }));
  app.route('/', sourcesRoutes({ db, now, timezone: TZ }));
  app.route('/', refreshRoutes({ db, runner }));
  const get = (path: string) => app.request(`http://127.0.0.1:${PORT}${path}`, { headers: HOST });
  const post = (path: string, body?: string) =>
    app.request(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: WRITE,
      ...(body === undefined ? {} : { body }),
    });
  return { app, db, runner, get, post, entries: logs.entries };
}

const sourcesOf = async (response: Response) => SourcesResponse.parse(await response.json());
const codexOf = async (get: ReturnType<typeof appFor>['get']) =>
  (await sourcesOf(await get('/api/sources'))).sources?.find((s) => s.id === 'codex');
const issueCount = async (get: ReturnType<typeof appFor>['get']) =>
  ((await (await get('/api/bootstrap')).json()) as { issues: unknown[] }).issues.length;

describe('GET /api/sources', () => {
  it('describes the failed source the way the banner and Sources need it', async () => {
    const db = memoryDb();
    seedDatabase(db, { scenario: 'refresh-failed' });
    const { get } = appFor({ db });
    const response = await get('/api/sources');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await sourcesOf(response);

    expect(body.running).toBeNull();
    expect(body.accounts).toBeUndefined();
    // The seeded world also holds the GitHub sync's row (M6: SourceStatus.id gains 'github'); the Sources page lists it apart.
    expect(body.sources?.map((s) => s.id)).toEqual(['codex', 'claude', 'paseo', 'github']);
    const codex = body.sources?.find((s) => s.id === 'codex');
    expect(codex).toMatchObject({
      name: 'Codex',
      status: 'failed',
      location: '~/.codex/sessions',
      lastAttemptResult: 'failed',
      consecutiveFailures: 1,
      staleAfter: '2026-11-03',
      // 9:40 AM and the previous evening, in the report timezone (UTC-8 on these dates).
      lastAttemptAt: '2026-11-04T17:40:00.000Z',
      lastSuccessAt: '2026-11-04T02:12:00.000Z',
      message:
        'Couldn’t read 2 new session files (unrecognized format). Already-imported history is unaffected.',
    });
    expect(codex?.oldestDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.sources?.find((s) => s.id === 'claude')).toMatchObject({
      status: 'ok',
      consecutiveFailures: 0,
      staleAfter: null,
      message: null,
    });
    expect(body.sources?.find((s) => s.id === 'paseo')).toMatchObject({
      status: 'partial',
      unreadable: 3,
      message: expect.stringContaining('3 agent records'),
    });
  });

  it('counts each provider’s sessions with recorded usage, and gives Paseo no count', async () => {
    const db = memoryDb();
    seedDatabase(db, { scenario: 'typical' });
    const { get } = appFor({ db });
    const body = await sourcesOf(await get('/api/sources'));
    const expected = (provider: string) =>
      (
        db
          .prepare(
            'SELECT COUNT(DISTINCT s.id) AS n FROM session s JOIN usage_event ue ON ue.session_id = s.id WHERE s.provider = ?',
          )
          .get(provider) as { n: number }
      ).n;
    expect(expected('codex')).toBeGreaterThan(0);
    expect(body.sources?.find((s) => s.id === 'codex')?.sessions).toBe(expected('codex'));
    expect(body.sources?.find((s) => s.id === 'claude')?.sessions).toBe(expected('claude'));
    expect(body.sources?.find((s) => s.id === 'paseo')?.sessions).toBeNull();
  });

  it('leaves out a source nothing has checked yet, rather than inventing a state for it', async () => {
    const db = memoryDb();
    const { get } = appFor({ db });
    expect((await sourcesOf(await get('/api/sources'))).sources).toEqual([]);
    db.prepare(
      "INSERT INTO source_state (source_id, status, last_attempt_result, consecutive_failures) VALUES ('claude', 'ok', 'succeeded', 0)",
    ).run();
    expect((await sourcesOf(await get('/api/sources'))).sources?.map((s) => s.id)).toEqual([
      'claude',
    ]);
  });

  it('says which run is going', async () => {
    const held = gate();
    const t = appFor({ adapters: [scriptedAdapter('codex', [holds(held, succeeds())])] });
    expect((await sourcesOf(await t.get('/api/sources'))).running).toBeNull();
    const started = RefreshRun.parse(
      await (await t.post('/api/refresh', '{"sources":["codex"]}')).json(),
    );
    expect((await sourcesOf(await t.get('/api/sources'))).running).toBe(started.id);
    held.release();
    await t.runner.idle();
    expect((await sourcesOf(await t.get('/api/sources'))).running).toBeNull();
  });
});

describe('POST /api/refresh', () => {
  it('starts a run and answers 202 with it, every requested source queued', async () => {
    const held = gate();
    const t = appFor({
      adapters: [scriptedAdapter('codex', [holds(held, succeeds({ imported: 2 }))])],
    });
    const response = await t.post('/api/refresh', '{"sources":["codex"]}');
    expect(response.status).toBe(202);
    const run = RefreshRun.parse(await response.json());
    expect(run).toMatchObject({ state: 'running', sources: { codex: { state: 'queued' } } });
    expect(run.finishedAt).toBeNull();
    expect(Date.parse(run.startedAt)).toBe(FIXED_NOW);

    held.release();
    await t.runner.idle();
    const done = RefreshRun.parse(await (await t.get(`/api/refresh/${run.id}`)).json());
    expect(done).toMatchObject({
      id: run.id,
      state: 'succeeded',
      sources: { codex: { state: 'succeeded', imported: 2 } },
    });
    expect(done.finishedAt).not.toBeNull();
  });

  it('refreshes every source when none are named, with or without a body', async () => {
    const t = appFor({ adapters: [scriptedAdapter('codex', [succeeds()])] });
    const withEmpty = RefreshRun.parse(await (await t.post('/api/refresh', '{}')).json());
    expect(Object.keys(withEmpty.sources).sort()).toEqual([
      'chatgpt_account',
      'claude',
      'codex',
      'github',
      'paseo',
    ]);
    await t.runner.idle();
    const bare = await t.post('/api/refresh');
    expect(bare.status).toBe(202);
    await t.runner.idle();
  });

  it('answers 409 refresh_running with the running id, so the client can attach to it', async () => {
    const held = gate();
    const t = appFor({ adapters: [scriptedAdapter('codex', [holds(held, succeeds())])] });
    const first = RefreshRun.parse(
      await (await t.post('/api/refresh', '{"sources":["codex"]}')).json(),
    );
    const second = await t.post('/api/refresh', '{"sources":["codex"]}');
    expect(second.status).toBe(409);
    const envelope = ErrorEnvelope.parse(await second.json());
    expect(envelope.error).toMatchObject({
      code: 'refresh_running',
      retryable: true,
      details: { runId: first.id },
    });
    held.release();
    await t.runner.idle();
  });

  it.each([
    ['an unknown source', '{"sources":["nope"]}'],
    ['an empty list', '{"sources":[]}'],
    ['a body that is not JSON', 'sources=codex'],
    ['a body that is not an object', '"codex"'],
  ])('rejects %s with 400 invalid_input and starts nothing', async (_name, body) => {
    const t = appFor({ adapters: [scriptedAdapter('codex', [succeeds()])] });
    const response = await t.post('/api/refresh', body);
    expect(response.status).toBe(400);
    expect(ErrorEnvelope.parse(await response.json()).error.code).toBe('invalid_input');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM refresh_run').get() as { n: number }).n).toBe(
      0,
    );
  });

  it('runs a source named twice once', async () => {
    const codex = scriptedAdapter('codex', [succeeds()]);
    const t = appFor({ adapters: [codex] });
    const run = RefreshRun.parse(
      await (await t.post('/api/refresh', '{"sources":["codex","codex"]}')).json(),
    );
    expect(Object.keys(run.sources)).toEqual(['codex']);
    await t.runner.idle();
    expect(codex.calls).toBe(1);
  });

  it('is refused without the app header, like every write', async () => {
    const t = appFor();
    const response = await t.app.request(`http://127.0.0.1:${PORT}/api/refresh`, {
      method: 'POST',
      headers: HOST,
      body: '{}',
    });
    expect(response.status).toBe(403);
  });
});

describe('GET /api/refresh/{runId}', () => {
  it('answers 404 not_found for a run that does not exist, and 400 for something that is not a number', async () => {
    const { get } = appFor();
    const missing = await get('/api/refresh/999');
    expect(missing.status).toBe(404);
    expect(ErrorEnvelope.parse(await missing.json()).error.code).toBe('not_found');
    for (const bad of ['abc', '0', '-1', '1.5', '1e3']) {
      const response = await get(`/api/refresh/${bad}`);
      expect(response.status, bad).toBe(400);
    }
  });

  it('shows a run in progress source by source, which is all the client polls', async () => {
    const codexHeld = gate();
    const t = appFor({
      adapters: [
        scriptedAdapter('codex', [holds(codexHeld, succeeds())]),
        scriptedAdapter('claude', [succeeds({ imported: 1 })]),
      ],
    });
    const run = RefreshRun.parse(
      await (await t.post('/api/refresh', '{"sources":["codex","claude"]}')).json(),
    );
    await vi.waitFor(async () => {
      const polled = RefreshRun.parse(await (await t.get(`/api/refresh/${run.id}`)).json());
      expect(polled.sources['claude']?.state).toBe('succeeded');
    });
    const during = RefreshRun.parse(await (await t.get(`/api/refresh/${run.id}`)).json());
    expect(during.state).toBe('running');
    expect(during.sources['codex']?.state).toBe('running');
    expect(during.sources['claude']).toMatchObject({ state: 'succeeded', imported: 1 });
    codexHeld.release();
    await t.runner.idle();
  });
});

describe('Retry, as the client drives it', () => {
  it('failed once, failed again, then recovered: the counts, the attempt times and the issue count follow each run', async () => {
    const db = memoryDb();
    seedDatabase(db, { scenario: 'refresh-failed' });
    let now = FIXED_NOW;
    const t = appFor({
      db,
      now: () => now,
      adapters: [scriptedAdapter('codex', [fails(), succeeds({ imported: 4 })])],
    });
    // Three things need attention in the seeded world: Codex, the Claude account and the repo GitHub no longer grants access to.
    expect(await issueCount(t.get)).toBe(3);
    expect(await codexOf(t.get)).toMatchObject({ consecutiveFailures: 1 });

    // Retry, and it fails again: the same banner source now says "failed again" (2), with the new attempt time.
    now = FIXED_NOW + 12 * 60_000;
    const retry = () => t.post('/api/refresh', '{"sources":["codex"]}');
    const again = RefreshRun.parse(await (await retry()).json());
    await t.runner.idle();
    expect(RefreshRun.parse(await (await t.get(`/api/refresh/${again.id}`)).json())).toMatchObject({
      state: 'failed',
      sources: { codex: { state: 'failed' } },
    });
    expect(await codexOf(t.get)).toMatchObject({
      status: 'failed',
      consecutiveFailures: 2,
      lastAttemptResult: 'failed',
      lastAttemptAt: new Date(now).toISOString(),
      staleAfter: '2026-11-03',
    });
    expect(await issueCount(t.get)).toBe(3);

    // Retry again and it works: nothing is stale, the counter is back to 0 and the issue goes away.
    now += 60_000;
    const recovered = RefreshRun.parse(await (await retry()).json());
    await t.runner.idle();
    expect(
      RefreshRun.parse(await (await t.get(`/api/refresh/${recovered.id}`)).json()),
    ).toMatchObject({
      state: 'succeeded',
      sources: { codex: { state: 'succeeded', imported: 4 } },
    });
    expect(await codexOf(t.get)).toMatchObject({
      status: 'ok',
      consecutiveFailures: 0,
      lastAttemptResult: 'succeeded',
      lastSuccessAt: new Date(now).toISOString(),
      staleAfter: null,
      message: null,
    });
    expect(await issueCount(t.get)).toBe(2);
  });

  it('a partial attempt resets the count and keeps the source on the list with its note', async () => {
    const db = memoryDb();
    seedDatabase(db, { scenario: 'refresh-failed' });
    const t = appFor({
      db,
      adapters: [scriptedAdapter('codex', [partial({ unreadable: 2, status: 'partial' })])],
    });
    await t.post('/api/refresh', '{"sources":["codex"]}');
    await t.runner.idle();
    expect(await codexOf(t.get)).toMatchObject({
      status: 'partial',
      consecutiveFailures: 0,
      lastAttemptResult: 'partial',
      unreadable: 2,
      staleAfter: null,
    });
  });
});
