import { createHash } from 'node:crypto';
import type { Provider, Scope } from '../../../shared/contracts/common.ts';
import { providerCoverage } from '../../../shared/domain/coverage.ts';
import { effectiveClass } from '../../../shared/domain/linking.ts';
import {
  addDays,
  dateInZone,
  isDateString,
  minDate,
  utcBounds,
} from '../../../shared/domain/periods.ts';
import { PROVIDER_NAMES, providersInScope } from '../../../shared/domain/scope.ts';
import {
  cleanReviewText,
  readWorkReviewTurns,
  type ReviewTranscript,
  type ReviewTranscriptFile,
} from '../../collectors/work-review/transcript.ts';
import type { Db } from '../../db/open.ts';
import { readLinkHealth } from '../../db/queries/link-health.ts';
import { getMeta } from '../../db/queries/meta.ts';
import { readPrLinkPairs } from '../../db/queries/metrics.ts';
import { listPullRequests, type PrCursor, type PrFilter } from '../../db/queries/prs.ts';
import { readRepoStates, readSourceStates } from '../../db/queries/usage.ts';
import { readWorkNoteStates } from '../../db/queries/work-review.ts';
import {
  readReviewSessionActivity,
  type ReviewDay,
} from '../../db/queries/work-review-activity.ts';

export { readWorkReviewTurns };

export interface WorkReviewPr {
  id: string;
  repo: string;
  number: number;
  title: string;
  date: string;
  mine: boolean;
  author: string | null;
}

export interface WorkReviewSessionDay {
  id: string;
  sessionId: number;
  date: string;
  provider: Provider;
  repo: string | null;
  title: string | null;
  group: string;
  linkedPrIds: string[];
  /** Changes with this day's local evidence. Used to reuse extracted notes across scopes. */
  fingerprint: string;
  cacheKey: string;
  sourceHash: string | null;
  /** Local source identity and bounds used only by explicit generation. */
  transcript: ReviewTranscript;
}

export interface WorkReviewEvidence {
  prs: WorkReviewPr[];
  sessionDays: WorkReviewSessionDay[];
  coverage: string[];
  fingerprint: string;
}

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readPrs(db: Db, filter: PrFilter, timezone: string, login: string | null): WorkReviewPr[] {
  const prs: WorkReviewPr[] = [];
  const pageSize = 500;
  let after: PrCursor | undefined;
  for (;;) {
    const page = listPullRequests(db, filter, { limit: pageSize, ...(after ? { after } : {}) });
    const batch = page.slice(0, pageSize);
    for (const row of batch) {
      prs.push({
        id: row.nodeId,
        repo: row.repoId,
        number: row.number,
        title: cleanReviewText(row.title) ?? `Pull request #${row.number}`,
        date: dateInZone(row.mergedAt, timezone),
        mine: login !== null && row.authorLogin?.toLowerCase() === login.toLowerCase(),
        author: cleanReviewText(row.authorLogin),
      });
    }
    const last = batch.at(-1);
    if (page.length <= pageSize || !last) return prs;
    after = { nodeId: last.nodeId, mergedAt: last.mergedAt };
  }
}

