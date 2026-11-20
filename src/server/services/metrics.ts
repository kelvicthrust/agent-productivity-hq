import type { z } from 'zod';
import type { Provider, Scope, UsageCoverage } from '../../shared/contracts/common.ts';
import type { OverviewResponse } from '../../shared/contracts/overview.ts';
import type { PullRequest, RecordsResponse as RecordsSchema } from '../../shared/contracts/prs.ts';
import type { SeriesResponse } from '../../shared/contracts/series.ts';
import type { AccountStatus } from '../../shared/contracts/sources.ts';
import type {
  ModelsResponse as ModelsSchema,
  ProviderKpi,
  Session,
} from '../../shared/contracts/usage.ts';
import {
  coveredFrom,
  deliveryCoverage,
  isTrueZero,
  prValue,
  providerCoverage,
  railCoverage,
  tokenValue,
  unavailableText,
  type DeliveryCoverageInput,
  type SourceCoverageInput,
} from '../../shared/domain/coverage.ts';
import {
  bucketIndexOf,
  bucketsFor,
  dateInZone,
  diffDays,
  isDateString,
  isoWeekday,
  lookbackStart,
  minDate,
  previousRange,
  rangeBounds,
  todayIn,
} from '../../shared/domain/periods.ts';
import { providersInScope, type RawFilters } from '../../shared/domain/scope.ts';
import type { Db } from '../db/open.ts';
import { readLinkHealth } from '../db/queries/link-health.ts';
import { getMeta } from '../db/queries/meta.ts';
import {
  readBucketTokens,
  readCrewProviders,
  readModelTotals,
  readPrLinkPairs,
  readRangeFacts,
  readRecordSessions,
  type PrLinkPair,
  type RangeFact,
  type RecordSessionRow,
} from '../db/queries/metrics.ts';
import {
  countPullRequests,
  listMergeTimes,
  listPullRequests,
  type PrFilter,
  type PrRow,
} from '../db/queries/prs.ts';
import {
  readGroupTotals,
  readLinkRows,
  readRepoStates,
  readSourceStates,
  UNKNOWN_GROUP,
  UNTRACKED_GROUP,
  type LinkRow,
  type RepoStateRow,
  type SourceStateRow,
  type UsageFilter,
  type UsageProvider,
} from '../db/queries/usage.ts';
import { buildChatgptWeeklyReport, chatgptStatus } from './accounts.ts';
import { claudePlanStatus } from './claude-account.ts';
import { buildSources } from './sources.ts';
import {
  decideLinkStatus,
  effectiveLinkClass,
  linkedPrsOf,
  resolveUsageScope,
  shortSessionRef,
  type UsageContext,
} from './usage.ts';

// The review surfaces' server half: the aligned series, the Overview, the records of one bucket and the model shares. Every figure
// is computed per request from stored rows (TECH › Critical logic):
//   - report-timezone dates become UTC bounds (`rangeBounds`), per bucket, and ONE event set feeds every granularity, so day, week
//     and month totals over the same days are equal (P-11);
//   - coverage decides what a total means: a covered bucket with no events is a real 0, an uncovered one is null, never drawn as zero
//     (P-05);
//   - provider totals are summed per provider and never added together; account-wide summaries ignore the repo filter.

export type MetricsContext = UsageContext;
export type RecordsResponse = z.infer<typeof RecordsSchema>;
export type ModelsResponse = z.infer<typeof ModelsSchema>;

export const DEFAULT_RECORDS_LIMIT = 30;
export const MAX_RECORDS_LIMIT = 100;
/** The Overview draws at most this many buddies per crew-count KPI (the contract's `crew` maximum). */
const CREW_LIMIT = 10;
/** The Overview's "Recently merged" list. */
const RECENT_PRS = 6;
/** More merged PRs than a 12-month lookback can hold: the Overview reads the whole period's PRs in one list. */
const ALL_PRS = 100_000;

// ---- the frame every route starts from -------------------------------------------------------------------------------------

