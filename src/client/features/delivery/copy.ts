import { int } from '../../lib/format';

// The words only the Delivery screen uses, moved from the D7 prototype (docs/design/prototype/app.js pageDelivery) unchanged
// except where a label carries a number: those go through `plural`, so they agree with it. The words of the PR table itself
// (column headings, the toggle names) live with the table in src/client/components/DeliveryTable.tsx, which is drawn by this
// screen only but may not import it. Words other screens share (the empty-repos state, link labels) are in lib/copy.ts.
// Typographic apostrophes (’) are the product's.

export const DELIVERY_COPY = {
  title: 'Delivery',
  loading: 'Loading pull requests…',
  loadFailed: 'Couldn’t load pull requests.',
  retry: 'Retry',

  list: {
    title: 'Merged pull requests',
    /** After the scope line. */
    scope: 'counted on merge date · each PR counts once, however many sessions link to it',
  },

  linkFilter: {
    label: 'Filter by link basis',
    all: 'All',
    evidence: 'Evidence',
    owner: 'Owner-confirmed',
    suggested: 'Suggested only',
    unlinked: 'Unlinked',
  },

  search: {
    label: 'Search pull requests',
    placeholder: 'Search title, repo or #',
  },

  /** Nothing in the period at all; says who the PRs would have been by when the author filter is on. */
  none: (authoredByYou: boolean) =>
    `No merged PRs in this period${authoredByYou ? ' authored by you' : ''}.`,
  /** PRs exist, but not for this tab or search. */
  noMatch: 'No PRs match these filters.',

  showMore: (next: number | null) => (next === null ? 'Show more' : `Show ${int(next)} more`),
  notShown: (n: number) => `${int(n)} not shown`,

  inaccessible: {
    /** "kelvin/archive-private is inaccessible. Its PRs are excluded until access is restored." */
    text: (repos: readonly string[]) =>
      `${repos.join(', ')} ${repos.length === 1 ? 'is' : 'are'} inaccessible. ${repos.length === 1 ? 'Its' : 'Their'} PRs are excluded until access is restored.`,
    fix: 'Fix in Sources & repos',
  },
} as const;
