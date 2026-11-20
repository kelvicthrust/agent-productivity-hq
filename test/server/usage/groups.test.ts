import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { rangeBounds } from '../../../src/shared/domain/periods.ts';
import { seedDatabase, type SeedOptions } from '../../fixtures/seed.ts';
import {
  TZ,
  addActiveSession,
  addEvent,
  addRepo,
  addSession,
  at,
  categories,
  get,
  groups,
  memoryDb,
  usageApp,
  type SessionOptions,
} from './helpers.ts';

// GET /api/usage/groups: one summary per tracked repo, then Untracked and Unknown when they have sessions. Tokens are per
// provider, from the stored provider_total, and are never added across providers.

function world() {
  const db = memoryDb();
  addRepo(db, 'acme/api');
  addRepo(db, 'acme/web');
  addRepo(db, 'acme/empty');
  addRepo(db, 'acme/gone', { access: 'inaccessible' });
  addRepo(db, 'acme/old', { tracking: 'stopped' });
  const day = at('2026-11-03', '09:00');
  const s = (o: Omit<SessionOptions, 'startedAt'>, tokens: number) =>
    addActiveSession(db, { startedAt: day, ...o }, tokens);

  // acme/api: a Codex root with a Codex-style event (cached and reasoning are subsets), a Claude root, a Claude child, an unknown
  const one = addSession(db, { id: 1, repo: 'acme/api', startedAt: day });
  addEvent(db, {
    session: one,
    at: day + 60_000,
    input: 1_000,
    cached: 800,
    output: 200,
    reasoning: 150,
  });
  const two = addSession(db, { id: 2, provider: 'claude', repo: 'acme/api', startedAt: day });
  addEvent(db, {
    session: two,
    at: day + 60_000,
    input: 10,
    cacheWrite: 20,
    cacheRead: 300,
    output: 40,
  });
  s({ id: 3, provider: 'claude', kind: 'child', parent: 1, basis: 'native', repo: 'acme/api' }, 50);
  s({ id: 4, kind: 'unknown', repo: 'acme/api' }, 7);
  // other repos and groups
  s({ id: 5, repo: 'acme/web' }, 500);
  s({ id: 6, provider: 'claude', repo: 'acme/gone' }, 60);
  s({ id: 7, repo: 'acme/old' }, 70);
  s({ id: 8, provider: 'claude', repo: 'acme/dotfiles' }, 80);
  s({ id: 9, repo: null }, 90);
  s({ id: 10, provider: 'claude', kind: 'unknown', repo: null }, 100);
  return { db, app: usageApp(db) };
}

const byKey = (body: Awaited<ReturnType<typeof groups>>) =>
  new Map((body.groups ?? []).map((g) => [g.key, g]));

