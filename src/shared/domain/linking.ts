// The rules of attribution (TECH › Attribution and Owner link decision transitions; data-and-sources › Attribution): which
// sessions a merged PR links to, and what an owner decision does to a link's class. Pure: no database, no clock, no I/O. The
// SQL that feeds it and the service that applies it live in src/server (db/queries/links.ts, services/links.ts).
//
//   classify        per PR: evidence links first (a recorded PR reference, or a session commit that is one of the PR's commits),
//                   then at most 3 suggestions for the sessions that gave no evidence;
//   effectiveClass  what a (computed link, owner decision) pair counts as, the one place the owner's say overrides the claim;
//   summarisePr     the PR's own class from its links: the strongest one, and a PR counts ONCE however many sessions link to it.
//
// Tokens are never allocated to a PR here or anywhere else: a linked session's tokens stay on their event dates.

const HOUR_MS = 3_600_000;

/** A session's last event must fall in this long before the merge for a repo-only suggestion (48 h). */
export const SUGGESTION_WINDOW_MS = 48 * HOUR_MS;
/** At most this many suggestions per PR, most recently active first. */
export const MAX_SUGGESTIONS_PER_PR = 3;
/** "Link a session" offers sessions active in this long before the merge (3 days). */
export const CANDIDATE_WINDOW_MS = 72 * HOUR_MS;
/** At most this many candidates are offered. */
export const MAX_CANDIDATES = 30;
/** The shortest commit id (hex characters) that counts as a match. Shorter prefixes collide too easily. */
export const MIN_COMMIT_ID_LENGTH = 7;

export type LinkClass = 'evidence' | 'suggested';
export type LinkBasis = 'pr_reference' | 'commit_match' | 'same_branch' | 'same_repo_window';
export type OwnerDecision = 'confirmed' | 'rejected' | 'dismissed';

/** The outcome of `effectiveClass`: what the pair counts as once the owner's decision is applied. */
export type EffectiveClass = 'evidence' | 'owner' | 'suggested' | 'rejected' | 'hidden' | 'none';
/** The classes that count as an effective link (what a session and a PR list). */
export type LinkedClass = 'evidence' | 'owner' | 'suggested';
export type PrLinkClass = LinkedClass | 'unlinked';

// ---- inputs ----------------------------------------------------------------------------------------------------------

export interface PrForLinking {
  /** Canonical lowercase `owner/name`. */
  repoId: string;
  number: number;
  mergedAt: number;
  headRef: string | null;
  mergeCommitSha: string | null;
  /** The commit ids read for the PR. */
  commits: readonly string[];
}

export interface SessionForLinking {
  id: number;
  repoId: string | null;
  gitBranch: string | null;
  startedAt: number;
  lastEventAt: number | null;
}

/** One identifier a session showed (a row of `session_ref`, without its time). */
export interface RefForIndex {
  sessionId: number;
  kind: 'pr_url' | 'commit' | 'branch';
  value: string;
}

/** The stored identifiers, indexed once for a whole recompute so each PR looks its evidence up instead of scanning. */
export interface RefIndex {
  /** `owner/name#number` to the sessions that showed it. */
  readonly prs: ReadonlyMap<string, ReadonlySet<number>>;
  /** A commit id (7 to 40 hex characters) to the sessions that showed it. */
  readonly commits: ReadonlyMap<string, ReadonlySet<number>>;
  /** A session to the branch names it worked on. */
  readonly branches: ReadonlyMap<number, ReadonlySet<string>>;
}

export function indexRefs(refs: Iterable<RefForIndex>): RefIndex {
  const prs = new Map<string, Set<number>>();
  const commits = new Map<string, Set<number>>();
  const branches = new Map<number, Set<string>>();
  const add = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
    const set = map.get(key);
    if (set) set.add(value);
    else map.set(key, new Set([value]));
  };
  for (const ref of refs) {
    if (ref.kind === 'pr_url') add(prs, ref.value, ref.sessionId);
    else if (ref.kind === 'commit') add(commits, ref.value, ref.sessionId);
    else add(branches, ref.sessionId, ref.value);
  }
  return { prs, commits, branches };
}

// ---- classify --------------------------------------------------------------------------------------------------------

