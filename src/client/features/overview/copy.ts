import type { Period } from '../../lib/filters';
import { int } from '../../lib/format';

// The words only the Overview uses, moved from the D7 prototype (docs/design/prototype/app.js pageOverview, kpis, acctCard,
// repoTable, recentList) unchanged except where a label carries a number (those go through `int`/`plural`, so they agree
// with it) and where the fixture's fixed wording is replaced by what the API says. Words other screens share (coverage
// phrases, range notices, the empty-repos state, status tags) are in lib/copy.ts. Typographic apostrophes (’) are the product's.

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

export const OVERVIEW_COPY = {
  /** The page's name. The visible heading is the greeting, so this is what a screen reader hears first. */
  title: 'Overview',
  /** After the greeting; `period` is lower-cased and `range` is "Nov 2 – Nov 8, 2026". */
  subtitle: (period: string, range: string) =>
    `Here’s what merged and where your agents spent their tokens · ${period.toLowerCase()}, ${range}`,
  loading: 'Loading overview…',

  /** The whole payload could not be read; the chart has its own panel for its own request. */
  failed: {
    title: 'Couldn’t load the overview',
    body: 'Your records are still on this machine. Try again, or check Sources & repos.',
    retry: 'Try again',
  },

  quiet: {
    heading: 'A quiet one.',
    body: 'No recorded agent activity and no merges in this period. Every source was collecting, so this is a true zero, not missing data.',
  },

  kpis: {
    region: 'Summary metrics',
    loading: 'Loading summary metrics',
    mergedPrs: {
      label: 'Merged PRs',
      addRepos: 'Add repositories',
      /** "Last week: 7". `label` is the API's ("Yesterday", "Last week", "Previous 30 days"). */
      previous: (label: string, value: number) => `${label}: ${int(value)}`,
      outsideLookback: (label: string) => `${label}: outside the 12-month lookback`,
      /** The count is real so far; a 0 is not yet a zero while the first backfill runs. */
      syncing: 'So far · still syncing',
    },
    linkedPrs: {
      label: 'Linked PRs',
      scope: 'Evidence or owner-confirmed',
      of: (total: number) => `of ${int(total)}`,
      suggestions: (n: number) => `${int(n)} with suggestions only`,
    },
    tokens: {
      label: 'Recorded local tokens',
      meta: 'Provider totals aren’t combined.',
    },
    rootSessions: {
      label: 'Root sessions',
      scope: 'Active in period',
      unknown: (n: number) => `${int(n)} with unknown relationship`,
    },
    childAgents: {
      label: 'Child agents',
      scope: 'Known parent, active in period',
      split: (paseo: number, native: number) => `Paseo ${int(paseo)} · native ${int(native)}`,
    },
    /** Buddies are drawn up to here, as a small cluster; the rest are counted ("+12"). */
    crewMax: 3,
  },

  accounts: {
    title: 'Account-reported usage',
    tag: 'Not filtered by repo',
    action: {
      chatgpt: {
        connect: 'Connect ChatGPT in Sources',
        reconnect: 'Reconnect ChatGPT in Sources',
      },
      claude: 'Check Claude plan limits in Sources',
    },
  },

  chart: {
    title: 'Delivery and usage over time',
  },

  repos: {
    title: 'By repository',
    caption: 'Merged PRs and recorded local tokens by repository',
    listLabel: 'Merged PRs and recorded local tokens by repository, one card each',
    scrollerLabel: 'Repository table, scrolls sideways',
    columns: {
      repo: 'Repository',
      merged: 'Merged PRs',
      linked: 'Linked',
      tokens: (provider: string) => `${provider} tokens`,
      roots: 'Root sessions',
    },
    untracked: 'Untracked repos',
    unknown: 'Unknown repo',
    usageOnly: '(usage only)',
    notApplicable: 'n/a',
    notCollected: '—',
    noRecords: 'No records',
    unavailable: 'Unavailable',
    fix: 'Fix',
    inaccessible: 'Inaccessible',
    empty: 'No recorded activity in this period.',
    noRepos:
      'No tracked repositories yet, so merged PRs aren’t available. Recorded usage is grouped by the repo each session recorded.',
  },

  recent: {
    title: 'Recently merged',
    /** Nothing merged in the period; `authoredByYou` says who the PRs would have been by. */
    none: (authoredByYou: boolean) =>
      `No merged PRs in this period${authoredByYou ? ' authored by you' : ''}. Agent work that didn’t merge still appears in Usage.`,
    syncing: 'Merged PRs are still being collected, so none are listed yet.',
    merged: (n: number) => `${int(n)} merged in this period`,
    viewAll: 'View all in Delivery',
    by: (author: string) => `by ${author}`,
  },
} as const;
