import { describe, expect, it } from 'vitest';
import { setMeta } from '../../../src/server/db/queries/meta.ts';
import { upsertPullRequests } from '../../../src/server/db/queries/prs.ts';
import {
  markSyncFinished,
  setRepoAccess,
  stopRepo,
  trackRepo,
} from '../../../src/server/db/queries/repos.ts';
import { ErrorEnvelope } from '../../../src/shared/contracts/errors.ts';
import { PrsResponse } from '../../../src/shared/contracts/prs.ts';
import { YearResponse } from '../../../src/shared/contracts/series.ts';
import { appFor, crew, type Crew } from './helpers.ts';

// GET /api/prs and GET /api/year (G6_6, G6_7, the server half of G6_9) over stored rows. The clock is Wednesday 2026-11-04 12:00
// in Los Angeles; the DST change was on Sunday 2026-11-01, so 2026-11-01 is a 25-hour day (07:00Z to 08:00Z the next day).
// `merged_at` places a PR in a day by the REPORT timezone, the author rule decides "mine", and every PR is `unlinked` until M8.

const ME = 'octo-kelvin';

async function world(options: { login?: string | null } = {}) {
  const c = await crew();
  if (options.login !== null) setMeta(c.db, 'github_login', options.login ?? ME);
  return { c, ...appFor(c) };
}

function addRepo(c: Crew, id: string, options: { complete?: boolean } = {}): void {
  trackRepo(c.db, { id, nodeId: `R_${id}`, displayName: id, now: c.now() });
  if (options.complete ?? true) markSyncFinished(c.db, id, { now: c.now(), complete: true });
}

/** The next PR number per repo, kept per database so every test starts again at 1. */
const numbering = new WeakMap<object, Map<string, number>>();
function addPr(
  c: Crew,
  repoId: string,
  mergedAt: string,
  extra: { number?: number; title?: string; author?: string | null; mergedBy?: string | null } = {},
): string {
  const numbers = numbering.get(c.db) ?? new Map<string, number>();
  numbering.set(c.db, numbers);
  const number = extra.number ?? (numbers.get(repoId) ?? 0) + 1;
  numbers.set(repoId, Math.max(number, numbers.get(repoId) ?? 0));
  const nodeId = `PR_${repoId}_${number}`;
  upsertPullRequests(c.db, [
    {
      nodeId,
      repoId,
      number,
      title: extra.title ?? `Change ${number}`,
      url: `https://github.com/${repoId}/pull/${number}`,
      authorLogin: extra.author === undefined ? ME : extra.author,
      mergedByLogin: extra.mergedBy === undefined ? ME : extra.mergedBy,
      mergedAt: Date.parse(mergedAt),
      headRef: null,
      baseRef: null,
      mergeCommitSha: null,
      commits: [],
      commitsComplete: true,
    },
  ]);
  return nodeId;
}

const prs = async (response: Response) => PrsResponse.parse(await response.json());
const idsOf = (body: { items?: { id: string }[] | undefined }) =>
  (body.items ?? []).map((i) => i.id);
const error = async (response: Response) => ErrorEnvelope.parse(await response.json()).error;

