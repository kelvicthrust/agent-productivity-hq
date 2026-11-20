import type { z } from 'zod';
import {
  SourceStatus,
  type RefreshRun,
  type SourcesResponse,
} from '../../shared/contracts/sources.ts';
import { coveredFrom } from '../../shared/domain/coverage.ts';
import { dateInZone, isDateString, todayIn } from '../../shared/domain/periods.ts';
import { PROVIDER_NAMES } from '../../shared/domain/scope.ts';
import type { Db } from '../db/open.ts';
import { readPaseoCounts, type PaseoCounts } from '../db/queries/paseo.ts';
import { hasRetainedPullRequests } from '../db/queries/prs.ts';
import {
  getRun,
  getRunningRun,
  listSourceStates,
  type RunRow,
  type SourceStateRow,
} from '../db/queries/sources.ts';
import { readSessionCounts } from '../db/queries/usage.ts';

// What Sources & repos and the failed-refresh banner read (GET /api/sources), and how a stored run is shown to the client
// (GET /api/refresh/{id}). Everything is computed per request from stored rows: the runner is the only writer.

type Sources = z.infer<typeof SourcesResponse>;
type Status = SourceStatus['status'];

const NAMES = { ...PROVIDER_NAMES, paseo: 'Paseo', github: 'GitHub' } as const;
/** The sources this response describes, in the order Sources lists them: the local ones, then the GitHub sync (M6). */
const LOCAL = ['codex', 'claude', 'paseo', 'github'] as const;
type LocalId = (typeof LOCAL)[number];

const STATUSES: readonly string[] = SourceStatus.shape.status.options;

const iso = (ms: number): string => new Date(ms).toISOString();
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** A status the contract knows, else the one the last attempt implies: a stored value outside the list must not break the page. */
function statusOf(row: SourceStateRow): Status {
  if (STATUSES.includes(row.status)) return row.status as Status;
  if (row.lastAttemptResult === 'failed') return 'failed';
  return row.lastAttemptResult === 'partial' ? 'partial' : 'ok';
}

/**
 * Sessions with recorded usage, per provider (the same count the Usage groups add up to: they partition sessions, so each session is
 * counted once). Paseo adds identity to sessions and has none of its own, so it gets no count.
 */
function sessionCounts(db: Db): Partial<Record<LocalId, number>> {
  return readSessionCounts(db);
}

/**
 * What Sources says about Claude Code's history (TECH › Failure modes: transcripts older than 30 days). Claude Code deletes
 * transcripts after `cleanupPeriodDays`, 30 unless the owner changed it, so a first import sees at most that much; the dashboard
 * never changes that setting. It is about the source, not about one attempt, so it is shown whatever the source's status.
 * An adapter may still replace it through `extra.retentionNote`.
 */
export const CLAUDE_RETENTION_NOTE =
  'Claude Code keeps transcripts for 30 days unless you change cleanupPeriodDays.';

/**
 * What Sources says about Paseo's agents (data-and-sources › Paseo enrichment): coverage starts at the first snapshot, and an agent
 * that matches no session is shown here and nowhere else (it adds no usage). Null until an agent has been seen.
 */
function paseoDiagnostics(paseo: PaseoCounts, timezone: string): string | null {
  if (paseo.agents === 0 || paseo.firstSeenAt === null) return null;
  const since = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(paseo.firstSeenAt);
  const agents = `${paseo.agents} ${paseo.agents === 1 ? 'agent' : 'agents'}`;
  const parts = [
    `Paseo agent metadata from ${since}.`,
    `${agents} seen: ${paseo.mapped} matched to a session, ${paseo.unmapped} not matched (they add no usage).`,
  ];
  if (paseo.parentUnmapped > 0) {
    const who = paseo.parentUnmapped === 1 ? 'One session' : `${paseo.parentUnmapped} sessions`;
    parts.push(
      `${who}’s parent agent isn’t one of your sessions, so its relationship shows as Unknown.`,
    );
  }
  return parts.join(' ');
}

