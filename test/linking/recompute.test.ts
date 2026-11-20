import { describe, expect, it } from 'vitest';
import { replaceComputedLinks } from '../../src/server/db/queries/links.ts';
import { buildOverview, buildRecords } from '../../src/server/services/metrics.ts';
import { buildRoots } from '../../src/server/services/usage.ts';
import {
  recomputeLinks,
  removeLinkDecision,
  setLinkDecision,
} from '../../src/server/services/links.ts';
import { resolveUsageScope } from '../../src/server/services/usage.ts';
import {
  DAY,
  HOUR,
  MERGED,
  NOW,
  REPO,
  TZ,
  addPr,
  addRepo,
  addSession,
  computed,
  decisions,
  memoryDb,
  rows,
  showRefs,
} from './world.ts';

// Recompute (G8_3, G8_4): the whole computed table is rebuilt from what is stored; an owner decision is never touched by it; and a
// PR counts once however many sessions link to it.

const FULL = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const ctx = { nowMs: NOW, timezone: TZ };
/** This week, every author: the default view keeps only the connected login's PRs and nobody is connected here. */
const ALL = { author: 'all' };

function world() {
  const db = memoryDb();
  addRepo(db, REPO);
  addRepo(db, 'kelvin/other');
  return db;
}

describe('recomputeLinks', () => {
  it('writes evidence and suggestions from the stored identifiers, PRs and sessions, and reports the counts', () => {
    const db = world();
    const pr7 = addPr(db, 7, { commits: [FULL], headRef: 'feature/seven' });
    const pr8 = addPr(db, 8, { mergedAt: MERGED + 5 * DAY, headRef: 'feature/eight' });
    const byRef = addSession(db, { lastEventAt: MERGED - 20 * HOUR });
    const byCommit = addSession(db, { lastEventAt: MERGED - 20 * HOUR, repo: null });
    const onBranch = addSession(db, { lastEventAt: MERGED - 3 * HOUR, branch: 'feature/seven' });
    const nearby = addSession(db, { lastEventAt: MERGED - 4 * HOUR });
    const stale = addSession(db, { lastEventAt: MERGED - 4 * DAY });
    showRefs(db, byRef, { prs: ['kelvin/app#7'] });
    showRefs(db, byCommit, { commits: [FULL.slice(0, 10)] });

    const result = recomputeLinks(db, NOW);

    expect(result).toEqual({ prs: 2, sessions: 5, evidence: 2, suggested: 2 });
    expect(computed(db)).toEqual({
      [`${pr7}/${byRef}`]: 'evidence:pr_reference',
      [`${pr7}/${byCommit}`]: 'evidence:commit_match',
      [`${pr7}/${onBranch}`]: 'suggested:same_branch',
      [`${pr7}/${nearby}`]: 'suggested:same_repo_window',
    });
    // PR 8 merged days later: the stale session is out of its 48 hours, and nobody else was active then
    expect(Object.keys(computed(db)).some((key) => key.startsWith(pr8))).toBe(false);
    expect(stale).toBeGreaterThan(0);
    expect(rows(db, 'SELECT DISTINCT computed_at FROM pr_session_link')).toEqual([
      { computed_at: NOW },
    ]);
  });

  it('is idempotent: the same data gives the same links, and a second run adds nothing', () => {
    const db = world();
    addPr(db, 7);
    const s = addSession(db, { lastEventAt: MERGED - HOUR });
    showRefs(db, s, { prs: ['kelvin/app#7'] });
    recomputeLinks(db, NOW);
    const first = computed(db);
    recomputeLinks(db, NOW + HOUR);
    expect(computed(db)).toEqual(first);
    expect(rows(db, 'SELECT COUNT(*) AS n FROM pr_session_link')).toEqual([{ n: 1 }]);
  });

  it('replaces the old computation: a link whose evidence is gone leaves, a new one arrives', () => {
    const db = world();
    const pr = addPr(db, 7);
    const old = addSession(db, { lastEventAt: MERGED - 30 * HOUR });
    showRefs(db, old, { prs: ['kelvin/app#7'] });
    recomputeLinks(db, NOW);
    expect(computed(db)).toEqual({ [`${pr}/${old}`]: 'evidence:pr_reference' });

    db.exec('DELETE FROM session_ref');
    const fresh = addSession(db, { lastEventAt: MERGED - 2 * HOUR });
    recomputeLinks(db, NOW);
    expect(computed(db)).toEqual({
      [`${pr}/${old}`]: 'suggested:same_repo_window',
      [`${pr}/${fresh}`]: 'suggested:same_repo_window',
    });
  });

  it('links PRs and sessions of a stopped repo too, so the links are right when it is tracked again', () => {
    const db = memoryDb();
    addRepo(db, 'kelvin/old', { tracking: 'stopped' });
    const pr = addPr(db, 3, { repo: 'kelvin/old' });
    const s = addSession(db, { repo: 'kelvin/old', lastEventAt: MERGED - HOUR });
    recomputeLinks(db, NOW);
    expect(computed(db)).toEqual({ [`${pr}/${s}`]: 'suggested:same_repo_window' });
  });

  it('writes nothing for a database with no PRs, and clears links of PRs that are gone', () => {
    const db = world();
    expect(recomputeLinks(db, NOW)).toEqual({ prs: 0, sessions: 0, evidence: 0, suggested: 0 });
    const pr = addPr(db, 7);
    const s = addSession(db, { lastEventAt: MERGED - HOUR });
    recomputeLinks(db, NOW);
    expect(Object.keys(computed(db))).toEqual([`${pr}/${s}`]);
    db.exec('DELETE FROM pull_request');
    expect(recomputeLinks(db, NOW).prs).toBe(0);
    expect(computed(db)).toEqual({});
  });

  it('rolls back whole: a computation the table cannot take leaves the previous links in place', () => {
    const db = world();
    const pr = addPr(db, 7);
    const s = addSession(db, { lastEventAt: MERGED - HOUR });
    recomputeLinks(db, NOW);
    const before = computed(db);
    expect(() =>
      replaceComputedLinks(
        db,
        [{ prNodeId: pr, sessionId: s, class: 'evidence', basis: 'same_branch' }],
        NOW,
      ),
    ).toThrow(TypeError);
    expect(computed(db)).toEqual(before);
  });
});

