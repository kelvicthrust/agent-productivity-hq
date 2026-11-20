import { inTransaction, type Db } from '../open.ts';
import { recordComputedLinksSuccess } from './link-health.ts';
import type { RecordSessionRow } from './metrics.ts';
import { readRepoRefClaims } from './repos.ts';
import type { UsageProvider } from './usage.ts';

// Everything SQL about PR-to-session links (TECH › Attribution, Owner link decision transitions; data-and-sources › Evidence
// extraction and Attribution). This module holds no rule: WHICH sessions link to a PR (`classify`), what an owner decision does
// to a link (the transition table) and which sessions may be offered for "Link a session" belong to shared/domain/linking.ts and
// services/links.ts. What lives here is what only SQL can guarantee:
//
//   session_ref          only identifiers get in: a value that does not have the shape of a PR reference, a commit id or a branch
//                        name is refused (counted, never stored, never echoed), so line text cannot reach the database through a
//                        parser mistake (G8_2, P-31);
//   pr_session_link      computed: `replaceComputedLinks` rebuilds it in one transaction and cannot reach owner_link_decision;
//   owner_link_decision  owner-authored: `changeDecision` reads the pair, lets the caller's rule decide, and writes in ONE
//                        transaction, and nothing here ever deletes a decision except an explicit `clear` (P-26, P-27).
//
// All times are epoch milliseconds, as everywhere in the database.

export type RefKind = 'pr_url' | 'commit' | 'branch';
export type LinkClassStored = 'evidence' | 'suggested';
export type LinkBasisStored = 'pr_reference' | 'commit_match' | 'same_branch' | 'same_repo_window';
export type DecisionStored = 'confirmed' | 'rejected' | 'dismissed';

// ---- session_ref: identifiers only -------------------------------------------------------------------------------------

export interface SessionRefInput {
  kind: RefKind;
  /** `owner/name#number` (lowercase), a 7 to 40 character lowercase hex commit id, or a branch name. Nothing else. */
  value: string;
  /** When the session showed this reference (epoch ms). The earliest sighting is kept. */
  observedAt: number;
}

/** What each kind may look like. A value outside its shape is refused, not trimmed or repaired. */
const REF_SHAPE: Record<RefKind, RegExp> = {
  pr_url: /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}#[1-9]\d{0,6}$/,
  commit: /^[0-9a-f]{7,40}$/,
  branch: /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/,
};

export const isRefIdentifier = (kind: RefKind, value: string): boolean =>
  REF_SHAPE[kind].test(value);

/**
 * Stores the identifiers one session showed. It runs inside the CALLER's transaction (the adapter's per-file commit), so a file
 * that fails to commit leaves no reference behind. Idempotent: the same identifier again changes nothing except that an earlier
 * `observedAt` is kept. A value that is not an identifier is counted in `rejected` and never stored.
 */
export function writeSessionRefs(
  db: Db,
  sessionId: number,
  refs: readonly SessionRefInput[],
): { stored: number; rejected: number } {
  const upsert = db.prepare(
    `INSERT INTO session_ref (session_id, kind, value, observed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, kind, value) DO UPDATE SET observed_at = MIN(session_ref.observed_at, excluded.observed_at)`,
  );
  let stored = 0;
  let rejected = 0;
  for (const ref of refs) {
    if (!isRefIdentifier(ref.kind, ref.value) || !Number.isFinite(ref.observedAt)) {
      rejected += 1;
      continue;
    }
    upsert.run(sessionId, ref.kind, ref.value, Math.trunc(ref.observedAt));
    stored += 1;
  }
  return { stored, rejected };
}

// ---- what `classify` reads -----------------------------------------------------------------------------------------------

export interface LinkPrRow {
  nodeId: string;
  /** Canonical lowercase `owner/name`. */
  repoId: string;
  number: number;
  mergedAt: number;
  headRef: string | null;
  mergeCommitSha: string | null;
  /** The commit ids read for the PR (identifiers). A PR whose `commits_complete` is false can have fewer than it really has. */
  commits: string[];
}

