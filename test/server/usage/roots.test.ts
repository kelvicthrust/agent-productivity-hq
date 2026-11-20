import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, shortSessionRef } from '../../../src/server/services/usage.ts';
import {
  addActiveSession,
  addEvent,
  addRepo,
  addSession,
  at,
  get,
  memoryDb,
  roots,
  usageApp,
} from './helpers.ts';

// GET /api/usage/groups/{groupKey}/roots: roots newest first and paged, their children, orphans whose root is outside the
// filters, and the Unknown relationship sessions. Times are in America/Los_Angeles; "this week" is 2026-11-02 to 2026-11-08.

function world() {
  const db = memoryDb();
  addRepo(db, 'acme/api');
  addRepo(db, 'acme/web');
  addRepo(db, 'acme/old', { tracking: 'stopped' });
  const api = (o: Parameters<typeof addActiveSession>[1], tokens?: number) =>
    addActiveSession(db, { repo: 'acme/api', ...o }, tokens);

  // five roots; 4 and 5 share a start time, so the id breaks the tie
  api(
    { id: 1, startedAt: at('2026-11-02', '08:00'), psid: '7f3a1b2c3d4e5f6a7b8c9d0e1f2a2c91' },
    1_000,
  );
  api({ id: 2, startedAt: at('2026-11-02', '09:00') }, 2_000);
  api({ id: 3, startedAt: at('2026-11-02', '10:00') }, 3_000);
  api({ id: 4, startedAt: at('2026-11-03', '10:00') }, 4_000);
  api({ id: 5, startedAt: at('2026-11-03', '10:00') }, 5_000);

  // root 1: two native subagents (Claude); listed oldest first
  api(
    {
      id: 12,
      kind: 'child',
      parent: 1,
      basis: 'native',
      provider: 'claude',
      startedAt: at('2026-11-02', '08:30'),
    },
    120,
  );
  api(
    {
      id: 11,
      kind: 'child',
      parent: 1,
      basis: 'native',
      provider: 'claude',
      startedAt: at('2026-11-02', '08:10'),
      psid: 'd2a70000000000000000000000000551c',
    },
    110,
  );
  // root 2: a named Paseo child on the other provider, and that child's own child, which belongs to the same root
  api(
    {
      id: 21,
      kind: 'child',
      parent: 2,
      basis: 'paseo',
      provider: 'claude',
      agent: 'implementer-1',
      name: 'implementer-1',
      nameSource: 'paseo',
      workspace: 'api · wt-1',
      startedAt: at('2026-11-02', '09:10'),
    },
    210,
  );
  api(
    {
      id: 22,
      kind: 'child',
      parent: 21,
      basis: 'paseo',
      provider: 'codex',
      agent: 'tester-2',
      name: 'tester-2',
      nameSource: 'paseo',
      workspace: 'api · wt-1',
      startedAt: at('2026-11-02', '09:20'),
    },
    220,
  );
  // a child whose root has no event this week: an orphan
  const quiet = addSession(db, { id: 90, repo: 'acme/api', startedAt: at('2026-09-01') });
  addEvent(db, { session: quiet, at: at('2026-09-01', '09:30'), input: 5 });
  api(
    {
      id: 31,
      kind: 'child',
      parent: 90,
      basis: 'native',
      provider: 'claude',
      startedAt: at('2026-11-03', '09:00'),
    },
    310,
  );
  // two sessions whose parent was never recorded
  api({ id: 41, kind: 'unknown', provider: 'claude', startedAt: at('2026-11-02', '11:00') }, 410);
  api({ id: 42, kind: 'unknown', startedAt: at('2026-11-03', '11:00') }, 420);

  // other groups
  addActiveSession(db, { id: 51, repo: 'acme/web', startedAt: at('2026-11-02', '12:00') }, 51);
  addActiveSession(db, { id: 61, repo: 'acme/old', startedAt: at('2026-11-02', '13:00') }, 61);
  addActiveSession(db, { id: 62, repo: 'acme/dotfiles', startedAt: at('2026-11-02', '14:00') }, 62);
  addActiveSession(db, { id: 71, repo: null, startedAt: at('2026-11-02', '15:00') }, 71);
  return { db, app: usageApp(db) };
}

const ids = (list: { id: number }[] | undefined) => (list ?? []).map((s) => s.id);