describe('a refresh keeps the owner’s decisions', () => {
  it('leaves every decision as it was, byte for byte, when the computed links change under it', () => {
    const db = world();
    const pr = addPr(db, 7);
    const suggested = addSession(db, { lastEventAt: MERGED - 2 * HOUR });
    const evidence = addSession(db, { lastEventAt: MERGED - 30 * HOUR });
    const dismissed = addSession(db, { lastEventAt: MERGED - 3 * HOUR });
    const added = addSession(db, { lastEventAt: MERGED - 2 * DAY });
    showRefs(db, evidence, { prs: ['kelvin/app#7'] });
    recomputeLinks(db, NOW);

    setLinkDecision(db, pr, suggested, 'confirmed', { nowMs: 1_111 });
    setLinkDecision(db, pr, evidence, 'rejected', { nowMs: 2_222 });
    setLinkDecision(db, pr, dismissed, 'dismissed', { nowMs: 3_333 });
    setLinkDecision(db, pr, added, 'confirmed', { nowMs: 4_444 });
    const kept = decisions(db);
    expect(kept).toHaveLength(4);

    // The world moves: the evidence is gone, a newer session takes the suggestion slots, and the clock is later.
    db.exec('DELETE FROM session_ref');
    for (let n = 1; n <= 4; n += 1) addSession(db, { lastEventAt: MERGED - n * 10 * 60_000 });
    const result = recomputeLinks(db, NOW + 3 * DAY);
    expect(result.evidence).toBe(0);
    expect(computed(db)[`${pr}/${evidence}`]).toBeUndefined();

    expect(decisions(db)).toEqual(kept);
    // and they still decide: the rejected pair has no claim now, the owner link and the dismissal stand
    const roots = rows(
      db,
      `SELECT session_id, decision FROM owner_link_decision WHERE pr_node_id = '${pr}' ORDER BY session_id`,
    );
    expect(roots).toEqual(
      [
        { session_id: suggested, decision: 'confirmed' },
        { session_id: evidence, decision: 'rejected' },
        { session_id: dismissed, decision: 'dismissed' },
        { session_id: added, decision: 'confirmed' },
      ].sort((a, b) => a.session_id - b.session_id),
    );
  });

  it('keeps the effect on the views too: a rejected evidence link stays unlinked and a confirmed manual add stays linked after a refresh', () => {
    const db = world();
    const evidencePr = addPr(db, 7);
    const manualPr = addPr(db, 8, { headRef: null });
    const s = addSession(db, { lastEventAt: MERGED - 30 * HOUR });
    const manual = addSession(db, { lastEventAt: MERGED - 50 * HOUR });
    showRefs(db, s, { prs: ['kelvin/app#7'] });
    recomputeLinks(db, NOW);
    setLinkDecision(db, evidencePr, s, 'rejected', ctx);
    setLinkDecision(db, manualPr, manual, 'confirmed', ctx);

    const classes = () => {
      const prs = buildRecords(db, ALL, { limit: 30 }, ctx).prs;
      return Object.fromEntries((prs ?? []).map((p) => [p.number, p.linkClass]));
    };
    const before = classes();
    expect(before).toEqual({ 7: 'unlinked', 8: 'owner' });
    recomputeLinks(db, NOW + HOUR);
    recomputeLinks(db, NOW + 2 * HOUR);
    expect(classes()).toEqual(before);
  });

  it('keeps the decisions on a PR when a recompute meets a database with no sessions at all', () => {
    const db = world();
    const pr = addPr(db, 7);
    const s = addSession(db, { lastEventAt: MERGED - HOUR });
    recomputeLinks(db, NOW);
    setLinkDecision(db, pr, s, 'dismissed', ctx);
    const kept = decisions(db);
    db.exec('DELETE FROM pr_session_link');
    recomputeLinks(db, NOW + HOUR);
    expect(decisions(db)).toEqual(kept);
    // taking it back still works afterwards
    removeLinkDecision(db, pr, s, ctx);
    expect(decisions(db)).toEqual([]);
  });
});

