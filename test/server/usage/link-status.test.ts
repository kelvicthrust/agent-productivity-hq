import { describe, expect, it } from 'vitest';
import {
  decideLinkStatus,
  effectiveLinkClass,
  linkedPrsOf,
} from '../../../src/server/services/usage.ts';
import type { LinkRow } from '../../../src/server/db/queries/usage.ts';
import { seedDatabase } from '../../fixtures/seed.ts';
import {
  addDecision,
  addLink,
  addPr,
  addRepo,
  addActiveSession,
  addEvent,
  addSession,
  at,
  groups,
  memoryDb,
  prNode,
  roots,
  usageApp,
} from './helpers.ts';

// data-and-sources › Usage-tree link status. The server decides how the Linked PRs cell is worded; the client never infers a
// check from missing data, and "Unlinked" is only possible when a check could really happen.

describe('effectiveLinkClass', () => {
  const table: [
    'evidence' | 'suggested' | null,
    'confirmed' | 'rejected' | 'dismissed' | null,
    string | null,
  ][] = [
    ['evidence', null, 'evidence'],
    ['suggested', null, 'suggested'],
    [null, null, null],
    ['suggested', 'confirmed', 'owner'],
    [null, 'confirmed', 'owner'], // a manual add has no computed link
    ['evidence', 'confirmed', 'evidence'], // a confirmation never weakens an evidence claim
    ['evidence', 'rejected', null], // "Mark incorrect" hides it
    ['suggested', 'rejected', null],
    ['suggested', 'dismissed', null],
    ['evidence', 'dismissed', null],
  ];
  it.each(table)('computed %s + decision %s → %s', (computed, decision, expected) => {
    expect(effectiveLinkClass(computed, decision)).toBe(expected);
  });
});

describe('decideLinkStatus', () => {
  const ok = { trackingState: 'active', accessState: 'ok', backfillComplete: true } as const;
  const link = [
    { prId: 'p', repo: 'a/b', number: 1, mergedAt: '2026-10-29T18:00:00.000Z', class: 'suggested' },
  ] as const;

  it('is linked whenever a link is listed, whatever the repo state', () => {
    expect(decideLinkStatus('a/b', ok, link)).toBe('linked');
    expect(decideLinkStatus(null, undefined, link)).toBe('linked');
    expect(decideLinkStatus('x/y', undefined, link)).toBe('linked');
  });

  it('is repo_unknown with no repo recorded', () => {
    expect(decideLinkStatus(null, undefined, [])).toBe('repo_unknown');
  });

  it('is repo_not_tracked for a repo that is stopped or has no repo row', () => {
    expect(decideLinkStatus('x/y', undefined, [])).toBe('repo_not_tracked');
    expect(decideLinkStatus('x/y', { ...ok, trackingState: 'stopped' }, [])).toBe(
      'repo_not_tracked',
    );
  });

  it('is prs_not_collected for a tracked repo that is not readable or not fully backfilled', () => {
    expect(decideLinkStatus('a/b', { ...ok, accessState: 'inaccessible' }, [])).toBe(
      'prs_not_collected',
    );
    expect(decideLinkStatus('a/b', { ...ok, accessState: 'unknown' }, [])).toBe(
      'prs_not_collected',
    );
    expect(decideLinkStatus('a/b', { ...ok, backfillComplete: false }, [])).toBe(
      'prs_not_collected',
    );
  });

  it('is unlinked only for a tracked, readable, fully collected repo with no link', () => {
    expect(decideLinkStatus('a/b', ok, [])).toBe('unlinked');
  });
});