describe('groups on a small world', () => {
  it('lists tracked repos by name, then Untracked and Unknown, each with sessions, roots and per-provider tokens', async () => {
    const { app } = world();
    const body = await groups(app);
    expect((body.groups ?? []).map((g) => g.key)).toEqual([
      'acme/api',
      'acme/empty',
      'acme/gone',
      'acme/web',
      '__untracked',
      '__unknown',
    ]);
    const g = byKey(body);
    expect(g.get('acme/api')).toEqual({
      key: 'acme/api',
      label: 'acme/api',
      note: null,
      roots: 2,
      sessions: 4,
      tokens: { codex: 1_207, claude: 420 },
    });
    expect(g.get('acme/empty')).toMatchObject({
      roots: 0,
      sessions: 0,
      tokens: { codex: 0, claude: 0 },
    });
    expect(g.get('acme/gone')).toMatchObject({
      roots: 1,
      sessions: 1,
      tokens: { codex: 0, claude: 60 },
    });
    expect(g.get('acme/web')).toMatchObject({
      roots: 1,
      sessions: 1,
      tokens: { codex: 500, claude: 0 },
    });
    expect(g.get('__untracked')).toEqual({
      key: '__untracked',
      label: 'Untracked repos',
      note: 'repo recorded, not on your tracked list',
      roots: 2,
      sessions: 2,
      tokens: { codex: 70, claude: 80 },
    });
    expect(g.get('__unknown')).toEqual({
      key: '__unknown',
      label: 'Unknown repo',
      note: 'no repository recorded',
      roots: 1,
      sessions: 2,
      tokens: { codex: 90, claude: 100 },
    });
  });

  it('counts a Codex session’s subsets once and never adds the two providers together', async () => {
    const { app } = world();
    const api = byKey(await groups(app)).get('acme/api');
    // session 1 recorded input 1000 (800 cached) and output 200 (150 reasoning): 1,200, not 2,150
    expect(api?.tokens?.codex).toBe(1_200 + 7);
    expect(Object.keys(api?.tokens ?? {}).sort()).toEqual(['claude', 'codex']);
    expect(api).not.toHaveProperty('total');
    expect(api?.tokens).not.toHaveProperty('total');
    expect(api?.tokens).not.toHaveProperty('all');
  });

  it('puts an inaccessible tracked repo in its own group, not under Untracked', async () => {
    const { app } = world();
    const g = byKey(await groups(app));
    expect(g.get('acme/gone')?.sessions).toBe(1);
    expect(g.get('__untracked')?.sessions).toBe(2); // acme/old (stopped) and acme/dotfiles (never tracked)
  });

  it('with a provider filter reports that provider only, in tokens, sessions and roots', async () => {
    const { app } = world();
    const body = await groups(app, '?provider=codex');
    const g = byKey(body);
    expect(g.get('acme/api')).toMatchObject({ roots: 1, sessions: 2, tokens: { codex: 1_207 } });
    expect(g.get('acme/api')?.tokens).not.toHaveProperty('claude');
    expect(g.get('__unknown')).toMatchObject({ roots: 1, sessions: 1, tokens: { codex: 90 } });
    // a reachable repo that has only the other provider's sessions has none left, and stays as an empty group
    expect(g.get('acme/web')).toMatchObject({ roots: 1, sessions: 1, tokens: { codex: 500 } });
    expect(g.get('acme/empty')).toMatchObject({ roots: 0, sessions: 0, tokens: { codex: 0 } });
    // an inaccessible repo is not listed when nothing in it is in scope
    expect(g.has('acme/gone')).toBe(false);
    expect(body.scope?.provider).toBe('codex');
  });

  it('with a repo filter keeps only the selected tracked repos and drops Untracked and Unknown', async () => {
    const { app } = world();
    const body = await groups(app, '?repos=acme/api,acme/web');
    expect((body.groups ?? []).map((g) => g.key)).toEqual(['acme/api', 'acme/web']);
    expect(body.scope?.repos).toEqual(['acme/api', 'acme/web']);
  });

  it('shows Untracked for a selected repo that is stopped, since its sessions are recorded but not tracked', async () => {
    const { app } = world();
    const body = await groups(app, '?repos=acme/old');
    expect((body.groups ?? []).map((g) => g.key)).toEqual(['__untracked']);
    expect(body.groups?.[0]).toMatchObject({
      sessions: 1,
      roots: 1,
      tokens: { codex: 70, claude: 0 },
    });
  });

  it('echoes repo ids this machine does not know and applies no repo filter for them', async () => {
    const { app } = world();
    const body = await groups(app, '?repos=nobody/nothing');
    expect(body.scope?.repos).toEqual([]);
    expect(body.scope?.ignoredRepos).toEqual(['nobody/nothing']);
    expect((body.groups ?? []).length).toBe(6);
  });

  it('counts sessions by their events inside the dates: a root with none in range is not a root, its child still is a session', async () => {
    const db = memoryDb();
    addRepo(db, 'acme/api');
    const root = addSession(db, { id: 1, repo: 'acme/api', startedAt: at('2026-10-01') });
    addEvent(db, { session: root, at: at('2026-10-01', '09:30'), input: 100 });
    addActiveSession(
      db,
      {
        id: 2,
        kind: 'child',
        parent: 1,
        basis: 'native',
        provider: 'claude',
        repo: 'acme/api',
        startedAt: at('2026-11-03'),
      },
      40,
    );
    const app = usageApp(db);
    expect(byKey(await groups(app)).get('acme/api')).toMatchObject({
      roots: 0,
      sessions: 1,
      tokens: { codex: 0, claude: 40 },
    });
    expect(
      byKey(await groups(app, '?start=2026-10-01&end=2026-11-04')).get('acme/api'),
    ).toMatchObject({
      roots: 1,
      sessions: 2,
      tokens: { codex: 100, claude: 40 },
    });
  });

  it('echoes the applied scope', async () => {
    const { app } = world();
    expect((await groups(app)).scope).toEqual({
      start: '2026-11-02',
      end: '2026-11-08',
      gran: 'day',
      repos: [],
      provider: 'all',
      author: 'mine',
      timezone: TZ,
    });
  });

  it('answers bad filters with the shared errors', async () => {
    const { app } = world();
    expect((await get(app, '/api/usage/groups?start=nope')).status).toBe(400);
    expect((await get(app, '/api/usage/groups?start=2026-11-05&end=2026-11-01')).status).toBe(400);
    expect((await get(app, '/api/usage/groups?provider=other')).status).toBe(400);
  });
});

