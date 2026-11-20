# Feasibility kit: experiments E1 to E8

Use these scripts to investigate the feasibility questions in TECH on your Mac. They read local provider data or use your existing sign-in, write a report and stop.

## What every script promises

- **Read-only.** A script never writes to Codex, Claude Code, Paseo, GitHub or any provider setting. The one write every script makes is its own findings file. Two make one more, each declared under that script below: E8 `--prepare` creates a new temporary folder under your system temp folder, and E6's GitHub App route puts one temporary entry in your macOS Keychain and deletes it again. Nothing else is written, and a script never writes through a symbolic link or hard link: one found at a file it was about to write is refused.
- **Metadata only.** Findings hold field names, counts, versions, time gaps and pass or fail. No message text, prompt, title, path, token or credential is printed or stored. If a script ever tried to print something that looks like a token, it stops instead.
- **It says what it will read before it reads.** Every source appears as a `Will read:` line first, and a read outside those folders is refused. The same goes for `Will start:` (a program) and `Will contact:` (a host). A script can only start the programs and contact the hosts listed for it below.
- **Nothing is installed or changed.** There is no product code in these scripts and they add nothing to your machine.

## How to run one

You need Node 26 and one `pnpm install` in this project. Run a script from the project folder:

```sh
node scripts/experiments/e1-claude.ts
```

Add `--help` to see what it reads, prints, writes, contacts and starts, and `--list-reads` to print only that list without reading anything. Every script accepts these flags:

- `--out <file>` writes the findings to a different folder (the file must still be named `E<n>.md`).
- `--json <file>` also writes the structured result.
- `--bin <name>=<path>` uses a specific program for a name such as `gh` or `codex`.
- `--home <dir>` treats a folder as your home when working out default paths.

Exit codes: `0` no criterion failed (a criterion that could not be evaluated is reported as not run, never as a pass), `1` at least one criterion failed, `2` the script itself stopped, with the reason on screen.

The default output `docs/implementation/experiments/E<n>.md` is ignored by Git. A public checkout includes no owner-run reports. Keep reports from real environments and any `--json` output private. Reports can contain personal usage metadata such as aggregate counts, plan type and timing.

## Things to know before you run them

- **ccusage (E1 and E2).** The scripts compare token totals with `ccusage --json --offline` for three sessions each. ccusage is not a dependency of this project and nothing here installs it. Run it yourself and give the script its output with `--oracle <file>`, or let the script start it if `ccusage` is already on your PATH; the example command under each script shows the exact flags. For Codex sessions that replay a parent's history, ccusage's baseline rule is only partly reproduced, so E2 can report a difference there. The findings name the rules it tried, and a difference is a finding, not a script fault.
- **Codex and your ChatGPT sign-in (E2 and E4).** Both start `codex app-server`, the program you already have, and use its existing sign-in. E4 asks it for your account usage, so Codex itself contacts ChatGPT to answer. The script contacts no host, does not read the sign-in file and never sees a token. It prints no email, account id or per-day figure.
- **E6 and the macOS Keychain.** The `gh` route uses the GitHub CLI you are already signed in with. The GitHub App route asks you to approve a device code in your browser, then stores the App's user token in the Keychain under the service `agent-productivity` (account `github-app-user-token.e6-experiment`), reads it back and deletes it, to prove the Keychain works for this. macOS may show you a Keychain prompt; allow it for that one entry. If a script is stopped part-way, delete that entry in Keychain Access. The token is never printed or written to a file.
- **E8 is optional.** Use it to check live Claude Code behavior on the machine where you run it. The `--prepare` report checks that the temporary configuration is wired and lists the seven live criteria as **NOT RUN**. The synthetic setup-only case in `test/experiments/e4-e8-findings.test.ts` checks those distinctions. Use `--report` after the live steps to find out which criteria passed on your system.
- **E8 and your Claude sign-in.** E8 builds a throwaway `CLAUDE_CONFIG_DIR` in your temporary folder so your real Claude Code settings are never touched. Claude Code will ask you to sign in inside that folder, and your plan's rate-limit data arrives only after you do. The script does not read, copy or store any credential. If you give `--seed-settings <file>` (for example a copy of your settings), it copies only your `model`, `effortLevel` and `theme` into the temporary configuration, and only when each is a plain word or a number; everything else in that file (environment variables, hooks, key helpers, permissions) is left out and only counted. Delete the temporary folder when you are done.
- **E8, step by step.** `--prepare` prints the steps with your folder's real paths: a first Claude Code session with the probe on, a second one at the same time, one in the project that has its own status line, one with no status line (the `claude-baseline` folder) to compare the footer, then the `--report` command. Every one of those is needed for a full result; a step you skip shows as "not run", never as a pass, and you can run `--report` again after more use.
- **E8 footer hints.** A footer hint is one of the small grey keyboard reminders on the bottom line of Claude Code, under the box you type in. Claude Code's own documentation ([Customize your status line](https://code.claude.com/docs/en/statusline)) names three: `? for shortcuts`, `esc to interrupt` and `hold space to speak`. It says that with a custom status line Claude Code stops showing most of the footer's keyboard hints and renders the status line in its own row above the footer badges. A status-line command cannot see the screen, so you tell the report which hints you saw: first in the baseline view (no status line), then with the probe. Give them as short lowercase words, separated by commas with no spaces, with `--footer-hints-without` and `--footer-hints-with`: use `shortcuts`, `esc-to-interrupt` and `hold-space-to-speak` for those three, and make up a short lowercase name with hyphens for any other (for example `shift-tab-to-cycle`). Type `none` for `--footer-hints-with` if you saw no hints with the probe; the baseline list needs at least one. For the two-session check, start Claude Code in two terminals the same way and send a message in each before running `--report`.

