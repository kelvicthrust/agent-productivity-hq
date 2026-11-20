import type { z } from 'zod';
import type { Scope } from '../../shared/contracts/common.ts';
import { ApiError } from '../../shared/contracts/errors.ts';
import type {
  Session,
  UsageCategoriesResponse,
  UsageGroupsResponse,
  UsageRootsResponse,
} from '../../shared/contracts/usage.ts';
import {
  coveredFrom,
  providerCoverage,
  type SourceCoverageInput,
} from '../../shared/domain/coverage.ts';
import {
  dateInZone,
  isDateString,
  minDate,
  rangeBounds,
  todayIn,
} from '../../shared/domain/periods.ts';
import { LINK_ORDER, linkedClassOf } from '../../shared/domain/linking.ts';
import { resolveScope, providersInScope, type RawFilters } from '../../shared/domain/scope.ts';
import { claudeTotal, codexTotal } from '../../shared/domain/tokens.ts';
import type { Db } from '../db/open.ts';
import { readRepoAliases } from '../db/queries/repos.ts';
import {
  UNKNOWN_GROUP,
  UNTRACKED_GROUP,
  readGroupSessions,
  readGroupTotals,
  readLedgers,
  readLinkRows,
  readRepoStates,
  readSourceStates,
  type GroupSelector,
  type GroupSessionRow,
  type LedgerRow,
  type LinkRow,
  type RepoStateRow,
  type SourceStateRow,
  type UsageFilter,
  type UsageProvider,
} from '../db/queries/usage.ts';

// The Usage page's server half: the per-provider ledgers, the group summaries and the paged session tree. Every figure is
// summed per provider from the stored `provider_total` or categories, so subsets (Codex cached input and reasoning) are
// never added again and providers are never added together. Everything is computed per request from stored rows.

export type UsageCategories = z.infer<typeof UsageCategoriesResponse>;
export type UsageGroups = z.infer<typeof UsageGroupsResponse>;
export type UsageRoots = z.infer<typeof UsageRootsResponse>;
type LinkedPr = Session['linkedPrs'][number];
type LinkStatus = Session['linkStatus'];

export interface UsageContext {
  nowMs: number;
  /** The report timezone (IANA). */
  timezone: string;
}

export const DEFAULT_ROOTS_LIMIT = 15;
export const MAX_ROOTS_LIMIT = 100;

const iso = (ms: number): string => new Date(ms).toISOString();

// ---- scope -----------------------------------------------------------------------------------------------------------

/** The filters of a Usage request as the shared resolver applies them (defaults, ranges, unknown repos echoed). */
export function resolveUsageScope(db: Db, raw: RawFilters, ctx: UsageContext): Scope {
  const knownRepos = new Set(readRepoStates(db).map((repo) => repo.id));
  const aliases = raw.repos === undefined ? new Map<string, string>() : readRepoAliases(db);
  const repos = raw.repos
    ?.split(',')
    .map((part) => aliases.get(part.trim()) ?? part)
    .join(',');
  const result = resolveScope(
    { ...raw, repos },
    {
      today: todayIn(ctx.nowMs, ctx.timezone),
      timezone: ctx.timezone,
      knownRepos,
    },
  );
  if (result.ok) return result.scope;
  if (result.code === 'invalid_range') throw new ApiError('invalid_range', result.message);
  throw new ApiError('invalid_input', result.message, { details: { fields: result.fields } });
}

function filterOf(scope: Scope): UsageFilter {
  const bounds = rangeBounds(scope.start, scope.end, scope.timezone);
  return {
    fromMs: bounds.start,
    toMs: bounds.end,
    providers: providersInScope(scope.provider),
    repos: scope.repos,
  };
}

// ---- GET /api/usage/categories ---------------------------------------------------------------------------------------

/**
 * Coverage of one provider's source over the selected dates. A source counts as found when it has imported records.
 * `stale` needs a failed last attempt, and the last fully collected date comes from `extra_json.staleAfter`, else from the
 * last success.
 */
