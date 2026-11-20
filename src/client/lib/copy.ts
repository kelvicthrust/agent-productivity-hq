import { PROVIDER_NAMES } from '../../shared/domain/scope';
import type { LinkHealth } from '../../shared/contracts/link-health';
import { count, int, plural, upperFirst } from './format';

// The product's words. Moved from the D7 prototype (docs/design/prototype/app.js, ui.js) verbatim, per
// docs/tech/design-to-code.md "Prototype reuse audit", with these deliberate differences:
//   - fixture phrases are gone: "(simulated)" after the sign-in toast, the "Prototype: names containing 'private' simulate
//     no access" hint, "(fixture: none)" after the tracking toast, and the "Design intent ...; not yet verified" caption
//   - a label that carries a number goes through `plural`, so it always agrees with the number ("1 record", "2 records")
//   - a sentence the prototype hard-wired to Codex takes the source's name
// What lives here: copy the shared components speak, copy more than one feature shares (range notices, empty states, the
// repository manager that Setup and Sources both show), and the Sources, banner and Retry copy. Copy only one feature uses
// stays in that feature. Typographic apostrophes (’) are the product's.

export { PROVIDER_NAMES };

/** Source rows by id: the two providers, Paseo (which adds identity to their sessions and is not a provider) and the GitHub sync (M6). */
export const SOURCE_NAMES = { ...PROVIDER_NAMES, paseo: 'Paseo', github: 'GitHub' } as const;

/**
 * What a source brings in, for the sentences that count or name it. The local sources import sessions of usage; the GitHub sync
 * brings merged PRs, so "GitHub usage" and "new sessions" would be wrong words for it.
 */
export function recordsOf(id: string): { noun: string; uncollected: (source: string) => string } {
  if (id === 'github')
    return { noun: 'merged PR', uncollected: () => 'Merged PRs since then aren’t collected yet' };
  if (id === 'paseo')
    return { noun: 'agent', uncollected: () => 'Agent changes since then haven’t been collected' };
  return {
    noun: 'session',
    uncollected: (source) => `${source} usage since then isn’t collected yet`,
  };
}

// ---- link basis and linked-PR cells ----

export const LINK_LABELS = {
  evidence: 'Evidence link',
  owner: 'Owner-confirmed',
  suggested: 'Suggested',
  unlinked: 'Unlinked',
  rejected: 'Marked incorrect',
} as const;

/** What a session's Linked PRs cell says when it cannot say "Unlinked": the PRs were never checked. */
export const LINK_STATUS_TEXT = {
  repoNotTracked: 'Repo not tracked, so PRs not checked',
  repoUnknown: 'No repo recorded, so PRs not checked',
  // Not in the D7 design (it went back to Design). The interim wording from docs/tech/local-api.md.
  prsNotCollected: 'PRs for this repo aren’t collected yet',
} as const;

// ---- session identity ----

export const RELATIONSHIP_LABELS = {
  root: 'Root session',
  nativeChild: 'Native subagent',
  paseoChild: 'Paseo child agent',
  unknown: 'Unknown relationship',
} as const;

export const SESSION_COPY = {
  noNameRecorded: 'No name recorded',
  paseo: 'Paseo',
  /** Read before the technical id so it is not taken for a stray string. Visually hidden. */
  idPrefix: 'Session ID:',
  started: 'Started',
  /** The accessible description of "Started" when the source records no start time and the first usage event stands in. */
  firstEventNote: 'First recorded activity; this source doesn’t record a start time',
} as const;

// ---- status tags ----

export const STATUS_TEXT = {
  looking: 'Looking…',
  found: 'Found',
  partial: 'Partial',
  /** A Partial source says how many records could not be read ("Partial · N unreadable", TECH). The number only, never a line. */
  partialUnreadable: (unreadable: number) => `Partial · ${int(unreadable)} unreadable`,
  refreshFailed: 'Refresh failed',
  unavailable: 'Unavailable',
  notFound: 'Not found',
  notRunning: 'Not running',
  accessDenied: 'Access denied',
  /** A password-protected Paseo daemon (a source state, not an error; not yet designed, so the words are plain). */
  needsPassword: 'Needs a password',
  refreshing: 'Refreshing…',
  waitingForSignIn: 'Waiting for sign-in…',
  existingSignIn: 'Using your existing sign-in',
  connected: 'Connected',
  notConnected: 'Not connected',
  reconnectNeeded: 'Reconnect needed',
  inaccessible: 'Inaccessible',
  collecting: 'Collecting',
  accessConfirmed: 'Access confirmed',
  notTracked: 'Not tracked',
} as const;