export interface LinkSessionRow {
  id: number;
  provider: UsageProvider;
  repoId: string | null;
  gitBranch: string | null;
  startedAt: number;
  lastEventAt: number | null;
}

export interface SessionRefRow {
  sessionId: number;
  kind: RefKind;
  value: string;
  observedAt: number;
}

export interface LinkInputs {
  prs: LinkPrRow[];
  sessions: LinkSessionRow[];
  refs: SessionRefRow[];
}

/**
 * Every merged PR, every session and every stored identifier, in three plain reads, so the recompute does its matching in
 * memory instead of asking the database about each PR. All PRs and sessions are returned whatever the repo's state: the views
 * hide a stopped or unreachable repo, and its computed links stay correct for when it is tracked again.
 */
export function readLinkInputs(db: Db): LinkInputs {
  const claims = readRepoRefClaims(db);
  const commits = new Map<string, string[]>();
  for (const row of db.prepare('SELECT pr_node_id, sha FROM pr_commit').all() as unknown as {
    pr_node_id: string;
    sha: string;
  }[]) {
    const list = commits.get(row.pr_node_id) ?? [];
    list.push(row.sha);
    commits.set(row.pr_node_id, list);
  }
  const prs = (
    db
      .prepare(
        'SELECT node_id, repo_id, number, merged_at, head_ref, merge_commit_sha FROM pull_request ORDER BY merged_at DESC, node_id',
      )
      .all() as unknown as {
      node_id: string;
      repo_id: string;
      number: number;
      merged_at: number;
      head_ref: string | null;
      merge_commit_sha: string | null;
    }[]
  ).map((row): LinkPrRow => ({
    nodeId: row.node_id,
    repoId: row.repo_id,
    number: row.number,
    mergedAt: row.merged_at,
    headRef: row.head_ref,
    mergeCommitSha: row.merge_commit_sha,
    commits: commits.get(row.node_id) ?? [],
  }));
  const sessions = (
    db
      .prepare(
        'SELECT id, provider, repo_id, git_branch, started_at, last_event_at FROM session ORDER BY id',
      )
      .all() as unknown as {
      id: number;
      provider: UsageProvider;
      repo_id: string | null;
      git_branch: string | null;
      started_at: number;
      last_event_at: number | null;
    }[]
  ).map((row): LinkSessionRow => ({
    id: row.id,
    provider: row.provider,
    repoId: row.repo_id,
    gitBranch: row.git_branch,
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
  }));
  const refs = (
    db
      .prepare(
        'SELECT session_id, kind, value, observed_at FROM session_ref ORDER BY session_id, kind, value',
      )
      .all() as unknown as {
      session_id: number;
      kind: RefKind;
      value: string;
      observed_at: number;
    }[]
  ).flatMap((row): SessionRefRow[] => {
    let value = row.value;
    if (row.kind === 'pr_url') {
      const separator = value.lastIndexOf('#');
      const claim = claims.get(value.slice(0, separator));
      if (claim) {
        if (claim.conflicted_at !== null && row.observed_at >= claim.conflicted_at) return [];
        value = `${claim.repo_id}${value.slice(separator)}`;
      }
    }
    return [{ sessionId: row.session_id, kind: row.kind, value, observedAt: row.observed_at }];
  });
  return { prs, sessions, refs };
}

// ---- pr_session_link: computed, rebuilt per refresh ------------------------------------------------------------------------

export interface ComputedLinkRow {
  prNodeId: string;
  sessionId: number;
  class: LinkClassStored;
  basis: LinkBasisStored;
}

/** The (class, basis) pairs the table accepts. A row outside it is a bug in `classify`, so it throws before anything is written. */
const COMPUTED_BASIS: Record<LinkClassStored, readonly LinkBasisStored[]> = {
  evidence: ['pr_reference', 'commit_match'],
  suggested: ['same_branch', 'same_repo_window'],
};