function sourceCoverage(
  row: SourceStateRow | undefined,
  timezone: string,
  today: string,
): SourceCoverageInput {
  if (!row || row.oldestEventAt === null) return { found: false };
  let staleAfter: string | null = null;
  if (row.lastAttemptResult === 'failed') {
    const stored = row.extra['staleAfter'];
    if (typeof stored === 'string' && isDateString(stored)) staleAfter = stored;
    else if (row.lastSuccessAt !== null) staleAfter = dateInZone(row.lastSuccessAt, timezone);
  }
  // Never earlier than what retention keeps: the first import writes its oldest date before retention prunes (P-29).
  return {
    found: true,
    oldestDate: coveredFrom(dateInZone(row.oldestEventAt, timezone), today),
    staleAfter,
  };
}

/** The partial or unmapped Paseo note shown above the tree: the stored note, else one built from the unreadable count. */
function paseoNote(row: SourceStateRow | undefined): string | null {
  if (!row || row.status !== 'partial') return null;
  const stored = row.extra['note'];
  if (typeof stored === 'string' && stored.trim() !== '') return stored;
  const count = row.unreadableCount + row.unsupportedCount;
  const what = count === 1 ? '1 agent record' : `${count} agent records`;
  return count > 0
    ? `${what} couldn’t be read. Their provider usage is still counted; their agent relationships show as Unknown.`
    : 'Some Paseo agent records couldn’t be read. Their provider usage is still counted; their agent relationships show as Unknown.';
}

/**
 * Per-provider token category ledgers for the selected dates and repos. Only the providers the `provider` filter selects are
 * returned, never a combined figure. Where the provider has no data for the dates (`none`, `unavailable`, `future`) the
 * numbers are left out, so a page cannot print a covered zero for history that does not exist.
 */
export function buildCategories(db: Db, scope: Scope, ctx: UsageContext): UsageCategories {
  const today = todayIn(ctx.nowMs, ctx.timezone);
  const sources = new Map(readSourceStates(db).map((row) => [row.sourceId, row]));
  const ledgers = new Map(readLedgers(db, filterOf(scope)).map((row) => [row.provider, row]));
  const span = { start: scope.start, end: minDate(scope.end, today) };

  const out: UsageCategories = { scope, paseoNote: paseoNote(sources.get('paseo')) };
  for (const provider of providersInScope(scope.provider)) {
    const input = sourceCoverage(sources.get(provider), ctx.timezone, today);
    const coverage = providerCoverage(span, input, today);
    const head = { coverage, coveredFrom: input.found ? (input.oldestDate ?? null) : null };
    const hasFigures = coverage !== 'none' && coverage !== 'unavailable' && coverage !== 'future';
    const row = ledgers.get(provider);
    if (provider === 'codex') out.codex = hasFigures ? { ...head, ...codexLedger(row) } : head;
    else out.claude = hasFigures ? { ...head, ...claudeLedger(row) } : head;
  }
  return out;
}

/** Codex: `cachedInput` is part of `input` and `reasoning` part of `output`, so the total is input + output and nothing else. */
function codexLedger(row: LedgerRow | undefined) {
  const categories = {
    input: row?.input ?? 0,
    cachedInput: row?.cachedInput ?? 0,
    output: row?.output ?? 0,
    reasoning: row?.reasoning ?? 0,
  };
  return { sessions: row?.sessions ?? 0, ...categories, total: codexTotal(categories) };
}

/** Claude Code: four separate categories that add. */
function claudeLedger(row: LedgerRow | undefined) {
  const categories = {
    inputUncached: row?.input ?? 0,
    cacheWrite: row?.cacheWrite ?? 0,
    cacheRead: row?.cacheRead ?? 0,
    output: row?.output ?? 0,
  };
  return { sessions: row?.sessions ?? 0, ...categories, total: claudeTotal(categories) };
}

// ---- GET /api/usage/groups -------------------------------------------------------------------------------------------

type Group = NonNullable<UsageGroups['groups']>[number];

/**
 * One summary per tracked repo (shown even with no sessions in scope, as the design does), then the Untracked and Unknown
 * groups when they have sessions. `roots` and `sessions` count sessions with an event in scope; `tokens` is per provider.
 */