## Self-test

The scripts are tested against synthetic fixtures with no personal data and no network: `pnpm exec vitest run test/experiments`. It runs every script in a clean environment, checks each declared read list against what the script actually touched, and fails if any fixture sentinel string (`SENTINEL_…`) appears in any output.

## The scripts

This part is generated from each script's own declaration by `node scripts/experiments/lib/runbook.ts --write`, and `--check` fails when it drifts.

<!-- BEGIN GENERATED RUNBOOK: node scripts/experiments/lib/runbook.ts --write -->

### E1 · Claude Code transcript shape and ccusage totals

Script: `scripts/experiments/e1-claude.ts`

Question: What is the Claude Code transcript shape on the installed version, and does the message id + request id dedupe rule reproduce ccusage's session totals?

Run it:

```sh
node scripts/experiments/e1-claude.ts --oracle <file from ccusage claude session --json --offline>
```

**Reads**

- Claude Code transcripts: every `*.jsonl` and `*.jsonl.zst` below `projects/`, in each folder given with `--claude-root`, else in each comma-separated entry of `$CLAUDE_CONFIG_DIR` (its `projects/` folder), else in `~/.config/claude/projects` and `~/.claude/projects`. Only those folders are opened (never settings or credentials). Lines are parsed in memory and never printed.
- ccusage oracle file: the file given with `--oracle` (the output of `ccusage claude session --json --offline`), when you give one.

**Prints**

- The folders it will read, counts of sessions, subagent files, lines and unreadable lines, whether a zstd decoder is present, and one verdict line per criterion. Never a line, title, id, path or token.

**Writes**

- docs/implementation/experiments/E1.md (the findings: field names, counts, token differences and time gaps only)

**Network**

- none: this script uses no network

**Starts programs**

- ccusage

**Pass criteria**

- `field-list-confirmed` — Field list confirmed: the type, timestamp, message id, model, request id and the four usage fields are present on lines that carry usage.
- `reconcile-three-sessions` — The `message.id` + `requestId` dedupe rule reproduces `ccusage claude session --json` totals for 3 sessions to within 0 tokens.
- `subagent-parent-mapping` — Subagent files map to their parent.
- `title-presence-recorded` — Title presence recorded.
- `session-start-before-first-usage` — The earliest line's `timestamp` is present on the main transcript and on a subagent file, and is at or before the first usage event; the gap between the two is recorded.