/**
 * Replaces the whole computed table with `links`, in one transaction: either every row of the new computation is there or the old
 * ones are. It never reads or writes `owner_link_decision`, so a refresh cannot change what the owner decided (P-27). A pair given
 * twice keeps the evidence row over a suggestion. Returns how many rows the table holds afterwards.
 */
export function replaceComputedLinks(
  db: Db,
  links: readonly ComputedLinkRow[],
  computedAt: number,
  runId?: number,
): number {
  for (const link of links) {
    if (!COMPUTED_BASIS[link.class]?.includes(link.basis))
      throw new TypeError(`A ${link.class} link cannot have the basis ${String(link.basis)}.`);
  }
  return inTransaction(db, () => {
    db.exec('DELETE FROM pr_session_link');
    const insert = db.prepare(
      `INSERT INTO pr_session_link (pr_node_id, session_id, class, basis, computed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (pr_node_id, session_id) DO UPDATE SET class = excluded.class, basis = excluded.basis
         WHERE excluded.class = 'evidence' AND pr_session_link.class <> 'evidence'`,
    );
    for (const link of links)
      insert.run(link.prNodeId, link.sessionId, link.class, link.basis, computedAt);
    recordComputedLinksSuccess(db, computedAt, runId);
    return (db.prepare('SELECT COUNT(*) AS n FROM pr_session_link').get() as { n: number }).n;
  });
}

// ---- owner decisions ------------------------------------------------------------------------------------------------------

export interface PairState {
  /** null when no merged PR has this id. */
  pr: { nodeId: string; repoId: string; number: number; mergedAt: number } | null;
  /** null when no session has this id. */
  session: {
    id: number;
    repoId: string | null;
    startedAt: number;
    lastEventAt: number | null;
  } | null;
  /** What the last recompute said about this pair. */
  computed: { class: LinkClassStored; basis: LinkBasisStored } | null;
  /** The owner's decision for this pair, with what the pair was when it was made. */
  decision: {
    decision: DecisionStored;
    priorClass: string | null;
    priorBasis: string | null;
    decidedAt: number;
  } | null;
}

export function readPair(db: Db, prNodeId: string, sessionId: number): PairState {
  const pr = db
    .prepare('SELECT node_id, repo_id, number, merged_at FROM pull_request WHERE node_id = ?')
    .get(prNodeId) as
    { node_id: string; repo_id: string; number: number; merged_at: number } | undefined;
  const session = db
    .prepare('SELECT id, repo_id, started_at, last_event_at FROM session WHERE id = ?')
    .get(sessionId) as
    | { id: number; repo_id: string | null; started_at: number; last_event_at: number | null }
    | undefined;
  const computed = db
    .prepare('SELECT class, basis FROM pr_session_link WHERE pr_node_id = ? AND session_id = ?')
    .get(prNodeId, sessionId) as { class: LinkClassStored; basis: LinkBasisStored } | undefined;
  const decision = db
    .prepare(
      'SELECT decision, prior_class, prior_basis, decided_at FROM owner_link_decision WHERE pr_node_id = ? AND session_id = ?',
    )
    .get(prNodeId, sessionId) as
    | {
        decision: DecisionStored;
        prior_class: string | null;
        prior_basis: string | null;
        decided_at: number;
      }
    | undefined;
  return {
    pr: pr
      ? { nodeId: pr.node_id, repoId: pr.repo_id, number: pr.number, mergedAt: pr.merged_at }
      : null,
    session: session
      ? {
          id: session.id,
          repoId: session.repo_id,
          startedAt: session.started_at,
          lastEventAt: session.last_event_at,
        }
      : null,
    computed: computed ? { class: computed.class, basis: computed.basis } : null,
    decision: decision
      ? {
          decision: decision.decision,
          priorClass: decision.prior_class,
          priorBasis: decision.prior_basis,
          decidedAt: decision.decided_at,
        }
      : null,
  };
}