export interface ComputedLink {
  sessionId: number;
  class: LinkClass;
  basis: LinkBasis;
}

interface ActiveSession {
  session: SessionForLinking;
  activeAt: number;
}

interface SessionIndex {
  ids: ReadonlySet<number>;
  byRepo: ReadonlyMap<string, readonly ActiveSession[]>;
}

/** Prepare the evidence membership and time-ordered suggestion candidates once per rebuild. */
export function indexSessions(sessions: readonly SessionForLinking[]): SessionIndex {
  const ids = new Set<number>();
  const byRepo = new Map<string, ActiveSession[]>();
  for (const session of sessions) {
    ids.add(session.id);
    if (session.repoId === null) continue;
    const entry = { session, activeAt: session.lastEventAt ?? session.startedAt };
    const group = byRepo.get(session.repoId);
    if (group) group.push(entry);
    else byRepo.set(session.repoId, [entry]);
  }
  for (const group of byRepo.values()) {
    group.sort((a, b) => a.activeAt - b.activeAt || a.session.id - b.session.id);
  }
  return { ids, byRepo };
}

/** Index of the first session active strictly after `at`, or the end of the group. */
function firstAfter(group: readonly ActiveSession[], at: number): number {
  let left = 0;
  let right = group.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (group[mid]!.activeAt <= at) left = mid + 1;
    else right = mid;
  }
  return left;
}

/** The sessions that showed a commit id which is a prefix of one of the PR's commits (or of its merge commit). */
function sessionsWithCommitOf(pr: PrForLinking, refs: RefIndex): ReadonlySet<number> {
  const found = new Set<number>();
  const ids = [...pr.commits, ...(pr.mergeCommitSha === null ? [] : [pr.mergeCommitSha])];
  for (const raw of ids) {
    const id = raw.toLowerCase();
    // A shown id is any prefix of the full id from 7 characters up, so each prefix is looked up (at most 34 per commit).
    for (let length = MIN_COMMIT_ID_LENGTH; length <= Math.min(id.length, 40); length += 1) {
      for (const sessionId of refs.commits.get(id.slice(0, length)) ?? []) found.add(sessionId);
    }
  }
  return found;
}

/**
 * The computed links of ONE merged PR, evidence first.
 *
 *  1. Evidence: the session recorded this PR's reference (`pr_reference`), or showed a commit id that prefix-matches one of the
 *     PR's commits or its merge commit (`commit_match`). When both hold, the PR reference is the basis. Evidence does not need the
 *     same repo: a session whose repo was not recorded still proves involvement.
 *  2. Suggestions, only for a session that gave no evidence: its repo is the PR's repo and its last event falls in
 *     [mergedAt - 48 h, mergedAt]. The basis is `same_branch` when the session worked on the PR's head branch, else
 *     `same_repo_window`. The 3 most recently active are kept, the higher session id winning a tie.
 */
export function classify(pr: PrForLinking, sessions: SessionIndex, refs: RefIndex): ComputedLink[] {
  const byReference = refs.prs.get(`${pr.repoId}#${pr.number}`);
  const byCommit = sessionsWithCommitOf(pr, refs);
  const evidence = new Set([...(byReference ?? []), ...byCommit]);
  const links: ComputedLink[] = [...evidence]
    .filter((id) => sessions.ids.has(id))
    .sort((a, b) => a - b)
    .map((sessionId) => ({
      sessionId,
      class: 'evidence',
      basis: byReference?.has(sessionId) ? 'pr_reference' : 'commit_match',
    }));

  const group = sessions.byRepo.get(pr.repoId);
  if (group === undefined) return links;
  const targetLength = links.length + MAX_SUGGESTIONS_PER_PR;
  const from = pr.mergedAt - SUGGESTION_WINDOW_MS;
  for (let i = firstAfter(group, pr.mergedAt) - 1; i >= 0 && links.length < targetLength; i -= 1) {
    const { session, activeAt } = group[i]!;
    if (activeAt < from) break;
    if (evidence.has(session.id)) continue;
    const sameBranch =
      pr.headRef !== null &&
      (session.gitBranch === pr.headRef || refs.branches.get(session.id)?.has(pr.headRef));
    links.push({
      sessionId: session.id,
      class: 'suggested',
      basis: sameBranch ? 'same_branch' : 'same_repo_window',
    });
  }
  return links;
}