**Findings file:** the script writes `docs/implementation/experiments/E1.md` by default. Keep results from real environments private.

### E2 · Codex rollout shape, replay baseline, parent reference and zstd

Script: `scripts/experiments/e2-codex.ts`

Question: What is the Codex rollout shape on the installed version: the replay baseline for spawned subagents, the parent reference, `.zst` support and session titles, and do the snapshot deltas reproduce ccusage's session totals?

Run it:

```sh
node scripts/experiments/e2-codex.ts --oracle <file from ccusage codex session --json --offline>
```

**Reads**

- Codex rollouts: every `*.jsonl` and `*.jsonl.zst` below `sessions/` and `archived_sessions/`, in each folder given with `--codex-home`, else in each comma-separated entry of `$CODEX_HOME`, else in `~/.codex`. Only those two folders are opened (never `auth.json` or `config.toml`). A plain file wins over its `.zst` twin, and a `sessions/` copy over an `archived_sessions/` copy. Lines are parsed in memory and never printed.
- ccusage oracle file: the file given with `--oracle` (the output of `ccusage codex session --json --offline`), when you give one.

**Prints**

- The folders it will read, counts of rollouts, lines and unreadable lines, whether a zstd decoder is present, and one verdict line per criterion. Never a line, title, id, path or token.

**Writes**

- docs/implementation/experiments/E2.md (the findings: field names, counts, token differences and time gaps only)

**Network**

- none: this script uses no network

**Starts programs**

- ccusage
- codex

**Pass criteria**

- `field-list-confirmed` — Field list confirmed: the session id, the turn model and the five `total_token_usage` fields are present.
- `reconcile-three-sessions` — 3 sessions (one with a spawned subagent, one archived) reconcile with `ccusage codex session --json` to within 0 tokens.
- `zst-rollouts-readable` — `.jsonl.zst` rollouts are read with the Node zstd decoder (a missing decoder is reported, not hidden).
- `parent-reference-located` — Parent reference located: a spawned subagent's rollout names its parent, and the parent is one of the rollouts read.
- `thread-list-name` — `thread/list.name` returned.
- `session-start-before-first-usage` — `session_meta.timestamp` is present and at or before the first `token_count`; the gap is recorded.
- `thread-created-at-compared` — If `codex` is available, `thread/list`'s `createdAt` is compared with `session_meta.timestamp`; the gap is recorded.

**Findings file:** the script writes `docs/implementation/experiments/E2.md` by default. Keep results from real environments private.

### E3 · Paseo daemon listing

Script: `scripts/experiments/e3-paseo.ts`

Question: Does the Paseo daemon list agents without a password, and does each agent's runtimeInfo.sessionId equal the Codex or Claude session id on disk?

Run it:

```sh
node scripts/experiments/e3-paseo.ts
```

**Reads**

- The Paseo agent list from the daemon at ws://127.0.0.1:6767/ws (or --paseo-url, loopback only), through @getpaseo/client with no password: per agent only its provider, runtimeInfo.sessionId, parent label, workspace id and workspace label, and whether it is archived
- File names, never contents, of Codex sessions under ~/.codex/sessions and ~/.codex/archived_sessions (or each entry of $CODEX_HOME, or --codex-home)
- File names, never contents, of Claude Code sessions under ~/.config/claude/projects and ~/.claude/projects (or each entry of $CLAUDE_CONFIG_DIR, or --claude-config)

**Prints**

- Which folders it will read and which daemon address it will contact, then counts: agents listed per provider, how many carry a session id, how many match a session on disk, parent edges, workspace labels and archived agents, and the verdicts. Never an agent title, folder, id, session id or label

**Writes**

- docs/implementation/experiments/E3.md (the findings)

**Network**

- 127.0.0.1:6767

**Starts programs**

- none

**Pass criteria**

- `list-without-password` — `agents.list({includeBackground: true})` succeeds without a password.
- `session-id-matches-codex` — `runtimeInfo.sessionId` equals the on-disk session id for one Codex agent.
- `session-id-matches-claude` — `runtimeInfo.sessionId` equals the on-disk session id for one Claude agent.
- `parent-edges-present` — Parent edges are present.
- `workspace-labels-present` — Workspace labels are present.
- `archived-listing-recorded` — Archived listing support is recorded.

