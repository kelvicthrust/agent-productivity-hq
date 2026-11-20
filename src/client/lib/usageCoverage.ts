import type { OverviewResponse } from '../../shared/contracts/overview';
import type { Repo } from '../../shared/contracts/repos';
import type { SourceStatus } from '../../shared/contracts/sources';
import { sourceRefreshFailed } from './sourceStatus';

// What the coverage strip on Usage says, built from state the client already reads: GET /api/sources (each local source's
// status, from the database) and GET /api/repos (the tracked repos). Overview (M7) will take the same shape from the
// server's `coverage` block, so this builds exactly the `OverviewResponse['coverage']` that `describeCoverage` takes.
// Accounts are not served until M9, so that group is left out and the strip does not draw it.

type Coverage = OverviewResponse['coverage'];

const at = (instant: string): number => Date.parse(instant);

/** The earliest of these instants, as it was given; null when there are none. */
function earliest(instants: readonly string[]): string | null {
  return instants.length === 0
    ? null
    : instants.reduce((first, next) => (at(next) < at(first) ? next : first));
}

/** The latest of these instants, as it was given; null when there are none. */
function latest(instants: readonly string[]): string | null {
  return instants.length === 0
    ? null
    : instants.reduce((last, next) => (at(next) > at(last) ? next : last));
}

const successOf = (source: SourceStatus): string[] =>
  source.lastSuccessAt ? [source.lastSuccessAt] : [];

/** Use a timestamp from a recorded success, never an attempt timestamp. */
export function lastSourceSuccess(sources: readonly SourceStatus[]): string | null {
  const failing = sources.filter(sourceRefreshFailed);
  return earliest(failing.flatMap(successOf)) ?? latest(sources.flatMap(successOf));
}

export function latestSourceAttempt(sources: readonly SourceStatus[]): string | null {
  return latest(
    sources.flatMap((source) =>
      source.lastAttemptAt && source.lastAttemptResult ? [source.lastAttemptAt] : [],
    ),
  );
}

/**
 * `sources` are the local sources a refresh has checked (a source nobody has checked is not in the list, so it is not drawn
 * and never reads as OK). `repos` are the tracked repos, inaccessible ones included.
 *
 * The refresh line follows the design: while any source's latest attempt failed it says when the failing source(s) last
 * worked ("Last successful refresh Nov 3, 6:12 PM"); otherwise it says when anything last succeeded ("Refreshed today,
 * 9:42 AM"). A failing source that never succeeded falls back to the newest success of the others.
 */
export function usageCoverage(sources: readonly SourceStatus[], repos: readonly Repo[]): Coverage {
  return {
    sources: [...sources],
    github: {
      tracked: repos.length,
      inaccessible: repos.filter((repo) => repo.accessState === 'inaccessible').length,
    },
    lastRefreshAt: lastSourceSuccess(sources),
    refreshFailed: sources.some(sourceRefreshFailed),
  };
}
