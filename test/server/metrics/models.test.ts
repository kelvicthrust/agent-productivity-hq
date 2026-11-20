import { describe, expect, it } from 'vitest';
import {
  addModelEvent,
  addRepo,
  addSession,
  addSource,
  at,
  get,
  memoryDb,
  metricsApp,
  models,
} from './helpers.ts';

// GET /api/models: token share per model WITHIN each provider, never across (the providers count tokens differently).

const API = 'kelvin/atlas-api';
const WEEK = '?start=2026-11-02&end=2026-11-08';

function world() {
  const db = memoryDb();
  addRepo(db, API);
  addRepo(db, 'kelvin/atlas-web');
  addSource(db, 'codex');
  addSource(db, 'claude');
  const day = at('2026-11-03');
  const codexA = addSession(db, { id: 1, provider: 'codex', repo: API, startedAt: day });
  const codexB = addSession(db, {
    id: 2,
    provider: 'codex',
    repo: 'kelvin/atlas-web',
    startedAt: day,
  });
  const claudeA = addSession(db, { id: 3, provider: 'claude', repo: API, startedAt: day });
  addModelEvent(db, 'gpt-5-codex', { session: codexA, at: day + 1000, input: 600 });
  addModelEvent(db, 'gpt-5-codex', { session: codexB, at: day + 2000, input: 200 });
  addModelEvent(db, 'gpt-5-codex-mini', {
    session: codexA,
    at: day + 3000,
    input: 150,
    output: 50,
  });
  addModelEvent(db, 'claude-opus-5-5', {
    session: claudeA,
    at: day + 4000,
    input: 10,
    cacheRead: 20,
  });
  addModelEvent(db, 'claude-haiku-5-5', { session: claudeA, at: day + 5000, output: 70 });
  return db;
}

describe('GET /api/models', () => {
  it('shares each provider’s tokens among its own models, largest first, with the sessions that used each', async () => {
    const body = await models(metricsApp(world()), WEEK);
    expect(body.codex).toEqual({
      coverage: 'ok',
      rows: [
        { model: 'gpt-5-codex', tokens: 800, sessions: 2, sharePercent: 80 },
        { model: 'gpt-5-codex-mini', tokens: 200, sessions: 1, sharePercent: 20 },
      ],
    });
    expect(body.claude).toEqual({
      coverage: 'ok',
      rows: [
        { model: 'claude-haiku-5-5', tokens: 70, sessions: 1, sharePercent: 70 },
        { model: 'claude-opus-5-5', tokens: 30, sessions: 1, sharePercent: 30 },
      ],
    });
  });

  it('follows the provider and repo filters', async () => {
    const app = metricsApp(world());
    const claude = await models(app, `${WEEK}&provider=claude`);
    expect(Object.keys(claude)).toEqual(['claude']);
    const web = await models(app, `${WEEK}&repos=kelvin/atlas-web`);
    expect(web.codex?.rows).toEqual([
      { model: 'gpt-5-codex', tokens: 200, sessions: 1, sharePercent: 100 },
    ]);
    expect(web.claude?.rows).toEqual([]); // covered, and no session of that repo used Claude
    expect(web.claude?.coverage).toBe('ok');
  });

  it('only counts the period, in the report timezone', async () => {
    const db = world();
    const session = addSession(db, {
      id: 9,
      provider: 'codex',
      repo: API,
      startedAt: at('2026-11-01'),
    });
    addModelEvent(db, 'gpt-5-codex', { session, at: at('2026-11-01', '23:59'), input: 100_000 });
    addModelEvent(db, 'gpt-5-codex', { session, at: at('2026-11-09', '00:00'), input: 100_000 });
    const body = await models(metricsApp(db), WEEK);
    expect(body.codex?.rows?.[0]).toMatchObject({ model: 'gpt-5-codex', tokens: 800 });
  });

  it('has no rows, only the coverage, for a provider with no covered dates', async () => {
    const db = memoryDb();
    addRepo(db, API);
    addSource(db, 'codex', { oldest: at('2026-11-04') });
    const app = metricsApp(db);
    const before = await models(app, '?start=2026-10-26&end=2026-11-01');
    expect(before).toEqual({
      codex: { coverage: 'unavailable', rows: [] },
      claude: { coverage: 'none', rows: [] },
    });
    const future = await models(app, '?start=2026-11-05&end=2026-11-08&provider=codex');
    expect(future.codex).toEqual({ coverage: 'future', rows: [] });
  });

  it('ignores author, which does not apply to usage, and still checks the rest of the filters', async () => {
    const app = metricsApp(world());
    expect(await models(app, `${WEEK}&author=all`)).toEqual(await models(app, WEEK));
    const bad = await get(app, '/api/models?provider=nobody');
    expect(bad.status).toBe(400);
  });

  it('rounds each share to a whole percent and orders ties by model name', async () => {
    const db = memoryDb();
    addRepo(db, API);
    addSource(db, 'codex');
    const session = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: API,
      startedAt: at('2026-11-03'),
    });
    for (const model of ['c-model', 'a-model', 'b-model']) {
      addModelEvent(db, model, { session, at: at('2026-11-03'), input: 100 });
    }
    const { codex } = await models(metricsApp(db), `${WEEK}&provider=codex`);
    expect(codex?.rows?.map((r) => [r.model, r.sharePercent])).toEqual([
      ['a-model', 33],
      ['b-model', 33],
      ['c-model', 33],
    ]);
  });
});
