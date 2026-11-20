import { COVERAGE_PHRASES, EMPTY_REPOS } from '../../lib/copy';

// The chart's words, moved from the D7 prototype (app.js chartBlock, readout, chartTable, legend; ui.js alignedChart) as they
// were. The coverage phrases that other screens also say ("History unavailable") come from lib/copy.

export const CHART_COPY = {
  /** The two panels' titles and units. Each panel has its own y-axis; the unit names it. */
  panels: {
    delivery: { title: 'Merged PRs', unit: 'count' },
    usage: { title: 'Recorded local tokens', unit: 'tokens, this machine' },
  },
  /** Read after the chart's name when it takes focus. */
  keyboardHelp:
    'Use the left and right arrow keys to move between periods; press Enter to see its records.',
  idleReadout: 'Hover a bucket, or focus the chart and use the arrow keys, to read its values.',
  hint: 'Click a bucket or press Enter to see its records. Merged PRs and tokens have separate axes and are never compared on one scale.',
  switchLabel: 'Chart display',
  views: { chart: 'Chart', table: 'Table' },
  /** The note drawn inside the delivery panel when no repo is tracked. */
  noTrackedRepositories: EMPTY_REPOS.heading,
  /** Said once across a run of buckets that have not happened yet. */
  upcomingCaption: 'Upcoming',
  defaultUnavailable: COVERAGE_PHRASES.historyUnavailable,
  legend: {
    label: 'Chart key',
    delivery: 'Merged PRs',
    tokens: (provider: string) => `${provider} tokens`,
    unavailable: COVERAGE_PHRASES.historyUnavailable,
    zero: 'Zero, covered',
    rail: 'Local coverage: complete, partial, none',
  },
  readout: {
    upcoming: 'Upcoming, no data yet',
    prs: 'Merged PRs',
    noTrackedRepos: 'no tracked repos',
    syncing: 'still syncing',
    prsSoFar: (prs: string) => `${prs} so far · still syncing`,
    notAvailable: 'not available',
    historyUnavailable: 'history unavailable',
    noLocalRecords: 'no local records',
    upcomingUsage: 'upcoming, no data yet',
    zero: '0 (no recorded activity)',
    tokens: (compactTokens: string) => `${compactTokens} tokens`,
    partial: 'partial coverage',
    stale: 'not collected since failed refresh',
  },
  table: {
    caption: 'as a table',
    scrollerLabel: 'Chart values as a table, scrolls sideways',
    period: 'Period',
    prs: 'Merged PRs',
    tokens: (provider: string) => `${provider} tokens`,
    coverage: 'Local coverage',
    upcoming: '—',
    noTrackedRepos: 'n/a',
    syncing: 'Syncing',
    prsSyncing: (prs: string) => `${prs} (syncing)`,
    unavailable: 'Unavailable',
    noRecords: 'No records',
    notAvailable: 'Not available',
    footnote:
      '* Partial: part of this period is before available history or not yet collected. Select a period to see its records.',
    coverageWords: {
      ok: 'Complete',
      partial: 'Partial',
      stale: 'Partial',
      unavailable: 'Unavailable',
      none: 'None',
      future: 'Upcoming',
    },
  },
  /** The two states the host can ask for in place of the picture (Overview's chart loading and error, design-to-code). */
  loading: 'Loading chart',
  error: {
    title: 'Couldn’t build this chart',
    body: 'The records are still available. Switch to Table to read the same values, or try again.',
    retry: 'Try again',
  },
} as const;
