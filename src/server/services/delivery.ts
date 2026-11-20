import type { z } from 'zod';
import type { DeliveryCoverage } from '../../shared/contracts/common.ts';
import { ApiError } from '../../shared/contracts/errors.ts';
import type { PrsResponse, PullRequest } from '../../shared/contracts/prs.ts';
import type { YearResponse } from '../../shared/contracts/series.ts';
import {
  dateInZone,
  lookbackStart,
  rangeBounds,
  todayIn,
  utcBounds,
} from '../../shared/domain/periods.ts';
import type { RawFilters } from '../../shared/domain/scope.ts';
import type { Db } from '../db/open.ts';
import { readLinkHealth } from '../db/queries/link-health.ts';
import { getMeta } from '../db/queries/meta.ts';
import { readPrLinkPairs } from '../db/queries/metrics.ts';
import {
  countPullRequests,
  listInaccessibleActiveRepos,
  listMergeTimes,
  listPullRequests,
  type PrCursor,
  type PrFilter,
  type PrRow,
} from '../db/queries/prs.ts';
import { listActiveRepos } from '../db/queries/repos.ts';
import { NO_LINKS, summariseLinks, type PrLinks } from './metrics.ts';
import { resolveUsageScope } from './usage.ts';

// The Delivery half of the API: the merged-PR table (GET /api/prs) and the year grid (GET /api/year). Everything is computed per
// request from stored rows (TECH › Critical logic, KPI definitions):
//   counted on `merged_at`, placed in a day or a range by the REPORT timezone (utcBounds), so a merge at 23:59 local belongs to
//     its day and one at 00:00 to the next, DST days included;
//   tracked and reachable repos only: a stopped repo has left the views, an inaccessible one is named in `inaccessibleRepos`;
//   the author rule: `mine` = the PR's AUTHOR is the connected GitHub login (case-insensitive), whoever merged it (P-20);
//   one row per PR, so a PR is counted once however many sessions link to it.
// A PR's link class is the strongest EFFECTIVE link of its sessions (evidence, owner, suggested, else unlinked): the same rule, the
// same function, as the Overview KPI and the Usage tree (metrics.ts `summariseLinks`, shared/domain/linking.ts), so a decision
// moves all three together.

type Prs = z.infer<typeof PrsResponse>;

export const DEFAULT_PRS_LIMIT = 50;
export const MAX_PRS_LIMIT = 200;
export const MAX_SEARCH_LENGTH = 200;
/** More rows than a person has merged PRs in a year: "all of them" for the queries that must see every PR of a range. */
const EVERY_ROW = 1_000_000;
const LINK_CLASSES = ['all', 'evidence', 'owner', 'suggested', 'unlinked'] as const;
type LinkFilter = (typeof LINK_CLASSES)[number];

export interface DeliveryContext {
  nowMs: number;
  /** The report timezone (IANA). */
  timezone: string;
}

export interface PrsQuery extends RawFilters {
  linkClass?: string | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: string | undefined;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const invalid = (field: string, reason: string): ApiError =>
  new ApiError('invalid_input', 'Some filters are not valid.', {
    details: { fields: { [field]: reason } },
  });

/** The connected GitHub login (app_meta.github_login, kept by the account service), or null before anyone connected. */
const connectedLogin = (db: Db): string | null => getMeta(db, 'github_login') || null;

// ---- the cursor ----

/** Opaque to the client: the merge time and node id of the last row of the page, so a page never skips or repeats a row. */
const encodeCursor = (row: PrCursor): string =>
  Buffer.from(JSON.stringify([row.mergedAt, row.nodeId])).toString('base64url');

function decodeCursor(raw: string): PrCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'number' &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === 'string' &&
      value[1] !== ''
    ) {
      return { mergedAt: value[0], nodeId: value[1] };
    }
  } catch {
    // falls through to the plain error below
  }
  throw invalid('cursor', 'That page link is no longer valid. Reload the list.');
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PRS_LIMIT;
  const limit = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(limit >= 1 && limit <= MAX_PRS_LIMIT)) {
    throw invalid('limit', `Use a whole number from 1 to ${MAX_PRS_LIMIT}.`);
  }
  return limit;
}

// ---- GET /api/prs ----

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

/**
 * Merged PRs of the selected dates, newest merge first. `counts` are the figures on the link-basis tabs: they follow the dates,
 * repos and author but not the tab or the search (as the prototype's Delivery page does), so they stay put while a person types.
 */
