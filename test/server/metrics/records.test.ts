import { describe, expect, it } from 'vitest';
import {
  addDecision,
  addEvent,
  addLink,
  addMergedPr,
  addRepo,
  addSession,
  addSource,
  at,
  connectAs,
  get,
  memoryDb,
  metricsApp,
  records,
} from './helpers.ts';

// GET /api/records: the merged PRs and sessions inside ONE bucket, under the same repo, provider and author filters as the chart.
// The clock is Wednesday 2026-11-04 12:00 in Los Angeles.

const API = 'kelvin/atlas-api';
const WEB = 'kelvin/atlas-web';
const DAY = '?start=2026-11-03&end=2026-11-03';

function world() {
  const db = memoryDb();
  addRepo(db, API);
  addRepo(db, WEB);
  addSource(db, 'codex');
  addSource(db, 'claude');
  connectAs(db, 'kelvin');
  return db;
}

describe('the bucket', () => {
  it('lists only what happened inside it: PRs newest merge first, sessions largest first', async () => {
    const db = world();
    addMergedPr(db, API, 1, at('2026-11-03', '09:00'));
    addMergedPr(db, WEB, 2, at('2026-11-03', '17:00'));
    addMergedPr(db, API, 3, at('2026-11-02', '23:59')); // the day before
    addMergedPr(db, API, 4, at('2026-11-04', '00:00')); // the day after
    const small = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: API,
      startedAt: at('2026-11-03'),
    });
    const large = addSession(db, {
      id: 2,
      provider: 'claude',
      repo: WEB,
      startedAt: at('2026-11-03'),
    });
    const outside = addSession(db, {
      id: 3,
      provider: 'codex',
      repo: API,
      startedAt: at('2026-11-02'),
    });
    addEvent(db, { session: small, at: at('2026-11-03', '08:00'), input: 10 });
    addEvent(db, { session: small, at: at('2026-11-03', '09:00'), input: 5 });
    addEvent(db, { session: large, at: at('2026-11-03', '10:00'), input: 500 });
    addEvent(db, { session: outside, at: at('2026-11-02', '23:59'), input: 9999 });

    const body = await records(metricsApp(db), DAY);
    expect(body.scope).toMatchObject({ start: '2026-11-03', end: '2026-11-03' });
    expect(body.prs?.map((p) => p.number)).toEqual([2, 1]);
    expect(body.prTotal).toBe(2);
    expect(body.sessions?.map((s) => [s.id, s.tokens])).toEqual([
      [2, 500],
      [1, 15],
    ]);
    expect(body.sessionTotal).toBe(2);
    expect(body.coverage).toEqual({ codex: 'ok', claude: 'ok', delivery: 'ok' });
  });

  it('puts the events of a 25-hour fall-back day in that day, none in its neighbours', async () => {
    const db = world();
    const session = addSession(db, {
      id: 1,
      provider: 'codex',
      repo: API,
      startedAt: at('2026-10-31'),
    });
    addEvent(db, { session, at: at('2026-10-31', '23:59'), input: 1 });
    addEvent(db, { session, at: at('2026-11-01', '00:00'), input: 10 });
    addEvent(db, { session, at: at('2026-11-01', '23:59'), input: 100 });
    addEvent(db, { session, at: at('2026-11-02', '00:00'), input: 1000 });
    const body = await records(metricsApp(db), '?start=2026-11-01&end=2026-11-01');
    expect(body.sessions?.map((s) => s.tokens)).toEqual([110]);
  });

  it('can span a whole week bucket that runs past today', async () => {
    const db = world();
    addMergedPr(db, API, 1, at('2026-11-03'));
    const body = await records(metricsApp(db), '?start=2026-11-02&end=2026-11-08');
    expect(body.prs).toHaveLength(1);
  });
});

describe('limit', () => {
  function crowded() {
    const db = world();
    for (let n = 1; n <= 35; n++) {
      addMergedPr(
        db,
        API,
        n,
        at(
          '2026-11-03',
          `${String(Math.floor(n / 4) + 1).padStart(2, '0')}:${String((n % 4) * 10).padStart(2, '0')}`,
        ),
      );
      const session = addSession(db, {
        id: n,
        provider: 'codex',
        repo: API,
        startedAt: at('2026-11-03'),
      });
      addEvent(db, { session, at: at('2026-11-03', '12:00'), input: n });
    }
    return metricsApp(db);
  }

  it('cuts each list at 30 by default and still reports the full totals', async () => {
    const body = await records(crowded(), DAY);
    expect(body.prs).toHaveLength(30);
    expect(body.sessions).toHaveLength(30);
    expect(body.prTotal).toBe(35);
    expect(body.sessionTotal).toBe(35);
    expect(body.sessions![0]!.tokens).toBe(35); // the largest first, so the cut drops the smallest
    expect(body.sessions!.at(-1)!.tokens).toBe(6);
  });

  it('takes the limit asked for, up to 100', async () => {
    const app = crowded();
    expect((await records(app, `${DAY}&limit=5`)).sessions).toHaveLength(5);
    const all = await records(app, `${DAY}&limit=100`);
    expect(all.prs).toHaveLength(35);
    expect(all.sessions).toHaveLength(35);
  });

  it.each(['0', '101', '-1', 'abc', '1.5', ''])('refuses limit=%j', async (limit) => {
    const { status, body } = await get(crowded(), `/api/records${DAY}&limit=${limit}`);
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: 'invalid_input', details: { fields: { limit: expect.any(String) } } },
    });
  });
});

