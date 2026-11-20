import { int } from '../../../lib/format';

// Words only the repository manager uses. What the design already wrote ("Add a GitHub repository", "Stop tracking", the
// confirm sentence, the toasts) is in lib/copy.ts SOURCES_COPY.repos and is used from there. These are the sentences the
// design has no line for: a first pass still running, a repo nobody has checked yet, a call that failed, and the pointers
// from an error to the step that fixes it.

export const REPO_COPY = {
  loading: 'Looking at your repositories…',
  loadFailed: 'Couldn’t load your repositories. Reload the page to try again.',
  /** The first pass reads merged PRs in the background; the count grows until it is done. */
  importing: (merged: number) =>
    merged > 0 ? `Importing merged PRs · ${int(merged)} so far` : 'Importing merged PRs…',
  accessUnknown: 'Access not checked yet',
  rechecking: 'Checking…',
  stopping: 'Stopping…',
  tracking: 'Tracking…',
  /** After Check again found the repo readable: the next read starts at once. */
  accessBack: (repo: string) => `${repo} is readable again · importing merged PRs.`,
  couldNotCheck: (reason: string) => `Couldn’t check access. ${reason}`,
  couldNotStop: (reason: string) => `Couldn’t stop tracking. ${reason}`,
  /** The toast after Stop tracking offers this (D7 prototype); it tracks the repo again, which asks GitHub for access once more. */
  undo: 'Undo',
  couldNotUndo: (reason: string) => `Couldn’t track it again. ${reason}`,
  fallback: 'Try again in a moment.',
  /** Under the add form, when the reason is that GitHub is not set up: the way to the steps. */
  openGuide: 'Open the GitHub setup steps',
  /** When the App is not installed on the owner: the page where an installation is added. */
  openInstall: 'Open your GitHub App installations',
} as const;
