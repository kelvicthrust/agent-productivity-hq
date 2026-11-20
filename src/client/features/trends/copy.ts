import type { Period } from '../../lib/filters';

// The words only Trends uses, moved from the D7 prototype (docs/design/prototype/app.js pageTrends, yearCard, modelBreakdown)
// unchanged except where the move from inline records to the records drawer changes what a sentence points at. Words other
// screens share (coverage phrases, range notices) are in lib/copy.ts. Typographic apostrophes (’) are the product's.

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

export const TRENDS_COPY = {
  title: 'Trends',
  loading: 'Loading trends…',
  /** After the heading: "This week · Nov 2 – Nov 8, 2026 · by day". */
  subtitle: (period: string, range: string, gran: string) => `${period} · ${range} · by ${gran}`,

  /** A card whose answer could not be read: its own words and its own Try again. */
  failed: {
    title: 'Couldn’t load this',
    body: 'Your records are still on this machine. Try again.',
    retry: 'Try again',
  },

  year: {
    title: 'A year of merges',
    /** After the delivery scope: "All repos · Authored by you · last 12 months · selected period outlined". */
    scope: 'last 12 months · selected period outlined',
    loading: 'Loading the year of merges',
    /** Cells are pointer targets and open the day's records in the drawer. */
    dayHint: 'Click a day to see its records.',
    syncing: 'Merged PRs are still being collected, so a day may show fewer merges than it had.',
  },

  chart: {
    title: 'Merged PRs and recorded local tokens',
  },

  /** The selected period, which the URL keeps (`sel`) and the chart marks; its records open in the drawer. */
  selection: {
    selected: 'Selected period:',
    show: 'Show records',
    clear: 'Clear selection',
  },

  models: {
    title: 'Recorded tokens by model',
    /** After the usage scope. */
    scope: 'share within each provider; providers aren’t compared on one scale',
    loading: 'Loading tokens by model',
    none: 'No recorded sessions in scope.',
  },
} as const;
