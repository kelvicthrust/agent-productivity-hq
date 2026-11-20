import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lookbackStart, todayIn, utcBounds } from '../../../shared/domain/periods.ts';
import type { Db } from '../../db/open.ts';
import {
  beginGithubPass,
  clearGithubCursor,
  githubCooldown,
  rotateGithubRepos,
  saveGithubPage,
  setGithubCooldown,
  type GithubPass,
} from '../../db/queries/githubSync.ts';
import {
  addPullRequestCommits,
  listPullRequestsWithMoreCommits,
  type PullRequestInput,
} from '../../db/queries/prs.ts';
import {
  getRepo,
  listActiveRepos,
  setRepoAccess,
  type RepoRecord,
} from '../../db/queries/repos.ts';
import type { AdapterContext, AdapterReport, SourceAdapter } from '../types.ts';
import { NO_CREDENTIAL_MESSAGE } from './auth.ts';
import { openSession, type GithubSession, type NoCredential, type Reply } from './client.ts';
import type { GithubAuth, NetFetch } from './ports.ts';
import { DEFAULT_BACKOFF_MS } from './rateLimit.ts';
import { inaccessibleMessage, type Inaccessible } from './repoCheck.ts';
import { isGithubRepoSlug } from '../../../shared/domain/repoInput.ts';

// Merged PRs, newest update first. Each GraphQL page commits with its pass checkpoint. Commit-list pages have their own
// checkpoint. The session holds credentials only in memory, and SQLite retains the rate-limit wake time across restarts.

export const ADAPTER_VERSION = 'github-graphql/2';
/** The sync stops, with the quota's reset time, once GitHub says fewer than this many points are left. */
export const RATE_LIMIT_FLOOR = 100;
export const COMMITS_PER_PAGE = 100;
const DAY_MS = 86_400_000;

const REPO_FIELDS = `
    id nameWithOwner
    pullRequests(states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title url mergedAt updatedAt
        author { login } mergedBy { login }
        headRefName baseRefName mergeCommit { oid }
        commits(first: ${COMMITS_PER_PAGE}) { totalCount nodes { commit { oid } } }
      }
    }`;
const QUERY_BY_SLUG = `query MergedPRs($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) { ${REPO_FIELDS} }
  rateLimit { remaining resetAt cost }
}`;
const QUERY_BY_NODE = `query MergedPRs($id: ID!, $after: String) {
  repository: node(id: $id) {
    ... on Repository { ${REPO_FIELDS} }
  }
  rateLimit { remaining resetAt cost }
}`;

// ---- what GitHub answers ----

const Actor = z.object({ login: z.string() }).nullable().optional();
const PrNode = z.object({
  id: z.string().min(1),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  mergedAt: z.string().nullable(),
  updatedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  author: Actor,
  mergedBy: Actor,
  headRefName: z.string().nullable().optional(),
  baseRefName: z.string().nullable().optional(),
  mergeCommit: z.object({ oid: z.string() }).nullable().optional(),
  commits: z.object({
    totalCount: z.number().int(),
    nodes: z.array(z.object({ commit: z.object({ oid: z.string() }) }).nullable()),
  }),
});
type PrNode = z.infer<typeof PrNode>;

const PrRepository = z.object({
  id: z.string().min(1),
  nameWithOwner: z.string().refine(isGithubRepoSlug),
  pullRequests: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    nodes: z.array(PrNode.nullable()),
  }),
});