/** What a transition rule asks for: leave the decision alone, record one, or take it back. */
export type DecisionChange =
  | { kind: 'keep' }
  | {
      kind: 'set';
      decision: DecisionStored;
      /** The pair as it was when the owner decided (TECH: `prior = suggested + basis`), or null for no link. */
      priorClass: string | null;
      priorBasis: string | null;
    }
  | { kind: 'clear' };

/**
 * One owner decision, in one transaction: the pair is read, `rule` (the service's transition table) says what to do with it, and
 * the decision row is written or deleted, all under the same lock, so a rule never judges a state that has already moved and a
 * decision is never half written. `rule` may throw to refuse the change (nothing is written then). Idempotent changes are the
 * rule's to express: return `keep`. Returns the pair before and after.
 */
export function changeDecision(
  db: Db,
  prNodeId: string,
  sessionId: number,
  now: number,
  rule: (state: PairState) => DecisionChange,
): { before: PairState; after: PairState } {
  return inTransaction(db, () => {
    const before = readPair(db, prNodeId, sessionId);
    const change = rule(before);
    if (change.kind === 'set') {
      db.prepare(
        `INSERT INTO owner_link_decision (pr_node_id, session_id, decision, prior_class, prior_basis, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (pr_node_id, session_id) DO UPDATE SET decision = excluded.decision, prior_class = excluded.prior_class,
           prior_basis = excluded.prior_basis, decided_at = excluded.decided_at`,
      ).run(prNodeId, sessionId, change.decision, change.priorClass, change.priorBasis, now);
    } else if (change.kind === 'clear') {
      db.prepare('DELETE FROM owner_link_decision WHERE pr_node_id = ? AND session_id = ?').run(
        prNodeId,
        sessionId,
      );
    }
    return { before, after: change.kind === 'keep' ? before : readPair(db, prNodeId, sessionId) };
  });
}

// ---- the evidence of one PR, and the sessions that could be linked to it --------------------------------------------------

/** A session with its tokens over ALL its events (the evidence item says how much the session recorded in all). */
export type LinkedSessionRow = RecordSessionRow;

export interface EvidenceRow {
  session: LinkedSessionRow;
  computed: { class: LinkClassStored; basis: LinkBasisStored } | null;
  decision: {
    decision: DecisionStored;
    priorClass: string | null;
    priorBasis: string | null;
  } | null;
}

interface RawSession {
  id: number;
  provider: UsageProvider;
  kind: LinkedSessionRow['kind'];
  parent_session_id: number | null;
  parent_basis: 'native' | 'paseo' | null;
  native_kind: string | null;
  recorded_name: string | null;
  name_source: string | null;
  provider_session_id: string;
  repo_id: string | null;
  paseo_agent_id: string | null;
  workspace_label: string | null;
  started_at: number;
  started_basis: 'source_start' | 'first_event';
  first_event_at: number | null;
  last_event_at: number | null;
  last_model: string | null;
  tokens: number;
}

const SESSION_COLUMNS = `s.id, s.provider, s.kind, s.parent_session_id, s.parent_basis, s.native_kind, s.recorded_name,
  s.name_source, s.provider_session_id, s.repo_id, s.paseo_agent_id, s.workspace_label, s.started_at, s.started_basis,
  s.first_event_at, s.last_event_at, s.last_model,
  COALESCE((SELECT SUM(ue.provider_total) FROM usage_event ue WHERE ue.session_id = s.id), 0) AS tokens`;