export function buildGroups(db: Db, scope: Scope): UsageGroups {
  const providers = providersInScope(scope.provider);
  const totals = new Map<
    string,
    { roots: number; sessions: number; tokens: Record<string, number> }
  >();
  for (const row of readGroupTotals(db, filterOf(scope))) {
    const entry = totals.get(row.group) ?? { roots: 0, sessions: 0, tokens: {} };
    entry.roots += row.roots;
    entry.sessions += row.sessions;
    entry.tokens[row.provider] = (entry.tokens[row.provider] ?? 0) + row.tokens;
    totals.set(row.group, entry);
  }

  const summary = (key: string, label: string, note: string | null): Group => {
    const entry = totals.get(key);
    const tokens: { codex?: number; claude?: number } = {};
    for (const provider of providers) tokens[provider] = entry?.tokens[provider] ?? 0;
    return { key, label, note, roots: entry?.roots ?? 0, sessions: entry?.sessions ?? 0, tokens };
  };

  const groups: Group[] = readRepoStates(db)
    .filter((repo) => repo.trackingState === 'active')
    .filter((repo) => scope.repos.length === 0 || scope.repos.includes(repo.id))
    // An inaccessible repo is a source problem, shown on Sources; here it appears only when it has sessions to show (the D7
    // prototype lists only repos it can reach). A reachable repo with no sessions in scope stays, as "0 roots · 0 sessions".
    .filter(
      (repo) => repo.accessState !== 'inaccessible' || (totals.get(repo.id)?.sessions ?? 0) > 0,
    )
    .map((repo) => summary(repo.id, repo.displayName, null));
  if (totals.has(UNTRACKED_GROUP)) {
    groups.push(
      summary(UNTRACKED_GROUP, 'Untracked repos', 'repo recorded, not on your tracked list'),
    );
  }
  if (totals.has(UNKNOWN_GROUP)) {
    groups.push(summary(UNKNOWN_GROUP, 'Unknown repo', 'no repository recorded'));
  }
  return { scope, groups };
}

// ---- link rules ------------------------------------------------------------------------------------------------------

/**
 * The class a (PR, session) pair has once the owner's decision is applied, as Delivery computes it. The rules are
 * shared/domain/linking.ts `effectiveClass` (data-and-sources › Attribution); this is the part of it a session lists. `null` means
 * the pair is not an effective link: marked incorrect, dismissed, or neither computed nor confirmed.
 */
export function effectiveLinkClass(
  computed: 'evidence' | 'suggested' | null,
  decision: 'confirmed' | 'rejected' | 'dismissed' | null,
): LinkedPr['class'] | null {
  return linkedClassOf(computed, decision);
}

/** A session's effective links: evidence, then owner, then suggested, newest merge first (a PR number breaks ties). */
export function linkedPrsOf(rows: readonly LinkRow[]): LinkedPr[] {
  return rows
    .flatMap((row) => {
      const cls = effectiveLinkClass(row.computed, row.decision);
      return cls === null ? [] : [{ row, cls }];
    })
    .sort(
      (a, b) =>
        LINK_ORDER[a.cls] - LINK_ORDER[b.cls] ||
        b.row.mergedAt - a.row.mergedAt ||
        a.row.prRepo.localeCompare(b.row.prRepo) ||
        b.row.prNumber - a.row.prNumber,
    )
    .map(({ row, cls }) => ({
      prId: row.prNodeId,
      repo: row.prRepo,
      number: row.prNumber,
      mergedAt: new Date(row.mergedAt).toISOString(),
      class: cls,
    }));
}

/**
 * How the Linked PRs cell is worded, decided here so the client never infers a check from missing data
 * (data-and-sources › Usage-tree link status). "Unlinked" is only possible when a check could really happen.
 */
export function decideLinkStatus(
  repoId: string | null,
  repo: Pick<RepoStateRow, 'trackingState' | 'accessState' | 'backfillComplete'> | undefined,
  linkedPrs: readonly LinkedPr[],
): LinkStatus {
  if (linkedPrs.length > 0) return 'linked';
  if (repoId === null) return 'repo_unknown';
  if (!repo || repo.trackingState !== 'active') return 'repo_not_tracked';
  if (repo.accessState !== 'ok' || !repo.backfillComplete) return 'prs_not_collected';
  return 'unlinked';
}

