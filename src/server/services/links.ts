import { ApiError } from '../../shared/contracts/errors.ts';
import type { EvidenceItem, PullRequest } from '../../shared/contracts/prs.ts';
import type { Session } from '../../shared/contracts/usage.ts';
import {
  CANDIDATE_WINDOW_MS,
  LINK_ORDER,
  MAX_CANDIDATES,
  classify,
  effectiveClass,
  indexRefs,
  indexSessions,
  isCandidate,
  summarisePr,
  type EffectiveClass,
  type LinkClass,
} from '../../shared/domain/linking.ts';
import type { Db } from '../db/open.ts';
import {
  changeDecision,
  readCandidateRows,
  readEvidenceRows,
  readLinkInputs,
  readPair,
  replaceComputedLinks,
  type ComputedLinkRow,
  type DecisionChange,
  type DecisionStored,
  type EvidenceRow,
  type LinkBasisStored,
  type PairState,
} from '../db/queries/links.ts';
import { getMeta } from '../db/queries/meta.ts';
import { listPullRequests, type PrRow } from '../db/queries/prs.ts';
import { readLinkRows, readRepoStates, type LinkRow } from '../db/queries/usage.ts';
import { toSession } from './metrics.ts';

// The link domain's service (TECH › Attribution, Owner link decision transitions; data-and-sources › Attribution):
//
//   recomputeLinks    after retention: match stored identifiers and recent same-repo activity, then rebuild the COMPUTED
//                     table in one transaction. It cannot touch an owner decision (the SQL has no way to), so a refresh never
//                     changes what the owner decided (P-27);
//   buildPrDetail     GET /api/prs/{prId}: the PR's evidence items and the sessions "Link a session" can offer;
//   setLinkDecision   PUT /api/prs/{prId}/links/{sessionId}: one owner decision, judged against the transition table and written in
//   removeLinkDecision  the same transaction it was read in; DELETE takes a decision back (Restore, Remove link and every Undo).
//
// Nothing here allocates tokens to a PR, and nothing here writes SQL: the queries are in db/queries/links.ts.

const iso = (ms: number): string => new Date(ms).toISOString();

// ---- recompute ---------------------------------------------------------------------------------------------------------

export interface LinkRecompute {
  prs: number;
  sessions: number;
  evidence: number;
  suggested: number;
}

/**
 * Classifies every merged PR and replaces the computed links with the result. Runs on whatever is stored (a source that failed
 * this run leaves its older sessions and references in place), for every PR and session whatever the repo's tracking state: the
 * views hide a stopped repo, and its links stay right for when it is tracked again. Idempotent: the same data gives the same links.
 */
export function recomputeLinks(db: Db, now: number, runId?: number): LinkRecompute {
  const { prs, sessions, refs } = readLinkInputs(db);
  const index = indexRefs(refs);
  const indexedSessions = indexSessions(sessions);
  const rows: ComputedLinkRow[] = [];
  for (const pr of prs) {
    for (const link of classify(pr, indexedSessions, index)) {
      rows.push({
        prNodeId: pr.nodeId,
        sessionId: link.sessionId,
        class: link.class,
        basis: link.basis,
      });
    }
  }
  replaceComputedLinks(db, rows, now, runId);
  const evidence = rows.filter((row) => row.class === 'evidence').length;
  return {
    prs: prs.length,
    sessions: sessions.length,
    evidence,
    suggested: rows.length - evidence,
  };
}

// ---- wording -----------------------------------------------------------------------------------------------------------

/** The source claim in words, as the design words it. */
const BASIS_TEXT: Readonly<Record<LinkBasisStored, string>> = {
  pr_reference: 'PR reference recorded in session',
  commit_match: 'Session commit matches merged commit',
  same_branch: 'Same repo and branch · active within 48 h before merge',
  same_repo_window: 'Same repo · active within 48 h before merge',
};

interface Claim {
  class: LinkClass;
  basis: LinkBasisStored;
}

