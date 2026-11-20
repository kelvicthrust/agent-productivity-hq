import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/shared/contracts/errors.ts';
import { EvidenceItem, PrDetailResponse } from '../../src/shared/contracts/prs.ts';
import { replaceComputedLinks, type ComputedLinkRow } from '../../src/server/db/queries/links.ts';
import {
  buildPrDetail,
  recomputeLinks,
  removeLinkDecision,
  setLinkDecision,
} from '../../src/server/services/links.ts';
import {
  DAY,
  HOUR,
  MERGED,
  NOW,
  REPO,
  addPr,
  addRepo,
  addSession,
  decisions,
  memoryDb,
  rows,
} from './world.ts';

// The owner-decision service (G8_4): the transition table of TECH › Owner link decision transitions, one transaction per decision,
// and the candidate list "Link a session" offers.

type Decision = 'confirmed' | 'rejected' | 'dismissed';
const DECISIONS: Decision[] = ['confirmed', 'dismissed', 'rejected'];

const SUGGESTED_TEXT = 'Same repo · active within 48 h before merge';
const EVIDENCE_TEXT = 'PR reference recorded in session';

/** One PR and one session in each state a pair can be in, built straight into the tables so each state is exact. */
function pairs() {
  const db = memoryDb();
  addRepo(db, REPO);
  addRepo(db, 'kelvin/other');
  const pr = addPr(db, 7);
  const at = (h: number) => MERGED - h * HOUR;
  const session = (hoursBefore: number, extra: Parameters<typeof addSession>[1] | object = {}) =>
    addSession(db, { lastEventAt: at(hoursBefore), ...extra });

  const s = {
    evidence: session(30),
    evidenceConfirmed: session(31),
    suggested: session(5),
    owner: session(6),
    ownerAdded: session(40),
    rejected: session(32),
    hidden: session(7),
    candidate: session(50),
    outside: session(24 * 4), // last active 4 days before the merge: outside the 3 days
    otherRepo: session(2, { repo: 'kelvin/other' }),
    noRepo: session(2, { repo: null }),
  };
  const link = (id: number, cls: 'evidence' | 'suggested', basis: ComputedLinkRow['basis']) => ({
    prNodeId: pr,
    sessionId: id,
    class: cls,
    basis,
  });
  replaceComputedLinks(
    db,
    [
      link(s.evidence, 'evidence', 'pr_reference'),
      link(s.evidenceConfirmed, 'evidence', 'commit_match'),
      link(s.suggested, 'suggested', 'same_repo_window'),
      link(s.owner, 'suggested', 'same_repo_window'),
      link(s.rejected, 'evidence', 'pr_reference'),
      link(s.hidden, 'suggested', 'same_repo_window'),
    ],
    NOW,
  );
  const decide = db.prepare(
    `INSERT INTO owner_link_decision (pr_node_id, session_id, decision, prior_class, prior_basis, decided_at)
     VALUES (?, ?, ?, ?, ?, 100)`,
  );
  decide.run(pr, s.evidenceConfirmed, 'confirmed', 'evidence', 'commit_match');
  decide.run(pr, s.owner, 'confirmed', 'suggested', 'same_repo_window');
  decide.run(pr, s.ownerAdded, 'confirmed', null, null);
  decide.run(pr, s.rejected, 'rejected', 'evidence', 'pr_reference');
  decide.run(pr, s.hidden, 'dismissed', 'suggested', 'same_repo_window');
  return { db, pr, s };
}

type Outcome = 'set' | 'keep' | 'refuse';
type StateName = keyof ReturnType<typeof pairs>['s'];

const TABLE: Record<StateName, Record<Decision, Outcome>> = {
  evidence: { confirmed: 'refuse', dismissed: 'refuse', rejected: 'set' },
  evidenceConfirmed: { confirmed: 'keep', dismissed: 'refuse', rejected: 'set' },
  suggested: { confirmed: 'set', dismissed: 'set', rejected: 'refuse' },
  owner: { confirmed: 'keep', dismissed: 'refuse', rejected: 'refuse' },
  ownerAdded: { confirmed: 'keep', dismissed: 'refuse', rejected: 'refuse' },
  rejected: { confirmed: 'refuse', dismissed: 'refuse', rejected: 'keep' },
  hidden: { confirmed: 'set', dismissed: 'keep', rejected: 'refuse' },
  candidate: { confirmed: 'set', dismissed: 'refuse', rejected: 'refuse' },
  outside: { confirmed: 'refuse', dismissed: 'refuse', rejected: 'refuse' },
  otherRepo: { confirmed: 'refuse', dismissed: 'refuse', rejected: 'refuse' },
  noRepo: { confirmed: 'refuse', dismissed: 'refuse', rejected: 'refuse' },
};