describe('roots: order, children, orphans and unknown relationship', () => {
  it('lists roots newest first, id descending on a tie, each with its children oldest first', async () => {
    const { app } = world();
    const body = await roots(app, 'acme/api');
    expect(ids(body.roots)).toEqual([5, 4, 3, 2, 1]);
    expect(body.remaining).toBe(0);
    expect(body.nextCursor).toBeNull();
    const byId = new Map((body.roots ?? []).map((r) => [r.id, r]));
    expect(ids(byId.get(1)?.children)).toEqual([11, 12]);
    expect(byId.get(1)?.childCount).toBe(2);
    expect(byId.get(5)?.children).toEqual([]);
    expect(byId.get(5)?.childCount).toBe(0);
  });

  it('hangs a subagent of a subagent under the same root', async () => {
    const { app } = world();
    const body = await roots(app, 'acme/api');
    const two = body.roots?.find((r) => r.id === 2);
    expect(ids(two?.children)).toEqual([21, 22]);
    expect(two?.children?.find((c) => c.id === 22)?.parentId).toBe(21);
    expect(two?.childCount).toBe(2);
  });

  it('lists a child whose root has no event in scope as an orphan, not as a root or under another root', async () => {
    const { app } = world();
    const body = await roots(app, 'acme/api');
    expect(ids(body.orphans)).toEqual([31]);
    expect(ids(body.roots)).not.toContain(90);
    expect(ids(body.roots)).not.toContain(31);
  });

  it('includes the Unknown relationship sessions, never as roots or children, newest first', async () => {
    const { app } = world();
    const body = await roots(app, 'acme/api');
    expect(ids(body.unknownRelationship)).toEqual([42, 41]);
    expect(ids(body.roots).filter((id) => id === 41 || id === 42)).toEqual([]);
    for (const root of body.roots ?? []) expect(ids(root.children)).not.toContain(41);
    expect(body.unknownRelationship?.every((s) => s.kind === 'unknown')).toBe(true);
  });

  it('turns children into orphans when the provider filter removes their root', async () => {
    const { app } = world();
    const body = await roots(app, 'acme/api', '?provider=claude');
    // roots 1 to 5 and 90 are Codex; every Claude child is now outside the filters
    expect(ids(body.roots)).toEqual([]);
    // newest start first: 31 (3 Nov), then 21, 12 and 11 (2 Nov)
    expect(ids(body.orphans)).toEqual([31, 21, 12, 11]);
    expect(ids(body.unknownRelationship)).toEqual([41]);
    expect(body.orphans?.every((s) => s.provider === 'claude')).toBe(true);
  });

  it('keeps a child under its root when both are in scope, whatever the date range excludes elsewhere', async () => {
    const { app } = world();
    const body = await roots(app, 'acme/api', '?start=2026-11-02&end=2026-11-02');
    expect(ids(body.roots)).toEqual([3, 2, 1]);
    expect(ids(body.roots?.find((r) => r.id === 1)?.children)).toEqual([11, 12]);
    // the 3rd of November's sessions are not in this day: neither is the orphan nor unknown 42
    expect(ids(body.orphans)).toEqual([]);
    expect(ids(body.unknownRelationship)).toEqual([41]);
  });

  it('counts only the tokens inside the requested dates', async () => {
    const db = memoryDb();
    addRepo(db, 'acme/api');
    const id = addSession(db, { id: 1, repo: 'acme/api', startedAt: at('2026-10-20') });
    addEvent(db, { session: id, at: at('2026-10-20', '09:05'), input: 700 });
    addEvent(db, { session: id, at: at('2026-11-03', '09:05'), input: 30 });
    addEvent(db, { session: id, at: at('2026-11-04', '09:05'), input: 12 });
    const app = usageApp(db);
    expect(
      (await roots(app, 'acme/api', '?start=2026-11-03&end=2026-11-03')).roots?.[0]?.tokens,
    ).toBe(30);
    expect(
      (await roots(app, 'acme/api', '?start=2026-11-02&end=2026-11-08')).roots?.[0]?.tokens,
    ).toBe(42);
    expect(
      (await roots(app, 'acme/api', '?start=2025-11-04&end=2026-11-04')).roots?.[0]?.tokens,
    ).toBe(742);
  });

  it('never adds a session’s Codex subsets or the two providers together', async () => {
    const db = memoryDb();
    addRepo(db, 'acme/api');
    const codex = addSession(db, { id: 1, repo: 'acme/api', startedAt: at('2026-11-02') });
    addEvent(db, {
      session: codex,
      at: at('2026-11-02', '10:00'),
      input: 1_000,
      cached: 800,
      output: 200,
      reasoning: 150,
    });
    const claude = addSession(db, {
      id: 2,
      provider: 'claude',
      repo: 'acme/api',
      startedAt: at('2026-11-02'),
    });
    addEvent(db, {
      session: claude,
      at: at('2026-11-02', '10:00'),
      input: 10,
      cacheWrite: 20,
      cacheRead: 300,
      output: 40,
    });
    const body = await roots(usageApp(db), 'acme/api');
    const byId = new Map((body.roots ?? []).map((r) => [r.id, r.tokens]));
    expect(byId.get(1)).toBe(1_200); // input + output; not + 800 cached or + 150 reasoning
    expect(byId.get(2)).toBe(370);
  });

  it('answers a tracked repo with nothing in scope with an empty page', async () => {
    const { app } = world();
    const body = await roots(app, 'acme/web', '?start=2026-11-05&end=2026-11-05');
    expect(body).toEqual({
      roots: [],
      orphans: [],
      unknownRelationship: [],
      nextCursor: null,
      remaining: 0,
    });
  });

  it('keeps each session in its own group, including the Untracked and Unknown ones', async () => {
    const { app } = world();
    expect(ids((await roots(app, 'acme/web')).roots)).toEqual([51]);
    expect(ids((await roots(app, '__untracked')).roots)).toEqual([62, 61]);
    expect(ids((await roots(app, '__unknown')).roots)).toEqual([71]);
    const untracked = (await roots(app, '__untracked')).roots ?? [];
    expect(untracked.map((s) => s.repoGroup)).toEqual(['untracked', 'untracked']);
    expect((await roots(app, '__unknown')).roots?.[0]).toMatchObject({
      repoGroup: 'unknown',
      repo: null,
    });
  });

  it('applies the repo filter to the groups: a filter naming another repo empties it, and excludes unknown and untracked', async () => {
    const { app } = world();
    expect(ids((await roots(app, 'acme/api', '?repos=acme/web')).roots)).toEqual([]);
    expect(ids((await roots(app, 'acme/web', '?repos=acme/web')).roots)).toEqual([51]);
    expect(ids((await roots(app, '__unknown', '?repos=acme/web')).roots)).toEqual([]);
    expect(ids((await roots(app, '__untracked', '?repos=acme/web')).roots)).toEqual([]);
  });

  it('survives a parent loop in damaged data: both sessions are orphans, nothing hangs', async () => {
    const { db, app } = world();
    addActiveSession(db, {
      id: 101,
      kind: 'child',
      basis: 'native',
      repo: 'acme/api',
      startedAt: at('2026-11-02', '16:00'),
    });
    addActiveSession(db, {
      id: 102,
      kind: 'child',
      basis: 'native',
      repo: 'acme/api',
      startedAt: at('2026-11-02', '16:05'),
    });
    db.exec(
      'UPDATE session SET parent_session_id = 102 WHERE id = 101; UPDATE session SET parent_session_id = 101 WHERE id = 102;',
    );
    const body = await roots(app, 'acme/api');
    expect(new Set(ids(body.orphans))).toEqual(new Set([31, 101, 102]));
  });
});