const PageBody = z.object({
  data: z
    .object({
      repository: z.unknown(),
      rateLimit: z.object({ remaining: z.number(), resetAt: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  errors: z
    .array(z.object({ type: z.string().optional(), message: z.string().optional() }))
    .optional(),
});

const CommitsBody = z.array(z.object({ sha: z.string().min(1) }));

type Page =
  | {
      kind: 'page';
      identity: { id: string; nodeId: string; displayName: string };
      nodes: PrNode[];
      hasNext: boolean;
      endCursor: string | null;
      /** Set when GitHub says fewer than RATE_LIMIT_FLOOR points are left: epoch ms of the reset. */
      limitedUntil: number | null;
    }
  /** `repository: null`: GitHub does not hand this repository to this sign-in. */
  | { kind: 'missing' }
  | { kind: 'rate_limited'; until: number }
  | { kind: 'invalid_cursor' }
  | { kind: 'unexpected' };

function readPage(body: unknown, nowMs: number): Page {
  const parsed = PageBody.safeParse(body);
  if (!parsed.success) return { kind: 'unexpected' };
  const { data, errors } = parsed.data;
  const resetAt = data?.rateLimit ? Date.parse(data.rateLimit.resetAt) : Number.NaN;
  if (errors?.some((error) => error.type === 'RATE_LIMITED')) {
    return { kind: 'rate_limited', until: Number.isFinite(resetAt) ? resetAt : nowMs + 60_000 };
  }
  if (
    errors?.some(
      ({ type, message }) =>
        type === 'INVALID_CURSOR_ARGUMENTS' ||
        type === 'INVALID_CURSOR' ||
        /\b(?:invalid|malformed)\b.*\bcursor\b|\bcursor\b.*\b(?:invalid|malformed|could not be resolved)\b/i.test(
          message ?? '',
        ),
    )
  )
    return { kind: 'invalid_cursor' };
  if (!data) return { kind: 'unexpected' };
  if (data.repository === null) return { kind: 'missing' };
  if (errors?.length) return { kind: 'unexpected' };
  const repository = PrRepository.safeParse(data.repository);
  if (!repository.success) return { kind: 'unexpected' };
  const {
    id,
    nameWithOwner,
    pullRequests: { pageInfo, nodes },
  } = repository.data;
  const low =
    data.rateLimit && data.rateLimit.remaining < RATE_LIMIT_FLOOR && Number.isFinite(resetAt);
  return {
    kind: 'page',
    identity: {
      id: nameWithOwner.toLowerCase(),
      displayName: nameWithOwner,
      nodeId: id,
    },
    nodes: nodes.filter((node): node is PrNode => node !== null),
    hasNext: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
    limitedUntil: low ? resetAt : null,
  };
}

/** One merged PR as the database takes it, or null for a node that must not be stored. */
function toInput(repoId: string, node: PrNode, lookbackMs: number): PullRequestInput | null {
  if (node.mergedAt === null) return null;
  const mergedAt = Date.parse(node.mergedAt);
  // Older than the lookback it would be deleted by retention anyway; a PR updated recently but merged long ago is not delivery
  // inside the window.
  if (!Number.isFinite(mergedAt) || mergedAt < lookbackMs) return null;
  const shas = node.commits.nodes.flatMap((entry) => (entry ? [entry.commit.oid] : []));
  return {
    nodeId: node.id,
    repoId,
    number: node.number,
    title: node.title,
    url: node.url,
    authorLogin: node.author?.login ?? null,
    mergedByLogin: node.mergedBy?.login ?? null,
    mergedAt,
    headRef: node.headRefName ?? null,
    baseRef: node.baseRefName ?? null,
    mergeCommitSha: node.mergeCommit?.oid ?? null,
    commits: shas,
    commitsComplete: node.commits.totalCount <= shas.length,
    commitsSignature: createHash('sha256')
      .update(JSON.stringify([node.mergeCommit?.oid ?? null, node.commits.totalCount, shas]))
      .digest('hex'),
    commitsNextPage: shas.length < Math.min(node.commits.totalCount, COMMITS_PER_PAGE) ? 1 : 2,
  };
}

// ---- one attempt ----

type Stop =
  | { kind: 'rate_limited'; until: number }
  | { kind: 'no_credential'; failure: NoCredential }
  | { kind: 'unreachable'; code: 'unreachable' | 'unexpected_answer' };

type RepoOutcome =
  | { kind: 'complete' }
  | { kind: 'stopped' }
  | { kind: 'inaccessible'; reason: Inaccessible }
  | Stop;

interface Attempt {
  db: Db;
  now: () => number;
  session: GithubSession;
  lookbackMs: number;
  /** New PRs written, PRs seen again, and pages written. */
  imported: number;
  seen: number;
  pages: number;
  inaccessible: string[];
  /** Set once GitHub says the quota is nearly spent: the next repo is not started. */
  limitedUntil: number | null;
}

/** Why a request got no data, as the repo's outcome. A 404 under the App's token is "not installed on that owner" (R20). */
function outcomeOf(reply: Exclude<Reply, { kind: 'ok' }>, via: 'gh' | 'app'): RepoOutcome {
  switch (reply.kind) {
    case 'not_found':
      return { kind: 'inaccessible', reason: via === 'app' ? 'app_not_installed' : 'not_found' };
    case 'forbidden':
    case 'rejected':
      return { kind: 'inaccessible', reason: 'forbidden' };
    case 'moved':
      return { kind: 'inaccessible', reason: 'moved' };
    case 'rate_limited':
      return { kind: 'rate_limited', until: reply.until };
    case 'no_credential':
      return { kind: 'no_credential', failure: reply.failure };
    case 'unreachable':
      return { kind: 'unreachable', code: 'unreachable' };
  }
}

/** A legacy repo has no saved successful-pass start and makes one conservative lookback pass. */
function cutoffFor(repo: RepoRecord, lookbackMs: number): number {
  if (!repo.backfillComplete || repo.completeStartedAt === null) return lookbackMs;
  return Math.max(lookbackMs, repo.completeStartedAt - DAY_MS);
}

/** The REST pagination checkpoint and its commit IDs advance together. */
async function readOwedCommits(attempt: Attempt, repo: RepoRecord): Promise<Stop | null> {
  for (const owed of listPullRequestsWithMoreCommits(attempt.db, repo.id)) {
    for (let page = owed.nextPage; ; page += 1) {
      if (attempt.limitedUntil !== null)
        return { kind: 'rate_limited', until: attempt.limitedUntil };
      const active = getRepo(attempt.db, repo.id);
      if (!active || active.trackingState !== 'active') return null;
      const reply = await attempt.session.get(
        `/repos/${active.slug}/pulls/${owed.number}/commits?per_page=${COMMITS_PER_PAGE}&page=${page}`,
      );
      if (reply.kind === 'rate_limited') return { kind: 'rate_limited', until: reply.until };
      if (reply.kind === 'no_credential') return { kind: 'no_credential', failure: reply.failure };
      if (reply.kind === 'unreachable') return { kind: 'unreachable', code: 'unreachable' };
      if (reply.kind !== 'ok') break;
      const shas = CommitsBody.safeParse(reply.body);
      if (!shas.success) break;

      const remaining = reply.headers.get('x-ratelimit-remaining');
      const resetAt = Number(reply.headers.get('x-ratelimit-reset')) * 1000;
      if (remaining !== null && Number(remaining) < RATE_LIMIT_FLOOR && resetAt > attempt.now()) {
        setGithubCooldown(attempt.db, resetAt);
        attempt.limitedUntil = resetAt;
      }
      const current = getRepo(attempt.db, repo.id);
      if (!current || current.trackingState !== 'active') return null;
      if (current.slug !== active.slug) break;

      // GitHub's REST listing caps the list at 250. A short page is the end of that listing.
      const complete = shas.data.length < COMMITS_PER_PAGE;
      addPullRequestCommits(
        attempt.db,
        owed.nodeId,
        shas.data.map((entry) => entry.sha),
        complete,
        page,
      );
      if (complete) break;
    }
  }
  return null;
}

function nextPass(pass: GithubPass, page: Extract<Page, { kind: 'page' }>): GithubPass | null {
  const oldest = page.nodes.at(-1);
  const reachedCutoff = oldest !== undefined && Date.parse(oldest.updatedAt) < pass.cutoffAt;
  if (page.hasNext && !reachedCutoff) return { ...pass, cursor: page.endCursor };
  // The first page alone already includes whatever changed after the pass started.
  // A multi-page backfill re-reads the head to pick up entries that moved during pagination.
  if (pass.phase === 'backfill' && pass.cursor !== null) {
    // GitHub reports whole seconds, so include the second in which the pass began.
    return {
      ...pass,
      phase: 'catch_up',
      cutoffAt: Math.floor(pass.startedAt / 1000) * 1000,
      cursor: null,
    };
  }
  return null;
}

async function syncRepo(attempt: Attempt, listed: RepoRecord): Promise<RepoOutcome> {
  const { db, now, session } = attempt;
  let pass = beginGithubPass(db, listed, now(), cutoffFor(listed, attempt.lookbackMs));
  let restartedCursor = false;
  for (;;) {
    const repo = getRepo(db, listed.id);
    if (!repo || repo.trackingState !== 'active') return { kind: 'stopped' };
    const [owner = '', name = ''] = repo.slug.split('/');
    const reply = repo.nodeId
      ? await session.graphql(QUERY_BY_NODE, { id: repo.nodeId, after: pass.cursor })
      : await session.graphql(QUERY_BY_SLUG, { owner, name, after: pass.cursor });
    if (reply.kind !== 'ok') return outcomeOf(reply, session.via);
    const page = readPage(reply.body, now());
    switch (page.kind) {
      case 'missing':
        return {
          kind: 'inaccessible',
          reason: session.via === 'app' ? 'app_not_installed' : 'not_found',
        };
      case 'rate_limited':
        return { kind: 'rate_limited', until: page.until };
      case 'invalid_cursor':
        if (pass.cursor !== null) {
          if (!clearGithubCursor(db, repo.id, pass)) return { kind: 'stopped' };
          if (!restartedCursor) {
            pass = { ...pass, cursor: null };
            restartedCursor = true;
            continue;
          }
        }
        return { kind: 'unreachable', code: 'unexpected_answer' };
      case 'unexpected':
        return { kind: 'unreachable', code: 'unexpected_answer' };
      case 'page':
        break;
    }

    if (page.hasNext && (!page.endCursor || page.endCursor === pass.cursor)) {
      return { kind: 'unreachable', code: 'unexpected_answer' };
    }
    const next = nextPass(pass, page);
    const written = saveGithubPage(db, repo.id, {
      identity: page.identity,
      prs: page.nodes.flatMap((node) => toInput(repo.id, node, attempt.lookbackMs) ?? []),
      pass,
      next,
      finishedAt: now(),
      limitedUntil: page.limitedUntil,
    });
    if (page.limitedUntil !== null) attempt.limitedUntil = page.limitedUntil;
    if (written === 'stopped') return { kind: 'stopped' };
    if (written === 'identity_conflict')
      return { kind: 'inaccessible', reason: 'identity_conflict' };
    attempt.imported += written.inserted;
    attempt.seen += written.updated;
    attempt.pages += 1;
    if (!next) {
      const owed = await readOwedCommits(attempt, repo);
      return owed ?? { kind: 'complete' };
    }
    if (attempt.limitedUntil !== null) return { kind: 'rate_limited', until: attempt.limitedUntil };
    if (pass.phase !== next.phase) restartedCursor = false;
    pass = next;
  }
}

// ---- what a run shows ----

/** "1:05 PM", or "Nov 5, 1:05 PM" when it is not today, in the report timezone. Plain spaces (newer ICU uses a narrow one). */
export function formatWaitUntil(untilMs: number, nowMs: number, timezone: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(untilMs);
  const sameDay = todayIn(untilMs, timezone) === todayIn(nowMs, timezone);
  const day = sameDay
    ? ''
    : `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: timezone }).format(untilMs)}, `;
  return `${day}${time}`.replace(/[\u202f\u00a0]/g, ' ');
}

export const waitingMessage = (untilMs: number, nowMs: number, timezone: string): string =>
  `Waiting for GitHub rate limit until ${formatWaitUntil(untilMs, nowMs, timezone)}`;

const UNEXPECTED_ANSWER = 'GitHub answered with something this app can’t read. Try again later.';

export interface GithubAdapterOptions {
  /** The only way out of this process (lib/net.ts, or the scripted GitHub in tests). */
  net: NetFetch;
  /** `accounts.auth` of the account service: it honours Disconnect on the gh route and records Reconnect needed. */
  auth: GithubAuth;
  /** The report timezone: the lookback starts at local midnight. */
  timezone: string;
}

export function createGithubAdapter(options: GithubAdapterOptions): SourceAdapter {
  const { net, auth, timezone } = options;

  async function refresh(context: AdapterContext): Promise<AdapterReport> {
    const { db, now, logger } = context;
    const repos = rotateGithubRepos(db, listActiveRepos(db));
    if (repos.length === 0)
      return { result: 'skipped', message: 'No repositories are being tracked.' };

    const waitingUntil = githubCooldown(db);
    if (now() < waitingUntil) {
      return partial(waitingMessage(waitingUntil, now(), timezone), 'rate_limited');
    }

    /** A limit GitHub gave: remember it so the next refreshes inside the window do not ask again, and say when it ends. */
    const waiting = (
      until: number,
      counts: { imported?: number; duplicatesSkipped?: number } = {},
    ): AdapterReport => {
      setGithubCooldown(db, until);
      return partial(waitingMessage(until, now(), timezone), 'rate_limited', counts);
    };
    /** No credential to read with. A rate limit on the sign-in check is a wait (partial, PRs kept), not a failed attempt. */
    const noCredential = (
      failure: NoCredential,
      counts: { imported?: number; duplicatesSkipped?: number } = {},
    ): AdapterReport =>
      failure.reason === 'rate_limited'
        ? waiting(failure.until ?? now() + DEFAULT_BACKOFF_MS, counts)
        : noCredentialReport(failure, counts);

    const opened = await openSession(net, auth, now);
    if (!opened.ok) return noCredential(opened.failure);

    const today = todayIn(now(), timezone);
    const attempt: Attempt = {
      db,
      now,
      session: opened.session,
      lookbackMs: utcBounds(lookbackStart(today), timezone).start,
      imported: 0,
      seen: 0,
      pages: 0,
      inaccessible: [],
      limitedUntil: null,
    };

    let stop: Stop | null = null;
    for (const listed of repos) {
      if (attempt.limitedUntil !== null) {
        stop = { kind: 'rate_limited', until: attempt.limitedUntil };
        break;
      }
      // Stopped while this attempt was running: it has left the active views and is not read any more (P-17).
      const repo = getRepo(db, listed.id);
      if (!repo || repo.trackingState !== 'active') continue;
      const outcome = await syncRepo(attempt, repo);
      if (outcome.kind === 'complete' || outcome.kind === 'stopped') continue;
      if (outcome.kind === 'inaccessible') {
        const [owner = '', name = ''] = repo.slug.split('/');
        setRepoAccess(db, repo.id, {
          state: 'inaccessible',
          error: inaccessibleMessage(outcome.reason, owner, name),
        });
        attempt.inaccessible.push(repo.displayName);
      } else {
        stop = outcome;
        break;
      }
    }

    const counts = { imported: attempt.imported, duplicatesSkipped: attempt.seen };
    if (stop?.kind === 'rate_limited') return waiting(stop.until, counts);
    if (stop?.kind === 'no_credential') return noCredential(stop.failure, counts);
    if (stop?.kind === 'unreachable') {
      if (stop.code === 'unexpected_answer') {
        logger.warn('github answered a page this app could not read', {
          source: 'github',
          code: stop.code,
        });
      }
      const message =
        stop.code === 'unexpected_answer' ? UNEXPECTED_ANSWER : NO_CREDENTIAL_MESSAGE.unreachable;
      // Pages written before the break are kept, so an attempt that got anywhere is partial; one that got nowhere failed.
      return attempt.pages > 0 ? partial(message, stop.code, counts) : failed(message, stop.code);
    }
    if (attempt.inaccessible.length > 0) {
      const names = attempt.inaccessible.join(', ');
      const message =
        attempt.inaccessible.length === 1
          ? `${names} isn’t accessible with this GitHub sign-in. Check it on Sources.`
          : `${names} aren’t accessible with this GitHub sign-in. Check them on Sources.`;
      return partial(message, 'inaccessible', counts);
    }
    return { result: 'succeeded', adapterVersion: ADAPTER_VERSION, ...counts };
  }

  return { id: 'github', refresh };
}

function partial(
  message: string,
  errorCode: string,
  counts: { imported?: number; duplicatesSkipped?: number } = {},
): AdapterReport {
  return {
    result: 'partial',
    status: 'partial',
    errorCode,
    message,
    adapterVersion: ADAPTER_VERSION,
    ...counts,
  };
}

function failed(
  message: string,
  errorCode: string,
  counts: { imported?: number; duplicatesSkipped?: number } = {},
): AdapterReport {
  return {
    result: 'failed',
    status: 'failed',
    errorCode,
    errorDetail: message,
    message,
    adapterVersion: ADAPTER_VERSION,
    ...counts,
  };
}

/**
 * Nothing to read with: not connected (or Connect not finished) is SKIPPED, as it was never attempted. A sign-in that was
 * refused (Reconnect needed), a Keychain that refuses, or no connection to GitHub FAILS the attempt, and earlier rows stay.
 */
function noCredentialReport(
  failure: NoCredential,
  counts: { imported?: number; duplicatesSkipped?: number } = {},
): AdapterReport {
  switch (failure.reason) {
    case 'not_connected':
    case 'needs_connect':
    case 'needs_app':
      return { result: 'skipped', message: failure.message };
    case 'reconnect':
      return failed(failure.message, 'reconnect_needed', counts);
    case 'keychain_refused':
      return failed(failure.message, 'keychain_refused', counts);
    case 'unreachable':
      return failed(failure.message, 'unreachable', counts);
    case 'rate_limited':
      // refresh() turns this into the "Waiting for GitHub rate limit until <time>" report before it gets here; this keeps the
      // switch whole and still never reads a limit as a failed attempt.
      return partial(failure.message, 'rate_limited', counts);
  }
}