describe('a PR with many sessions counts once', () => {
  it('counts one linked PR in the Overview and the records however many sessions link to it, and lists it once per session', () => {
    const db = world();
    const pr = addPr(db, 7, { commits: [FULL] });
    const sessions = [
      addSession(db, { lastEventAt: MERGED - 20 * HOUR, tokens: 100 }),
      addSession(db, { lastEventAt: MERGED - 21 * HOUR, tokens: 200, provider: 'codex' }),
      addSession(db, { lastEventAt: MERGED - 22 * HOUR, tokens: 300 }),
      addSession(db, { lastEventAt: MERGED - 23 * HOUR, tokens: 400, repo: null }),
      addSession(db, { lastEventAt: MERGED - 3 * HOUR, tokens: 500 }),
      addSession(db, { lastEventAt: MERGED - 2 * HOUR, tokens: 600 }),
    ];
    showRefs(db, sessions[0]!, { prs: ['kelvin/app#7'] });
    showRefs(db, sessions[1]!, { prs: ['kelvin/app#7'], commits: [FULL] }); // both: still one link
    showRefs(db, sessions[2]!, { commits: [FULL.slice(0, 7)] });
    showRefs(db, sessions[3]!, { commits: [FULL] });
    recomputeLinks(db, NOW);
    // four evidence links, two suggestions, one PR
    expect(
      rows(db, 'SELECT class, COUNT(*) AS n FROM pr_session_link GROUP BY class ORDER BY class'),
    ).toEqual([
      { class: 'evidence', n: 4 },
      { class: 'suggested', n: 2 },
    ]);
    setLinkDecision(db, pr, sessions[4]!, 'confirmed', ctx); // and an owner link on top

    const overview = buildOverview(db, ALL, ctx);
    expect(overview.kpis.mergedPrs?.value).toBe(1);
    expect(overview.kpis.linkedPrs).toMatchObject({ value: 1, of: 1 });
    const records = buildRecords(db, ALL, { limit: 30 }, ctx);
    expect(records.prTotal).toBe(1);
    expect(records.prs).toHaveLength(1);
    expect(records.prs?.[0]).toMatchObject({
      linkClass: 'evidence',
      linkedSessionCount: 5, // four by evidence and the owner's one; the remaining suggestion is counted apart
      suggestedCount: 1,
      providers: ['codex', 'claude'],
    });
    // the PR's repo row counts it once as well
    expect(overview.repoRows?.find((r) => r.repo === REPO)).toMatchObject({
      mergedPrs: 1,
      linkedPrs: 1,
    });
  });
});

describe('the Usage tree’s linked PRs (G8_6)', () => {
  it('lists each session’s PRs with the class they count as, evidence first, once per PR', () => {
    const db = world();
    const evidencePr = addPr(db, 7, { commits: [FULL] });
    const suggestedPr = addPr(db, 8, { mergedAt: MERGED + 2 * HOUR, headRef: 'x' });
    const ownerPr = addPr(db, 9, { mergedAt: MERGED + DAY });
    const s = addSession(db, { lastEventAt: MERGED + HOUR, tokens: 50 });
    showRefs(db, s, { commits: [FULL] });
    recomputeLinks(db, NOW);
    // the session is evidence for PR 7, suggested for PR 8 (last event is 1 h before it merged), and the owner adds PR 9
    setLinkDecision(db, ownerPr, s, 'confirmed', ctx);

    const scope = resolveUsageScope(db, { start: '2026-10-25', end: '2026-11-04' }, ctx);
    const tree = buildRoots(db, scope, { groupKey: REPO, limit: 15 });
    const session = tree.roots?.[0];
    expect(session).toBeDefined();
    expect(session?.id).toBe(s);
    expect(session?.linkStatus).toBe('linked');
    expect(session?.linkedPrs).toEqual([
      {
        prId: evidencePr,
        repo: REPO,
        number: 7,
        mergedAt: '2026-11-03T18:00:00.000Z',
        class: 'evidence',
      },
      {
        prId: ownerPr,
        repo: REPO,
        number: 9,
        mergedAt: '2026-11-04T18:00:00.000Z',
        class: 'owner',
      },
      {
        prId: suggestedPr,
        repo: REPO,
        number: 8,
        mergedAt: '2026-11-03T20:00:00.000Z',
        class: 'suggested',
      },
    ]);
    // a rejected link is not listed any more
    setLinkDecision(db, evidencePr, s, 'rejected', ctx);
    const again = buildRoots(db, scope, { groupKey: REPO, limit: 15 }).roots?.[0];
    expect(again?.linkedPrs?.map((l) => l.number)).toEqual([9, 8]);
  });
});