interface Frame {
  scope: Scope;
  today: string;
  providers: UsageProvider[];
  sources: Record<UsageProvider, SourceCoverageInput>;
  repos: RepoStateRow[];
  delivery: DeliveryCoverageInput;
}

/**
 * What a source's coverage is built from: found when it has imported records; `stale` needs a failed last attempt, and the last
 * fully collected date comes from `extra_json.staleAfter`, else from the last success. Never earlier than what retention keeps.
 * This is the rule `GET /api/usage/categories` applies (services/usage.ts), and a test holds the two to the same answers.
 */
function sourceInput(
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
  return {
    found: true,
    oldestDate: coveredFrom(dateInZone(row.oldestEventAt, timezone), today),
    staleAfter,
  };
}

/** Delivery is read from tracked, reachable repos in scope: with none it is `none`, while any is still on its backfill, `syncing`. */
function deliveryInput(repos: readonly RepoStateRow[], scope: Scope): DeliveryCoverageInput {
  const inScope = repos.filter(
    (repo) =>
      repo.trackingState === 'active' &&
      repo.accessState !== 'inaccessible' &&
      (scope.repos.length === 0 || scope.repos.includes(repo.id)),
  );
  return {
    activeRepos: inScope.length,
    backfillIncomplete: inScope.some((repo) => !repo.backfillComplete),
  };
}

function frameOf(db: Db, raw: RawFilters, ctx: MetricsContext): Frame {
  const scope = resolveUsageScope(db, raw, ctx);
  const today = todayIn(ctx.nowMs, ctx.timezone);
  const states = new Map(readSourceStates(db).map((row) => [row.sourceId, row]));
  const repos = readRepoStates(db);
  return {
    scope,
    today,
    providers: providersInScope(scope.provider),
    sources: {
      codex: sourceInput(states.get('codex'), ctx.timezone, today),
      claude: sourceInput(states.get('claude'), ctx.timezone, today),
    },
    repos,
    delivery: deliveryInput(repos, scope),
  };
}

/** The events a request selects: `[start, end]` as local dates, the providers and the repo filter. */
function usageFilter(frame: Frame, start: string, end: string): UsageFilter {
  const bounds = rangeBounds(start, end, frame.scope.timezone);
  return {
    fromMs: bounds.start,
    toMs: bounds.end,
    providers: frame.providers,
    repos: frame.scope.repos,
  };
}

/** `mine` = the PR's author is the connected GitHub login (app_meta.github_login); with no login known nothing is mine. */
const connectedLogin = (db: Db): string | null => getMeta(db, 'github_login') || null;

function prFilter(frame: Frame, login: string | null, start: string, end: string): PrFilter {
  const bounds = rangeBounds(start, end, frame.scope.timezone);
  return {
    fromMs: bounds.start,
    toMs: bounds.end,
    repos: frame.scope.repos,
    author: frame.scope.author === 'mine' ? { mode: 'mine', login } : { mode: 'all' },
  };
}

