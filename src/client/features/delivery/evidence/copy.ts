import type { LinkAction } from '../../../lib/links';

// The words of an opened PR's evidence panel, moved from the D7 prototype (docs/design/prototype/app.js `evItem`, `addLinkForm`,
// `prDetail` and `linkAction`) unchanged, with these differences:
//   - the buttons keep the design's labels ("Confirm link", "Remove link"); their accessible names add the session, so that
//     several of the same button on one PR can be told apart (the visible words stay at the start of the name, WCAG 2.5.3)
//   - Restore has an Undo, which the prototype's does not: the transition table says every change can be undone (TECH › Owner link
//     decision transitions), and a Restore is one of them
//   - an Undo says it was done ("Change undone."), because the prototype's silent undo tells a screen reader nothing happened
// The failure sentence is `LINK_SAVE_FAILED` in lib/links.ts. Typographic apostrophes (’) are the product's.

export const EVIDENCE_COPY = {
  heading: 'Link evidence',
  loading: 'Loading link evidence…',
  loadFailed: 'Couldn’t load link evidence.',
  retry: 'Retry',
  basis: 'Basis:',
  /** The session's tokens stay where they were used; this is only how much the session recorded. */
  tokens: (compact: string) => `Session tokens: ${compact}`,
  footnote:
    'A linked session is recorded evidence of involvement, not proof it produced the PR alone. Token counts belong to each session and stay on the dates they were used.',

  empty: {
    /** Someone else's PR: nothing on this machine is expected to link. */
    byOther: (author: string) => `Authored by ${author}. No sessions from this machine are linked.`,
    /** Yours, with nothing found. */
    none: (canLink: boolean) =>
      `No session evidence found for this PR. ${
        canLink
          ? 'You can link a session yourself.'
          : 'No local sessions were recorded in this repo in the 3 days before the merge.'
      }`,
  },

  /** The visible label of each action. */
  actions: {
    confirm: 'Confirm link',
    dismiss: 'Dismiss',
    reject: 'Mark incorrect',
    restore: 'Restore',
    remove: 'Remove link',
    add: 'Add link',
  } satisfies Record<LinkAction, string>,

  linkSession: {
    open: 'Link a session',
    /** The select's label. */
    label: (repo: string) => `Session in ${repo}, up to 3 days before the merge`,
    cancel: 'Cancel',
    close: 'Close',
    hint: 'Your link is labeled Owner-confirmed and can be removed later. It doesn’t change what the source recorded.',
    noCandidates: (repo: string) =>
      `No other local sessions in ${repo} in the 3 days before this merge.`,
  },

  undo: 'Undo',
  /** After an Undo went through. */
  undone: 'Change undone.',
  /** What each success says; every one carries an Undo. */
  toast: {
    confirm: 'Link confirmed and labeled Owner-confirmed.',
    dismiss: 'Suggestion dismissed.',
    remove: 'Your link was removed.',
    reject: 'Marked incorrect. The source’s claim is kept but not counted.',
    restore: 'Evidence link restored.',
    add: 'Session linked and labeled Owner-confirmed.',
  } satisfies Record<LinkAction, string>,
} as const;