const detail = (db: DatabaseSync, prId: string) => buildPrDetail(db, prId);

const decisionOf = (db: DatabaseSync, pr: string, session: number) =>
  decisions(db).find((d) => d['pr_node_id'] === pr && d['session_id'] === session);

const refusal = (run: () => unknown): ApiError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the change to be refused');
};

describe('the transition table', () => {
  const cases = Object.entries(TABLE).flatMap(([state, byDecision]) =>
    DECISIONS.map((decision) => [state as StateName, decision, byDecision[decision]] as const),
  );

  it.each(cases)('%s + %s → %s', (state, decision, outcome) => {
    const { db, pr, s } = pairs();
    const session = s[state];
    const before = decisions(db);
    const run = () => setLinkDecision(db, pr, session, decision, { nowMs: 9_999 });

    if (outcome === 'refuse') {
      const error = refusal(run);
      expect(error.code).toBe('invalid_input');
      expect(error.status).toBe(400);
      expect(error.details).toMatchObject({ fields: { decision: error.message } });
      expect(decisions(db)).toEqual(before); // nothing was written
      expect(db.isTransaction).toBe(false);
      return;
    }
    const item = EvidenceItem.parse(run());
    expect(item.session.id).toBe(session);
    expect(db.isTransaction).toBe(false);
    const row = decisionOf(db, pr, session);
    if (outcome === 'keep') {
      expect(decisions(db)).toEqual(before); // idempotent: not even decided_at moves
    } else {
      expect(row).toMatchObject({ decision, decided_at: 9_999 });
    }
  });

  it('covers every state the table names', () => {
    const { s } = pairs();
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(s).sort());
  });

  it('records the source claim the decision was made over, and none for a session with no claim', () => {
    const { db, pr, s } = pairs();
    setLinkDecision(db, pr, s.suggested, 'confirmed', { nowMs: 1 });
    setLinkDecision(db, pr, s.evidence, 'rejected', { nowMs: 2 });
    setLinkDecision(db, pr, s.candidate, 'confirmed', { nowMs: 3 });
    expect(decisionOf(db, pr, s.suggested)).toMatchObject({
      prior_class: 'suggested',
      prior_basis: 'same_repo_window',
    });
    expect(decisionOf(db, pr, s.evidence)).toMatchObject({
      decision: 'rejected',
      prior_class: 'evidence',
      prior_basis: 'pr_reference',
    });
    expect(decisionOf(db, pr, s.candidate)).toMatchObject({ prior_class: null, prior_basis: null });
  });

  it('leaves the computed claim alone whatever the owner decides', () => {
    const { db, pr, s } = pairs();
    const claims = () => rows(db, 'SELECT * FROM pr_session_link ORDER BY session_id');
    const before = claims();
    setLinkDecision(db, pr, s.suggested, 'dismissed', { nowMs: 1 });
    setLinkDecision(db, pr, s.evidence, 'rejected', { nowMs: 1 });
    setLinkDecision(db, pr, s.candidate, 'confirmed', { nowMs: 1 });
    removeLinkDecision(db, pr, s.owner, { nowMs: 1 });
    expect(claims()).toEqual(before);
  });
});