// ---- token ledger ----

export const LEDGER_COPY = {
  caption: (provider: keyof typeof PROVIDER_NAMES) =>
    `${PROVIDER_NAMES[provider]} token categories`,
  total: 'Provider total',
  codex: {
    input: 'Input',
    cachedInput: 'Cached input',
    cachedInputNote: 'included in input',
    output: 'Output',
    reasoning: 'Reasoning',
    reasoningNote: 'included in output',
    rule: 'Total = input + output. Cached input and reasoning are subsets and aren’t added again.',
  },
  claude: {
    inputUncached: 'Input (uncached)',
    cacheWrite: 'Cache write',
    cacheRead: 'Cache read',
    output: 'Output',
    rule: 'Total = uncached input + cache write + cache read + output (separate categories, none counted twice).',
  },
} as const;

// ---- coverage strip ----

export const COVERAGE_COPY = {
  regionLabel: 'Source coverage',
  groups: { machine: 'This machine', delivery: 'Delivery', accounts: 'Account reports' },
  github: 'GitHub',
  lastSuccessfulRefresh: 'Last successful refresh',
  refreshed: 'Refreshed',
  manageSources: 'Manage sources',
  since: (date: string) => `since ${date}`,
  found: 'found',
  checking: 'checking',
  partial: (unreadable?: number | null) =>
    unreadable ? `partial · ${int(unreadable)} unreadable` : 'partial',
  refreshFailed: 'refresh failed',
  notFound: 'not found',
  notRunning: 'not running',
  accessDenied: 'access denied',
  reposTracked: (tracked: number, inaccessible: number) =>
    `${count(tracked, 'repo')} tracked${inaccessible > 0 ? ` · ${int(inaccessible)} inaccessible` : ''}`,
  reconnectNeeded: 'reconnect needed',
  notConnected: 'not connected',
  /** Connected, but no report has arrived yet: a first read, or Claude Code's first status-line update. */
  noReportYet: 'connected · no report yet',
  tokensOnly: (window: string | null) => (window ? `tokens · ${window}` : 'tokens'),
  percentOnly: '% of limit only',
} as const;

const LINK_HEALTH_COPY: Record<LinkHealth['state'], string | null> = {
  fresh: null,
  stale: 'Pull request links are out of date. Showing the last successful rebuild.',
  unavailable: 'Pull request links are unavailable until a rebuild succeeds.',
};

export const linkHealthNotice = (health: LinkHealth | undefined): string | null =>
  LINK_HEALTH_COPY[health?.state ?? 'fresh'];

// ---- coverage phrases (Overview, Trends, Usage, record lists) ----

export const COVERAGE_PHRASES = {
  noLocalRecords: 'No local records',
  historyUnavailable: 'History unavailable',
  noRecords: 'No records',
  unavailable: 'Unavailable',
  noLocalRecordsOnMachine: 'No local records on this machine.',
  historyUnavailableForPeriod: 'History unavailable for this period.',
  noTrackedRepos: 'No tracked repos',
  cachedRecentDaysMissing: 'Cached; recent days missing',
  fromDateOnly: (date: string) => `From ${date} only`,
} as const;

/** Notices above Overview, Trends and Usage. */
export const RANGE_NOTICES = {
  noLocalRecords:
    'No local agent records were found on this machine. Usage here comes from account reports only and can’t be split by repo, session or PR.',
  /** `starts` reads like "Codex from Feb 2, 2026; Claude Code from Mar 14, 2026". */
  historyStarts: (starts: string) =>
    `Local usage history on this machine starts: ${starts}. Earlier dates show as unavailable, not zero.`,
  repoFilter:
    'Repo filter is on: sessions with an unknown or untracked repo are excluded. Account-reported usage is not filtered by repo.',
} as const;

export const EMPTY_REPOS = {
  heading: 'No tracked repositories',
  body: 'Add the GitHub repositories you want to follow. Merged PRs, and their links to agent sessions, appear once a repo is tracked. Local usage is still shown without them.',
  action: 'Add repositories',
} as const;

export const PERIOD_NOT_HAPPENED = 'This period hasn’t happened yet.';

// ---- refresh, retry, banner ----

/** "failed" for the first failure in a row, "failed again" after that (`SourceStatus.consecutiveFailures`). */
export function failureWord(consecutiveFailures: number): 'failed' | 'failed again' {
  return consecutiveFailures > 1 ? 'failed again' : 'failed';
}

