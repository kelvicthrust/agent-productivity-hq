// The words only Setup uses. What the design already wrote and other screens share (the status words, "Connect {name}", the repository
// manager's labels and errors, "Merged PRs will import after setup") comes from lib/copy.ts; these are the Setup sentences from the D7
// prototype (docs/design/prototype/app.js › setupDiscover, setupAccounts, setupRepos, pageSetup) with the fixture phrases left out, plus
// the lines the prototype has no words for (a look that failed, Paseo not running, the finish that could not be saved).

export const SETUP_COPY = {
  /** The page's name. The prototype's headline sits under it as the lead line. */
  title: 'Setup',
  lead: 'Let’s find your agents',
  intro:
    'This dashboard reads agent records on the computer it’s installed on, so there’s nothing to pick. Connect accounts only where they add data, then choose the repos to track.',
  progress: 'Setup progress',
  /** The caption at the right of the app bar (D7: "Step 1 of 3"). */
  stepOf: (step: number, total: number) => `Step ${step} of ${total}`,
  steps: ['Local sources', 'Accounts', 'Repositories'],

  actions: {
    back: 'Back',
    skip: 'Skip this step',
    next: 'Continue',
    withoutGithub: 'Continue without GitHub',
    finish: 'Finish setup',
    finishing: 'Finishing…',
  },
  /** Why Continue waits on step 1: the look has not answered yet. Said beside the button, not only by its colour. */
  waitingForLook: 'Continue is ready when the look is done. You can skip this step.',
  finishFailed: (reason: string) => `Couldn’t finish setup. ${reason}`,
  fallback: 'Try again in a moment.',

  sources: {
    title: 'Finding agent records on this machine',
    scope: 'Automatic and read-only',
    looking: 'Looking for records…',
    checking: 'Checking its usual locations on this machine.',
    notFound: (name: string) =>
      `No records in its usual locations. If you use ${name} here, run it once, then check again.`,
    denied: (name: string) =>
      `${name}’s data is here but couldn’t be read (permission denied). Allow read access, then retry. You can continue without it.`,
    notRunning:
      'Paseo isn’t running on this machine. Start it, then check again. You can continue without it.',
    needsPassword:
      'Paseo is asking for a password, which this dashboard doesn’t support. You can continue without it.',
    partial: 'Some of its records can’t be read. What can be read will be imported.',
    location: 'Location',
    foundAutomatically: 'found automatically',
    retry: 'Retry',
    checkAgain: 'Check again',
    someFound: (found: number, of: number) =>
      `${found} of ${of} sources found. History starts where each source’s records start. You can check source availability later in Sources & repos.`,
    noneFound:
      'No local agent records found on this machine. You can still connect accounts for account-reported usage and track repos for merged PRs.',
    failed: 'Couldn’t look at this machine. Check again, or skip this step.',
    checkFailed: (name: string) =>
      `Agent Productivity HQ couldn’t check ${name}. Check again, or continue.`,
  },

  accounts: {
    title: 'Connect accounts',
    scope: 'Only where they add data',
    loading: 'Looking at your accounts…',
    loadFailed: 'Couldn’t load your accounts. Reload the page to try again.',
    githubPurpose: 'Merged PRs require a GitHub connection and a tracked repository.',
    chatgptPurpose: 'Optional · adds account-reported Codex usage.',
    noLocalCodex:
      'Connected, but no local Codex history was found on this machine. You’ll see account-reported totals only, without session detail.',
    claude:
      'You can check Claude plan limits later in Sources & repos using your existing Claude Code sign-in.',
    footnote:
      'Sign-in happens on the provider’s own page. This dashboard never asks for your password, model API keys or browser cookies. Local usage works without any of these.',
    githubUnavailable: 'GitHub sign-in isn’t available in this session.',
    chatgptUnavailable: 'ChatGPT sign-in isn’t available in this session.',
    connect: (name: string) => `Connect ${name}`,
    connecting: 'Connecting…',
    reconnect: 'Reconnect',
    cancel: 'Cancel',
    cancelling: 'Cancelling…',
    startAgain: 'Start again',
    tag: { needsApp: 'Setup needed', failed: 'Connection problem' },
    github: {
      connected: (login: string | null | undefined) =>
        login ? `GitHub connected as ${login}.` : 'GitHub connected.',
      identity: (login: string) => `Identity: ${login} (used for “Authored by you”)`,
      changeClientId: 'Change client ID',
      closeSetup: 'Close GitHub setup',
      clientId: {
        label: 'GitHub App client ID',
        placeholder: 'Iv…',
        hint: 'Copy the Client ID from your GitHub App’s settings page. It isn’t a secret. Never paste a client secret here; this app never asks for one.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Client ID saved',
        empty: 'Paste the Client ID from your GitHub App’s settings page.',
      },
      device: {
        heading: 'Enter this code on GitHub',
        body: 'Open the GitHub page below, sign in if it asks, and type this code. This page keeps checking and finishes on its own.',
        waiting: 'Waiting for you to enter the code on GitHub…',
        expires: (when: string) => `The code expires ${when}.`,
        open: 'Open github.com/login/device',
        codeLabel: 'Code',
        lost: 'A sign-in is waiting for GitHub, but this page no longer has its code. Cancel it, or start again to get a new code.',
      },
    },
    chatgpt: {
      signInCaption: 'This signs Codex in on this computer too.',
      waiting: {
        heading: 'Finish signing in to ChatGPT',
        body: 'The sign-in page opens in a new tab. When you finish there, this page picks it up.',
        open: 'Open the ChatGPT sign-in page',
        lost: 'A ChatGPT sign-in is waiting, but this page has no sign-in page to show for it. Cancel it, or start again to open a new one.',
        expires: (when: string) => `The sign-in is open until ${when}.`,
      },
      connected: 'ChatGPT connected.',
    },
  },

  repos: {
    title: 'Choose repositories to track',
    scope: 'Merged PRs come only from these repos. You can change this any time.',
    skipNote: 'You can finish without any: add repositories later in Sources & repos.',
    loading: 'Looking at your repositories…',
    loadFailed: 'Couldn’t load your repositories. Reload the page to try again.',
    accessUnknown: 'Access not checked yet',
    rechecking: 'Checking…',
    removing: 'Removing…',
    backToAccounts: 'Back to accounts',
    githubRequired:
      'Connect GitHub to add repositories. You can also finish setup and connect later in Sources & repos.',
    githubLoading: 'Looking at your GitHub connection…',
    openInstall: 'Open your GitHub App installations',
    tracking: (repo: string) => `Tracking ${repo}`,
  },
} as const;