function toSource(
  row: SourceStateRow,
  id: LocalId,
  context: {
    timezone: string;
    today: string;
    sessions: number | undefined;
    hasRetainedData: boolean;
    diagnostics: string | null;
  },
): SourceStatus {
  const status = statusOf(row);
  const failed = row.lastAttemptResult === 'failed';
  // "The last date fully collected before a failed refresh": what the adapter recorded, else the day of the last success.
  // Only while the latest attempt is a failure; after a success there is nothing stale (and a stored value would be old).
  const recorded = typeof row.extra['staleAfter'] === 'string' ? row.extra['staleAfter'] : null;
  const staleAfter = !failed
    ? null
    : recorded && isDateString(recorded)
      ? recorded
      : row.lastSuccessAt === null
        ? null
        : dateInZone(row.lastSuccessAt, context.timezone);
  return {
    id,
    name: NAMES[id],
    status,
    location: row.location,
    // "History from": never earlier than what retention keeps, as in coverage (the first import records its date before pruning).
    oldestDate:
      row.oldestEventAt === null
        ? null
        : coveredFrom(dateInZone(row.oldestEventAt, context.timezone), context.today),
    sessions: context.sessions ?? null,
    hasRetainedData: context.hasRetainedData,
    unreadable: row.unreadableCount,
    unsupported: row.unsupportedCount,
    lastSuccessAt: row.lastSuccessAt === null ? null : iso(row.lastSuccessAt),
    lastAttemptAt: row.lastAttemptAt === null ? null : iso(row.lastAttemptAt),
    lastAttemptResult: row.lastAttemptResult,
    consecutiveFailures: row.consecutiveFailures,
    staleAfter,
    message:
      id === 'paseo' && (status === 'notrunning' || status === 'needspassword')
        ? context.diagnostics
        : (text(row.errorDetail) ?? text(row.extra['note']) ?? context.diagnostics),
    retentionNote:
      text(row.extra['retentionNote']) ?? (id === 'claude' ? CLAUDE_RETENTION_NOTE : null),
  };
}

/**
 * The local sources and the run in progress. A source nothing has checked yet has no stored row and is left out, so the
 * page never claims a state nobody observed. `accounts` are not part of this answer yet: they arrive with the accounts routes.
 */
export function buildSources(db: Db, options: { timezone: string; now?: () => number }): Sources {
  const rows = new Map(listSourceStates(db).map((row) => [row.sourceId, row]));
  const sessions = sessionCounts(db);
  const paseo = rows.has('paseo') ? readPaseoCounts(db) : null;
  const retained: Record<LocalId, boolean> = {
    codex: (sessions.codex ?? 0) > 0,
    claude: (sessions.claude ?? 0) > 0,
    paseo: paseo !== null && paseo.agents > 0,
    github: rows.has('github') && hasRetainedPullRequests(db),
  };
  const today = todayIn((options.now ?? Date.now)(), options.timezone);
  const sources: SourceStatus[] = [];
  for (const id of LOCAL) {
    const row = rows.get(id);
    if (row)
      sources.push(
        toSource(row, id, {
          timezone: options.timezone,
          today,
          sessions: sessions[id],
          hasRetainedData: retained[id],
          diagnostics: id === 'paseo' && paseo ? paseoDiagnostics(paseo, options.timezone) : null,
        }),
      );
  }
  return { sources, running: getRunningRun(db)?.id ?? null };
}

/** A stored run as the API shows it. */
export function toRefreshRun(run: RunRow): RefreshRun {
  return {
    id: run.id,
    state: run.state,
    startedAt: iso(run.startedAt),
    finishedAt: run.finishedAt === null ? null : iso(run.finishedAt),
    linkRebuild: run.linkRebuild,
    sources: run.sources,
  };
}

/** One run by id, or null when there is none with that number. */
export function getRefreshRun(db: Db, id: number): RefreshRun | null {
  const run = getRun(db, id);
  return run ? toRefreshRun(run) : null;
}