describe('linkedPrsOf', () => {
  const row = (over: Partial<LinkRow>): LinkRow => ({
    sessionId: 1,
    prNodeId: 'p',
    prRepo: 'a/b',
    prNumber: 1,
    mergedAt: 0,
    computed: 'suggested',
    decision: null,
    ...over,
  });

  it('orders evidence, then owner, then suggested, newest merge first', () => {
    const list = linkedPrsOf([
      row({ prNodeId: 's-new', prNumber: 5, mergedAt: 500, computed: 'suggested' }),
      row({
        prNodeId: 'o-old',
        prNumber: 3,
        mergedAt: 100,
        computed: 'suggested',
        decision: 'confirmed',
      }),
      row({ prNodeId: 'e-old', prNumber: 1, mergedAt: 50, computed: 'evidence' }),
      row({ prNodeId: 'o-new', prNumber: 4, mergedAt: 400, computed: null, decision: 'confirmed' }),
      row({ prNodeId: 'e-new', prNumber: 2, mergedAt: 300, computed: 'evidence' }),
      row({ prNodeId: 's-old', prNumber: 6, mergedAt: 10, computed: 'suggested' }),
    ]);
    expect(list.map((l) => `${l.class}:${l.prId}`)).toEqual([
      'evidence:e-new',
      'evidence:e-old',
      'owner:o-new',
      'owner:o-old',
      'suggested:s-new',
      'suggested:s-old',
    ]);
  });

  it('leaves out rejected and dismissed links', () => {
    expect(
      linkedPrsOf([
        row({ computed: 'evidence', decision: 'rejected' }),
        row({ prNodeId: 'q', computed: 'suggested', decision: 'dismissed' }),
      ]),
    ).toEqual([]);
  });
});