const toSessionRow = (row: RawSession): LinkedSessionRow => ({
  id: row.id,
  provider: row.provider,
  kind: row.kind,
  parentId: row.parent_session_id,
  parentBasis: row.parent_basis,
  nativeKind: row.native_kind,
  recordedName: row.recorded_name,
  nameSource: row.name_source,
  providerSessionId: row.provider_session_id,
  repoId: row.repo_id,
  paseoAgentId: row.paseo_agent_id,
  workspaceLabel: row.workspace_label,
  startedAt: row.started_at,
  startedBasis: row.started_basis,
  firstEventAt: row.first_event_at,
  lastEventAt: row.last_event_at,
  lastModel: row.last_model,
  tokens: row.tokens,
});

/**
 * Every session that has a computed link to the PR or an owner decision about it: the computed links, plus pairs the owner decided
 * on that have no computed link (a manual add). A dismissed or rejected pair is returned too: whether it shows, and how, is the
 * service's rule. Order is not specified.
 */
export function readEvidenceRows(db: Db, prNodeId: string): EvidenceRow[] {
  const rows = db
    .prepare(
      `WITH pairs(session_id) AS (
         SELECT l.session_id FROM pr_session_link l WHERE l.pr_node_id = ?1
         UNION
         SELECT d.session_id FROM owner_link_decision d WHERE d.pr_node_id = ?1
       )
       SELECT ${SESSION_COLUMNS},
              l.class AS link_class, l.basis AS link_basis,
              d.decision AS decision, d.prior_class AS prior_class, d.prior_basis AS prior_basis
         FROM pairs p
         JOIN session s ON s.id = p.session_id
         LEFT JOIN pr_session_link l ON l.pr_node_id = ?1 AND l.session_id = s.id
         LEFT JOIN owner_link_decision d ON d.pr_node_id = ?1 AND d.session_id = s.id`,
    )
    .all(prNodeId) as unknown as (RawSession & {
    link_class: LinkClassStored | null;
    link_basis: LinkBasisStored | null;
    decision: DecisionStored | null;
    prior_class: string | null;
    prior_basis: string | null;
  })[];
  return rows.map((row) => ({
    session: toSessionRow(row),
    computed:
      row.link_class !== null && row.link_basis !== null
        ? { class: row.link_class, basis: row.link_basis }
        : null,
    decision:
      row.decision === null
        ? null
        : { decision: row.decision, priorClass: row.prior_class, priorBasis: row.prior_basis },
  }));
}

/**
 * Sessions of the PR's repo that were active in `[fromMs, toMs]` (they started no later than `toMs` and their last event is no
 * earlier than `fromMs`) and are not already listed for the PR: a pair is listed when it has a computed link or an owner
 * decision, except that a DISMISSED suggestion is hidden and may be offered again. Most recently active first, at most `limit`.
 * The window is the caller's (the service passes the 3 days before the merge); this query adds no rule of its own.
 */
export function readCandidateRows(
  db: Db,
  prNodeId: string,
  window: { fromMs: number; toMs: number },
  limit: number,
): LinkedSessionRow[] {
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS}
         FROM pull_request pr
         JOIN session s ON s.repo_id = pr.repo_id
        WHERE pr.node_id = ?1
          AND s.started_at <= ?3 AND COALESCE(s.last_event_at, s.started_at) >= ?2
          AND NOT (
            (EXISTS (SELECT 1 FROM pr_session_link l WHERE l.pr_node_id = pr.node_id AND l.session_id = s.id)
               AND NOT EXISTS (SELECT 1 FROM owner_link_decision d
                                WHERE d.pr_node_id = pr.node_id AND d.session_id = s.id AND d.decision = 'dismissed'))
            OR EXISTS (SELECT 1 FROM owner_link_decision d
                        WHERE d.pr_node_id = pr.node_id AND d.session_id = s.id AND d.decision IN ('confirmed', 'rejected'))
          )
        ORDER BY COALESCE(s.last_event_at, s.started_at) DESC, s.id DESC
        LIMIT ?4`,
    )
    .all(prNodeId, window.fromMs, window.toMs, limit) as unknown as RawSession[];
  return rows.map(toSessionRow);
}
