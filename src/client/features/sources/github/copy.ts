// Words only the GitHub connection uses. The row's own words (the name, "Needed for merged PR history and private repo access",
// "Identity: …", the status tags) are in lib/copy.ts SOURCES_COPY.accounts and STATUS_TEXT.

export const GITHUB_COPY = {
  title: 'GitHub',
  loading: 'Looking at your GitHub connection…',
  loadFailed: 'Couldn’t load your GitHub connection. Reload the page to try again.',
  unavailable: 'GitHub sign-in isn’t available in this session.',
  fallback: 'Try again in a moment.',

  // A status tag never wraps, so these are the short forms; the server's longer sentence goes under the tag. The words the design
  // already has (Connected, Not connected, Reconnect needed, Waiting for sign-in…) come from lib/copy.ts STATUS_TEXT.
  tag: {
    needsApp: 'Setup needed',
    failed: 'Connection problem',
  },

  connect: 'Connect GitHub',
  connecting: 'Connecting…',
  reconnect: 'Reconnect',
  disconnect: 'Disconnect',
  disconnecting: 'Disconnecting…',
  toast: {
    existing: 'Using your existing GitHub sign-in.',
    connected: (login: string | null | undefined) =>
      login ? `GitHub connected as ${login}.` : 'GitHub connected.',
    disconnected: 'GitHub disconnected. Imported history stays on this machine.',
    clientIdSaved: 'Client ID saved.',
    couldNotConnect: (reason: string) => `Couldn’t connect GitHub. ${reason}`,
    couldNotDisconnect: (reason: string) => `Couldn’t disconnect GitHub. ${reason}`,
  },
  syncLabel: 'Merged PR sync',

  // ---- the client-ID field ----
  clientId: {
    label: 'GitHub App client ID',
    placeholder: 'Iv…',
    hint: 'Copy the Client ID from your GitHub App’s settings page. It isn’t a secret. Never paste a client secret here; this app never asks for one.',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Client ID saved',
    empty: 'Paste the Client ID from your GitHub App’s settings page.',
  },

  // ---- the device-code panel ----
  device: {
    heading: 'Enter this code on GitHub',
    body: 'Open the GitHub page below, sign in if it asks, and type this code. This page keeps checking and finishes on its own.',
    waiting: 'Waiting for you to enter the code on GitHub…',
    expires: (when: string) => `The code expires ${when}.`,
    open: 'Open github.com/login/device',
    cancel: 'Cancel',
    cancelling: 'Cancelling…',
    codeLabel: 'Code',
    /** A sign-in is waiting on the server but this page no longer has its code (it was reloaded or left). */
    lost: 'A sign-in is waiting for GitHub, but this page no longer has its code. Cancel it, or start again to get a new code.',
    startAgain: 'Start again',
  },
} as const;