/** The claim the pair carries: what the last recompute says, else what it said when the owner decided (kept with the decision). */
function claimOf(row: EvidenceRow): Claim | null {
  if (row.computed !== null) return row.computed;
  const prior = row.decision;
  if (
    prior !== null &&
    (prior.priorClass === 'evidence' || prior.priorClass === 'suggested') &&
    prior.priorBasis !== null &&
    Object.hasOwn(BASIS_TEXT, prior.priorBasis)
  ) {
    return { class: prior.priorClass, basis: prior.priorBasis as LinkBasisStored };
  }
  return null;
}

/** The actions each class offers (the design's buttons, in its order: Dismiss then Confirm). */
const ACTIONS: Readonly<
  Record<'evidence' | 'owner' | 'suggested' | 'rejected', EvidenceItem['actions']>
> = {
  evidence: ['reject'],
  owner: ['remove'],
  suggested: ['dismiss', 'confirm'],
  rejected: ['restore'],
};

/**
 * One pair as an evidence item, or null when it has nothing to show (no claim and no decision, or a dismissed suggestion, which is
 * hidden). `showHidden` is for the answer to a Dismiss: the contract's item has no "hidden" class, so the dismissed claim is
 * returned with the class it had and no actions, and the screen drops it.
 */
function toItem(
  row: EvidenceRow,
  session: Session,
  options: { showHidden?: boolean } = {},
): EvidenceItem | null {
  const cls: EffectiveClass = effectiveClass(row.computed, row.decision?.decision ?? null);
  if (cls === 'none') return null;
  if (cls === 'hidden' && !options.showHidden) return null;
  const claim = claimOf(row);
  const claimText = claim === null ? null : BASIS_TEXT[claim.basis];
  const sourceClass = claim?.class ?? null;

  switch (cls) {
    case 'evidence':
    case 'suggested':
      return {
        session,
        effectiveClass: cls,
        sourceClass,
        basis: claim?.basis ?? 'owner',
        basisText: claimText ?? 'Recorded in session',
        actions: [...ACTIONS[cls]],
      };
    case 'owner':
      return {
        session,
        effectiveClass: 'owner',
        sourceClass,
        basis: 'owner',
        basisText:
          claim === null
            ? 'Confirmed by you'
            : `Confirmed by you (was ${claim.class}: ${claimText})`,
        actions: [...ACTIONS.owner],
      };
    case 'rejected':
      return {
        session,
        effectiveClass: 'rejected',
        sourceClass,
        basis: claim?.basis ?? 'owner',
        basisText:
          claimText === null
            ? 'You marked it incorrect, so it isn’t counted as linked.'
            : `Source claim kept: ${claimText}. You marked it incorrect, so it isn’t counted as linked.`,
        actions: [...ACTIONS.rejected],
      };
    case 'hidden':
      return {
        session,
        effectiveClass: claim?.class ?? 'suggested',
        sourceClass,
        basis: claim?.basis ?? 'owner',
        basisText:
          claimText === null
            ? 'Dismissed by you.'
            : `Dismissed by you. Source claim kept: ${claimText}.`,
        actions: [],
      };
  }
}

// ---- sessions as the API shows them --------------------------------------------------------------------------------------

/** What `toSession` needs besides the row: every repo's state and the session's own links to PRs. */
function sessionLookups(db: Db, sessionIds: readonly number[]) {
  const links = new Map<number, LinkRow[]>();
  for (const link of readLinkRows(db, sessionIds)) {
    const list = links.get(link.sessionId) ?? [];
    list.push(link);
    links.set(link.sessionId, list);
  }
  return { repos: new Map(readRepoStates(db).map((repo) => [repo.id, repo])), links };
}

const NO_ROWS: readonly LinkRow[] = [];

// ---- GET /api/prs/{prId} -------------------------------------------------------------------------------------------------

export interface PrDetail {
  pr: PullRequest;
  evidence: EvidenceItem[];
  candidates: Session[];
}

const notFound = (what: 'pull request' | 'session'): ApiError =>
  new ApiError('not_found', `There is no ${what} with that id.`);