describe('GET /api/prs', () => {
  it('lists merged PRs newest merge first, with the author and the merger apart, and the GitHub link', async () => {
    const { c, get } = await world();
    addRepo(c, 'acme/widgets');
    const older = addPr(c, 'acme/widgets', '2026-11-03T18:00:00Z', { title: 'Older' });
    const newer = addPr(c, 'acme/widgets', '2026-11-04T09:00:00Z', {
      title: 'Newer',
      author: ME,
      mergedBy: 'teammate',
    });

    const res = await get('/api/prs?start=2026-11-02&end=2026-11-08');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await prs(res);
    expect(idsOf(body)).toEqual([newer, older]);
    expect(body.items?.[0]).toEqual({
      id: newer,
      repo: 'acme/widgets',
      number: 2,
      title: 'Newer',
      url: 'https://github.com/acme/widgets/pull/2',
      mergedAt: '2026-11-04T09:00:00.000Z',
      author: ME,
      mergedBy: 'teammate',
      authoredByMe: true,
      linkClass: 'unlinked',
      linkedSessionCount: 0,
      suggestedCount: 0,
      providers: [],
    });
    expect(body.scope).toMatchObject({
      start: '2026-11-02',
      end: '2026-11-08',
      author: 'mine',
      timezone: 'America/Los_Angeles',
    });
    expect(body.nextCursor).toBeNull();
    expect(body.inaccessibleRepos).toEqual([]);
  });

  it('defaults to this week (Monday-start), in the report timezone', async () => {
    const { c, get } = await world();
    addRepo(c, 'acme/widgets');
    const inWeek = addPr(c, 'acme/widgets', '2026-11-02T20:00:00Z');
    addPr(c, 'acme/widgets', '2026-11-02T07:00:00Z'); // 23:00 on Sunday 11-01 in Los Angeles

    expect(idsOf(await prs(await get('/api/prs')))).toEqual([inWeek]);
  });

  describe('counted on merged_at, by the report-timezone day (P-19)', () => {
    it('puts 23:59 local in its day and 00:00 local in the next', async () => {
      const { c, get } = await world();
      addRepo(c, 'acme/widgets');
      const late = addPr(c, 'acme/widgets', '2026-11-03T07:59:00Z'); // 23:59 on 11-02 (PST)
      const early = addPr(c, 'acme/widgets', '2026-11-03T08:00:00Z'); // 00:00 on 11-03

      expect(idsOf(await prs(await get('/api/prs?start=2026-11-02&end=2026-11-02')))).toEqual([
        late,
      ]);
      expect(idsOf(await prs(await get('/api/prs?start=2026-11-03&end=2026-11-03')))).toEqual([
        early,
      ]);
      expect(idsOf(await prs(await get('/api/prs?start=2026-11-02&end=2026-11-03')))).toEqual([
        early,
        late,
      ]);
    });

    it('treats the 25-hour day of the DST change as one day', async () => {
      const { c, get } = await world();
      addRepo(c, 'acme/widgets');
      const first = addPr(c, 'acme/widgets', '2026-11-01T07:00:00Z'); // 00:00 PDT on 11-01
      const last = addPr(c, 'acme/widgets', '2026-11-02T07:59:59Z'); // 23:59:59 PST on 11-01
      const next = addPr(c, 'acme/widgets', '2026-11-02T08:00:00Z'); // 00:00 PST on 11-02

      const day = await prs(await get('/api/prs?start=2026-11-01&end=2026-11-01'));
      expect(idsOf(day).sort()).toEqual([first, last].sort());
      expect(idsOf(await prs(await get('/api/prs?start=2026-11-02&end=2026-11-02')))).toEqual([
        next,
      ]);
    });
  });

  describe('the author rule (P-20)', () => {
    async function mixed() {
      const w = await world();
      addRepo(w.c, 'acme/widgets');
      const mine = addPr(w.c, 'acme/widgets', '2026-11-03T18:00:00Z', {
        author: ME,
        mergedBy: 'teammate',
      });
      const theirs = addPr(w.c, 'acme/widgets', '2026-11-03T17:00:00Z', {
        author: 'teammate',
        mergedBy: ME,
      });
      const ghost = addPr(w.c, 'acme/widgets', '2026-11-03T16:00:00Z', {
        author: null,
        mergedBy: null,
      });
      return { ...w, mine, theirs, ghost };
    }
    const week = '?start=2026-11-02&end=2026-11-08';

    it('mine (the default) is authored by the connected login, whoever merged it', async () => {
      const { get, mine } = await mixed();
      const body = await prs(await get(`/api/prs${week}`));
      expect(idsOf(body)).toEqual([mine]);
      expect(body.items?.[0]).toMatchObject({
        author: ME,
        mergedBy: 'teammate',
        authoredByMe: true,
      });
      expect(body.counts?.all).toBe(1);
    });

    it('all keeps every merge, and a PR merged by me but authored by someone else is not "mine"', async () => {
      const { get, mine, theirs, ghost } = await mixed();
      const body = await prs(await get(`/api/prs${week}&author=all`));
      expect(idsOf(body)).toEqual([mine, theirs, ghost]);
      expect(body.items?.map((i) => i.authoredByMe)).toEqual([true, false, false]);
      expect(body.items?.[1]).toMatchObject({ author: 'teammate', mergedBy: ME });
      expect(body.scope?.author).toBe('all');
    });

    it('compares the login without case', async () => {
      const { c, get, mine } = await mixed();
      setMeta(c.db, 'github_login', ME.toUpperCase());
      const body = await prs(await get(`/api/prs${week}`));
      expect(idsOf(body)).toEqual([mine]);
      expect(body.items?.[0]?.authoredByMe).toBe(true);
    });

    it('with nobody connected, nothing is "mine"', async () => {
      const { c, get } = await world({ login: null });
      addRepo(c, 'acme/widgets');
      addPr(c, 'acme/widgets', '2026-11-03T18:00:00Z');
      expect((await prs(await get(`/api/prs${week}`))).items).toEqual([]);
      expect((await prs(await get(`/api/prs${week}&author=all`))).items).toHaveLength(1);
    });
  });

  it('leaves out stopped repos and unreachable ones, and names the unreachable ones in a notice', async () => {
    const { c, get } = await world();
    addRepo(c, 'acme/widgets');
    addRepo(c, 'acme/stopped');
    addRepo(c, 'acme/private');
    const kept = addPr(c, 'acme/widgets', '2026-11-03T18:00:00Z');
    addPr(c, 'acme/stopped', '2026-11-03T18:00:00Z');
    addPr(c, 'acme/private', '2026-11-03T18:00:00Z');
    stopRepo(c.db, 'acme/stopped', c.now());
    setRepoAccess(c.db, 'acme/private', { state: 'inaccessible', error: 'no access' });

    const body = await prs(await get('/api/prs?start=2026-11-02&end=2026-11-08'));

    expect(idsOf(body)).toEqual([kept]);
    expect(body.counts?.all).toBe(1);
    expect(body.inaccessibleRepos).toEqual(['acme/private']);
    // The notice follows the repo filter: asking for another repo does not name this one.
    const other = await prs(
      await get('/api/prs?start=2026-11-02&end=2026-11-08&repos=acme/widgets'),
    );
    expect(other.inaccessibleRepos).toEqual([]);
  });

  it('filters by repo, and echoes ids it does not know in scope.ignoredRepos', async () => {
    const { c, get } = await world();
    addRepo(c, 'acme/widgets');
    addRepo(c, 'acme/gadgets');
    addPr(c, 'acme/widgets', '2026-11-03T18:00:00Z');
    const gadget = addPr(c, 'acme/gadgets', '2026-11-03T19:00:00Z');

    const body = await prs(
      await get('/api/prs?start=2026-11-02&end=2026-11-08&repos=acme/gadgets,nobody/knows-me'),
    );

    expect(idsOf(body)).toEqual([gadget]);
    expect(body.scope).toMatchObject({
      repos: ['acme/gadgets'],
      ignoredRepos: ['nobody/knows-me'],
    });
  });

  describe('search and the link tabs', () => {
    async function searchable() {
      const w = await world();
      addRepo(w.c, 'acme/widgets');
      addRepo(w.c, 'acme/gadgets');
      const a = addPr(w.c, 'acme/widgets', '2026-11-03T18:00:00Z', {
        number: 12,
        title: 'Fix the Frobnicator',
      });
      const b = addPr(w.c, 'acme/gadgets', '2026-11-03T17:00:00Z', {
        number: 7,
        title: 'Add 100% coverage',
      });
      return { ...w, a, b };
    }
    const week = '/api/prs?start=2026-11-02&end=2026-11-08';

    it('matches the title, the repo, and #number, ignoring case, and keeps the tab counts fixed', async () => {
      const { get, a, b } = await searchable();
      expect(idsOf(await prs(await get(`${week}&q=frobnic`)))).toEqual([a]);
      expect(idsOf(await prs(await get(`${week}&q=GADGETS`)))).toEqual([b]);
      expect(idsOf(await prs(await get(`${week}&q=%2312`)))).toEqual([a]);
      expect(idsOf(await prs(await get(`${week}&q=acme/gadgets%237`)))).toEqual([b]);
      expect(idsOf(await prs(await get(`${week}&q=nothing-like-this`)))).toEqual([]);
      const searched = await prs(await get(`${week}&q=frobnic`));
      expect(searched.counts).toEqual({ all: 2, evidence: 0, owner: 0, suggested: 0, unlinked: 2 });
    });

    it('treats % and _ in a search as plain text', async () => {
      const { get, b } = await searchable();
      expect(idsOf(await prs(await get(`${week}&q=100%25`)))).toEqual([b]);
      expect(idsOf(await prs(await get(`${week}&q=%25`)))).toEqual([b]);
      expect(idsOf(await prs(await get(`${week}&q=_`)))).toEqual([]);
    });

    it('calls every PR unlinked until M8: the other tabs are empty and unlinked is everything', async () => {
      const { get, a, b } = await searchable();
      const all = await prs(await get(week));
      expect(all.counts).toEqual({ all: 2, evidence: 0, owner: 0, suggested: 0, unlinked: 2 });
      expect(
        all.items?.every((i) => i.linkClass === 'unlinked' && i.linkedSessionCount === 0),
      ).toBe(true);
      expect(idsOf(await prs(await get(`${week}&linkClass=unlinked`)))).toEqual([a, b]);
      for (const tab of ['evidence', 'owner', 'suggested']) {
        const empty = await prs(await get(`${week}&linkClass=${tab}`));
        expect(empty.items).toEqual([]);
        expect(empty.nextCursor).toBeNull();
        expect(empty.counts?.all).toBe(2);
      }
    });
  });

  describe('paging', () => {
    it('walks a cursor through every PR once, newest first, ties and all', async () => {
      const { c, get } = await world();
      addRepo(c, 'acme/widgets');
      // Five distinct merge times and two PRs sharing one, so the cursor has to break a tie.
      const times = [15, 14, 13, 13, 12, 11].map((h) => `2026-11-03T${h}:00:00Z`);
      const added = times.map((at) => ({ at, id: addPr(c, 'acme/widgets', at) }));
      const expected = [...added]
        .sort((x, y) => y.at.localeCompare(x.at) || y.id.localeCompare(x.id))
        .map((entry) => entry.id);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `/api/prs?start=2026-11-02&end=2026-11-08&limit=4${cursor ? `&cursor=${cursor}` : ''}`;
        const body = await prs(await get(query));
        expect(body.counts?.all).toBe(6);
        seen.push(...idsOf(body));
        cursor = body.nextCursor ?? null;
        pages += 1;
      } while (cursor && pages < 5);

      expect(pages).toBe(2);
      expect(seen).toEqual(expected);
    });

    it('gives no next cursor on the last page, and 50 is the default page size', async () => {
      const { c, get } = await world();
      addRepo(c, 'acme/widgets');
      for (let n = 0; n < 51; n += 1) {
        addPr(
          c,
          'acme/widgets',
          new Date(Date.parse('2026-11-03T00:00:00Z') + n * 60_000).toISOString(),
        );
      }
      const first = await prs(await get('/api/prs?start=2026-11-02&end=2026-11-08'));
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await prs(
        await get(`/api/prs?start=2026-11-02&end=2026-11-08&cursor=${first.nextCursor}`),
      );
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    });
  });

  describe('refuses what it cannot read, in plain words', () => {
    const cases: [string, string, string][] = [
      ['limit=0', 'limit', 'invalid_input'],
      ['limit=201', 'limit', 'invalid_input'],
      ['limit=lots', 'limit', 'invalid_input'],
      ['cursor=not-a-cursor', 'cursor', 'invalid_input'],
      ['linkClass=maybe', 'linkClass', 'invalid_input'],
      [`q=${'x'.repeat(201)}`, 'q', 'invalid_input'],
      ['author=everyone', 'author', 'invalid_input'],
      ['start=yesterday', 'start', 'invalid_input'],
    ];
    for (const [query, field, code] of cases) {
      it(`${query.slice(0, 40)} is 400 ${code} naming ${field}`, async () => {
        const { get } = await world();
        const res = await get(`/api/prs?${query}`);
        expect(res.status).toBe(400);
        const e = await error(res);
        expect(e.code).toBe(code);
        expect(Object.keys((e.details?.['fields'] as Record<string, string>) ?? {})).toContain(
          field,
        );
      });
    }

    it('a range before the 12-month history, or backwards, is 400 invalid_range', async () => {
      const { get } = await world();
      for (const query of ['start=2025-01-01&end=2025-01-31', 'start=2026-11-08&end=2026-11-02']) {
        const res = await get(`/api/prs?${query}`);
        expect(res.status).toBe(400);
        expect((await error(res)).code).toBe('invalid_range');
      }
    });
  });
});