// ---- the seeded world, against figures recomputed in JS from the raw events ------------------------------------------------

interface Truth {
  roots: Set<number>;
  sessions: Set<number>;
  tokens: { codex: number; claude: number };
}

/** Recomputes every group's figures event by event, without the SQL the service uses. */
function truth(
  db: DatabaseSync,
  range: { start: string; end: string },
  provider?: string,
  repos: string[] = [],
) {
  const bounds = rangeBounds(range.start, range.end, TZ);
  const active = new Set(
    (
      db.prepare("SELECT id FROM repo WHERE tracking_state = 'active'").all() as { id: string }[]
    ).map((r) => r.id),
  );
  const events = db
    .prepare(
      `SELECT ue.session_id AS sid, ue.occurred_at AS at, ue.provider_total AS total, s.provider, s.kind, s.repo_id AS repo
         FROM usage_event ue JOIN session s ON s.id = ue.session_id`,
    )
    .all() as {
    sid: number;
    at: number;
    total: number;
    provider: 'codex' | 'claude';
    kind: string;
    repo: string | null;
  }[];
  const out = new Map<string, Truth>();
  for (const e of events) {
    if (e.at < bounds.start || e.at >= bounds.end) continue;
    if (provider && e.provider !== provider) continue;
    if (repos.length > 0 && !(e.repo && repos.includes(e.repo))) continue;
    const key = e.repo === null ? '__unknown' : active.has(e.repo) ? e.repo : '__untracked';
    const g = out.get(key) ?? {
      roots: new Set(),
      sessions: new Set(),
      tokens: { codex: 0, claude: 0 },
    };
    g.sessions.add(e.sid);
    if (e.kind === 'root') g.roots.add(e.sid);
    g.tokens[e.provider] += e.total;
    out.set(key, g);
  }
  return out;
}

const RANGES = [
  { name: 'this week', query: '', range: { start: '2026-11-02', end: '2026-11-08' } },
  {
    name: 'one day',
    query: '?start=2026-11-03&end=2026-11-03',
    range: { start: '2026-11-03', end: '2026-11-03' },
  },
  {
    name: 'last 30 days',
    query: '?start=2026-10-06&end=2026-11-04',
    range: { start: '2026-10-06', end: '2026-11-04' },
  },
  {
    name: '12 months',
    query: '?start=2025-11-04&end=2026-11-04',
    range: { start: '2025-11-04', end: '2026-11-04' },
  },
];