// ---- sessions --------------------------------------------------------------------------------------------------------

type RelationshipLabel = NonNullable<Session['relationshipLabel']>;

function relationshipLabel(row: GroupSessionRow): RelationshipLabel {
  if (row.kind === 'root') return 'Root session';
  if (row.kind === 'unknown') return 'Unknown relationship';
  return row.parentBasis === 'paseo' || row.nativeKind === 'paseo'
    ? 'Paseo child agent'
    : 'Native subagent';
}

/** "thread 7f3a…2c91" (Codex) or "session d2a7…551c" (Claude): the shortened id the row shows under "Session ID:". */
export function shortSessionRef(provider: UsageProvider, providerSessionId: string): string {
  const short =
    providerSessionId.length > 9
      ? `${providerSessionId.slice(0, 4)}…${providerSessionId.slice(-4)}`
      : providerSessionId;
  return `${provider === 'codex' ? 'thread' : 'session'} ${short}`;
}

interface SessionLookups {
  repos: ReadonlyMap<string, RepoStateRow>;
  links: ReadonlyMap<number, LinkedPr[]>;
}

function toSession(row: GroupSessionRow, lookups: SessionLookups, childCount?: number): Session {
  const repo = row.repoId === null ? undefined : lookups.repos.get(row.repoId);
  const linkedPrs = lookups.links.get(row.id) ?? [];
  const label = relationshipLabel(row);
  const named = row.recordedName !== null && row.recordedName.trim() !== '';
  const repoGroup: NonNullable<Session['repoGroup']> =
    row.repoId === null ? 'unknown' : repo?.trackingState === 'active' ? 'tracked' : 'untracked';
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    relationshipLabel: label,
    nameLead: named ? row.recordedName! : label,
    named,
    nameSource:
      named && (row.nameSource === 'paseo' || row.nameSource === 'provider_title')
        ? row.nameSource
        : null,
    paseo:
      row.paseoAgentId === null
        ? null
        : { agentId: row.paseoAgentId, workspace: row.workspaceLabel },
    providerSessionRef: shortSessionRef(row.provider, row.providerSessionId),
    repo: row.repoId,
    repoGroup,
    ...(row.lastModel === null ? {} : { model: row.lastModel }),
    tokens: row.tokens,
    startedAt: iso(row.startedAt),
    startedBasis: row.startedBasis,
    firstEventAt: iso(row.firstEventAt ?? row.startedAt),
    lastEventAt: iso(row.lastEventAt ?? row.firstEventAt ?? row.startedAt),
    parentId: row.parentId,
    ...(childCount === undefined ? {} : { childCount }),
    linkStatus: decideLinkStatus(row.repoId, repo, linkedPrs),
    linkedPrs,
  };
}

// ---- GET /api/usage/groups/{groupKey}/roots --------------------------------------------------------------------------

/** The group a key names, or `not_found`. A repo key must be an active tracked repo: that is what a group is. */
function resolveGroup(key: string, repos: readonly RepoStateRow[]): GroupSelector {
  if (key === UNTRACKED_GROUP) return { kind: 'untracked' };
  if (key === UNKNOWN_GROUP) return { kind: 'unknown' };
  const repo = repos.find((r) => r.id === key && r.trackingState === 'active');
  if (!repo) {
    throw new ApiError('not_found', 'There is no usage group with that name.', {
      details: { groupKey: key.slice(0, 200) },
    });
  }
  return { kind: 'repo', repoId: repo.id };
}

interface Position {
  startedAt: number;
  id: number;
}

/** Roots are listed newest first by their start time, with the id breaking ties, so a page boundary is a plain (time, id) position. */
const newestFirst = (a: Position, b: Position): number => b.startedAt - a.startedAt || b.id - a.id;
const oldestFirst = (a: Position, b: Position): number => a.startedAt - b.startedAt || a.id - b.id;

export function encodeCursor(position: Position): string {
  return Buffer.from(JSON.stringify({ s: position.startedAt, i: position.id })).toString(
    'base64url',
  );
}