/**
 * The PR as the Delivery table shows it: only a PR of a tracked, reachable repo, so a stopped or unreachable repo's PRs are as
 * unknown here as they are in the list.
 */
function findPr(db: Db, prId: string): PrRow {
  // `readPair` finds the PR by its id; the list query then gives the display fields under the same view rules as GET /api/prs.
  const known = readPair(db, prId, 0).pr;
  const row =
    known === null
      ? undefined
      : listPullRequests(
          db,
          {
            fromMs: known.mergedAt,
            toMs: known.mergedAt + 1,
            repos: [known.repoId],
            author: { mode: 'all' },
          },
          { limit: 200 },
        ).find((candidate) => candidate.nodeId === prId);
  if (!row) throw notFound('pull request');
  return row;
}

/** Strongest first (evidence, owner, suggested, then the struck-through ones), the most recently active session first within each. */
function itemOrder(a: EvidenceItem, b: EvidenceItem): number {
  const rank = (item: EvidenceItem): number =>
    item.effectiveClass === 'rejected' ? 3 : LINK_ORDER[item.effectiveClass];
  return (
    rank(a) - rank(b) ||
    Date.parse(b.session.lastEventAt) - Date.parse(a.session.lastEventAt) ||
    b.session.id - a.session.id
  );
}

/**
 * One PR's evidence: every session with a computed link or an owner decision (a dismissed suggestion is hidden), and up to 30
 * candidate sessions for "Link a session": same repo, active in the 3 days up to the merge, not already listed. The `pr` is the
 * Delivery row, with its class and counts from these same items, so the row and its expansion cannot disagree.
 */
export function buildPrDetail(db: Db, prId: string): PrDetail {
  const pr = findPr(db, prId);
  const rows = readEvidenceRows(db, prId);
  const candidateRows = readCandidateRows(
    db,
    prId,
    { fromMs: pr.mergedAt - CANDIDATE_WINDOW_MS, toMs: pr.mergedAt },
    MAX_CANDIDATES,
  );
  const lookups = sessionLookups(db, [
    ...rows.map((row) => row.session.id),
    ...candidateRows.map((row) => row.id),
  ]);
  const sessionOf = (row: EvidenceRow['session']): Session =>
    toSession(row, lookups.repos, lookups.links.get(row.id) ?? NO_ROWS);

  const evidence = rows
    .flatMap((row) => {
      const item = toItem(row, sessionOf(row.session));
      return item === null ? [] : [item];
    })
    .sort(itemOrder);

  const summary = summarisePr(evidence.map((item) => item.effectiveClass));
  const linkedProviders = new Set(
    evidence
      .filter((item) => item.effectiveClass !== 'rejected')
      .map((item) => item.session.provider),
  );
  const login = getMeta(db, 'github_login') || null;
  return {
    pr: {
      id: pr.nodeId,
      repo: pr.repoId,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      mergedAt: iso(pr.mergedAt),
      author: pr.authorLogin,
      mergedBy: pr.mergedByLogin,
      authoredByMe:
        login !== null &&
        pr.authorLogin !== null &&
        pr.authorLogin.toLowerCase() === login.toLowerCase(),
      linkClass: summary.linkClass,
      linkedSessionCount: summary.linked,
      suggestedCount: summary.suggested,
      providers: (['codex', 'claude'] as const).filter((provider) => linkedProviders.has(provider)),
    },
    evidence,
    candidates: candidateRows.map(sessionOf),
  };
}

// ---- owner decisions -----------------------------------------------------------------------------------------------------

const KEEP: DecisionChange = { kind: 'keep' };

/** A change the transition table does not allow from the pair's current state: `invalid_input`, naming the field. */
const refuse = (message: string): ApiError =>
  new ApiError('invalid_input', message, { details: { fields: { decision: message } } });

/** The pair must exist: an unknown PR or session is `not_found` whichever change was asked for. */
function knownPair(state: PairState): asserts state is PairState & {
  pr: NonNullable<PairState['pr']>;
  session: NonNullable<PairState['session']>;
} {
  if (state.pr === null) throw notFound('pull request');
  if (state.session === null) throw notFound('session');
}