export function buildPrs(db: Db, query: PrsQuery, ctx: DeliveryContext): Prs {
  const scope = resolveUsageScope(db, query, ctx);

  const linkClass = (query.linkClass ?? 'all') as LinkFilter;
  if (!LINK_CLASSES.includes(linkClass)) {
    throw invalid('linkClass', 'Use all, evidence, owner, suggested or unlinked.');
  }
  const search = query.q?.trim() ?? '';
  if (search.length > MAX_SEARCH_LENGTH) {
    throw invalid('q', `Search for up to ${MAX_SEARCH_LENGTH} characters.`);
  }
  const limit = parseLimit(query.limit);
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

  const login = connectedLogin(db);
  const bounds = rangeBounds(scope.start, scope.end, scope.timezone);
  const base: PrFilter = {
    fromMs: bounds.start,
    toMs: bounds.end,
    repos: scope.repos,
    author: scope.author === 'mine' ? { mode: 'mine', login } : { mode: 'all' },
  };

  const all = countPullRequests(db, base);
  // The class of every PR in the selected dates: the tab figures follow the dates, repos and author, never the tab or the search.
  const inRange = listPullRequests(db, base, { limit: EVERY_ROW }).slice(0, EVERY_ROW);
  const links = summariseLinks(
    readPrLinkPairs(
      db,
      inRange.map((row) => row.nodeId),
    ),
  );
  const linksOf = (row: PrRow): PrLinks => links.get(row.nodeId) ?? NO_LINKS;
  const counts = { all, evidence: 0, owner: 0, suggested: 0, unlinked: 0 };
  for (const row of inRange) counts[linksOf(row).linkClass] += 1;

  const inaccessible = listInaccessibleActiveRepos(db).filter(
    (id) => scope.repos.length === 0 || scope.repos.includes(id),
  );

  // A tab keeps the PRs of its class: the rows are read in order, filtered, and cut to a page (the cursor is a position in the
  // newest-first order, so a filtered page never skips or repeats a row).
  const rows =
    linkClass === 'all'
      ? listPullRequests(db, { ...base, search }, { limit, ...(after ? { after } : {}) })
      : listPullRequests(db, { ...base, search }, { limit: EVERY_ROW, ...(after ? { after } : {}) })
          .filter((row) => linksOf(row).linkClass === linkClass)
          .slice(0, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    scope,
    counts,
    linkHealth: readLinkHealth(db),
    items: page.map((row) => toPullRequest(row, login, linksOf(row))),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    inaccessibleRepos: inaccessible,
  };
}

// ---- GET /api/year ----

/**
 * Daily merge counts for the last 12 months (today − 365 days … today, report timezone). A day with no merge is absent from
 * `counts`: it is a covered zero. `delivery` says whether that is true: `none` with no tracked, reachable repo in scope,
 * `syncing` while any of them is still on its first pass, else `ok`.
 */
export function buildYear(
  db: Db,
  query: Pick<RawFilters, 'repos' | 'author'>,
  ctx: DeliveryContext,
): YearResponse {
  const scope = resolveUsageScope(db, query, ctx);
  const today = todayIn(ctx.nowMs, ctx.timezone);
  const start = lookbackStart(today);

  const login = connectedLogin(db);
  const times = listMergeTimes(db, {
    fromMs: utcBounds(start, ctx.timezone).start,
    toMs: utcBounds(today, ctx.timezone).end,
    repos: scope.repos,
    author: scope.author === 'mine' ? { mode: 'mine', login } : { mode: 'all' },
  });

  const counts: Record<string, number> = {};
  for (const mergedAt of times) {
    const day = dateInZone(mergedAt, ctx.timezone);
    counts[day] = (counts[day] ?? 0) + 1;
  }
  const days = Object.keys(counts);
  // The busiest day: most merges, the later day on a tie (the prototype's rule).
  let busiest: string | null = null;
  for (const day of days) {
    const count = counts[day] ?? 0;
    const best = busiest === null ? -1 : (counts[busiest] ?? 0);
    if (count > best || (count === best && busiest !== null && day > busiest)) busiest = day;
  }

  const inScope = listActiveRepos(db).filter(
    (repo) =>
      repo.accessState !== 'inaccessible' &&
      (scope.repos.length === 0 || scope.repos.includes(repo.id)),
  );
  const delivery: DeliveryCoverage =
    inScope.length === 0
      ? 'none'
      : inScope.some((repo) => !repo.backfillComplete)
        ? 'syncing'
        : 'ok';

  return {
    start,
    today,
    counts,
    total: times.length,
    daysWithMerge: days.length,
    busiestDay: busiest === null ? null : { date: busiest, count: counts[busiest] ?? 0 },
    delivery,
  };
}
