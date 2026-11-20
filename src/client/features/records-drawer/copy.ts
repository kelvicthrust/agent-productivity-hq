import type { UsageCoverage } from '../../../shared/contracts/common';
import { COVERAGE_PHRASES, PROVIDER_NAMES } from '../../lib/copy';
import { count, int } from '../../lib/format';

// What the records drawer says. The words come from the D7 prototype (docs/design/prototype/app.js `drawer`, `prListBlock` and
// `sessListBlock`), with one change: where a source has nothing to show, the sentence is the shared coverage phrase
// (lib/copy COVERAGE_PHRASES, PERIOD_NOT_HAPPENED), so Overview, Trends, Usage and this list can never describe the same gap in
// different words.

export const DRAWER_COPY = {
  close: 'Close',
  /** The line under the heading. `prs` and `sessions` are the two scope labels. */
  scope: (prs: string, sessions: string) =>
    `Records in this period · PRs: ${prs} · Sessions: ${sessions}`,
  tabs: { label: 'Record type', prs: 'Merged PRs', sessions: 'Sessions' },
  /** A tab's name and its count; "—" when nobody measured the count (never a 0 that was not measured). */
  tab: (name: string, total: number | null) => `${name} ${total === null ? '—' : int(total)}`,
  loading: 'Loading records…',
  loadFailed: 'Couldn’t load these records.',
  retry: 'Try again',
  openInUsage: 'Open in Usage',
  openInDelivery: 'Open in Delivery',
  showMore: 'Show more',
  prs: {
    listLabel: 'Merged pull requests',
    none: (authoredByYou: boolean) =>
      `No merged PRs in this period${authoredByYou ? ' authored by you' : ''}. GitHub history for tracked repos covers these dates, so this is a true zero.`,
    syncing: 'Merged PRs are still being collected, so this list may be incomplete.',
    syncingNone: 'Merged PRs are still being collected, so none are listed yet.',
    /** `shown` of `total`, once the list is as long as the drawer will make it. */
    capped: (shown: number, total: number) =>
      `Showing the newest ${int(shown)} of ${int(total)} merged PRs. Open in Delivery for all.`,
    by: (author: string) => `by ${author}`,
  },
  sessions: {
    listLabel: 'Sessions',
    none: 'No recorded sessions in this period. Covered sources had no activity, so this is a true zero.',
    capped: (shown: number, total: number) =>
      `Showing the ${int(shown)} largest of ${int(total)} sessions. Open in Usage for all.`,
    /** A session's token count, read after the number so a screen reader hears what it counts. */
    tokens: 'tokens',
  },
  /** How far a list has got while more can still be asked for. */
  progress: (shown: number, total: number) => `Showing ${int(shown)} of ${int(total)}`,
  /** Said to a screen reader when the list lands, since the heading it hears first was spoken before the numbers existed. */
  announce: (prs: number | null, sessions: number | null) =>
    [
      prs === null ? null : count(prs, 'merged PR'),
      sessions === null ? null : count(sessions, 'session'),
    ]
      .filter((part): part is string => part !== null)
      .join(' and '),
} as const;

/**
 * What a provider's coverage of the bucket says about its sessions, or null when nothing needs saying ("ok", and "future",
 * which the period line covers once for both providers). `warn` is a gap that limits what is shown, `info` is plain context.
 */
export function coverageNote(
  provider: keyof typeof PROVIDER_NAMES,
  coverage: UsageCoverage | undefined,
): { tone: 'info' | 'warn'; text: string } | null {
  const name = PROVIDER_NAMES[provider];
  switch (coverage) {
    case 'unavailable':
      return { tone: 'info', text: `${name}: ${COVERAGE_PHRASES.historyUnavailableForPeriod}` };
    case 'none':
      return { tone: 'info', text: `${name}: ${COVERAGE_PHRASES.noLocalRecordsOnMachine}` };
    case 'partial':
      return { tone: 'info', text: `${name}: only part of this period is covered.` };
    case 'stale':
      return { tone: 'warn', text: `${name}: not collected after the failed refresh.` };
    default:
      return null;
  }
}

/** Whether a provider's coverage means its sessions were measured here (a count of 0 is then a real zero). */
export const isMeasured = (coverage: UsageCoverage | undefined): boolean =>
  coverage === 'ok' || coverage === 'partial' || coverage === 'stale';
