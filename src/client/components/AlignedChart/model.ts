import type { DeliveryCoverage, Provider, UsageCoverage } from '../../../shared/contracts/common';
import type { Bucket } from '../../../shared/contracts/series';
import { railCoverage } from '../../../shared/domain/coverage';

// What a series bucket means for the chart, read once so the drawing, the readout and the table cannot disagree. The rules are
// the prototype's (app.js `readout`, `cellTok`, `usageCov`, `delivCov`) applied to the API's Bucket:
//   - a number is drawn and a null never is: a provider without coverage has no bar and no zero tick, only hatching;
//   - `future` is quiet: nothing is drawn and the words say "Upcoming", never zero;
//   - the providers are never added up for display. Each is a segment of its own, in its own colour and pattern.

export const PROVIDERS: readonly Provider[] = ['codex', 'claude'];

/**
 * The providers a series carries. The API leaves a provider out of `tokens` and `usage` when the provider filter excludes it, so
 * a provider is in the chart when any bucket mentions it. A series that mentions neither (an empty one) is drawn for both, so
 * the usage panel is never left without a provider to name.
 */
export function providersIn(buckets: readonly Bucket[]): Provider[] {
  const present = PROVIDERS.filter((provider) =>
    buckets.some(
      (bucket) => bucket.tokens[provider] !== undefined || bucket.usage[provider] !== undefined,
    ),
  );
  return present.length > 0 ? present : [...PROVIDERS];
}

/**
 * One provider's coverage in a bucket. A provider the API gave no coverage for is read from its token count: a number means it
 * was collected, no number means there was nothing to collect from.
 */
export function providerUsage(bucket: Bucket, provider: Provider): UsageCoverage {
  const stated = bucket.usage[provider];
  if (stated !== undefined) return stated;
  return typeof bucket.tokens[provider] === 'number' ? 'ok' : 'none';
}

/** The provider's token count when there is one. A null (or a missing count) is "no number", never 0. */
export function providerTokens(bucket: Bucket, provider: Provider): number | null {
  const tokens = bucket.tokens[provider];
  return typeof tokens === 'number' ? tokens : null;
}

/** The one coverage value for a bucket's rail: the API's, or the same rule applied to the providers in the chart. */
export function railOf(bucket: Bucket, providers: readonly Provider[]): UsageCoverage {
  return (
    bucket.usage.rail ?? railCoverage(providers.map((provider) => providerUsage(bucket, provider)))
  );
}

/** "No local coverage at all": hatched in the usage panel and drawn as an empty outline on the rail. */
export const isUncovered = (coverage: UsageCoverage): boolean =>
  coverage === 'unavailable' || coverage === 'none';

/** A bucket that starts after today: the chart draws nothing for it and the words say it has not happened yet. */
export const isUpcoming = (bucket: Bucket): boolean => bucket.delivery === 'future';

/** What the delivery panel can say about a bucket. */
export type DeliveryState =
  /** Tracked repos are synced: `prs` is a real count, and 0 is a real zero. */
  | { kind: 'ok'; prs: number }
  /** The first backfill is still running: a count is real so far, but a 0 is not yet a zero. */
  | { kind: 'syncing'; prs: number | null }
  | { kind: 'none' }
  | { kind: 'future' }
  /** The API said the repos were synced but gave no count. Nothing is drawn and no zero is invented. */
  | { kind: 'unknown' };

export function deliveryOf(bucket: Bucket): DeliveryState {
  const coverage: DeliveryCoverage = bucket.delivery;
  if (coverage === 'future') return { kind: 'future' };
  if (coverage === 'none') return { kind: 'none' };
  if (coverage === 'syncing') return { kind: 'syncing', prs: bucket.prs };
  return bucket.prs === null ? { kind: 'unknown' } : { kind: 'ok', prs: bucket.prs };
}

/**
 * No repo is tracked: some bucket says `none` for delivery and none says it has (or is collecting) merged PRs. The chart then
 * says so inside the delivery panel instead of leaving a silent empty one. Upcoming buckets are not evidence either way.
 */
export function noTrackedRepos(buckets: readonly Bucket[]): boolean {
  const states = buckets.map(deliveryOf);
  return (
    states.some((state) => state.kind === 'none') &&
    !states.some((state) => state.kind === 'ok' || state.kind === 'syncing')
  );
}