/**
 * The attempt line, the same wherever a failed refresh is described: "Codex refresh failed today, 9:40 AM", then
 * "Codex refresh failed again today, 9:52 AM". `when` is already formatted (`formatWhen`).
 */
export function attemptLine(source: string, consecutiveFailures: number, when: string): string {
  return `${source} refresh ${failureWord(consecutiveFailures)} ${when}`;
}

export const REFRESH_COPY = {
  refresh: 'Refresh',
  refreshAll: 'Refresh all',
  allDescription: 'Refresh sources and recheck any previously enabled Claude plan limits.',
  refreshing: 'Refreshing…',
  retry: 'Retry',
  retrying: 'Retrying…',
  checkAgain: 'Check again',
  viewSource: 'View source',
  /** "Latest attempt:" on a Sources row, after a failure: "Failed today, 9:40 AM" / "Failed again today, 9:52 AM". */
  failedAttempt: (consecutiveFailures: number, when: string) =>
    upperFirst(`${failureWord(consecutiveFailures)} ${when}`),
  attemptSucceeded: 'Succeeded',
  attemptPartial: 'Succeeded with problems',
  lastSuccess: (when: string) => `Last successful refresh: ${when}`,
  latestAttempt: (attempt: string) => `Latest attempt: ${attempt}`,
  toast: {
    /** The Retry succeeded for a source that had been failing. */
    recovered: (source: string, imported: number, noun = 'session') =>
      `${source} refreshed · ${int(imported)} new ${plural(imported, noun)} imported. Records already imported were skipped.`,
    failed: (source: string, again: boolean) =>
      `${source} ${again ? 'still ' : ''}couldn’t be refreshed. Try again.`,
    notFound: (source: string) => `${source}: still no records on this machine.`,
    partial: (source: string, unreadable: number) =>
      `${source} refreshed · ${count(unreadable, 'record')} still unreadable.`,
    noNewRecords: (source: string) =>
      `${source} refreshed · no new records. Nothing was duplicated.`,
    all: 'Refreshed all sources · no duplicates.',
    allRecovered: (source: string, imported: number, noun = 'session') =>
      `Refreshed all sources · ${source} recovered with ${int(imported)} new ${plural(imported, noun)}; nothing duplicated.`,
  },
} as const;

/** The failed-refresh banner distinguishes the latest attempt from the last success and stored records. */
export const BANNER_COPY = {
  heading: 'Refresh failed.',
  body: (
    source: string,
    consecutiveFailures: number,
    attemptWhen: string,
    lastSuccess: string | null,
    retained: boolean,
    uncollected = `${source} usage since then isn’t collected yet`,
  ) => {
    const attempt = attemptLine(source, consecutiveFailures, attemptWhen);
    const success = lastSuccess ? ` ${REFRESH_COPY.lastSuccess(upperFirst(lastSuccess))}.` : '';
    const gap = lastSuccess && retained ? ` ${uncollected}.` : '';
    const saved = retained ? ' Previously collected records are kept.' : '';
    return `${attempt}.${success}${gap}${saved}`;
  },
  viewSource: REFRESH_COPY.viewSource,
  retry: REFRESH_COPY.retry,
  retrying: REFRESH_COPY.retrying,
} as const;

// ---- Sources & repos (also the repository manager Setup shows) ----