describe('roots: the fields of a session row', () => {
  it('names a session by its recorded name, else by its relationship, and never invents a name', async () => {
    const { app } = world();
    const body = await roots(app, 'acme/api');
    const two = body.roots?.find((r) => r.id === 2);
    expect(two).toMatchObject({
      kind: 'root',
      relationshipLabel: 'Root session',
      nameLead: 'Root session',
      named: false,
      nameSource: null,
      paseo: null,
    });
    const paseo = two?.children?.find((c) => c.id === 21);
    expect(paseo).toMatchObject({
      kind: 'child',
      relationshipLabel: 'Paseo child agent',
      nameLead: 'implementer-1',
      named: true,
      nameSource: 'paseo',
      paseo: { agentId: 'implementer-1', workspace: 'api · wt-1' },
      parentId: 2,
      provider: 'claude',
      model: 'claude-opus-5-5',
    });
    const native = body.roots?.find((r) => r.id === 1)?.children?.find((c) => c.id === 12);
    expect(native).toMatchObject({
      relationshipLabel: 'Native subagent',
      nameLead: 'Native subagent',
      named: false,
      nameSource: null,
      paseo: null,
    });
    expect(body.unknownRelationship?.[0]).toMatchObject({
      kind: 'unknown',
      relationshipLabel: 'Unknown relationship',
      nameLead: 'Unknown relationship',
      parentId: null,
    });
  });

  it('shows the shortened session id and the times as instants', async () => {
    const { app } = world();
    const body = await roots(app, 'acme/api');
    const one = body.roots?.find((r) => r.id === 1);
    expect(one?.providerSessionRef).toBe('thread 7f3a…2c91');
    expect(one?.repo).toBe('acme/api');
    expect(one?.repoGroup).toBe('tracked');
    expect(one?.startedAt).toBe(new Date(at('2026-11-02', '08:00')).toISOString());
    expect(one?.startedBasis).toBe('source_start');
    expect(one?.firstEventAt).toBe(new Date(at('2026-11-02', '08:01')).toISOString());
    expect(one?.lastEventAt).toBe(new Date(at('2026-11-02', '08:01')).toISOString());
    expect(shortSessionRef('claude', 'd2a7aaaaaaaa551c')).toBe('session d2a7…551c');
    expect(shortSessionRef('claude', 'short')).toBe('session short');
  });

  it('reports a first-event start with its basis', async () => {
    const db = memoryDb();
    addRepo(db, 'acme/api');
    addActiveSession(db, {
      id: 1,
      repo: 'acme/api',
      startedAt: at('2026-11-02'),
      startedBasis: 'first_event',
    });
    expect((await roots(usageApp(db), 'acme/api')).roots?.[0]?.startedBasis).toBe('first_event');
  });
});