**Findings file:** the script writes `docs/implementation/experiments/E3.md` by default. Keep results from real environments private.

### E4 · ChatGPT account reads through the Codex app-server

Script: `scripts/experiments/e4-chatgpt.ts`

Question: Does the Codex app-server report the existing ChatGPT sign-in and daily usage buckets without a prompt, and how does one window compare with local Codex totals?

Run it:

```sh
node scripts/experiments/e4-chatgpt.ts --local-tokens <ccusage total> --window-start <YYYY-MM-DD> --window-end <YYYY-MM-DD>
```

**Reads**

- The Codex app-server's answers on its standard output: account/read (account type and plan type only), account/usage/read (bucket dates and token counts, which fields are null) and account/rateLimits/read (how many windows report a percentage); the server is started with `codex app-server`, which uses Codex's own sign-in
- Nothing on disk. The local Codex total for the comparison window comes from you: --local-tokens, --window-start and --window-end (for example from `ccusage codex daily --json`)

**Prints**

- The command it starts, then counts and verdicts: account type and plan type, how many daily buckets, the day span they cover, which usage fields are null, and for the comparison window the account figure and the local figure side by side. Never an email, account id, token or per-day figure

**Writes**

- docs/implementation/experiments/E4.md (the findings)

**Network**

- none: this script uses no network

**Starts programs**

- codex

**Pass criteria**

- `account-read-existing-signin` — `account/read` reports the existing ChatGPT sign-in with no prompt (P-42).
- `usage-returns-buckets` — `account/usage/read` returns daily usage buckets.
- `lookback-and-nulls-recorded` — The bucket lookback and the null fields are recorded.
- `overlap-window-compared` — One overlapping window is compared with local Codex totals.

**Findings file:** the script writes `docs/implementation/experiments/E4.md` by default. Keep results from real environments private.

### E5 · Evidence availability

Script: `scripts/experiments/e5-evidence.ts`

Question: For one well-linked merged PR does the in-memory extractor find a PR URL or commit ref in a session, and for one ambiguous PR do only suggestions appear, with no body text kept?

Run it:

```sh
node scripts/experiments/e5-evidence.ts --linked-pr <owner/name#number> --linked-commit <sha> --ambiguous-pr <owner/name#number> --ambiguous-merged-at <ISO time>
```

**Reads**

- Claude Code transcripts: every *.jsonl under ~/.config/claude/projects and ~/.claude/projects (or each entry of $CLAUDE_CONFIG_DIR, or --claude-root), line by line in memory
- Codex rollouts: every *.jsonl and *.jsonl.zst under ~/.codex/sessions and ~/.codex/archived_sessions (or each entry of $CODEX_HOME, or --codex-root), line by line in memory
- Nothing else: the two PRs come from your flags (--linked-pr, --linked-commit, --ambiguous-pr, --ambiguous-commit, --ambiguous-merged-at), not from GitHub

**Prints**

- Which folders it will read, then counts only: session files scanned, lines scanned, PR URL and commit refs found, how many sessions carry evidence for each of the two PRs, the share of sessions with any ref, and how many sessions fall in the 48 hours before the ambiguous PR merged. Never a line, a PR URL, a SHA, a branch or a path

**Writes**

- docs/implementation/experiments/E5.md (the findings)

**Network**

- none: this script uses no network

**Starts programs**

- none

**Pass criteria**

- `linked-pr-has-evidence` — For 1 well-linked merged PR, the extractor finds a `pr_url` or `commit` ref in a session.
- `ambiguous-pr-only-suggestions` — For 1 ambiguous PR, only suggestions appear: no `pr_url` or `commit` ref points at it.
- `only-identifiers-kept` — No body text is persisted: only matched identifiers are held in memory, and nothing is written.

**Findings file:** the script writes `docs/implementation/experiments/E5.md` by default. Keep results from real environments private.

### E6 · GitHub access, both routes

Script: `scripts/experiments/e6-github.ts`