export const SOURCES_COPY = {
  title: 'Sources & repos',
  subtitle: 'Setup and upkeep. Everyday review lives in Overview.',
  /**
   * "Data kept on this machine" (the D7 card, requirements P-29 to P-31). D7's own scope line reads "Design intent … not yet
   * verified", which is review scaffolding, so the scope line here says where the data is. The body is D7's: what is kept, what is
   * never stored, and the only network requests.
   */
  dataKept: {
    title: 'Data kept on this machine',
    scope: 'Stored on this computer only',
    body: 'Usage metrics and link metadata are kept for 12 months on this machine so history survives log cleanup. Prompts, responses, tool output and credentials aren’t stored. GitHub and account-report reads are the only network requests. Checking Claude plan limits contacts Anthropic using your existing Claude Code sign-in and saves the limit percentages, reset times and check status.',
  },
  local: {
    title: 'On this machine',
    /** A password-protected Paseo daemon: not designed yet, so the words are plain (Implementation, M8). */
    paseoPassword: 'Paseo is asking for a password, which this dashboard doesn’t support.',
    paseoSnapshot: 'Names and parents come from its last snapshot.',
    paseoNotRunning: 'Start Paseo, then check again.',
    scope:
      'The dashboard reads supported agent records on the computer it’s installed on. There’s nothing to choose; what it finds appears here.',
    notFound:
      'Nothing in its usual locations on this machine. If you use it here, run it once, then check again.',
    location: 'Location',
    foundAutomatically: 'found automatically',
    historyFrom: (date: string, sessions?: number | null) =>
      `History from ${date}${sessions ? ` · ${count(sessions, 'session')}` : ''}`,
  },
  accounts: {
    title: 'Accounts',
    scope:
      'Connection and report availability are shown separately. A connection doesn’t guarantee a report or local history.',
    footnote:
      'Sign-in opens the provider’s own page. The dashboard never asks for your password, model API keys or browser cookies. Local usage works without any account connection.',
    purpose: {
      chatgpt: 'Optional · account-reported Codex usage',
      claude:
        'Uses your Claude Code sign-in to check your subscription limits. After the first successful check, Refresh and Refresh all also check these limits. macOS may ask for Keychain access.',
      github: 'Needed for merged PR history and private repo access',
    },
    claudeRefresh:
      'Refresh and Refresh all also check these limits using your Claude Code sign-in.',
    identity: (login: string) => `Identity: ${login} (used for “Authored by you”)`,
    noReport: 'Usage report: none until connected',
    tokensReport: (window: string, scope: string) => `Usage report: tokens · ${window} · ${scope}`,
    lastReport: (when: string) => `Last report: ${when}`,
    checkAccess: 'Check access',
    reconnect: 'Reconnect',
    connect: (name: string) => `Connect ${name}`,
    disconnect: 'Disconnect',
    toast: {
      opening: (name: string) => `Opening ${name} sign-in in your browser…`,
      connected: (name: string) => `${name} connected. Usage report updated.`,
      disconnected: (name: string) => `${name} disconnected. Local usage is unaffected.`,
      githubOk: (readable: number) =>
        `GitHub connection OK · ${count(readable, 'tracked repo')} readable.`,
    },
  },
  repos: {
    title: 'Tracked repositories',
    scope: 'Merged PRs come only from repos listed here',
    fieldLabel: 'Add a GitHub repository',
    placeholder: 'owner/name or https://github.com/owner/name',
    hint: 'Private repos work when your GitHub connection can read them.',
    add: 'Add repository',
    adding: 'Checking access…',
    none: 'No repositories tracked yet.',
    collectedPrs: (merged: number) => `${count(merged, 'merged PR')} in the last 12 months`,
    importsAfterSetup: 'Merged PRs will import after setup',
    recheck: 'Check again',
    remove: 'Remove',
    stopTracking: 'Stop tracking',
    cancel: 'Cancel',
    confirmGroup: (repo: string) => `Confirm stop tracking ${repo}`,
    confirmHeading: (repo: string) => `Stop tracking ${repo}?`,
    confirmBody:
      'Collection stops and it leaves the overview. Imported history stays on this machine for 12 months, so tracking it again restores it.',
    previouslyTracked: 'Previously tracked',
    historyKept: 'History is kept on this machine within the 12-month window.',
    retained: (merged: number, stopped: string) =>
      `${count(merged, 'merged PR')} retained · stopped ${stopped}`,
    trackAgain: 'Track again',
    error: {
      empty: 'Enter a repository as owner/name or a GitHub URL.',
      malformed:
        'That doesn’t look like a GitHub repository. Use owner/name, for example kelvin/atlas-api.',
      alreadyTracked: (repo: string) => `${repo} is already tracked.`,
      connectGithubFirst:
        'Connect GitHub first (step 2) so the dashboard can check access to this repository.',
      noAccess: (repo: string) =>
        `GitHub didn’t grant access to ${repo}. Check the name, or that your GitHub connection can read this repository, then try again.`,
    },
    toast: {
      tracking: (repo: string, importing: boolean) =>
        `Tracking ${repo}${importing ? ' · importing merged PRs' : ''}`,
      trackingAgain: (repo: string) =>
        `Tracking ${repo} again · retained history restored without duplicates.`,
      stopped: (repo: string) => `Stopped tracking ${repo}. History kept on this machine.`,
      stillNoAccess: (repo: string) =>
        `Still no access to ${repo}. Its retained history stays readable.`,
    },
  },
  data: {
    title: 'Data kept on this machine',
    body: 'Usage metrics and link metadata are kept for 12 months on this machine so history survives log cleanup. Prompts, responses, tool output and credentials aren’t stored. GitHub and account-report reads are the only network requests.',
  },
} as const;
