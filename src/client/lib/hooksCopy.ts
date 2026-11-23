// The words of Claude Code's hooks switch: the opt-in control that has Claude Code tell HQ when an agent needs the owner. The control
// (components/ClaudeHooksSwitch.tsx) is shown on the Sources screen and, once, in a dialog the first time HQ is opened. Plain, warm, no
// celebration; every state is said in words. Typographic apostrophes (’) are the product's.

export const HOOKS_COPY = {
  heading: 'Know when Claude Code needs you',
  intro:
    'HQ can only guess when an agent outside Paseo is waiting for you. Turn this on to have Claude Code tell HQ directly.',
  summary:
    'Turning it on adds five entries to your Claude Code settings. Everything else in them is kept, and turning it off removes only those entries.',
  status: {
    off: 'Off. HQ guesses, and says “May be waiting for you”.',
    on: 'On. Claude Code tells HQ when it needs you.',
    needs_repair:
      'Needs repair. HQ’s entries in Claude Code’s settings don’t match this version of the app.',
    unavailable: 'Not available. HQ can’t find a Claude Code settings file it is able to change.',
  },
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  repair: 'Repair',
  turningOn: 'Turning on…',
  turningOff: 'Turning off…',
  repairing: 'Repairing…',
  disclosure: 'What will change',
  /** Said when the button is pressed before the owner has been shown the plan: nothing is changed by that press. */
  reviewFirst:
    'Nothing has changed. Read what will change below, then press the button again to confirm.',
  reading: 'Reading your Claude Code settings…',
  removes: 'Turning it off removes only HQ’s entries from these files, and from no others.',
  removesFrom: 'HQ’s entries are in',
  /**
   * Why the switch is in the state it is, in plain words, for every reason the server reports. `folder` is HQ's hook folder, as the
   * owner knows it (home-relative where it can be).
   */
  reasonNote: (reason: string, folder?: string): string | undefined =>
    ({
      no_claude_folder: 'HQ couldn’t find a Claude Code folder on this computer.',
      settings_blocked:
        'HQ can’t change at least one of Claude Code’s settings files, so it leaves them all as they are.',
      unsupported_path:
        'HQ’s data folder or the Node it runs under has a character in its path that HQ can’t put safely in a shell command (a line break or other control character, or a path over 1,024 characters), so it installs nothing. Spaces, quotes, $, backticks, backslashes and any letters or symbols are fine.',
      entries_changed:
        'HQ’s entries in the settings are not exactly what this version of the app writes.',
      script_missing:
        'HQ’s hook script is missing, has changed or can’t be run by Claude Code’s hook.',
      node_missing:
        'The Node that Claude Code’s hook would run can’t be found. Restart HQ so it uses the Node that is installed, or turn it off.',
      registry_unpublished:
        'HQ could not tell the hook script where it is running, so Claude Code’s hook could not reach it.',
      cleanup_incomplete: `HQ’s entries are out of Claude Code’s settings, but HQ could not remove its own files in ${folder ?? 'its folder'}; you can delete them.`,
    })[reason],
  noEntries: 'No settings file holds HQ’s entries.',
  ownWrites: (folder: string) => `HQ’s own files, written in ${folder}`,
  ownRemoves: (folder: string) => `HQ’s own files, removed from ${folder}`,
  ownName: {
    script: 'agent-productivity-hook.mjs (the hook script)',
    registry: 'registry.json (where the running app can be reached)',
  },
  removeFiles: 'Remove HQ’s files',
  loading: 'Reading your Claude Code settings…',
  readFailed: 'Couldn’t read the settings to show what will change.',
  checkFailed: 'Couldn’t check your Claude Code settings. Try again.',
  planChanged:
    'The available Claude Code settings actions changed. Try again after the card updates.',
  retry: 'Read again',
  files: 'Settings files',
  willCreate: 'will be created',
  events: 'Events',
  command: 'Command each entry runs',
  receives: 'What HQ receives',
  receivesBody:
    'Five things: the event’s name, the session id, the kind of notification, why a session ended, and the folder it works in. Never your prompts, commands, replies or notification text.',
  backup:
    'The first time HQ changes a settings file it saves a copy beside it, named settings.json.agent-productivity-backup. Turning it off leaves that copy in place.',
  noFolder: 'HQ couldn’t find a Claude Code folder on this computer.',
  blocked: {
    unreadable: 'can’t be read',
    not_json: 'isn’t valid JSON',
    not_an_object: 'isn’t a JSON object',
    unsupported_shape: 'has a hooks section HQ can’t add to safely',
    unsupported_layout: 'is laid out in a way HQ can’t edit safely',
    not_writable: 'can’t be written to',
    backup_unusable:
      'has an empty or unreadable backup beside it (settings.json.agent-productivity-backup); look at that file',
  },
  blockedNote: 'HQ leaves a file it can’t change exactly as it is.',
  done: {
    on: 'Turned on. Claude Code will tell HQ when an agent needs you. A session that is already open may need a restart to begin.',
    off: 'Turned off. HQ’s entries are removed from Claude Code’s settings, and nothing else in them was touched.',
    repair: 'Repaired. HQ’s entries match this version of the app again.',
    /** Turned off, but HQ’s own files could not all be removed: said, never reported as a clean removal. */
    offLeftover: (folder: string) =>
      `Turned off. HQ’s entries are removed from Claude Code’s settings, but HQ could not remove its own files in ${folder}; you can delete them.`,
  },
  failed: 'Nothing was turned on or off.',
  /** Where the control lives and what it does not touch. HQ's first-time prompt and the Sources card both say the first line. */
  scope: 'This only changes what HQ can show. Your usage and delivery numbers are unaffected.',
  /** The Sources card, before the switch's state is known and when it could not be read. */
  stateLoading: 'Looking at the switch…',
  stateFailed: 'Couldn’t read this setting. Reload the page to try again.',
  /** HQ's first-time prompt: asked once, and says where the switch is afterwards. */
  firstTime: {
    foundLater: 'You can find this later under Sources.',
    notNow: 'Not now',
    done: 'Done',
  },
} as const;