/**
 * The transition table (TECH › Owner link decision transitions) as a rule for `changeDecision`, which reads the pair, applies the
 * rule and writes in one transaction. The pair's CURRENT effective class decides what a decision may do:
 *
 *   confirmed   from suggested → owner (Confirm);  from none or hidden → owner (Link a session: needs a candidate, or the pair's
 *               own claim); already owner → unchanged. Not from evidence (nothing to confirm) or from rejected (Restore first).
 *   dismissed   from suggested → hidden;  already hidden → unchanged. Nothing else is a suggestion.
 *   rejected    from evidence → rejected;  already rejected → unchanged. Only a source claim of evidence can be marked incorrect.
 *
 * Every decision records the source claim it was made over (`prior`), or none, and never changes the claim itself.
 */
function decisionRule(decision: DecisionStored): (state: PairState) => DecisionChange {
  return (state) => {
    knownPair(state);
    const current = effectiveClass(state.computed, state.decision?.decision ?? null);
    const set: DecisionChange = {
      kind: 'set',
      decision,
      priorClass: state.computed?.class ?? null,
      priorBasis: state.computed?.basis ?? null,
    };

    if (decision === 'confirmed') {
      if (current === 'suggested') return set;
      if (current === 'owner') return KEEP;
      if (current === 'evidence') {
        if (state.decision?.decision === 'confirmed') return KEEP;
        throw refuse('This link is already evidence, so there is nothing to confirm.');
      }
      if (current === 'rejected') throw refuse('Restore this link before changing it.');
      // none or hidden: "Link a session". A pair with its own claim (a dismissed suggestion) may be linked again; otherwise the
      // session must be a candidate: same repo, active in the 3 days up to the merge.
      if (state.computed !== null || isCandidate(state.pr, state.session)) return set;
      throw refuse(
        'That session can’t be linked: it must be in the same repo and active in the 3 days before the merge.',
      );
    }
    if (decision === 'dismissed') {
      if (current === 'suggested') return set;
      if (current === 'hidden') return KEEP;
      throw refuse('Only a suggested link can be dismissed.');
    }
    if (current === 'evidence') return set;
    if (current === 'rejected') return KEEP;
    throw refuse('Only an evidence link can be marked incorrect.');
  };
}

/** Taking a decision back (Restore, Remove link and every Undo): the computed class shows again. Idempotent. */
function takeBack(state: PairState): DecisionChange {
  if (state.pr === null) throw notFound('pull request');
  // A decision about a session that is gone can still be cleared; a pair that never existed cannot.
  if (state.session === null && state.decision === null) throw notFound('session');
  return state.decision === null ? KEEP : { kind: 'clear' };
}

/**
 * Records one owner decision and answers with the updated item. Idempotent. A change the table does not allow is `invalid_input`
 * (nothing is written), an unknown PR or session `not_found`. A dismissed pair answers with its claim, class as it was, and no actions.
 */
export function setLinkDecision(
  db: Db,
  prId: string,
  sessionId: number,
  decision: DecisionStored,
  ctx: { nowMs: number },
): EvidenceItem {
  changeDecision(db, prId, sessionId, ctx.nowMs, decisionRule(decision));
  const row = readEvidenceRows(db, prId).find((candidate) => candidate.session.id === sessionId);
  const lookups = sessionLookups(db, [sessionId]);
  const item =
    row === undefined
      ? null
      : toItem(
          row,
          toSession(row.session, lookups.repos, lookups.links.get(sessionId) ?? NO_ROWS),
          {
            showHidden: true,
          },
        );
  if (item === null) throw new Error('A decision was written but its pair could not be read back.');
  return item;
}

/** Takes the owner's decision on a pair back. Idempotent: no decision is not an error. */
export function removeLinkDecision(
  db: Db,
  prId: string,
  sessionId: number,
  ctx: { nowMs: number },
): void {
  changeDecision(db, prId, sessionId, ctx.nowMs, takeBack);
}