describe('roots: paging', () => {
  async function pages(app: ReturnType<typeof usageApp>, key: string, limit: number, query = '') {
    const out = [];
    let cursor: string | null = null;
    do {
      const q: string = `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}${query}`;
      const page = await roots(app, key, q);
      out.push(page);
      cursor = page.nextCursor ?? null;
    } while (cursor && out.length < 20);
    return out;
  }

  it('pages roots with a cursor and says how many remain', async () => {
    const { app } = world();
    const all = await pages(app, 'acme/api', 2);
    expect(all.map((p) => ids(p.roots))).toEqual([[5, 4], [3, 2], [1]]);
    expect(all.map((p) => p.remaining)).toEqual([3, 1, 0]);
    expect(all.map((p) => p.nextCursor !== null)).toEqual([true, true, false]);
  });

  it('shows each session once across the pages: orphans and unknown-relationship sessions come with the first page only', async () => {
    const { app } = world();
    const all = await pages(app, 'acme/api', 2);
    expect(ids(all[0]?.orphans)).toEqual([31]);
    expect(ids(all[0]?.unknownRelationship)).toEqual([42, 41]);
    for (const later of all.slice(1)) {
      expect(later.orphans).toEqual([]);
      expect(later.unknownRelationship).toEqual([]);
    }
    const seen = all.flatMap((p) => [
      ...(p.roots ?? []).flatMap((r) => [r.id, ...ids(r.children)]),
      ...ids(p.orphans),
      ...ids(p.unknownRelationship),
    ]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set([1, 2, 3, 4, 5, 11, 12, 21, 22, 31, 41, 42]));
  });

  it('returns exactly the limit when there are more roots, and the default is 15', async () => {
    const db = memoryDb();
    addRepo(db, 'acme/api');
    for (let id = 1; id <= 40; id++) {
      addActiveSession(db, {
        id,
        repo: 'acme/api',
        startedAt: at('2026-11-02', '08:00') + id * 60_000,
      });
    }
    const app = usageApp(db);
    const first = await roots(app, 'acme/api');
    expect(first.roots).toHaveLength(15);
    expect(first.remaining).toBe(25);
    expect((await roots(app, 'acme/api', '?limit=100')).roots).toHaveLength(40);
    expect((await roots(app, 'acme/api', '?limit=40')).remaining).toBe(0);
    expect((await roots(app, 'acme/api', '?limit=40')).nextCursor).toBeNull();
  });

  it('continues from a position, not a row: a newer root arriving between pages causes no repeat and no gap', async () => {
    const { db, app } = world();
    const first = await roots(app, 'acme/api', '?limit=2');
    expect(ids(first.roots)).toEqual([5, 4]);
    addActiveSession(db, { id: 6, repo: 'acme/api', startedAt: at('2026-11-04', '08:00') }, 600);
    db.prepare('DELETE FROM usage_event WHERE session_id = 4').run();
    db.prepare('DELETE FROM session WHERE id = 4').run();
    const second = await roots(app, 'acme/api', `?limit=2&cursor=${first.nextCursor}`);
    expect(ids(second.roots)).toEqual([3, 2]);
  });

  it('keeps the page boundary inside a group of roots that share a start time', async () => {
    const db = memoryDb();
    addRepo(db, 'acme/api');
    for (let id = 1; id <= 5; id++) {
      addActiveSession(db, { id, repo: 'acme/api', startedAt: at('2026-11-02', '08:00') });
    }
    const all = await pages(usageApp(db), 'acme/api', 2);
    expect(all.map((p) => ids(p.roots))).toEqual([[5, 4], [3, 2], [1]]);
  });

  it('round-trips its own cursor and refuses anything else', () => {
    const cursor = encodeCursor({ startedAt: 1_762_000_000_000, id: 77 });
    expect(decodeCursor(cursor)).toEqual({ startedAt: 1_762_000_000_000, id: 77 });
    for (const bad of [
      '',
      'abc',
      'e30',
      Buffer.from('{"s":1}').toString('base64url'),
      Buffer.from('{"s":"x","i":1}').toString('base64url'),
    ]) {
      expect(() => decodeCursor(bad)).toThrow();
    }
  });
});