describe('groups on the seeded world match the raw events', () => {
  const db = memoryDb();
  seedDatabase(db, { scale: 'typical' });
  const app = usageApp(db);

  it.each(RANGES)('$name: sessions, roots and tokens per group', async ({ query, range }) => {
    const expected = truth(db, range);
    const body = await groups(app, query);
    const got = byKey(body);
    for (const [key, t] of expected) {
      expect(got.get(key), key).toMatchObject({
        roots: t.roots.size,
        sessions: t.sessions.size,
        tokens: t.tokens,
      });
    }
    // every group the API lists beyond the truth has nothing in scope (tracked repos with no sessions)
    for (const [key, g] of got) {
      if (key !== undefined && !expected.has(key))
        expect(g, key).toMatchObject({ roots: 0, sessions: 0, tokens: { codex: 0, claude: 0 } });
    }
  });

  it('with the provider and repo filters', async () => {
    const range = { start: '2025-11-04', end: '2026-11-04' };
    const codex = byKey(await groups(app, '?start=2025-11-04&end=2026-11-04&provider=codex'));
    for (const [key, t] of truth(db, range, 'codex')) {
      expect(codex.get(key), key).toMatchObject({
        roots: t.roots.size,
        sessions: t.sessions.size,
        tokens: { codex: t.tokens.codex },
      });
    }
    const filtered = byKey(
      await groups(app, '?start=2025-11-04&end=2026-11-04&repos=kelvin/atlas-api,kelvin/notes-cli'),
    );
    expect([...filtered.keys()].sort()).toEqual(['kelvin/atlas-api', 'kelvin/notes-cli']);
    for (const [key, t] of truth(db, range, undefined, ['kelvin/atlas-api', 'kelvin/notes-cli'])) {
      expect(filtered.get(key), key).toMatchObject({
        roots: t.roots.size,
        sessions: t.sessions.size,
        tokens: t.tokens,
      });
    }
  });

  it('reconciles with the ledgers: each provider’s group tokens add up to its ledger total, and every session is in one group', async () => {
    for (const { query, range } of RANGES) {
      const ledger = await categories(app, query);
      const sum = { codex: 0, claude: 0 };
      let sessions = 0;
      for (const g of (await groups(app, query)).groups ?? []) {
        sum.codex += g.tokens?.codex ?? 0;
        sum.claude += g.tokens?.claude ?? 0;
        sessions += g.sessions ?? 0;
      }
      expect(sum.codex, JSON.stringify(range)).toBe(ledger.codex?.total);
      expect(sum.claude, JSON.stringify(range)).toBe(ledger.claude?.total);
      expect(sessions).toBe((ledger.codex?.sessions ?? 0) + (ledger.claude?.sessions ?? 0));
    }
  });
});

describe('groups in the other seeded scenarios', () => {
  const seeded = (options: SeedOptions) => {
    const db = memoryDb();
    seedDatabase(db, options);
    return usageApp(db);
  };

  it('with no tracked repos, every session is Untracked or Unknown', async () => {
    const body = await groups(seeded({ scenario: 'no-repos' }), '?start=2025-11-04&end=2026-11-04');
    expect((body.groups ?? []).map((g) => g.key)).toEqual(['__untracked', '__unknown']);
  });

  it('with no repos and no local sessions there are no groups', async () => {
    expect((await groups(seeded({ scenario: 'empty' }))).groups).toEqual([]);
  });

  it('with tracked repos but no local sessions, each repo is listed empty and there is no Untracked or Unknown group', async () => {
    const body = await groups(
      seeded({ scenario: 'account-only' }),
      '?start=2025-11-04&end=2026-11-04',
    );
    expect((body.groups ?? []).length).toBeGreaterThan(0);
    for (const g of body.groups ?? []) {
      expect(g.key?.startsWith('__')).toBe(false);
      expect(g).toMatchObject({ roots: 0, sessions: 0, tokens: { codex: 0, claude: 0 } });
    }
  });

  it('keeps the refresh-failed world’s Codex sessions from before the failure', async () => {
    const body = await groups(
      seeded({ scenario: 'refresh-failed' }),
      '?start=2026-11-03&end=2026-11-03',
    );
    expect((body.groups ?? []).some((g) => (g.tokens?.codex ?? 0) > 0)).toBe(true);
  });
});