function coverageOf(db: Db, scope: Scope, span: ReviewSpan, login: string | null): string[] {
  const { today, end, repos } = span;
  if (scope.start > today) return ['The selected dates are in the future.'];

  const notes: string[] = [];
  if (scope.ignoredRepos?.length) notes.push('Some selected repositories are unavailable locally.');
  if (scope.author === 'mine' && login === null)
    notes.push('Connect GitHub to identify pull requests you authored.');
  const tracked = readRepoStates(db).filter(
    (repo) => repo.trackingState === 'active' && (repos.length === 0 || repos.includes(repo.id)),
  );
  const reachable = tracked.filter((repo) => repo.accessState !== 'inaccessible');
  if (reachable.length === 0) notes.push('GitHub coverage is unavailable for this selection.');
  else if (reachable.some((repo) => !repo.backfillComplete))
    notes.push('GitHub history is still syncing.');
  if (tracked.length > reachable.length)
    notes.push('Some tracked repositories are inaccessible to GitHub sync.');

  const sources = new Map(readSourceStates(db).map((row) => [row.sourceId, row]));
  for (const provider of providersInScope(scope.provider)) {
    const row = sources.get(provider);
    const stale = row?.extra['staleAfter'];
    const state = providerCoverage(
      { start: scope.start, end },
      {
        found: row?.oldestEventAt != null,
        oldestDate:
          row?.oldestEventAt == null ? null : dateInZone(row.oldestEventAt, scope.timezone),
        staleAfter:
          row?.lastAttemptResult !== 'failed'
            ? null
            : typeof stale === 'string' && isDateString(stale)
              ? stale
              : row.lastSuccessAt === null
                ? null
                : dateInZone(row.lastSuccessAt, scope.timezone),
      },
      today,
    );
    const name = PROVIDER_NAMES[provider];
    if (state === 'none' || state === 'unavailable')
      notes.push(`${name} session history is unavailable for these dates.`);
    else if (state === 'stale' || row?.lastAttemptResult === 'failed')
      notes.push(`${name} session history may be out of date.`);
    else if (state === 'partial' || row?.status === 'partial')
      notes.push(`${name} session history is incomplete for this selection.`);
  }
  return notes;
}

interface ReviewSpan {
  today: string;
  end: string;
  repos: readonly string[];
}

function readSessionDays(
  db: Db,
  scope: Scope,
  days: ReviewDay[],
  span: ReviewSpan,
  prs: WorkReviewPr[],
  linksFresh: boolean,
): WorkReviewSessionDay[] {
  const bySession = new Map<number, Set<string>>();
  for (const link of readPrLinkPairs(
    db,
    prs.map((pr) => pr.id),
  )) {
    const verified = effectiveClass(linksFresh ? link.computed : null, link.decision);
    if (verified !== 'evidence' && verified !== 'owner') continue;
    const linked = bySession.get(link.sessionId) ?? new Set();
    linked.add(link.prNodeId);
    bySession.set(link.sessionId, linked);
  }

  const bounds = new Map(days.map((day) => [day.date, day]));
  const units = new Map<
    string,
    {
      day: WorkReviewSessionDay;
      activity: { first: number; last: number; lastEventId: number; events: number; total: number };
      sourceTouchedOnDay: boolean;
    }
  >();
  for (const row of readReviewSessionActivity(
    db,
    days,
    providersInScope(scope.provider),
    span.repos,
  )) {
    const id = `${row.session_id}:${row.date}`;
    const { start, end } = bounds.get(row.date)!;
    let unit = units.get(id);
    if (!unit) {
      unit = {
        day: {
          id,
          sessionId: row.session_id,
          date: row.date,
          provider: row.provider,
          repo: row.repo_id,
          title: cleanReviewText(row.recorded_name),
          group: String(row.root_id ?? row.session_id),
          linkedPrIds: [...(bySession.get(row.session_id) ?? [])].sort(),
          fingerprint: '',
          cacheKey: JSON.stringify([scope.timezone, id]),
          sourceHash: null,
          transcript: {
            provider: row.provider,
            providerSessionId: row.provider_session_id,
            fromMs: Math.max(start, row.source_started === 1 ? row.started_at : start),
            toMs: end,
            files: [],
          },
        },
        activity: {
          first: row.first_at,
          last: row.last_at,
          lastEventId: row.last_event_id,
          events: 0,
          total: 0,
        },
        sourceTouchedOnDay: false,
      };
      units.set(id, unit);
    }
    const activity = unit.activity;
    activity.last = Math.max(activity.last, row.last_at);
    activity.lastEventId = Math.max(activity.lastEventId, row.last_event_id);
    activity.events += row.events;
    activity.total += row.total;
    unit.sourceTouchedOnDay ||=
      row.file_mtime !== null && row.file_mtime >= start && row.file_mtime < end;
    unit.day.transcript.files.push(
      row.file_path !== null &&
        row.file_size !== null &&
        row.file_size > 0 &&
        row.file_offset !== null &&
        row.file_offset > 0 &&
        row.file_head !== null &&
        (row.file_state === 'ok' || row.file_state === 'partial')
        ? {
            path: row.file_path,
            size: row.file_size,
            offset: row.file_offset,
            head: row.file_head,
            partial: row.file_state === 'partial',
          }
        : null,
    );
  }
  const notes = readWorkNoteStates(
    db,
    [...units.values()].map(({ day }) => day.cacheKey),
  );
  return [...units.values()].map(({ day, activity, sourceTouchedOnDay }) => {
    day.fingerprint = hash([
      day.id,
      day.provider,
      day.transcript.providerSessionId,
      day.transcript.fromMs,
      scope.timezone,
      day.title,
      activity,
    ]);
    const files = day.transcript.files.filter(
      (file): file is ReviewTranscriptFile => file !== null,
    );
    const size = day.transcript.files.length;
    const sourceHash = files.length
      ? hash([size, files.sort((a, b) => a.path.localeCompare(b.path))])
      : null;
    const saved = notes.get(day.cacheKey);
    const previouslyCaptured = saved?.hash === day.fingerprint ? saved : null;
    // A full historical note survives ordinary later appends and transcript expiry. While activity
    // is live, the imported prefix can change even when it contains no new usage record.
    const latest =
      sourceHash !== null &&
      (!previouslyCaptured ||
        previouslyCaptured.partial ||
        day.date === span.today ||
        sourceTouchedOnDay);
    day.sourceHash = latest ? sourceHash : (previouslyCaptured?.sourceHash ?? sourceHash);
    return day;
  });
}

