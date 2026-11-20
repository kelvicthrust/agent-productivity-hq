import type { Period } from '../../lib/filters';
import { plural } from '../../lib/format';

// The words only the Usage screen uses, moved from the D7 prototype (docs/design/prototype/app.js pageUsage, catCard,
// usageTree) unchanged except where a label carries a number: those go through `count`/`plural` in the caller, so they
// agree with it. Words other screens share (ledger rows, link labels, coverage phrases, range notices) are in lib/copy.ts.
// Typographic apostrophes (’) are the product's.

/** The period named in the page head. The same words as the filter bar's, which a feature may not import. */
export const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today',
  'this-week': 'This week',
  'this-month': 'This month',
  'last-30': 'Last 30 days',
  'last-90': 'Last 90 days',
  'last-12m': 'Last 12 months',
  custom: 'Custom range',
};

export const USAGE_COPY = {
  title: 'Usage',
  loading: 'Loading usage…',
  loadFailed: 'Couldn’t load usage. Reload the page to try again.',
  retry: 'Retry',

  ledgers: {
    /** After the provider total rule when the history starts partway through the period. */
    coversOnward: (date: string) => `Covers ${date} onward only.`,
    /** A stale source still has figures: they are what was imported before the refresh failed. */
    cached: 'Cached; recent days missing.',
  },

  noRecords: {
    heading: 'No session detail on this machine',
    body: 'No supported Codex, Claude Code or Paseo records were found here. Account-reported totals appear on Overview, but they can’t be broken down by repo, session, agent or PR.',
    accounts: 'View account-reported usage',
    sources: 'Check sources',
  },

  tree: {
    title: 'Sessions by repository',
    /** After the scope line. */
    scope:
      'Repo → root session → child agents, where relationships are recorded. Paseo adds agent and workspace identity to provider sessions; it isn’t counted as extra usage.',
    caption:
      'Sessions grouped by repository, root session and child agents. Each row leads with the recorded agent name, or its relationship when no name was recorded, with the technical ID below. Linked PRs name their evidence level: Evidence link, Owner-confirmed, Suggested or Unlinked.',
    /** The name of the phone list, which has no caption. */
    listLabel: 'Sessions grouped by repository, root session and child agents',
    /** The table scrolls sideways by itself when its columns do not fit; the region is how a keyboard reaches it. */
    scrollerLabel: 'Usage by repository, scrolls sideways',
    columns: {
      session: 'Session',
      provider: 'Provider',
      model: 'Model',
      started: 'Started',
      tokens: 'Tokens',
      linkedPrs: 'Linked PRs',
    },
    empty: 'No sessions in scope.',
    loadingSessions: 'Loading sessions…',
    sessionsFailed: 'Couldn’t load these sessions.',
    parentOutside: 'parent outside current filters',
    unknownHeading: (count: number) => `Unknown relationship (${count})`,
    unknownNote: 'Parent not recorded, so these aren’t counted as roots or children',
    showMore: (n: number) => `Show ${n} more ${plural(n, 'root')}`,
    notShown: (n: number) => `${n} not shown`,
    expand: (label: string) => `Expand ${label}`,
    collapse: (label: string) => `Collapse ${label}`,
    showChildren: (n: number, label: string) => `Show ${n} child ${plural(n, 'agent')} of ${label}`,
    hideChildren: (n: number, label: string) => `Hide ${n} child ${plural(n, 'agent')} of ${label}`,
    showUnknown: 'Show sessions with unknown relationship',
    hideUnknown: 'Hide sessions with unknown relationship',
    tokens: 'Tokens',
    linkedPrs: 'Linked PRs',
  },
} as const;