describe('Session.linkStatus and linkedPrs through the roots route', () => {
  /** Every case is one root session with an event this week, in its own repo situation. */
  function world() {
    const db = memoryDb();
    addRepo(db, 'acme/api'); // tracked, readable, backfilled
    addRepo(db, 'acme/web', { access: 'inaccessible' });
    addRepo(db, 'acme/new', { backfill: false });
    addRepo(db, 'acme/odd', { access: 'unknown' });
    addRepo(db, 'acme/old', { tracking: 'stopped' });

    const day = (n: number) => at(`2026-11-0${n}`, '09:00');
    const s = (id: number, repo: string | null) =>
      addActiveSession(db, { id, repo, startedAt: day(2) + id * 60_000 });

    // Links live on acme/api's PRs.
    const pr1 = addPr(db, 'acme/api', 1, at('2026-10-20'));
    const pr2 = addPr(db, 'acme/api', 2, at('2026-10-25'));
    const pr3 = addPr(db, 'acme/api', 3, at('2026-10-27'));
    const pr4 = addPr(db, 'acme/api', 4, at('2026-10-30'));
    const pr5 = addPr(db, 'acme/api', 5, at('2026-11-01'));
    const stoppedPr = addPr(db, 'acme/old', 9, at('2026-10-28'));

    // 1: every class at once, in a deliberately scrambled insertion order
    s(1, 'acme/api');
    addLink(db, pr2, 1, 'suggested');
    addLink(db, pr3, 1, 'suggested');
    addDecision(db, pr3, 1, 'confirmed'); // suggested, confirmed by the owner → owner
    addDecision(db, pr4, 1, 'confirmed'); // manual add, no computed link → owner
    addLink(db, pr1, 1, 'evidence');
    // 2: the only link was marked incorrect → unlinked
    s(2, 'acme/api');
    addLink(db, pr1, 2, 'evidence');
    addDecision(db, pr1, 2, 'rejected');
    // 3: the only link was dismissed → unlinked
    s(3, 'acme/api');
    addLink(db, pr2, 3, 'suggested');
    addDecision(db, pr2, 3, 'dismissed');
    // 4: a suggestion alone is still linked
    s(4, 'acme/api');
    addLink(db, pr5, 4, 'suggested');
    // 5: nothing
    s(5, 'acme/api');
    // 6: link only to a stopped repo's PR, which Delivery does not show → not listed
    s(6, 'acme/api');
    addLink(db, stoppedPr, 6, 'evidence');
    // 7..9: tracked repos whose PRs were not (all) collected
    s(7, 'acme/web');
    s(8, 'acme/new');
    s(9, 'acme/odd');
    // 10, 11, 12: not tracked / no repo
    s(10, 'acme/old');
    s(11, 'acme/dotfiles'); // never a repo row
    s(12, null);
    // 13: no repo recorded but a link exists → linked wins
    s(13, null);
    addLink(db, pr4, 13, 'evidence');

    return { db, app: usageApp(db), pr: { pr1, pr2, pr3, pr4, pr5 } };
  }

  async function statusOf(w: ReturnType<typeof world>) {
    const out = new Map<number, { status: string; links: string[] }>();
    for (const key of [
      'acme/api',
      'acme/web',
      'acme/new',
      'acme/odd',
      '__untracked',
      '__unknown',
    ]) {
      const body = await roots(w.app, key, '?limit=100');
      for (const session of body.roots ?? []) {
        out.set(session.id, {
          status: session.linkStatus,
          links: session.linkedPrs.map((l) => `${l.class}#${l.number}`),
        });
      }
    }
    return out;
  }

  it('words every session honestly', async () => {
    const w = world();
    const status = await statusOf(w);
    const read = (id: number) => status.get(id)?.status;
    expect(read(1)).toBe('linked');
    expect(read(2)).toBe('unlinked');
    expect(read(3)).toBe('unlinked');
    expect(read(4)).toBe('linked');
    expect(read(5)).toBe('unlinked');
    expect(read(6)).toBe('unlinked');
    expect(read(7)).toBe('prs_not_collected');
    expect(read(8)).toBe('prs_not_collected');
    expect(read(9)).toBe('prs_not_collected');
    expect(read(10)).toBe('repo_not_tracked');
    expect(read(11)).toBe('repo_not_tracked');
    expect(read(12)).toBe('repo_unknown');
    expect(read(13)).toBe('linked');
    expect(status.size).toBe(13);
  });

  it('lists effective links only: evidence, owner, suggested, newest merge first', async () => {
    const status = await statusOf(world());
    expect(status.get(1)?.links).toEqual(['evidence#1', 'owner#4', 'owner#3', 'suggested#2']);
    expect(status.get(4)?.links).toEqual(['suggested#5']);
    expect(status.get(13)?.links).toEqual(['evidence#4']);
  });

  it('lists nothing unless the status is linked', async () => {
    const status = await statusOf(world());
    for (const { status: s, links } of status.values()) {
      expect(links.length > 0).toBe(s === 'linked');
    }
  });

  it('carries the PR id, repo and number of each link', async () => {
    const w = world();
    const body = await roots(w.app, 'acme/api', '?limit=100');
    const first = body.roots?.find((s) => s.id === 1);
    expect(first?.linkedPrs[0]).toEqual({
      prId: prNode('acme/api', 1),
      repo: 'acme/api',
      number: 1,
      mergedAt: '2026-10-20T17:00:00.000Z',
      class: 'evidence',
    });
  });

  it('never says Unlinked where no check could happen, even with no links at all', async () => {
    const w = world();
    const status = await statusOf(w);
    for (const id of [7, 8, 9, 10, 11, 12]) {
      expect(status.get(id)?.links).toEqual([]);
      expect(status.get(id)?.status).not.toBe('unlinked');
    }
  });

  it('is computed per request from stored rows, and reading never changes a link or a decision', async () => {
    const w = world();
    const count = (table: string) =>
      (w.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = [count('pr_session_link'), count('owner_link_decision')];
    expect((await statusOf(w)).get(5)?.status).toBe('unlinked');

    // the owner confirms a link by hand; the very next read shows it
    addDecision(w.db, w.pr.pr5, 5, 'confirmed');
    const after = await statusOf(w);
    expect(after.get(5)).toEqual({ status: 'linked', links: ['owner#5'] });

    const rows = [count('pr_session_link'), count('owner_link_decision')];
    expect(rows).toEqual([before[0], before[1]! + 1]);
  });

  it('puts the status on children, orphans and unknown-relationship sessions too', async () => {
    const db = memoryDb();
    addRepo(db, 'acme/api');
    const pr = addPr(db, 'acme/api', 7, at('2026-10-30'));
    addActiveSession(db, { id: 1, repo: 'acme/api', startedAt: at('2026-11-02') });
    addActiveSession(db, {
      id: 2,
      kind: 'child',
      parent: 1,
      basis: 'native',
      repo: 'acme/api',
      startedAt: at('2026-11-02', '10:00'),
    });
    // a root whose only event is long before this week: its child is an orphan in this week's tree
    const quietRoot = addSession(db, { id: 5, repo: 'acme/api', startedAt: at('2026-09-01') });
    addEvent(db, { session: quietRoot, at: at('2026-09-01', '09:30'), input: 10 });
    addActiveSession(db, {
      id: 3,
      kind: 'child',
      parent: quietRoot,
      basis: 'native',
      repo: 'acme/api',
      startedAt: at('2026-11-02', '11:00'),
    });
    addActiveSession(db, {
      id: 4,
      kind: 'unknown',
      repo: 'acme/api',
      startedAt: at('2026-11-02', '12:00'),
    });
    addLink(db, pr, 2, 'evidence');
    addLink(db, pr, 3, 'suggested');
    addLink(db, pr, 4, 'suggested');

    const body = await roots(usageApp(db), 'acme/api');
    expect(body.roots?.[0]?.linkStatus).toBe('unlinked');
    expect(body.roots?.[0]?.children?.[0]).toMatchObject({
      id: 2,
      linkStatus: 'linked',
      linkedPrs: [{ class: 'evidence', number: 7 }],
    });
    expect(body.orphans?.[0]).toMatchObject({ id: 3, linkStatus: 'linked' });
    expect(body.unknownRelationship?.[0]).toMatchObject({ id: 4, linkStatus: 'linked' });
  });
});

describe('link status on the seeded world', () => {
  it('matches Delivery’s effective classes for every session in a group', async () => {
    const db = memoryDb();
    seedDatabase(db, { scale: 'typical' });
    const app = usageApp(db);
    const range = '?start=2025-11-05&end=2026-11-04&limit=100';
    const all = await groups(app, '?start=2025-11-05&end=2026-11-04');

    let checked = 0;
    for (const group of all.groups ?? []) {
      const body = await roots(app, group.key!, range);
      const sessions = [
        ...(body.roots ?? []).flatMap((r) => [r, ...(r.children ?? [])]),
        ...(body.orphans ?? []),
        ...(body.unknownRelationship ?? []),
      ];
      for (const session of sessions) {
        // The seed has owner confirmations (decision rows) and computed evidence and suggestions; recompute from the rows.
        const rows = db
          .prepare(
            `SELECT l.class AS computed, d.decision
               FROM pr_session_link l
               JOIN pull_request p ON p.node_id = l.pr_node_id
               JOIN repo r ON r.id = p.repo_id AND r.tracking_state = 'active'
               LEFT JOIN owner_link_decision d ON d.pr_node_id = l.pr_node_id AND d.session_id = l.session_id
              WHERE l.session_id = ?`,
          )
          .all(session.id) as { computed: string; decision: string | null }[];
        const expected = rows.filter(
          (r) => r.decision !== 'rejected' && r.decision !== 'dismissed',
        ).length;
        expect(session.linkedPrs.length, `session ${session.id}`).toBe(expected);
        expect(session.linkedPrs.length > 0).toBe(session.linkStatus === 'linked');
        if (session.repo === 'kelvin/archive-private' && expected === 0) {
          expect(session.linkStatus).toBe('prs_not_collected');
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