describe('GET /api/year', () => {
  const year = async (response: Response) => YearResponse.parse(await response.json());

  it('counts merges per report-timezone day over the last 12 months, and summarises them', async () => {
    const { c, get } = await world();
    addRepo(c, 'acme/widgets');
    addPr(c, 'acme/widgets', '2026-11-03T07:59:00Z'); // 11-02 local
    addPr(c, 'acme/widgets', '2026-11-03T08:00:00Z'); // 11-03 local
    addPr(c, 'acme/widgets', '2026-11-03T20:00:00Z'); // 11-03 local
    addPr(c, 'acme/widgets', '2026-11-04T01:00:00Z'); // 11-03 local (17:00 PST)
    addPr(c, 'acme/widgets', '2026-09-10T19:00:00Z');

    const body = await year(await get('/api/year'));

    expect(body).toEqual({
      start: '2025-11-04',
      today: '2026-11-04',
      counts: { '2026-11-02': 1, '2026-11-03': 3, '2026-09-10': 1 },
      total: 5,
      daysWithMerge: 3,
      busiestDay: { date: '2026-11-03', count: 3 },
      delivery: 'ok',
    });
  });

  it('takes the later day when two days tie for busiest', async () => {
    const { c, get } = await world();
    addRepo(c, 'acme/widgets');
    addPr(c, 'acme/widgets', '2026-10-01T19:00:00Z');
    addPr(c, 'acme/widgets', '2026-10-01T20:00:00Z');
    addPr(c, 'acme/widgets', '2026-10-09T19:00:00Z');
    addPr(c, 'acme/widgets', '2026-10-09T20:00:00Z');
    addPr(c, 'acme/widgets', '2026-10-05T19:00:00Z');

    expect((await year(await get('/api/year'))).busiestDay).toEqual({
      date: '2026-10-09',
      count: 2,
    });
  });

  it('starts at today − 365 days: the first local day is in, the day before is out', async () => {
    const { c, get } = await world();
    addRepo(c, 'acme/widgets');
    addPr(c, 'acme/widgets', '2025-11-04T08:00:00Z'); // 00:00 on 2025-11-04 (PST)
    addPr(c, 'acme/widgets', '2025-11-04T07:59:00Z'); // 23:59 on 2025-11-03

    const body = await year(await get('/api/year'));

    expect(body.counts).toEqual({ '2025-11-04': 1 });
    expect(body.total).toBe(1);
  });

  it('follows the author rule and the repo filter', async () => {
    const { c, get } = await world();
    addRepo(c, 'acme/widgets');
    addRepo(c, 'acme/gadgets');
    addPr(c, 'acme/widgets', '2026-11-03T18:00:00Z', { author: ME });
    addPr(c, 'acme/widgets', '2026-11-03T19:00:00Z', { author: 'teammate', mergedBy: ME });
    addPr(c, 'acme/gadgets', '2026-11-02T19:00:00Z', { author: ME });

    expect((await year(await get('/api/year'))).total).toBe(2);
    expect((await year(await get('/api/year?author=all'))).total).toBe(3);
    const filtered = await year(await get('/api/year?author=all&repos=acme/widgets'));
    expect(filtered.counts).toEqual({ '2026-11-03': 2 });
    expect((await year(await get('/api/year?repos=acme/gadgets&author=all'))).total).toBe(1);
    const nobody = await year(await get('/api/year?repos=nobody/at-all'));
    expect(nobody).toMatchObject({ total: 2, delivery: 'ok' });
  });

  describe('coverage', () => {
    it('is none with no tracked repo, and none when the only one is unreachable', async () => {
      const { c, get } = await world();
      expect(await year(await get('/api/year'))).toMatchObject({
        delivery: 'none',
        total: 0,
        counts: {},
      });
      addRepo(c, 'acme/private');
      setRepoAccess(c.db, 'acme/private', { state: 'inaccessible', error: 'no access' });
      expect((await year(await get('/api/year'))).delivery).toBe('none');
    });

    it('is syncing while a repo in scope is still on its first pass, and ok once it is done', async () => {
      const { c, get } = await world();
      addRepo(c, 'acme/widgets');
      addRepo(c, 'acme/gadgets', { complete: false });
      expect((await year(await get('/api/year'))).delivery).toBe('syncing');
      // Only repos in scope count: filtered to the finished one, it is ok.
      expect((await year(await get('/api/year?repos=acme/widgets'))).delivery).toBe('ok');
      expect((await year(await get('/api/year?repos=acme/gadgets'))).delivery).toBe('syncing');
      markSyncFinished(c.db, 'acme/gadgets', { now: c.now(), complete: true });
      expect((await year(await get('/api/year'))).delivery).toBe('ok');
    });

    it('leaves a stopped repo out of the grid and of the coverage', async () => {
      const { c, get } = await world();
      addRepo(c, 'acme/widgets');
      addPr(c, 'acme/widgets', '2026-11-03T18:00:00Z');
      stopRepo(c.db, 'acme/widgets', c.now());
      expect(await year(await get('/api/year'))).toMatchObject({ total: 0, delivery: 'none' });
    });
  });

  it('refuses an author it does not know', async () => {
    const { get } = await world();
    const res = await get('/api/year?author=everyone');
    expect(res.status).toBe(400);
    expect((await error(res)).code).toBe('invalid_input');
  });
});
