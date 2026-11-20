export const ACCOUNTS_COPY = {
  loading: 'Looking at your accounts…',
  loadFailed: 'Couldn’t load your accounts. Reload the page to try again.',
  fallback: 'Try again in a moment.',

  chatgpt: {
    name: 'ChatGPT',
    connecting: 'Connecting…',
    disconnecting: 'Disconnecting…',
    cancel: 'Cancel',
    cancelling: 'Cancelling…',
    startAgain: 'Start again',
    /**
     * The disclosure beside the Connect button (owner choice P4; design-to-code › "ChatGPT connect disclosure"): the dashboard
     * starts Codex's own sign-in, and a Codex that was signed out is signed in by it, on this computer, not only in the dashboard.
     */
    signInCaption: 'This signs Codex in on this computer too.',
    waiting: {
      heading: 'Finish signing in to ChatGPT',
      body: 'The sign-in page opens in a new tab. When you finish there, this page picks it up.',
      open: 'Open the ChatGPT sign-in page',
      /** The sign-in is running on the server but this page did not start it (a reload, or another tab). */
      lost: 'A ChatGPT sign-in is waiting, but this page has no sign-in page to show for it. Cancel it, or start again to open a new one.',
      expires: (when: string) => `The sign-in is open until ${when}.`,
    },
    toast: {
      existing: 'Using your existing Codex sign-in.',
      connected: 'ChatGPT connected. Usage report updated.',
      disconnected:
        'ChatGPT disconnected. Codex stays signed in, and what was imported stays on this machine.',
      couldNotConnect: (reason: string) => `Couldn’t connect ChatGPT. ${reason}`,
      couldNotDisconnect: (reason: string) => `Couldn’t disconnect ChatGPT. ${reason}`,
    },
  },

  claude: {
    title: 'Claude plan limits',
    check: 'Show Claude plan limits',
    checkAgain: 'Check again',
    checking: 'Checking…',
    checkFailed: 'Agent Productivity HQ couldn’t complete the plan limits check. Try again.',
    window: 'Window',
    legacyHook:
      'Agent Productivity HQ found a legacy status-line hook. Review the steps to remove it.',
    recordUnreadable: 'Agent Productivity HQ couldn’t read its saved Claude status-line record.',
    remove: 'Remove old status line',
    close: 'Close',
    saving: 'Working…',
    removed: 'Legacy Claude status-line hook removed.',
  },

  preview: {
    heading: 'Make and verify the Claude capture removal',
    intro:
      'Remove the capture hook from the listed settings, save your changes, then verify removal here.',
    button: 'Verify removal',
    loading: 'Reading your Claude Code settings…',
    retry: 'Read settings again',
    file: 'Settings file',
    resolvedFile: 'Resolved file',
    current: 'Status line now',
    restore: 'Previous statusLine value',
    removeKey: 'Remove the statusLine key.',
    alreadyRemoved: 'This file no longer references the capture hook. Keep your current settings.',
    none: 'None',
    refusal: {
      conflict: 'Review the settings and try again.',
      unreadable: 'Fix or restore the file, then try again.',
    },
  },
} as const;