/** Coverage of each in-scope provider over `span`. */
function coverageOf(
  frame: Frame,
  span: { start: string; end: string },
): Record<UsageProvider, UsageCoverage> {
  return {
    codex: providerCoverage(span, frame.sources.codex, frame.today),
    claude: providerCoverage(span, frame.sources.claude, frame.today),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ---- GET /api/series -------------------------------------------------------------------------------------------------------

/**
 * Aligned chart buckets. Each carries the merged-PR count (null where delivery is none or future), the provider token totals
 * (null where that provider's history is uncovered) and the coverage the chart's rail and hatch are drawn from.
 */
export function buildSeries(db: Db, raw: RawFilters, ctx: MetricsContext): SeriesResponse {
  const frame = frameOf(db, raw, ctx);
  const { scope, today, providers } = frame;
  const buckets = bucketsFor(scope.start, scope.end, scope.gran);
  const ranges = buckets.map((bucket) => ({
    bucket,
    bounds: rangeBounds(bucket.start, bucket.end, scope.timezone),
  }));

  const tokens = readBucketTokens(
    db,
    ranges.map(({ bucket, bounds }) => ({
      index: bucket.index,
      fromMs: bounds.start,
      toMs: bounds.end,
    })),
    { providers, repos: scope.repos },
  );

  // Merged PRs: the same bounds on `merged_at`, each merge placed in its report-timezone day and the day in its bucket.
  const merges = new Array<number>(buckets.length).fill(0);
  const mergeTimes = listMergeTimes(
    db,
    prFilter(frame, connectedLogin(db), scope.start, scope.end),
  );
  for (const mergedAt of mergeTimes) {
    const index = bucketIndexOf(buckets, dateInZone(mergedAt, scope.timezone));
    if (index >= 0) merges[index] = (merges[index] ?? 0) + 1;
  }

  let anyUnavailable = false;
  const out: SeriesResponse['buckets'] = buckets.map((bucket) => {
    const coverage = coverageOf(frame, bucket);
    const delivery = deliveryCoverage(bucket, frame.delivery, today);
    const totals = tokens.get(bucket.index) ?? {};
    const tokenRow: SeriesResponse['buckets'][number]['tokens'] = {};
    const usage: SeriesResponse['buckets'][number]['usage'] = {};
    for (const provider of providers) {
      tokenRow[provider] = tokenValue(coverage[provider], totals[provider] ?? 0);
      usage[provider] = coverage[provider];
    }
    usage.rail = railCoverage(providers.map((provider) => coverage[provider]));
    if (usage.rail === 'unavailable') anyUnavailable = true;
    return {
      start: bucket.start,
      end: bucket.end,
      label: bucket.label,
      short: bucket.short,
      partOfRange: bucket.partOfRange,
      prs: prValue(delivery, merges[bucket.index] ?? 0),
      delivery,
      tokens: tokenRow,
      usage,
    };
  });

  return {
    scope,
    buckets: out,
    unavailableText: anyUnavailable
      ? unavailableText(
          providers.map((provider) =>
            frame.sources[provider].found ? frame.sources[provider].oldestDate : null,
          ),
        )
      : null,
  };
}

// ---- link classes of merged PRs --------------------------------------------------------------------------------------------

export interface PrLinks {
  linkClass: PullRequest['linkClass'];
  /** Evidence plus owner links. */
  linked: number;
  suggested: number;
  providers: Provider[];
}

export const NO_LINKS: PrLinks = { linkClass: 'unlinked', linked: 0, suggested: 0, providers: [] };

/**
 * Each PR's class takes its strongest effective link: evidence, then owner, then suggested, else unlinked (data-and-sources ›
 * Attribution). A rejected or dismissed link does not count, and a PR counts once however many sessions link to it.
 */
export function summariseLinks(pairs: readonly PrLinkPair[]): Map<string, PrLinks> {
  const counts = new Map<
    string,
    { evidence: number; owner: number; suggested: number; providers: Set<Provider> }
  >();
  for (const pair of pairs) {
    const cls = effectiveLinkClass(pair.computed, pair.decision);
    if (cls === null) continue;
    const entry = counts.get(pair.prNodeId) ?? {
      evidence: 0,
      owner: 0,
      suggested: 0,
      providers: new Set<Provider>(),
    };
    entry[cls] += 1;
    entry.providers.add(pair.provider);
    counts.set(pair.prNodeId, entry);
  }
  return new Map(
    [...counts].map(([id, entry]) => [
      id,
      {
        linkClass:
          entry.evidence > 0
            ? 'evidence'
            : entry.owner > 0
              ? 'owner'
              : entry.suggested > 0
                ? 'suggested'
                : 'unlinked',
        linked: entry.evidence + entry.owner,
        suggested: entry.suggested,
        providers: (['codex', 'claude'] as const).filter((p) => entry.providers.has(p)),
      } satisfies PrLinks,
    ]),
  );
}

function toPullRequest(row: PrRow, login: string | null, links: PrLinks): PullRequest {
  return {
    id: row.nodeId,
    repo: row.repoId,
    number: row.number,
    title: row.title,
    url: row.url,
    mergedAt: iso(row.mergedAt),
    author: row.authorLogin,
    mergedBy: row.mergedByLogin,
    authoredByMe:
      login !== null &&
      row.authorLogin !== null &&
      row.authorLogin.toLowerCase() === login.toLowerCase(),
    linkClass: links.linkClass,
    linkedSessionCount: links.linked,
    suggestedCount: links.suggested,
    providers: links.providers,
  };
}

const isLinked = (links: PrLinks | undefined): boolean =>
  links?.linkClass === 'evidence' || links?.linkClass === 'owner';

// ---- GET /api/overview -----------------------------------------------------------------------------------------------------

/** The wording of the previous-period comparison ("Yesterday", "Last week", "Previous 30 days"). */
function previousLabel(start: string, end: string, today: string): string {
  const days = diffDays(start, end) + 1;
  if (days === 1) return start === today ? 'Yesterday' : 'Previous day';
  if (days === 7 && isoWeekday(start) === 1) return 'Last week';
  return `Previous ${days} days`;
}

function providerKpi(
  coverage: UsageCoverage,
  tokens: number,
  source: SourceCoverageInput,
): ProviderKpi {
  const partial = coverage === 'partial';
  return {
    coverage,
    value: tokenValue(coverage, tokens),
    note: partial
      ? 'From <date> only'
      : coverage === 'stale'
        ? 'Cached; recent days missing'
        : null,
    coveredFrom: partial ? (source.oldestDate ?? null) : null,
  };
}

const sumBy = (facts: readonly RangeFact[], pick: (fact: RangeFact) => boolean): number =>
  facts.filter(pick).reduce((total, fact) => total + fact.sessions, 0);

/**
 * The Overview: the five KPIs, the coverage strip, the per-repository table and the recently merged PRs. `accounts` holds the
 * account reports there are (ChatGPT's; Claude's arrives with its capture); it is account-wide and ignores the repo filter, as does `coverage` (it describes the machine, not the selection).
 */
export function buildOverview(
  db: Db,
  raw: RawFilters,
  ctx: MetricsContext,
  claudeStatus: AccountStatus = claudePlanStatus(db, ctx.nowMs),
): OverviewResponse {
  const frame = frameOf(db, raw, ctx);
  const { scope, today, providers } = frame;
  const login = connectedLogin(db);
  const usage = usageFilter(frame, scope.start, scope.end);
  const elapsed = { start: scope.start, end: minDate(scope.end, today) };
  const coverage = coverageOf(frame, elapsed);

  // Delivery: every merged PR of the period in one list, newest first. It feeds the KPIs, the table and the recent list.
  const delivery = deliveryCoverage({ start: scope.start }, frame.delivery, today);
  const filter = prFilter(frame, login, scope.start, scope.end);
  const prs = listPullRequests(db, filter, { limit: ALL_PRS }).slice(0, ALL_PRS);
  const links = summariseLinks(
    readPrLinkPairs(
      db,
      prs.map((pr) => pr.nodeId),
    ),
  );
  const hasDelivery = delivery !== 'none' && delivery !== 'future';

  const linkedCount = prs.filter((pr) => isLinked(links.get(pr.nodeId))).length;
  const suggestedOnly = prs.filter((pr) => links.get(pr.nodeId)?.linkClass === 'suggested').length;

  const previous = previousRange(scope.start, scope.end);
  const outsideLookback = previous.start < lookbackStart(today);
  const mergedPrs: NonNullable<OverviewResponse['kpis']['mergedPrs']> = {
    value: hasDelivery ? prs.length : null,
    delivery,
  };
  if (hasDelivery) {
    mergedPrs.previous = {
      label: previousLabel(scope.start, scope.end, today),
      value: outsideLookback
        ? null
        : countPullRequests(db, prFilter(frame, login, previous.start, previous.end)),
      outsideLookback,
    };
  }

  // Local usage: one scan, grouped by provider and relationship.
  const facts = readRangeFacts(db, usage);
  const tokens = (provider: UsageProvider): number =>
    facts.filter((fact) => fact.provider === provider).reduce((sum, fact) => sum + fact.tokens, 0);
  const localTokens: NonNullable<OverviewResponse['kpis']['localTokens']> = {};
  for (const provider of providers) {
    localTokens[provider] = providerKpi(
      coverage[provider],
      tokens(provider),
      frame.sources[provider],
    );
  }
  // "No local records": no in-scope provider has covered dates, so a count of 0 would be a claim nobody can make.
  const hasLocal = providers.some(
    (p) => coverage[p] !== 'none' && coverage[p] !== 'unavailable' && coverage[p] !== 'future',
  );
  const roots = sumBy(facts, (f) => f.relationship === 'root');
  const paseo = sumBy(facts, (f) => f.relationship === 'paseo');
  const native = sumBy(facts, (f) => f.relationship === 'native');

  const kpis: OverviewResponse['kpis'] = {
    mergedPrs,
    linkedPrs: hasDelivery
      ? { value: linkedCount, of: prs.length, suggestedOnly }
      : { value: null, of: null },
    localTokens,
    rootSessions: hasLocal
      ? {
          value: roots,
          unknownRelationship: sumBy(facts, (f) => f.relationship === 'unknown'),
          crew: readCrewProviders(db, usage, 'root', CREW_LIMIT),
        }
      : { value: null },
    childAgents: hasLocal
      ? {
          value: paseo + native,
          paseo,
          native,
          crew: readCrewProviders(db, usage, 'child', CREW_LIMIT),
        }
      : { value: null },
  };

  const sources = buildSources(db, { timezone: ctx.timezone, now: () => ctx.nowMs }).sources ?? [];
  // Account-wide cards, from stored rows alone (Overview never starts Codex or opens a Claude file). A report is shown only for an
  // account that is connected: a figure left over from before Disconnect or Turn off is not the account's to show now.
  const chatgptStatusNow = chatgptStatus(db, { timezone: ctx.timezone });
  const chatgptReport =
    chatgptStatusNow.status === 'notconnected' ? null : buildChatgptWeeklyReport(db, ctx.nowMs);
  const claudeReport = claudeStatus.planLimits?.report ?? null;
  const active = frame.repos.filter((repo) => repo.trackingState === 'active');
  const lastAttempts = sources.flatMap((source) =>
    source.lastAttemptAt ? [source.lastAttemptAt] : [],
  );

  return {
    scope,
    kpis,
    linkHealth: readLinkHealth(db),
    coverage: {
      sources,
      github: {
        tracked: active.length,
        inaccessible: active.filter((repo) => repo.accessState === 'inaccessible').length,
      },
      // Account-wide: the repo filter never reaches these, and a status is read from stored rows (it never starts Codex).
      accounts: [chatgptStatusNow, claudeStatus],
      lastRefreshAt: lastAttempts.length > 0 ? lastAttempts.sort().at(-1)! : null,
      refreshFailed: sources.some((source) => source.lastAttemptResult === 'failed'),
    },
    // Account-reported usage, shown apart from every local total (P-33 to P-36): never added to a KPI, a chart or a row.
    accounts: [chatgptReport, claudeReport].filter((report) => report !== null),
    repoRows: repoRows(db, frame, { usage, coverage, prs, links }),
    recentPrs: prs
      .slice(0, RECENT_PRS)
      .map((pr) => toPullRequest(pr, login, links.get(pr.nodeId) ?? NO_LINKS)),
    periodMergedCount: prs.length,
    trueZero: isTrueZero({
      range: { start: scope.start, end: scope.end },
      today,
      providers,
      sources: frame.sources,
      delivery,
      events: facts.reduce((sum, fact) => sum + fact.events, 0),
      merges: prs.length,
    }),
  };
}

/**
 * One row per tracked repo (shown even with no activity, as the design does), then the Untracked and Unknown usage-only groups
 * when no repo filter is set and they have sessions. A repo GitHub no longer grants has no PR figures (they were not collected);
 * its local usage is still real and still shown, so the table keeps adding up to the Usage page.
 */
function repoRows(
  db: Db,
  frame: Frame,
  data: {
    usage: UsageFilter;
    coverage: Record<UsageProvider, UsageCoverage>;
    prs: readonly PrRow[];
    links: ReadonlyMap<string, PrLinks>;
  },
): OverviewResponse['repoRows'] {
  const { scope, providers } = frame;
  const totals = new Map<
    string,
    { roots: number; tokens: Partial<Record<UsageProvider, number>> }
  >();
  for (const row of readGroupTotals(db, data.usage)) {
    const entry = totals.get(row.group) ?? { roots: 0, tokens: {} };
    entry.roots += row.roots;
    entry.tokens[row.provider] = (entry.tokens[row.provider] ?? 0) + row.tokens;
    totals.set(row.group, entry);
  }
  const merged = new Map<string, { merged: number; linked: number }>();
  for (const pr of data.prs) {
    const entry = merged.get(pr.repoId) ?? { merged: 0, linked: 0 };
    entry.merged += 1;
    if (isLinked(data.links.get(pr.nodeId))) entry.linked += 1;
    merged.set(pr.repoId, entry);
  }

  const tokenCells = (key: string): { codex?: number | null; claude?: number | null } => {
    const cells: { codex?: number | null; claude?: number | null } = {};
    for (const provider of providers) {
      cells[provider] = tokenValue(data.coverage[provider], totals.get(key)?.tokens[provider] ?? 0);
    }
    return cells;
  };

  const rows: OverviewResponse['repoRows'] = frame.repos
    .filter((repo) => repo.trackingState === 'active')
    .filter((repo) => scope.repos.length === 0 || scope.repos.includes(repo.id))
    .map((repo) => {
      const reachable = repo.accessState !== 'inaccessible';
      return {
        group: 'tracked' as const,
        repo: repo.id,
        accessState: repo.accessState,
        mergedPrs: reachable ? (merged.get(repo.id)?.merged ?? 0) : null,
        linkedPrs: reachable ? (merged.get(repo.id)?.linked ?? 0) : null,
        tokens: tokenCells(repo.id),
        rootSessions: totals.get(repo.id)?.roots ?? 0,
      };
    });

  // Usage-only groups: sessions whose repo is not tracked, or has none recorded. A repo filter excludes them (local-api › Filters).
  if (scope.repos.length === 0) {
    for (const [group, key] of [
      ['untracked', UNTRACKED_GROUP],
      ['unknown', UNKNOWN_GROUP],
    ] as const) {
      if (!totals.has(key)) continue;
      rows.push({
        group,
        repo: null,
        mergedPrs: null,
        linkedPrs: null,
        tokens: tokenCells(key),
        rootSessions: totals.get(key)?.roots ?? 0,
      });
    }
  }
  return rows;
}

// ---- GET /api/records ------------------------------------------------------------------------------------------------------

type RecordsCoverage = NonNullable<RecordsResponse['coverage']>;

function relationshipLabel(row: RecordSessionRow): NonNullable<Session['relationshipLabel']> {
  if (row.kind === 'root') return 'Root session';
  if (row.kind === 'unknown') return 'Unknown relationship';
  return row.parentBasis === 'paseo' || row.nativeKind === 'paseo'
    ? 'Paseo child agent'
    : 'Native subagent';
}

/** A session as the Usage tree shows it (services/usage.ts), with `tokens` meaning the bucket's own. A test holds the two equal. */
export function toSession(
  row: RecordSessionRow,
  repos: ReadonlyMap<string, RepoStateRow>,
  linkRows: readonly LinkRow[],
): Session {
  const repo = row.repoId === null ? undefined : repos.get(row.repoId);
  const linkedPrs = linkedPrsOf(linkRows);
  const label = relationshipLabel(row);
  const named = row.recordedName !== null && row.recordedName.trim() !== '';
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
    repoGroup:
      row.repoId === null ? 'unknown' : repo?.trackingState === 'active' ? 'tracked' : 'untracked',
    ...(row.lastModel === null ? {} : { model: row.lastModel }),
    tokens: row.tokens,
    startedAt: iso(row.startedAt),
    startedBasis: row.startedBasis,
    firstEventAt: iso(row.firstEventAt ?? row.startedAt),
    lastEventAt: iso(row.lastEventAt ?? row.firstEventAt ?? row.startedAt),
    parentId: row.parentId,
    linkStatus: decideLinkStatus(row.repoId, repo, linkedPrs),
    linkedPrs,
  };
}

/**
 * The merged PRs and the sessions inside ONE bucket (`start`..`end` are the bucket's own dates), under the same repo, provider and
 * author filters as the chart. `limit` cuts each list; `prTotal` and `sessionTotal` are the full counts. PRs are newest merge
 * first and sessions largest first. `coverage` says what an empty list means: a covered zero, or history nobody holds.
 */
export function buildRecords(
  db: Db,
  raw: RawFilters,
  params: { limit: number },
  ctx: MetricsContext,
): RecordsResponse {
  const frame = frameOf(db, raw, ctx);
  const { scope, today, providers } = frame;
  const login = connectedLogin(db);

  const filter = prFilter(frame, login, scope.start, scope.end);
  const prRows = listPullRequests(db, filter, { limit: params.limit }).slice(0, params.limit);
  const links = summariseLinks(
    readPrLinkPairs(
      db,
      prRows.map((pr) => pr.nodeId),
    ),
  );

  const { rows, total } = readRecordSessions(
    db,
    usageFilter(frame, scope.start, scope.end),
    params.limit,
  );
  const linkRows = new Map<number, LinkRow[]>();
  for (const link of readLinkRows(
    db,
    rows.map((row) => row.id),
  )) {
    const list = linkRows.get(link.sessionId) ?? [];
    list.push(link);
    linkRows.set(link.sessionId, list);
  }
  const repos = new Map(frame.repos.map((repo) => [repo.id, repo]));

  const covered = coverageOf(frame, { start: scope.start, end: minDate(scope.end, today) });
  const coverage: RecordsCoverage = {
    delivery: deliveryCoverage({ start: scope.start }, frame.delivery, today),
  };
  for (const provider of providers) coverage[provider] = covered[provider];

  return {
    scope,
    prs: prRows.map((pr) => toPullRequest(pr, login, links.get(pr.nodeId) ?? NO_LINKS)),
    prTotal: countPullRequests(db, filter),
    sessions: rows.map((row) => toSession(row, repos, linkRows.get(row.id) ?? [])),
    sessionTotal: total,
    coverage,
  };
}

// ---- GET /api/models -------------------------------------------------------------------------------------------------------

/**
 * Token share per model WITHIN each provider, never across: the providers count tokens differently, so they are not compared on one
 * scale. Rows are largest first. Where a provider has no covered dates the rows are empty and `coverage` says why.
 */
export function buildModels(db: Db, raw: RawFilters, ctx: MetricsContext): ModelsResponse {
  const frame = frameOf(db, raw, ctx);
  const { scope, today, providers } = frame;
  const covered = coverageOf(frame, { start: scope.start, end: minDate(scope.end, today) });
  const totals = readModelTotals(db, usageFilter(frame, scope.start, scope.end));

  const out: ModelsResponse = {};
  for (const provider of providers) {
    const coverage = covered[provider];
    const hasFigures = tokenValue(coverage, 0) !== null;
    const mine = hasFigures ? totals.filter((row) => row.provider === provider) : [];
    const sum = mine.reduce((total, row) => total + row.tokens, 0);
    out[provider] = {
      coverage,
      rows: mine
        .map((row) => ({
          model: row.model,
          tokens: row.tokens,
          sessions: row.sessions,
          sharePercent: sum > 0 ? Math.round((row.tokens / sum) * 100) : 0,
        }))
        .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model)),
    };
  }
  return out;
}
