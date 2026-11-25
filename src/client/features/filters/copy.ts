import type { AuthorFilter, Granularity, ProviderFilter } from '../../../shared/contracts/common';
import { PERIOD_LABEL } from '../../lib/copy';
import type { PeriodPreset } from '../../lib/filters';

// The words only the filter bar uses. They are the D7 prototype's (docs/design/prototype/app.js), kept in one place so
// a wording change is one edit. Strings shared with other screens belong in the shared copy module, not here.

/** Group labels and the scope each one states. Period and Group by apply to everything, so they state none. */
export const GROUPS = {
  period: { label: 'Period' },
  groupBy: { label: 'Group by' },
  repos: { label: 'Repos', scope: 'usage & delivery' },
  provider: { label: 'Provider', scope: 'usage only' },
  author: { label: 'Author', scope: 'delivery only' },
} as const;

/** The three presets that have a segment of their own; the rest live under Custom. */
export const SEGMENT_PRESETS: readonly PeriodPreset[] = ['today', 'this-week', 'this-month'];

export const QUICK_RANGES: ReadonlyArray<{ preset: PeriodPreset; label: string }> = [
  { preset: 'last-week', label: PERIOD_LABEL['last-week'] },
  { preset: 'last-month', label: PERIOD_LABEL['last-month'] },
  { preset: 'last-30', label: PERIOD_LABEL['last-30'] },
  { preset: 'last-90', label: PERIOD_LABEL['last-90'] },
  { preset: 'last-12m', label: PERIOD_LABEL['last-12m'] },
];

/** Segment value and label pairs, in display order. */
export const GRAN_OPTIONS: ReadonlyArray<readonly [Granularity, string]> = [
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
];

export const PROVIDER_OPTIONS: ReadonlyArray<readonly [ProviderFilter, string]> = [
  ['all', 'All'],
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
];
/** The provider as the phone summary names it. */
export const PROVIDER_SUMMARY = {
  all: 'All providers',
  codex: 'Codex',
  claude: 'Claude Code',
} as const;

export const AUTHOR_OPTIONS: ReadonlyArray<readonly [AuthorFilter, string]> = [
  ['mine', 'Mine'],
  ['all', 'All in tracked repos'],
];
/** The author as the phone summary names it. */
export const AUTHOR_SUMMARY = { mine: 'My PRs', all: 'All tracked PRs' } as const;

export const COPY = {
  filters: 'Filters',
  closeFilters: 'Close filters',
  reset: 'Reset',
  showResults: 'Show results',
  custom: 'Custom',
  customDialog: 'Custom range',
  quickRanges: 'Quick ranges',
  customDates: 'Custom dates',
  from: 'From',
  to: 'To',
  cancel: 'Cancel',
  apply: 'Apply',
  repoDialog: 'Repository filter',
  repoList: 'Tracked repositories',
  allRepos: 'All repos',
  done: 'Done',
  noRepos: 'No tracked repositories yet.',
  loadingRepos: 'Loading repositories…',
  reposFailed: 'The repository list could not be loaded.',
  retry: 'Try again',
  inaccessible: '(inaccessible)',
  notTracked: '(not tracked)',
  repoHint:
    'Applies to local usage and merged PRs. While a repo is selected, sessions with an unknown or untracked repo are excluded. Account-reported usage is not filtered by repo.',
} as const;

export const timezoneLine = (timezone: string): string => `Times in ${timezone} (this machine)`;

export const lookbackHint = (earliest: string): string =>
  `Up to 12 months back, from ${earliest}. Earlier data isn’t retained.`;

export const rangeProblem = {
  missing: 'Choose both dates.',
  order: 'The start date must be on or before the end date.',
  outside: (earliest: string): string => `Choose dates between ${earliest} and today.`,
} as const;