describe('unknown PRs and sessions', () => {
  it('is not_found for an unknown PR or session, for a decision and for taking one back', () => {
    const { db, pr, s } = pairs();
    const notFound = (run: () => unknown) => {
      const error = refusal(run);
      expect(error.code).toBe('not_found');
      expect(error.status).toBe(404);
      return error;
    };
    for (const decision of DECISIONS) {
      notFound(() => setLinkDecision(db, 'PR_nope', s.suggested, decision, { nowMs: 1 }));
      notFound(() => setLinkDecision(db, pr, 987_654, decision, { nowMs: 1 }));
    }
    notFound(() => removeLinkDecision(db, 'PR_nope', s.suggested, { nowMs: 1 }));
    notFound(() => removeLinkDecision(db, pr, 987_654, { nowMs: 1 }));
    expect(decisions(db)).toHaveLength(5);
  });

  it('can still take back a decision about a session that is gone, and the unknown id is not echoed', () => {
    const { db, pr } = pairs();
    db.prepare(
      "INSERT INTO owner_link_decision (pr_node_id, session_id, decision, decided_at) VALUES (?, 424242, 'confirmed', 1)",
    ).run(pr);
    removeLinkDecision(db, pr, 424_242, { nowMs: 2 });
    expect(decisionOf(db, pr, 424_242)).toBeUndefined();
    const error = refusal(() => detail(db, 'PR_nope'));
    expect(JSON.stringify(error.toEnvelope())).not.toMatch(/PR_nope/);
  });
});

describe('taking a decision back', () => {
  it('shows the computed class again, and is idempotent', () => {
    const { db, pr, s } = pairs();
    removeLinkDecision(db, pr, s.owner, { nowMs: 5 });
    expect(decisionOf(db, pr, s.owner)).toBeUndefined();
    removeLinkDecision(db, pr, s.owner, { nowMs: 6 }); // nothing to take back: not an error
    removeLinkDecision(db, pr, s.candidate, { nowMs: 6 });
    const items = detail(db, pr).evidence;
    expect(items.find((i) => i.session.id === s.owner)).toMatchObject({
      effectiveClass: 'suggested',
      basisText: SUGGESTED_TEXT,
    });
  });

  it('is the Undo of every change: the pair goes back to what it was', () => {
    const { db, pr, s } = pairs();
    const state = (id: number) => decisionOf(db, pr, id)?.['decision'] ?? null;
    // Confirm, Dismiss, Mark incorrect and Link a session are undone by taking the decision back
    for (const [id, decision] of [
      [s.suggested, 'confirmed'],
      [s.suggested, 'dismissed'],
      [s.evidence, 'rejected'],
      [s.candidate, 'confirmed'],
    ] as const) {
      const was = state(id);
      setLinkDecision(db, pr, id, decision, { nowMs: 1 });
      removeLinkDecision(db, pr, id, { nowMs: 2 });
      expect(state(id)).toBe(was);
    }
    // Restore and Remove link are undone by putting the decision back
    removeLinkDecision(db, pr, s.rejected, { nowMs: 3 });
    setLinkDecision(db, pr, s.rejected, 'rejected', { nowMs: 4 });
    expect(state(s.rejected)).toBe('rejected');
    removeLinkDecision(db, pr, s.owner, { nowMs: 3 });
    setLinkDecision(db, pr, s.owner, 'confirmed', { nowMs: 4 });
    expect(state(s.owner)).toBe('confirmed');
    removeLinkDecision(db, pr, s.ownerAdded, { nowMs: 3 });
    setLinkDecision(db, pr, s.ownerAdded, 'confirmed', { nowMs: 4 });
    expect(state(s.ownerAdded)).toBe('confirmed');
  });
});

describe('the item a decision answers with', () => {
  it('words each state as the design does and offers only what the table allows from it', () => {
    const { db, pr, s } = pairs();
    const answer = (id: number, d: Decision) =>
      EvidenceItem.parse(setLinkDecision(db, pr, id, d, { nowMs: 1 }));

    const confirmed = answer(s.suggested, 'confirmed');
    expect(confirmed).toMatchObject({
      effectiveClass: 'owner',
      sourceClass: 'suggested',
      basis: 'owner',
      basisText: `Confirmed by you (was suggested: ${SUGGESTED_TEXT})`,
      actions: ['remove'],
    });

    const rejected = answer(s.evidence, 'rejected');
    expect(rejected).toMatchObject({
      effectiveClass: 'rejected',
      sourceClass: 'evidence',
      basis: 'pr_reference',
      basisText: `Source claim kept: ${EVIDENCE_TEXT}. You marked it incorrect, so it isn’t counted as linked.`,
      actions: ['restore'],
    });

    const linked = answer(s.candidate, 'confirmed');
    expect(linked).toMatchObject({
      effectiveClass: 'owner',
      sourceClass: null,
      basis: 'owner',
      basisText: 'Confirmed by you',
      actions: ['remove'],
    });

    const idempotent = answer(s.owner, 'confirmed');
    expect(idempotent.effectiveClass).toBe('owner');
  });

  it('answers a Dismiss with the claim as it was and no actions, and the pair leaves the list', () => {
    const { db, pr, s } = pairs();
    const item = EvidenceItem.parse(
      setLinkDecision(db, pr, s.suggested, 'dismissed', { nowMs: 1 }),
    );
    expect(item).toMatchObject({
      effectiveClass: 'suggested',
      sourceClass: 'suggested',
      actions: [],
    });
    expect(item.basisText).toContain('Dismissed by you');
    expect(detail(db, pr).evidence.some((i) => i.session.id === s.suggested)).toBe(false);
  });

  it('shows over evidence a confirmation that was made before the evidence arrived, as evidence', () => {
    const { db, pr, s } = pairs();
    const item = detail(db, pr).evidence.find((i) => i.session.id === s.evidenceConfirmed);
    expect(item).toMatchObject({
      effectiveClass: 'evidence',
      basis: 'commit_match',
      actions: ['reject'],
    });
  });
});