Question: Can the dashboard read merged PRs with commits for a private tracked repo through the gh route and through a GitHub App, including device flow, the Keychain, refresh without a client secret and the two 404 cases?

Run it:

```sh
node scripts/experiments/e6-github.ts --repo <owner/name> --client-id <App client ID> --uninstalled-repo <owner/name> --inaccessible-repo <owner/name>
```

**Reads**

- The GitHub CLI token: the output of `gh auth token`, held in memory to sign two requests and never printed or stored
- GitHub API answers from https://api.github.com: GET /user (whether a login came back), the merged-PR GraphQL page for --repo (counts only), GET /user/installations (permission names) and GET /repos/{owner}/{name} for --uninstalled-repo and --inaccessible-repo (the HTTP status only)
- GitHub device-flow answers from https://github.com, only with --client-id: the one-time user code (printed so you can type it at github.com/login/device) and the token pair (held in memory, never printed)
- One temporary macOS Keychain entry (service agent-productivity, account github-app-user-token.e6-experiment), read back after it is written

**Prints**

- Which program and hosts it will contact, the one-time device code and github.com/login/device, then HTTP statuses, counts of merged PRs and commits, permission names and verdicts. Never a token, a login, a repository name or a PR title

**Writes**

- docs/implementation/experiments/E6.md (the findings)
- One temporary macOS Keychain entry (service agent-productivity, account github-app-user-token.e6-experiment) holding the token pair, written, read back and deleted; only on the App route, and never with --keyring memory

**Network**

- api.github.com
- github.com

**Starts programs**

- gh

**Pass criteria**

- `gh-token-and-login` — **gh route:** `gh auth token` returns a token and `GET /user` returns a `login`.
- `gh-graphql-merged-prs` — **gh route:** the GraphQL query returns merged PRs, with commits, for one private tracked repo.
- `app-device-flow` — **App route 1:** the device flow completes.
- `keyring-binary-loads` — **App route 2:** the `@napi-rs/keyring` native binary loads on Node 26 (arm64).
- `keychain-round-trip` — **App route 2:** the token is stored in and read back from the Keychain via `@napi-rs/keyring`.
- `app-minimal-permissions` — **App route 3:** the same query works with only Pull requests and Metadata read permissions.
- `app-refresh-no-secret` — **App route 4:** a forced refresh with no client secret succeeds and rotates both tokens.
- `app-uninstalled-owner-404` — **App route 5:** a repo whose owner hasn't installed the App returns 404 and maps to the install message.
- `app-inaccessible-repo` — **App route 6:** an inaccessible repo is handled as expected.

**Findings file:** the script writes `docs/implementation/experiments/E6.md` by default. Keep results from real environments private.

### E8 · Claude status-line probe

Script: `scripts/experiments/e8-claude-probe.ts`

Question: Does Claude Code send rate_limits and its version to a user-level status-line command on the installation host, to every session when two run at once, does a snapshot written first survive cancellation, does a project-level statusLine replace it, and which footer hints disappear, all within the overhead budget?

Run it:

```sh
node scripts/experiments/e8-claude-probe.ts --prepare, then after using Claude Code as it prints: node scripts/experiments/e8-claude-probe.ts --report --dir <the folder --prepare printed> --footer-hints-without <hints> --footer-hints-with <hints>
```

**Reads**

- --prepare, only with --seed-settings <file>: that settings file (for example a copy of ~/.claude/settings.json), read once as JSON. Only the plain preferences effortLevel, model and theme are copied into the temporary configuration, and only when the value is a boolean, a number or a short plain word (letters, digits, dot, underscore, hyphen); everything else (env, hooks, apiKeyHelper, awsAuthRefresh, permissions, servers, any object or array) is left out and only counted, never printed or written
- --report: the folder given with --dir (the temporary folder --prepare made): claude-config/settings.json, to check the hook is wired, and samples.jsonl, which the hook wrote: one line per status-line run holding field names, numbers, hashed session and folder ids, the Claude Code version and timings. --footer-hints-without and --footer-hints-with are typed by the owner: short lowercase words, never read from a file