describe('filters', () => {
  function filtered() {
    const db = world();
    const day = at('2026-11-03');
    const sessions = [
      addSession(db, { id: 1, provider: 'codex', repo: API, startedAt: day }),
      addSession(db, { id: 2, provider: 'claude', repo: API, startedAt: day }),
      addSession(db, { id: 3, provider: 'codex', repo: WEB, startedAt: day }),
      addSession(db, { id: 4, provider: 'codex', repo: null, startedAt: day }),
    ];
    sessions.forEach((session, i) => addEvent(db, { session, at: day + 1000, input: 10 ** i }));
    addMergedPr(db, API, 1, day, 'kelvin');
    addMergedPr(db, API, 2, day, 'someone-else');
    addMergedPr(db, WEB, 1, day, 'kelvin');
    return metricsApp(db);
  }

  it('applies repo to both lists, excluding sessions with no or untracked repo', async () => {
    const body = await records(filtered(), `${DAY}&repos=${API}&author=all`);
    expect(body.prs?.map((p) => [p.repo, p.number]).sort()).toEqual([
      [API, 1],
      [API, 2],
    ]);
    expect(body.sessions?.map((s) => s.id).sort()).toEqual([1, 2]);
  });

  it('applies provider to sessions only', async () => {
    const body = await records(filtered(), `${DAY}&provider=claude&author=all`);
    expect(body.sessions?.map((s) => s.id)).toEqual([2]);
    expect(body.prTotal).toBe(3);
    expect(body.coverage).toEqual({ claude: 'ok', delivery: 'ok' });
  });

  it('applies author to PRs only', async () => {
    const mine = await records(filtered(), `${DAY}&author=mine`);
    expect(mine.prTotal).toBe(2);
    expect(mine.sessionTotal).toBe(4);
    expect((await records(filtered(), `${DAY}&author=all`)).prTotal).toBe(3);
  });
});

describe('coverage of an empty bucket', () => {
  it('says whether an empty list is a covered zero, history nobody holds or a day still to come', async () => {
    const db = memoryDb();
    addRepo(db, API, { backfill: false });
    addSource(db, 'codex', { oldest: at('2026-11-02') });
    const app = metricsApp(db);

    const quiet = await records(app, '?start=2026-11-03&end=2026-11-03');
    expect(quiet).toMatchObject({ prs: [], prTotal: 0, sessions: [], sessionTotal: 0 });
    expect(quiet.coverage).toEqual({ codex: 'ok', claude: 'none', delivery: 'syncing' });

    const before = await records(app, '?start=2026-10-30&end=2026-10-30');
    expect(before.coverage).toMatchObject({ codex: 'unavailable', claude: 'none' });

    const future = await records(app, '?start=2026-11-06&end=2026-11-06');
    expect(future.coverage).toEqual({ codex: 'future', claude: 'future', delivery: 'future' });
    expect(future.sessions).toEqual([]);
  });

  it('has no delivery when nothing is tracked', async () => {
    const body = await records(metricsApp(memoryDb()), DAY);
    expect(body.coverage?.delivery).toBe('none');
  });
});

describe('each record', () => {
  it('carries its link class, counts and providers on a PR, and its link status on a session', async () => {
    const db = world();
    addRepo(db, 'kelvin/stopped', { tracking: 'stopped' });
    const day = at('2026-11-03');
    const linked = addSession(db, { id: 1, provider: 'codex', repo: API, startedAt: day });
    const suggested = addSession(db, { id: 2, provider: 'claude', repo: API, startedAt: day });
    const untracked = addSession(db, {
      id: 3,
      provider: 'codex',
      repo: 'kelvin/stopped',
      startedAt: day,
    });
    const unknown = addSession(db, { id: 4, provider: 'codex', repo: null, startedAt: day });
    const lonely = addSession(db, { id: 5, provider: 'codex', repo: WEB, startedAt: day });
    [linked, suggested, untracked, unknown, lonely].forEach((session, i) =>
      addEvent(db, { session, at: day + 1000, input: 1000 - i }),
    );
    const pr = addMergedPr(db, API, 7, day + 5000);
    addLink(db, pr, linked, 'evidence');
    addLink(db, pr, suggested, 'suggested');
    const dismissed = addMergedPr(db, API, 8, day + 4000);
    addLink(db, dismissed, lonely, 'suggested');
    addDecision(db, dismissed, lonely, 'dismissed');

    const body = await records(metricsApp(db), DAY);
    const [first, second] = body.prs!;
    expect(first).toMatchObject({
      id: pr,
      repo: API,
      number: 7,
      linkClass: 'evidence',
      linkedSessionCount: 1,
      suggestedCount: 1,
      providers: ['codex', 'claude'],
      authoredByMe: true,
    });
    expect(second).toMatchObject({ number: 8, linkClass: 'unlinked', providers: [] });

    const byId = new Map(body.sessions!.map((s) => [s.id, s]));
    expect(byId.get(1)).toMatchObject({
      linkStatus: 'linked',
      linkedPrs: [{ prId: pr, repo: API, number: 7, class: 'evidence' }],
      repoGroup: 'tracked',
    });
    expect(byId.get(2)).toMatchObject({
      linkStatus: 'linked',
      linkedPrs: [{ prId: pr, repo: API, number: 7, class: 'suggested' }],
    });
    expect(byId.get(3)).toMatchObject({ linkStatus: 'repo_not_tracked', repoGroup: 'untracked' });
    expect(byId.get(4)).toMatchObject({
      linkStatus: 'repo_unknown',
      repoGroup: 'unknown',
      repo: null,
    });
    expect(byId.get(5)).toMatchObject({ linkStatus: 'unlinked', linkedPrs: [] }); // the dismissed suggestion is not listed
  });
});