describe('the PR detail', () => {
  it('lists evidence, then owner, then suggested, then marked incorrect, and leaves a dismissed suggestion out', () => {
    const { db, pr, s } = pairs();
    const parsed = PrDetailResponse.parse(detail(db, pr));
    const listed = (parsed.evidence ?? []).map((i) => [i.effectiveClass, i.session.id]);
    expect(listed.map(([cls]) => cls)).toEqual([
      'evidence',
      'evidence',
      'owner',
      'owner',
      'suggested',
      'rejected',
    ]);
    expect(listed.map(([, id]) => id)).not.toContain(s.hidden);
    // within a class, the most recently active session first
    expect(listed.filter(([cls]) => cls === 'evidence').map(([, id]) => id)).toEqual([
      s.evidence,
      s.evidenceConfirmed,
    ]);
  });

  it('gives the PR row its class and counts from the same items', () => {
    const { db, pr, s } = pairs();
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('github_login', 'KELVIN')").run();
    const { pr: row } = detail(db, pr);
    expect(row).toMatchObject({
      id: pr,
      repo: REPO,
      number: 7,
      mergedAt: new Date(MERGED).toISOString(),
      authoredByMe: true,
      linkClass: 'evidence',
      linkedSessionCount: 4, // two evidence, two owner (the rejected and dismissed pairs do not count)
      suggestedCount: 1,
      providers: ['claude'],
    });
    // marking one evidence link incorrect takes it out of the count and leaves the PR linked by the others
    setLinkDecision(db, pr, s.evidence, 'rejected', { nowMs: 1 });
    expect(detail(db, pr).pr).toMatchObject({ linkClass: 'evidence', linkedSessionCount: 3 });
  });

  it('is not_found for a PR of a stopped repo, as it is not in the Delivery list', () => {
    const { db } = pairs();
    addRepo(db, 'kelvin/gone', { tracking: 'stopped' });
    const gone = addPr(db, 3, { repo: 'kelvin/gone' });
    expect(refusal(() => detail(db, gone)).code).toBe('not_found');
  });

  it('gives a PR with nothing linked an empty evidence list and unlinked', () => {
    const db = memoryDb();
    addRepo(db, REPO);
    const pr = addPr(db, 11);
    const result = PrDetailResponse.parse(detail(db, pr));
    expect(result.evidence).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.pr).toMatchObject({
      linkClass: 'unlinked',
      linkedSessionCount: 0,
      suggestedCount: 0,
    });
  });
});