/**
 * Whether a session could be offered for "Link a session": same repo as the PR, and active at some point in the 3 days up to the
 * merge (it started no later than the merge and its last event is no earlier than 3 days before). The SQL of the candidate list
 * (`readCandidateRows`) applies the same predicate, so the list and the guard on a write cannot disagree.
 */
export function isCandidate(
  pr: Pick<PrForLinking, 'repoId' | 'mergedAt'>,
  session: Pick<SessionForLinking, 'repoId' | 'startedAt' | 'lastEventAt'>,
): boolean {
  return (
    session.repoId !== null &&
    session.repoId === pr.repoId &&
    session.startedAt <= pr.mergedAt &&
    (session.lastEventAt ?? session.startedAt) >= pr.mergedAt - CANDIDATE_WINDOW_MS
  );
}

// ---- effective class -------------------------------------------------------------------------------------------------

type ClaimInput = LinkClass | { class: LinkClass } | null | undefined;

/**
 * What a (PR, session) pair counts as, the owner's decision applied to the computed claim (data-and-sources › Attribution):
 *
 *  - `rejected` ("Mark incorrect") is `rejected`: the claim is kept and shown struck through, and the pair does not count as linked;
 *  - `dismissed` is `hidden`: not listed, not counted, kept internally so it can be offered again;
 *  - `confirmed` is `owner`, with or without a computed claim (a manual add has none); a confirmation never weakens an
 *    `evidence` claim, so over evidence the class stays `evidence`;
 *  - no decision keeps the computed class, or is `none` when there is no claim either.
 */
export function effectiveClass(
  computed: ClaimInput,
  decision: OwnerDecision | null | undefined,
): EffectiveClass {
  const claim = typeof computed === 'string' ? computed : (computed?.class ?? null);
  if (decision === 'rejected') return 'rejected';
  if (decision === 'dismissed') return 'hidden';
  if (decision === 'confirmed') return claim === 'evidence' ? 'evidence' : 'owner';
  return claim ?? 'none';
}

/** The effective class if the pair counts as a link (evidence, owner or suggested), else null. Sessions and PRs list these only. */
export function linkedClassOf(
  computed: ClaimInput,
  decision: OwnerDecision | null | undefined,
): LinkedClass | null {
  const cls = effectiveClass(computed, decision);
  return cls === 'evidence' || cls === 'owner' || cls === 'suggested' ? cls : null;
}

/** Evidence, then owner, then suggested: the order a session lists its PRs in and the strength a PR takes its class from. */
export const LINK_ORDER: Readonly<Record<LinkedClass, number>> = {
  evidence: 0,
  owner: 1,
  suggested: 2,
};

// ---- the PR's own class ----------------------------------------------------------------------------------------------

export interface PrLinkSummary {
  linkClass: PrLinkClass;
  /** Sessions linked by evidence or by the owner. */
  linked: number;
  suggested: number;
}

/**
 * A PR's class from the effective classes of ALL its links: the strongest (evidence, owner, suggested, else unlinked). The PR is
 * one row however many sessions link to it, so counting PRs by this class counts each PR once. `rejected`, `hidden` and `none`
 * are not links.
 */
export function summarisePr(classes: Iterable<EffectiveClass>): PrLinkSummary {
  let evidence = 0;
  let owner = 0;
  let suggested = 0;
  for (const cls of classes) {
    if (cls === 'evidence') evidence += 1;
    else if (cls === 'owner') owner += 1;
    else if (cls === 'suggested') suggested += 1;
  }
  const linkClass: PrLinkClass =
    evidence > 0 ? 'evidence' : owner > 0 ? 'owner' : suggested > 0 ? 'suggested' : 'unlinked';
  return { linkClass, linked: evidence + owner, suggested };
}

/** Linked PRs are the ones with an evidence or owner link (P-24, P-25); a suggestion alone is not linked. */
export const isLinkedClass = (cls: PrLinkClass): boolean => cls === 'evidence' || cls === 'owner';