**Prints**

- --prepare: the temporary folder and the exact commands to start Claude Code with it. --report: counts of runs, windows present, versions, cancelled runs, concurrent sessions and timings in milliseconds, the footer hints the owner named, then verdicts. Never a path from the samples, a session id, a prompt or any text

**Writes**

- docs/implementation/experiments/E8.md (the findings)
- --prepare only: a new temporary folder crew-e8-XXXXXX under the system temp folder holding claude-config/settings.json, claude-baseline/settings.json (an empty configuration, for looking at the footer with no status line), project-with-statusline/.claude/settings.json, project-plain/NOTE.txt and an empty samples.jsonl; the hook, run by Claude Code, appends to samples.jsonl there. Never ~/.claude and never a real settings file

**Network**

- none: this script uses no network

**Starts programs**

- none

**Pass criteria**

- `config-dir-prepared` — The run uses a **temporary `CLAUDE_CONFIG_DIR`** first; real settings are not involved.
- `rate-limits-delivered` — `rate_limits.five_hour` and `seven_day` reach the script for the active plan.
- `claude-version-recorded` — The installed Claude Code version is recorded.
- `snapshot-lands-before-cancel` — The snapshot is written **before** the script does anything else and still lands when Claude Code cancels the script on a rapid update.
- `project-statusline-override` — A project-level `statusLine` really does stop snapshots from that project (the documented precedence).
- `concurrent-sessions-observed` — Two Claude Code sessions running at once each receive both windows, and any arrival that carries an older figure than an earlier one is counted (observed only; the product rule is built in M9).
- `footer-hints-recorded` — The footer hints that disappear when the probe status line replaces the default are recorded (the owner names them; a hook cannot see the screen).
- `hook-overhead-within-budget` — Script overhead is measured: p95 ≤ 100 ms, Node start-up included.

**Findings file:** the script writes `docs/implementation/experiments/E8.md` by default. Keep results from real environments private.

### E9 · Live activity in transcripts

Script: `scripts/experiments/e9-live-activity.ts`

Question: Which transcript files do agents started outside Paseo write, and which records mark a prompt, thinking, a tool call, a tool result, the end of a turn, an error, an interruption and an approval request?

Run it:

```sh
node scripts/experiments/e9-live-activity.ts --window-hours 24 --out /tmp/E9.md
```

**Reads**

- Claude Code transcripts: *.jsonl modified in the last 24 hours (--window-hours) under ~/.config/claude/projects and ~/.claude/projects (or each entry of $CLAUDE_CONFIG_DIR, or --claude-root), line by line in memory
- Codex rollouts: *.jsonl modified in that window under ~/.codex/sessions and ~/.codex/archived_sessions (or each entry of $CODEX_HOME, or --codex-root), line by line in memory
- Nothing else: no desktop app folder, no settings, no history files

**Prints**

- Which folders it will read, then counts only: files and lines per provider and origin, and histograms of record types, content-block types, tool names (an MCP tool as mcp-tool), stop reasons, entry points, Codex source and originator values and payload types, and how each file ends. Never a line, a prompt, a tool input or output, a path below the root, a title or an id

**Writes**

- docs/implementation/experiments/E9.md (the findings)

**Network**

- none: this script uses no network

**Starts programs**

- none

**Pass criteria**

- `claude-transcripts-found` — Claude Code transcripts modified in the window are found under the approved roots, and the entry points that wrote them are counted.
- `codex-rollouts-found` — Codex rollouts modified in the window are found under the approved roots, and their source and originator values are counted.
- `claude-markers-present` — Claude Code transcripts carry a record for a user prompt, a thinking block, a tool call, a tool result and the end of a turn.
- `codex-markers-present` — Codex rollouts carry a record for a turn start, a reasoning item, a tool call and its output, and the end of a turn.
- `only-counts-kept` — Only counts were kept: every histogram key is an identifier-shaped type or name, and no text, path or id was printed or written.

**Findings file:** the script writes `docs/implementation/experiments/E9.md` by default. Keep results from real environments private.

<!-- END GENERATED RUNBOOK -->