describe('candidates for "Link a session"', () => {
  const ids = (db: DatabaseSync, pr: string) =>
    (detail(db, pr).candidates ?? []).map((session) => session.id);

  it('are same-repo sessions active in the 3 days up to the merge that are not already listed', () => {
    const { db, pr, s } = pairs();
    // not listed: the candidate (computed nothing, no decision). Listed pairs never appear again, except a dismissed suggestion.
    expect(new Set(ids(db, pr))).toEqual(new Set([s.candidate, s.hidden]));
  });

  it('includes the edge of the window and excludes a millisecond before it, and a session that began after the merge', () => {
    const db = memoryDb();
    addRepo(db, REPO);
    const pr = addPr(db, 7);
    const onEdge = addSession(db, { lastEventAt: MERGED - 3 * DAY, startedAt: MERGED - 4 * DAY });
    const justOut = addSession(db, {
      lastEventAt: MERGED - 3 * DAY - 1,
      startedAt: MERGED - 4 * DAY,
    });
    const spanning = addSession(db, {
      lastEventAt: MERGED + 6 * HOUR,
      startedAt: MERGED - 2 * HOUR,
    });
    const later = addSession(db, { lastEventAt: MERGED + 6 * HOUR, startedAt: MERGED + HOUR });
    expect(new Set(ids(db, pr))).toEqual(new Set([onEdge, spanning]));
    expect(ids(db, pr)).not.toContain(justOut);
    expect(ids(db, pr)).not.toContain(later);
  });

  it('is the same set the "Link a session" guard accepts: offered means allowed, not offered means refused', () => {
    const db = memoryDb();
    addRepo(db, REPO);
    addRepo(db, 'kelvin/other');
    const pr = addPr(db, 7);
    const all = [
      addSession(db, { lastEventAt: MERGED - HOUR }),
      addSession(db, { lastEventAt: MERGED - 3 * DAY }),
      addSession(db, { lastEventAt: MERGED - 3 * DAY - 1 }),
      addSession(db, { lastEventAt: MERGED + DAY, startedAt: MERGED + HOUR }),
      addSession(db, { lastEventAt: MERGED + DAY, startedAt: MERGED - HOUR }),
      addSession(db, { lastEventAt: MERGED - HOUR, repo: 'kelvin/other' }),
      addSession(db, { lastEventAt: MERGED - HOUR, repo: null }),
    ];
    const offered = new Set(ids(db, pr));
    for (const id of all) {
      let allowed = true;
      try {
        setLinkDecision(db, pr, id, 'confirmed', { nowMs: 1 });
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        allowed = false;
      }
      expect(allowed, `session ${id}`).toBe(offered.has(id));
    }
  });

  it('offers the most recently active first, at most 30, and none that is already listed', () => {
    const db = memoryDb();
    addRepo(db, REPO);
    const pr = addPr(db, 7);
    const sessions = Array.from({ length: 35 }, (_, n) =>
      addSession(db, {
        lastEventAt: MERGED - (n + 1) * 10 * 60_000 - 3 * HOUR,
        startedAt: MERGED - 3 * DAY,
      }),
    );
    recomputeLinks(db, NOW); // the 3 most recent become suggestions and leave the candidates
    const offered = ids(db, pr);
    expect(offered).toHaveLength(30);
    expect(offered).toEqual(sessions.slice(3, 33));
  });

  it('shows a session with all its tokens, not a period’s', () => {
    const db = memoryDb();
    addRepo(db, REPO);
    const pr = addPr(db, 7);
    const s = addSession(db, { lastEventAt: MERGED - 60 * HOUR, tokens: 1234 });
    db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total)
       VALUES ('claude', 'second', ?, ?, 'm', 66)`,
    ).run(s, MERGED - 61 * HOUR);
    const candidate = detail(db, pr).candidates?.[0];
    expect(candidate).toMatchObject({ id: s, tokens: 1300, linkStatus: 'unlinked', linkedPrs: [] });
  });

  it('offers a dismissed suggestion again, and linking it makes it an owner link that keeps the claim', () => {
    const { db, pr, s } = pairs();
    expect(ids(db, pr)).toContain(s.hidden);
    const item = setLinkDecision(db, pr, s.hidden, 'confirmed', { nowMs: 77 });
    expect(item).toMatchObject({
      effectiveClass: 'owner',
      sourceClass: 'suggested',
      basisText: `Confirmed by you (was suggested: ${SUGGESTED_TEXT})`,
    });
    expect(ids(db, pr)).not.toContain(s.hidden);
  });
});

describe('a link lists the session’s PRs too', () => {
  it('shows the session in an item with its own linked PRs and status', () => {
    const { db, pr, s } = pairs();
    const item = detail(db, pr).evidence.find((i) => i.session.id === s.evidence);
    expect(item?.session).toMatchObject({
      linkStatus: 'linked',
      linkedPrs: [{ prId: pr, repo: REPO, number: 7, class: 'evidence' }],
    });
  });
});