/** Read stored facts only. This is also safe to use for cache-state polling. */
export function collectWorkReviewEvidence(db: Db, scope: Scope, nowMs: number): WorkReviewEvidence {
  const today = dateInZone(nowMs, scope.timezone);
  const end = minDate(scope.end, today);
  const repos = [...scope.repos].sort();
  const login = getMeta(db, 'github_login') || null;
  // Unknown repo preferences must never broaden the material sent for a review.
  const allReposIgnored = repos.length === 0 && Boolean(scope.ignoredRepos?.length);
  const days: ReviewDay[] = [];
  for (let date = scope.start; !allReposIgnored && date <= end; date = addDays(date, 1)) {
    const bounds = utcBounds(date, scope.timezone);
    days.push({ date, start: bounds.start, end: bounds.end });
  }
  const first = days[0];
  const last = days.at(-1);
  const prs =
    first && last
      ? readPrs(
          db,
          {
            fromMs: first.start,
            toMs: last.end,
            repos,
            author: scope.author === 'mine' ? { mode: 'mine', login } : { mode: 'all' },
          },
          scope.timezone,
          login,
        )
      : [];
  const span = { today, end, repos };
  const linksFresh = prs.length === 0 || readLinkHealth(db).state === 'fresh';
  const sessionDays = readSessionDays(db, scope, days, span, prs, linksFresh);
  const coverage = coverageOf(db, scope, span, login);
  if (!linksFresh)
    coverage.push(
      'Computed pull request associations are awaiting verification. Owner confirmations still apply.',
    );
  return {
    prs,
    sessionDays,
    coverage,
    fingerprint: hash({
      scope: [
        scope.start,
        scope.end,
        scope.timezone,
        scope.author,
        scope.provider,
        repos,
        scope.ignoredRepos,
      ],
      prs,
      coverage,
      days: sessionDays.map(({ fingerprint, sourceHash, group, repo, linkedPrIds }) => [
        fingerprint,
        sourceHash,
        group,
        repo,
        linkedPrIds,
      ]),
    }),
  };
}
