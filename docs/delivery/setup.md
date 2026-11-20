# Agent Productivity HQ local setup

Use this guide to configure a local installation, run the clean-checkout smoke check or recover
from a startup problem. The [delivery build record](../archive/delivery/build-record.md) records the earlier candidate
and assessment results.

## Run a release archive with npx

Use an Apple Silicon Mac with Node 22.x (22.16.0+) or any stable 24.0.0+ and npm. Get
`kelvicthrust-agent-productivity-hq-1.0.2.tgz` and `SHA256SUMS` from the same GitHub release.
Run `shasum -a 256 kelvicthrust-agent-productivity-hq-1.0.2.tgz` and compare the result with
the delivered checksum. Keep the archive compressed at a path you can reuse.

```sh
npx --package="/absolute/path/to/kelvicthrust-agent-productivity-hq-1.0.2.tgz" agent-productivity-hq
```

The launcher starts or reuses the dashboard for your data directory and opens the default browser.
If the browser cannot open, use the URL printed in the terminal. Add `--no-open` after
`agent-productivity-hq` to print the URL without opening the browser. A new data directory opens
[Setup](../../README.md#first-launch-setup). The dashboard stays running after the command exits.
The launcher keeps its runtime files under `~/Library/Application Support/agent-productivity-cli/`,
separate from the [data directory](#data-directory). Clearing the npm cache leaves those files in place.

To stop a dashboard started from Terminal, add `stop` at the end of the command. Use
the same `AGENT_PRODUCTIVITY_DATA_DIR` if you set one at launch. The command preserves your data.
Stop a server started from source with Ctrl+C in its terminal. For a Paseo-managed server, disable
the plugin from **Settings → Plugins** on the daemon host.

If the local port is occupied, follow the message printed by the launcher. Stop the app that owns
the port or set `AGENT_PRODUCTIVITY_PORT` to a free port when launching a separate data directory.
See [startup recovery](#when-something-is-wrong) for data-directory and port conflicts.

## Requirements

The packaged launchers support Apple Silicon macOS on a trusted single-user host. Other local processes and OS users can access the ordinary loopback listener. Keep that listener out of port-sharing and reverse-proxy configurations.

For a standalone checkout, use Node 26 (manifest range `>=26.0.0`) and pnpm 11.25.0. The GitHub App connection uses macOS Keychain.
The first dependency installation needs registry access. The lockfile and
[pnpm workspace configuration](../../pnpm-workspace.yaml) govern versions, install scripts and release age.

## Install and run

From the repository root, run these commands in order:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

The expected ready line is:

```text
Agent Productivity HQ is running at http://127.0.0.1:4317
```

Open <http://127.0.0.1:4317>. Check `/api/health` for `status: "ok"`, `version` and `schemaVersion`.
With a fresh data directory, complete [Setup](../../README.md#first-launch-setup) and confirm
Overview opens and the first refresh starts. Without sources or repositories, Overview shows
the corresponding empty states.

`pnpm start` serves `dist/client` in the foreground. Stop with Ctrl+C and restart from the same
checkout with the same settings. Run `pnpm build` again after client changes.

## Open Agent HQ from Paseo Desktop

Click **Agent HQ** in the Paseo sidebar. On desktop, the dashboard opens in a
Paseo workspace. On Android and iOS, it opens in the phone’s browser. Connect the phone
to Tailscale using the same account as the daemon Mac. The dashboard runs on the Mac
and stays available after you close the tab. If the phone cannot open its browser, copy the
private address shown in the launcher and open it in your browser.

### Install from the release archive

1. Use an Apple Silicon Mac for the daemon and Paseo Desktop 0.16.1 or later for the workspace
   browser. Connect both devices to Tailscale with the same personal account. The host needs
   the Tailscale CLI, HTTPS certificates enabled, and permission to run Serve. If approval is
   required, complete it in Tailscale on the host and click **Retry**.
2. On the daemon host, download `kelvicthrust-paseo-agent-productivity-hq-1.0.0.tgz` and
   `SHA256SUMS` from the same GitHub release. Compare the archive's SHA-256 with the corresponding
   entry and unpack it into a versioned directory owned by your macOS user. Keep the extracted
   `package` directory at a stable path while installed.
3. On the target host in **Settings → Plugins**, enable plugins, enter the absolute path to
   that `package` directory and install it. The same operation is available in the host’s CLI
   as `paseo plugin install /absolute/path/to/package`.
4. Click **Agent HQ**. The launcher looks for Apple Silicon Node.js 22.x (22.16.0+) or any stable 24.0.0+ on the daemon Mac. If it cannot find one, click **Install runtime** to download the official ARM64 build from nodejs.org. The launcher verifies its pinned SHA-256 and installs a private copy. This requires internet access once. Other devices only need Paseo and Tailscale. A fresh database opens Setup. On desktop the launcher uses
   the saved workspace, or the only available workspace. If several are available, choose one
   in plugin settings. On a phone you can open the dashboard without choosing a workspace.

The daemon can discover compatible Homebrew and nvm installations even when its PATH differs from your
terminal. If it offers **Install runtime** despite Node working through a mise shim, add the installed
Node version’s actual `bin` directory to the daemon PATH or use the private install.

The optional runtime lives in `~/Library/Application Support/agent-productivity/paseo-runtime/`
on the daemon Mac. It contains the executable and its license. After disabling the plugin, you can remove
that directory to reclaim space. The dashboard database and provider sign-ins are stored separately.

The remote address uses the daemon's private HTTPS name on port 4317. The managed server
checks the Serve identity on every remote dashboard request. Use an untagged client device signed
into the host owner's Tailscale account. The normal local dashboard remains available to
processes on the host. [How Tailscale Serve supplies identity](https://tailscale.com/docs/features/tailscale-serve#identity-headers)

### Upgrade a launcher or recover

After the public release, install a pinned version on the daemon host with
`paseo plugin install npm:@kelvicthrust/paseo-agent-productivity-hq@1.0.0`.
Use the plugin listing once Paseo has approved the release.

Before the first managed launch, record the previous plugin source, workspace and Ports share.
Stop the standalone app and back up its entire data directory, including SQLite companion files.
Keep its Keychain entries. If you use a custom `AGENT_PRODUCTIVITY_DATA_DIR`, set its absolute
path in the daemon environment before starting the plugin. Remove **only** the verified old dashboard link using its owning Ports
panel. Remove any other forwarding rule to the ordinary dashboard listener before enabling
managed access. A route to that listener retains the access policy of its original proxy.

For an existing directory-based launcher, the packaged plugin uses the same ID.
Record its source and workspace before removing its registration in **Settings → Plugins**.
Install the new extracted directory, then select the recorded workspace in **Dashboard
workspace**. Removing a registration can discard plugin settings. The pilot cutover saves
and restores that preference through Paseo. The dashboard database and Keychain items are
stored separately. To reinstall an older version, remove the replacement registration,
install the recorded source, and restore its original workspace and private URL.

A launch error names the failed step. Resolve an occupied port or an existing database owner
on the host, reconnect Tailscale, or select an available workspace as indicated. Click **Retry**.
Disabling or removing the managed plugin ends its service and managed share. History and sign-ins
stay on the host. For rollback, disable the plugin, restore the stopped backup if needed,
start the previous application and restore the previous launcher and share from the recorded
configuration. Restoring an old share also restores its former access policy.

### Launcher development checks

From the repository root, install the root dependencies with `pnpm install --frozen-lockfile`.
Then install the launcher's test dependencies, check its types, and run its Node and rendered tests:

```sh
npm --prefix plugins/paseo-agent-productivity ci --ignore-scripts
npm --prefix plugins/paseo-agent-productivity run typecheck
npm --prefix plugins/paseo-agent-productivity test
```

Before cutting a release, check the [Node security releases](https://nodejs.org/en/blog/vulnerability)
when selecting the private fallback. Pin the official ARM64 archive and its SHA-256 together.
Host compatibility is separate: the packaged server uses SQLite transaction state introduced in
22.16.0 and 24.0.0. Use a current patch release of a supported Node line.

Release builders run `pnpm pack:paseo` on Apple Silicon with npm 11 on `PATH` to produce the versioned tarball in
`dist/paseo`. Use a compatible host Node to run `pnpm test:paseo-package` against that artifact before private distribution.
Run `pnpm pack:cli` to build the terminal package in `dist/cli`, then run `pnpm test:cli-package` with the supported host Node to exercise the packed launcher from an unrelated directory.

## Isolated clean-checkout smoke start

After installing dependencies, building and checking the checkout, select a fresh sibling data
directory to keep the smoke check separate from your normal dashboard data:

```sh
AGENT_PRODUCTIVITY_DATA_DIR=../agent-productivity-smoke pnpm start
```

Open <http://127.0.0.1:4317>, confirm Setup appears, then stop the server with Ctrl+C. Use a new
empty directory for each smoke check. Finish setup only when you intend to start the local providers
and integrations. The [synthetic preview](../../README.md#the-synthetic-preview) can exercise the
dashboard with invented data.

## Data directory

The [server configuration](../../src/server/lib/config.ts) defines these platform defaults:

- macOS uses `~/Library/Application Support/agent-productivity`.
- Linux uses `$XDG_DATA_HOME/agent-productivity` or `~/.local/share/agent-productivity`.

Set `AGENT_PRODUCTIVITY_DATA_DIR` to select a different directory. The app creates it with mode
`0700` and its data files with mode `0600`. It holds `agent-productivity.db`,
`logs/agent-productivity.log`, the ownership database `agent-productivity-lock.sqlite` and the
running instance details in `agent-productivity.lock`. Keep using the same directory to resume your
existing setup. Select an empty directory for a fresh start.

After Setup, normal startup reads the installation host's Codex and Claude Code history and starts
the configured integrations. GitHub can reuse an existing `gh` sign-in, and ChatGPT can reuse Codex
sign-in. In Setup or Sources, search by repository name or owner, then choose **Track**. You can
also paste a GitHub URL. The GitHub App can only suggest repos available to that installation.

### Check Claude plan limits

In **Sources & repos → Accounts**, choose **Show Claude plan limits**. This reads the Claude Code
sign-in on the machine running the dashboard and checks Anthropic once. macOS may ask for Keychain
access. **Check again** requests a new reading. After the first successful check, clicking
**Refresh** in the app bar or **Refresh all** on Sources also updates the limits for that Claude
Code profile. Opening the dashboard, scheduled refreshes and source-row refreshes use the saved
reading. Local Claude Code sessions and tokens import without this step or Paseo.

Sign in through Claude Code if your session expired. If the provider asks you to wait, retry at the
time shown. When a check fails, the last successful reading keeps its date. Provider support for
this undocumented endpoint can change. Anthropic restricts third-party use of Claude.ai credentials;
an on-demand check still uses that credential. See [Anthropic’s credential guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

If the dashboard shows a legacy hook, open **Remove old status line** in the Claude row. Restore
the indicated value in the recorded Claude Code profile, then verify removal in that installation.
Keep the indicated recovery files until verification succeeds. For a Kelvin Agent Crew installation,
complete this step in that installation before [moving to Agent Productivity HQ](#move-from-kelvin-agent-crew).

### Let Claude Code tell HQ when it needs you (optional)

For a tour of the rooms, roster, and activity states, see the [HQ guide](../product/hq.md).

HQ can only guess when a Claude Code session that Paseo does not run is waiting for you. Open
**Sources & repos → Know when Claude Code needs you** to let Claude Code tell HQ directly. The
first eligible HQ visit in each browser offers the same control in a dismissible dialog while hooks
are off. The switch affects only HQ.

**What will change** shows the settings files, five hook events and exact command. The settings
change only after you review the preview and confirm **Turn on**. This adds one entry per event to the
user-level `settings.json` in each Claude Code folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude` and
`~/.config/claude`), keeps everything else in the file, copies the hook script into
`claude-hooks/` in the data directory and saves a copy of the file beside it once, as
`settings.json.agent-productivity-backup`. **Turn off** removes only HQ's entries, the script and
the registry, and leaves that copy. The hooks send HQ only the event name, the session id, the kind
of notification, why a session ended and the working folder, and only to this dashboard on
`127.0.0.1`. If the dashboard isn't running, the hook does nothing and Claude Code carries on. If
**Not available** appears, the preview says which file can't be changed (for example, it isn't valid
JSON, or is laid out in a way HQ can't edit safely; HQ never rewrites a settings file, it only edits
its own entries in place); fix the file and look again. After an upgrade, **Repair** brings the
entries up to date. If HQ can't delete its own files after **Turn off**, the page says so and names
the folder; you can delete them, or press **Remove HQ's files** to try again. **Turn off**, **Repair**
and **Turn on** each show their own list of files before anything is written.

## Environment variables

Variables used by Agent Productivity HQ and its checks.

| Variable                          | Read by                                           | Meaning                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_PRODUCTIVITY_PORT`         | Managed plugin, `pnpm start`, `pnpm preview:seed` | Port on `127.0.0.1`, a whole number from 1 to 65535. Default **4317**. Anything else stops at start with a plain message.                                                                                   |
| `AGENT_PRODUCTIVITY_DATA_DIR`     | Managed plugin, `pnpm start`, `pnpm preview:seed` | See [Data directory](#data-directory) for the defaults and contents. The preview uses `.preview-data/` in the project.                                                                                      |
| `AGENT_PRODUCTIVITY_HOST`         | Managed plugin, `pnpm start`                      | Leave unset or use `127.0.0.1`. A different nonempty value is refused at startup.                                                                                                                           |
| `XDG_DATA_HOME`                   | `pnpm start` (Linux)                              | Parent of the default data folder when `AGENT_PRODUCTIVITY_DATA_DIR` is unset. Ignored on macOS.                                                                                                            |
| `CODEX_HOME`                      | `pnpm start`, experiment scripts                  | Comma-separated Codex folders. Default locations and subfolders are defined in [data and sources](../tech/data-and-sources.md#discovery-automatic-no-picker).                                               |
| `CLAUDE_CONFIG_DIR`               | `pnpm start`, experiment scripts                  | Comma-separated history locations. The on-demand Claude plan check uses the active profile. Default locations are defined in [data and sources](../tech/data-and-sources.md#discovery-automatic-no-picker). |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | On-demand Claude plan check                       | Uses the credential profile selected by Claude Code when its sign-in is stored separately from its transcript history.                                                                                      |
| `USER`                            | On-demand Claude plan check on macOS              | Account name used to locate the active Claude Code Keychain entry.                                                                                                                                          |
| `PATH`                            | Setup                                             | Setup discovery checks for a `codex` file without running it.                                                                                                                                               |
| `NODE_OPTIONS`                    | Packaged CLI checks                               | The browser-failure test injects a stub into the test launcher. The launcher clears this variable before starting the dashboard service.                                                                    |
| `NODE_ENV`                        | `pnpm test`, `pnpm build`                         | Tests always run as `test` and the build always builds for production, whatever the shell exported.                                                                                                         |
| `PDLC_TEST_WORKERS`               | `pnpm test:e2e`                                   | How many Playwright workers to use (a number); default half the machine.                                                                                                                                    |
| `PLAYWRIGHT_BROWSERS_PATH`        | `pnpm test:e2e`                                   | Where Playwright's headless shell is installed. Checks never install it.                                                                                                                                    |
| `BENCH_RECORD`                    | `pnpm bench`                                      | When set, writes the measured table to `test/bench/RESULTS.md` (then run `pnpm exec prettier --write test/bench/RESULTS.md`).                                                                               |
| `EXPERIMENTS_FORCE_NO_ZSTD`       | experiment self-tests                             | Test-only: makes the readers behave as if no zstd decoder were installed.                                                                                                                                   |

## When something is wrong

- **The database cannot be used.** The recovery page identifies the file and gives commands to move
  it aside yourself. Stop the server first. Keep the database and any `-wal` and `-shm` companions together
  when moving or backing it up. Restart to create a fresh database if you choose to move it aside.
- **The disk is full.** At startup, the recovery page names the data directory. Free space and
  restart the dashboard. During a refresh, free space and use **Retry** on the affected source to resume from
  the retained import.
- **Another copy already holds the data directory.** On the same port, a second process prints the
  ready instance's address and exits successfully. On a different port it serves a page that points
  to the existing instance and stays in the foreground. The address may be missing while the first
  instance starts. Use the existing instance or stop it before trying again. Its process releases
  the ownership lock when it exits.

## Upgrade and rollback

1. Stop all dashboard processes. Back up the entire data directory, including any SQLite companion files.
2. Update to the intended checkout and follow [Install and run](#install-and-run) with the existing
   data directory. Startup applies outstanding migrations in a transaction.
   [Schema 005](../../src/server/db/migrations/005_link_inputs.sql) adds transactional tracking of
   changes to the stored inputs for computed PR links.
3. Check that the server reaches its ready line, then open the existing dashboard.

To roll back, stop the new process, restore your pre-upgrade data directory backup and build and start
the previous checkout with that restored directory. Keep a separate copy of the upgraded directory if
you need data created since the backup.

## Move from Kelvin Agent Crew

Agent Productivity HQ starts with a fresh database and its own GitHub App Keychain entry. The previous
database retains the old tracked repositories, account choices and manual link decisions. Add the
repositories you want to follow during the new Setup. Available history is imported again from the
configured sources.

1. Record the old server checkout and revision, the installed launcher source path and revision,
   the data directory, tracked repositories, Paseo workspace ID and private Ports URL. Stop the old
   server and back up its complete data directory, including SQLite companion files. Its default
   on macOS was `~/Library/Application Support/kelvin-agent-crew`. On Linux it was
   `$XDG_DATA_HOME/kelvin-agent-crew` or `~/.local/share/kelvin-agent-crew`. Preserve the old GitHub
   App Keychain entry for rollback.
2. If a legacy Claude status-line hook is installed, restart the old checkout with its original data
   directory and use **Remove old status line**. Restore the setting yourself in the recorded Claude
   Code profile and verify removal in that dashboard. Then stop the old server to free port 4317.
3. Build and start [Agent Productivity HQ](#install-and-run) with the new default or a fresh
   `AGENT_PRODUCTIVITY_DATA_DIR`. Keep it separate from the old directory, which can contain legacy
   Claude capture files. Update any launch configuration that used `CREW_PORT`,
   `CREW_HOST` or `CREW_DATA_DIR` to use the new names. Complete Setup, track your repositories
   and reconnect only the accounts you use. If you use a GitHub App, enter its client ID and connect
   again to save the new Keychain entry.
4. Stop the standalone instance and [install the managed plugin](#open-agent-hq-from-paseo-desktop)
   if using Paseo Desktop. Confirm that clicking
   **Agent HQ** in Paseo Desktop opens the dashboard. Then run
   `paseo plugin disable kelvin-agent-crew` on the Paseo host to retain the former launcher's settings.

To roll back, stop Agent Productivity HQ and start the former checkout with its original data directory
and launch settings. If the directory needs to be recovered, restore the backup first. On the daemon Mac,
restore the former launcher files at their recorded source path and revision before enabling it.
Run `paseo plugin disable agent-productivity` and `paseo plugin enable kelvin-agent-crew`. Confirm the
previous launcher opens the restored server through the private Ports share. Keep both data directories
and their Keychain entries available for later use.

## Routine checks

Run these checks after installation:

```sh
pnpm typecheck
pnpm lint && pnpm format:check
pnpm test
pnpm test:contract
```

The [README checks table](../../README.md#checks) covers browser, security and performance checks.
The [delivery handoff](../archive/delivery/handoff.md) records the scope and limits of earlier assessments.