describe('roots: errors', () => {
  const bad = async (path: string) => {
    const { app } = world();
    return get(app, path);
  };
  const code = (body: unknown) => (body as { error: { code: string } }).error.code;
  const fields = (body: unknown) =>
    (body as { error: { details?: { fields?: Record<string, string> } } }).error.details?.fields ??
    {};

  it('answers a cursor this server did not make with invalid_input naming the field', async () => {
    const res = await bad('/api/usage/groups/acme%2Fapi/roots?cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expect(code(res.body)).toBe('invalid_input');
    expect(Object.keys(fields(res.body))).toEqual(['cursor']);
  });

  it.each(['0', '-1', '101', '1.5', 'abc', '', '15x'])(
    'answers limit=%s with invalid_input',
    async (limit) => {
      const res = await bad(`/api/usage/groups/acme%2Fapi/roots?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(code(res.body)).toBe('invalid_input');
      expect(Object.keys(fields(res.body))).toEqual(['limit']);
    },
  );

  it('refuses an oversized cursor without parsing it', async () => {
    const res = await bad(`/api/usage/groups/acme%2Fapi/roots?cursor=${'A'.repeat(5_000)}`);
    expect(res.status).toBe(400);
    expect(code(res.body)).toBe('invalid_input');
  });

  it('answers a malformed percent-encoding in the group key with not_found, not an error page', async () => {
    for (const key of ['%ZZ', '%E0%A4%A']) {
      const res = await bad(`/api/usage/groups/${key}/roots`);
      expect(res.status, key).toBe(404);
      expect(code(res.body), key).toBe('not_found');
    }
  });

  it('does not route an unencoded repo id: the slash makes a longer path', async () => {
    const res = await bad('/api/usage/groups/acme/api/roots');
    expect(res.status).toBe(404);
  });

  it('accepts the whole allowed range of limit', async () => {
    expect((await bad('/api/usage/groups/acme%2Fapi/roots?limit=1')).status).toBe(200);
    expect((await bad('/api/usage/groups/acme%2Fapi/roots?limit=100')).status).toBe(200);
  });

  it('answers a group that does not exist, or a repo that is not tracked, with not_found', async () => {
    for (const key of ['nobody%2Fnothing', 'acme%2Fold', 'acme%2Fdotfiles', '__other', '']) {
      const res = await bad(`/api/usage/groups/${key}/roots`);
      expect(res.status, key).toBe(404);
      expect(code(res.body), key).toBe('not_found');
    }
  });

  it('answers bad filters with the shared invalid_input and invalid_range errors', async () => {
    const dates = await bad('/api/usage/groups/acme%2Fapi/roots?start=yesterday');
    expect(dates.status).toBe(400);
    expect(code(dates.body)).toBe('invalid_input');
    expect(fields(dates.body)).toHaveProperty('start');
    const range = await bad('/api/usage/groups/acme%2Fapi/roots?start=2026-11-05&end=2026-11-01');
    expect(range.status).toBe(400);
    expect(code(range.body)).toBe('invalid_range');
    const before = await bad('/api/usage/groups/acme%2Fapi/roots?start=2020-01-01&end=2020-01-02');
    expect(code(before.body)).toBe('invalid_range');
    const provider = await bad('/api/usage/groups/acme%2Fapi/roots?provider=gemini');
    expect(code(provider.body)).toBe('invalid_input');
  });

  it('sends no-store and a Host-guarded response like every other route', async () => {
    const { app } = world();
    const ok = await get(app, '/api/usage/groups/acme%2Fapi/roots');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const wrongHost = await app.request('http://evil.test/api/usage/groups/acme%2Fapi/roots', {
      headers: { host: 'evil.test' },
    });
    expect(wrongHost.status).toBe(421);
  });
});