/** A cursor this server makes is under 60 characters; anything much longer is not one, so it is refused before it is parsed. */
const MAX_CURSOR_LENGTH = 200;

/** Reads a cursor this server made. Anything else is `invalid_input`. */
export function decodeCursor(cursor: string): Position {
  if (cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value === 'object' && value !== null) {
      const { s, i } = value as { s?: unknown; i?: unknown };
      if (Number.isSafeInteger(s) && Number.isSafeInteger(i)) {
        return { startedAt: s as number, id: i as number };
      }
    }
  } catch {
    // falls through to the error below
  }
  throw invalidCursor();
}

const invalidCursor = () =>
  new ApiError('invalid_input', 'The page marker is not valid.', {
    details: { fields: { cursor: 'Use the nextCursor a previous response returned.' } },
  });

/**
 * One page of a group's tree.
 *
 * - `roots`: root sessions with an event in scope, newest start first, each with its children (oldest first). A child hangs
 *   under its nearest root ancestor when that root is in the same group and in scope.
 * - `orphans`: children whose root is not in the list: it has no event in scope, is filtered out (for example by the
 *   provider filter) or sits in another group.
 * - `unknownRelationship`: sessions whose parent was not recorded. They are never counted as roots or children.
 *
 * Only roots are paged. Orphans and unknown-relationship sessions come with the first page (no cursor) and are empty on later
 * pages, so a client that appends every page's lists shows each session once. `remaining` is the number of roots after this page.
 */
export function buildRoots(
  db: Db,
  scope: Scope,
  params: { groupKey: string; cursor?: string | undefined; limit: number },
): UsageRoots {
  const repoStates = readRepoStates(db);
  const group = resolveGroup(params.groupKey, repoStates);
  const after = params.cursor === undefined ? null : decodeCursor(params.cursor);
  const rows = readGroupSessions(db, filterOf(scope), group);

  const roots = rows.filter((row) => row.kind === 'root').sort(newestFirst);
  const rootIds = new Set(roots.map((row) => row.id));
  const childrenOf = new Map<number, GroupSessionRow[]>();
  const orphans: GroupSessionRow[] = [];
  for (const row of rows) {
    if (row.kind !== 'child') continue;
    if (row.rootId !== null && rootIds.has(row.rootId)) {
      const list = childrenOf.get(row.rootId) ?? [];
      list.push(row);
      childrenOf.set(row.rootId, list);
    } else orphans.push(row);
  }
  const unknown = rows.filter((row) => row.kind === 'unknown');

  const first = after === null ? 0 : roots.findIndex((row) => newestFirst(row, after) > 0);
  const start = first === -1 ? roots.length : first;
  const page = roots.slice(start, start + params.limit);
  const remaining = roots.length - (start + page.length);

  const newestList = (list: GroupSessionRow[]) => [...list].sort(newestFirst);
  const shown = [
    ...page,
    ...page.flatMap((row) => childrenOf.get(row.id) ?? []),
    ...(after === null ? [...orphans, ...unknown] : []),
  ];
  const linkRows = new Map<number, LinkRow[]>();
  for (const link of readLinkRows(
    db,
    shown.map((row) => row.id),
  )) {
    const list = linkRows.get(link.sessionId) ?? [];
    list.push(link);
    linkRows.set(link.sessionId, list);
  }
  const lookups: SessionLookups = {
    repos: new Map(repoStates.map((repo) => [repo.id, repo])),
    links: new Map([...linkRows].map(([id, list]) => [id, linkedPrsOf(list)])),
  };

  const last = page.at(-1);
  return {
    roots: page.map((row) => {
      const children = (childrenOf.get(row.id) ?? []).sort(oldestFirst);
      return {
        ...toSession(row, lookups, children.length),
        children: children.map((child) => toSession(child, lookups)),
      };
    }),
    orphans: after === null ? newestList(orphans).map((row) => toSession(row, lookups)) : [],
    unknownRelationship:
      after === null ? newestList(unknown).map((row) => toSession(row, lookups)) : [],
    nextCursor: remaining > 0 && last ? encodeCursor(last) : null,
    remaining,
  };
}
