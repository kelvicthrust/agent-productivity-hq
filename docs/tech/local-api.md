# Local HTTP API (T1–T5, scoped clarification T6)

The current contract exposes an explicit Claude subscription check and a read-only GitHub repository
picker. Earlier milestone deltas below describe their original revisions. The Sources response
includes saved account coverage and does not trigger Claude credential reads or provider checks.
The standalone browser refresh buttons also send `{ "mode": "refresh" }` to the protected plan-check
endpoint. This checks only a profile with a saved successful OAuth reading and honors the existing
cooldown. The ordinary `/api/refresh` run proceeds independently.

Standalone Overview's ChatGPT report contains the saved weekly Codex subscription limit when the source
identified the general Codex quota. `coverage.accounts` carries connection status even when the
weekly reading is unavailable. `/api/sources` carries saved account coverage, including the
available daily token span.

The managed Paseo session reports its mode in `/api/bootstrap` and serves weekly subscription
readings at `/api/paseo-quota`. This cache is independent of the roster and local token history.
The explicit per-provider action rechecks Paseo and uses the local provider sign-in only if Paseo
lacks a current general weekly reading for that provider. Ordinary managed refreshes leave direct
checks to that action.

### Native Paseo reports

The Paseo plugin calls `dashboard.native` on the selected host with daemon management permission.
The managed process validates each operation's parameters and calls the guarded app in process.
Query fields use the same names and filter values as HTTP, with integers sent as JSON numbers and `repos` as a
comma-separated string. Read operations use the same scope, coverage and cursor semantics.

| Native operation | HTTP route |
| --- | --- |
| `overview`, `series`, `year`, `models`, `records` | `GET /api/overview`, `/api/series`, `/api/year`, `/api/models`, `/api/records` |
| `prs`, `prDetail` | `GET /api/prs`, `GET /api/prs/{prId}` |
| `prLinkSet`, `prLinkRemove` | `PUT` and `DELETE /api/prs/{prId}/links/{sessionId}` |
| `usageCategories`, `usageGroups`, `usageRoots` | `GET /api/usage/categories`, `/api/usage/groups`, `/api/usage/groups/{groupKey}/roots` |
| `refresh`, `refreshStatus` | `POST /api/refresh`, `GET /api/refresh/{runId}` |

The plugin supplies raw PR and group IDs. The bridge URL-encodes them, parses the public report
responses with their API codecs and translates public errors to `reason`, `message` and
`retryable`. A refresh in progress also returns `details.runId` so the screen can follow it.
The native allowlist includes setup, account, repo and quota operations, including the explicit
managed quota fallback.

### Paseo browser handoff

`dashboard.browser-handoff` uses daemon management permission and returns a Serve origin and a
single-use ticket after the managed share is ready. The two-minute ticket belongs to that share.
The browser loads the existing application at `/paseo/`, clears the fragment, and submits the
ticket to `POST /api/paseo-handoff`. The exact HTTPS origin, Serve identity and request headers
are checked before exchange. Send the returned credential in `X-Agent-Productivity-Browser-Session` on same-origin report and
management requests. It lasts eight hours and is revoked when the
share ends. The browser stores it in its tab's session storage.

The session authorizes the native report and management operations shown above, plus bootstrap,
roster, sources, the GitHub and ChatGPT connections, repo operations and managed quota. Setup
runs in Paseo. Reset and Claude Code settings, including legacy capture previews, use the Mac
owner's browser session. The Tailscale owner check applies to both browser sessions.

**Product follow-up:** `RefreshRun.linkRebuild` is `null` when the run reaches the link stage and
the stored computation is already fresh. That skip preserves the last successful rebuild time.
The existing `pending`, `succeeded`, `failed` and `interrupted` values keep their meanings, and
runs without a recorded link stage still return `null`. The stored link inputs and health are
described in the [technical specification](../../TECH.md#refresh-run-state-machine).

**HQ delta (M0):** `GET /api/hq` is served: the live roster of coding agents on this machine, with each feed's status. In M0 no live feeder is wired, so a process answers 200 with `codex`, `claude` and `paseo` all `unavailable`, no agents and `truncated: false`; a process given a roster service answers from it. The roster is memory-only and the page polls it every 2 s while visible. `HqAgent`, `HqFeed` and `HqResponse` join the named schemas. Nothing else in this contract changed.

**T6 scope, 2026-11-16:** the [Setup progress and API boundary](#setup-progress-and-api-boundary) now agrees with the [design-to-code mapping](design-to-code.md#setup-indicator-reconciliation). This is a proposed presentation clarification; every OpenAPI block and the accepted M6–M10 repairs below are retained unchanged. No endpoint, request, response or server side effect changes.

**M10 delta (Implementation):** `POST /api/setup/discover` and `POST /api/setup/complete` are served, and the contract test's pending set is empty. Discover only looks. It answers `sources` for the three on-this-machine sources (`codex`, `claude`, `paseo`; `ok` or `partial` when found, `notfound`, `denied`, and for Paseo `notrunning` or `needspassword`) and `accounts` for `github` and `chatgpt` as `GET /api/sources` reads them (the Claude plan-usage switch is opt-in on Sources and is not part of Setup). It records each source's status and location on its row without recording an attempt (as discovery does at every refresh), imports nothing, reads no transcript, starts no program outside the live launchers, writes no usage event and takes nothing from the client: the request body is empty, so no path, folder, key or token is ever sent or asked for. Complete marks setup done (`app_meta.setup_completed_at`, with the report timezone, in one transaction) and answers `202` with the `RefreshRun` it started; it is allowed with zero sources and zero repos. A repeat changes nothing and starts no second run: it answers the run still going, else the latest finished one, and starts one only if there has never been a run. `GET /api/bootstrap` says `setupComplete: true` from then on. A process that reads this machine (`pnpm start`) starts no refresh run by itself, at launch or on the timer, until Setup has been finished: the first run is Complete's, and every launch after it starts its own as before. A process that has no machine of its own (the synthetic preview, a test) looks at no folder: discover answers the stored rows as they are. Nothing else in this contract changed.

**HQ hooks delta (2026-11-19):** `GET /api/hq/claude-hooks` and `PUT /api/hq/claude-hooks` preview and switch the owner's opt-in Claude Code hooks, and `POST /api/hq/hooks/claude` (loopback only, bearer token) is what the installed hook script posts. `GET /api/hq` gains `exactPrompts` (`off`, `on`, `needs_repair`, `unavailable`); `HqResponse` requires it, and `ClaudeHooksStatus` joins the named schemas. `ClaudeHooksStatus.plans` holds one plan per action the state offers (`on`, `repair`, `off`), each with its own file list and its own `preview`, a fingerprint of that action, the command, the observed condition of HQ's own files (the script, the Node the command names, the registry as the installed hook script would read it, and HQ's own leftover files) and the bytes of every settings file it was computed from; `ClaudeHooksStatus.preview` repeats the first offered action's. `PUT` must send back the fingerprint of the action it confirms (`enabled: false` is `off`; `enabled: true` is `on` when no file holds HQ's entries, else `repair`) and is refused with `409 claude_hooks_stale` if it is missing, no longer current or another action's, so a write can never differ from what was shown. Four error codes join the table: `claude_hooks_blocked` (422), `claude_hooks_unavailable` (422), `claude_hooks_stale` (409) and `claude_hooks_failed` (500); a settings file that kept changing is the existing `claude_settings_conflict` (409). *(Later the same day:* `ClaudeHooksFileReason` gained `backup_unusable`, the one-time copy beside a settings file being empty or not a settings file, answered `422 claude_hooks_blocked` with `details.files` naming it; the plan for `off` records each leftover's bytes and inode in its fingerprint, and a turn-off or "Remove HQ's files" deletes only what that plan lists. No route or field was added.*)* Nothing else in this contract changed.

**M9 delta (Implementation):** The ChatGPT and Claude account routes are served, replacing the M6 sentence that they answer `422` until M9. `POST /api/accounts/chatgpt/connect`, `GET /api/accounts/chatgpt/connect/{loginId}` and `POST /api/accounts/chatgpt/disconnect` run over the process's Codex integration; Connect over an existing Codex sign-in answers `mode: existing` and starts a ChatGPT-only read, and Disconnect only stops the dashboard reading. `GET /api/accounts/claude/usage-capture/preview` and `PUT /api/accounts/claude/usage-capture` run over the Claude capture; the refusals are `409 claude_settings_conflict`, `422 claude_settings_unreadable` and `422 claude_statusline_unsupported`, and `POST /api/accounts/claude/disconnect` stays `422` (Claude has no sign-in flow). A process started without an integration (a test, or a build that has none) answers these routes with `422` and a plain sentence. `GET /api/sources` returns the ChatGPT and Claude cards beside GitHub's. On `GET /api/overview`, `coverage.accounts` always lists the ChatGPT and Claude statuses, and `accounts[]` holds a report only for an account that is connected: ChatGPT once its status is not `notconnected`, Claude while capture is verified and a window has been stored. A connected account with no report yet is in `coverage.accounts` as `connected` or `existing` and has no entry in `accounts[]`; the client words that as "connected · no report yet", never "not connected". The current capture flow keeps its phase in Crew's capture record and projects whether it is active into `claude_capture_enabled`, so Overview reads only its database.

**M8 delta (Implementation):** `GET /api/prs/{prId}` and `PUT` and `DELETE /api/prs/{prId}/links/{sessionId}` are served. `GET /api/prs`, `/api/prs/{prId}`, `/api/overview`, `/api/records` and the Usage tree now all read the same effective link classes, so `linkClass`, `linkedSessionCount`, `suggestedCount` and `providers` on a PR, the Linked PRs KPI and a session's `linkedPrs` and `linkStatus` agree for the same link; the `counts` of `GET /api/prs` are per class and each PR is in exactly one of them. Each PR is counted once however many sessions link to it, and no response carries tokens for a PR. `GET /api/prs/{prId}` is `404 not_found` for a PR the Delivery list would not show (a stopped or unreachable repo), its `evidence` lists the effective links strongest first (evidence, owner, suggested, then marked incorrect, struck through with its source claim kept), a dismissed suggestion is not listed, and `candidates` are up to 30 same-repo sessions active in the 3 days up to the merge that are not already listed. A change the transition table does not allow from the pair's current state is `400 invalid_input` (nothing is written); an unknown PR or session is `404 not_found`; the same change twice is the same state. A `dismissed` PUT answers with the item as it was, no actions and "Dismissed by you", which the screen drops. Evidence is read from `session_ref`, which holds identifiers only (`owner/name#number` in lower case, a commit id of 7 to 40 hex characters, a branch name): the Codex and Claude Code adapters scan each line in memory as they read it, and a value of any other shape is refused. The computed links are rebuilt after every refresh and an owner decision is never read, changed or deleted by that. Paseo's `SourceStatus` row has the states `ok`, `notrunning` (nothing listening) and `needspassword`; the last two are skipped attempts, not failures (no failure is counted, the last snapshot still names and parents the tree), and while the row has neither an error nor a note its `message` says what Paseo found: when agent metadata starts, how many agents were seen, matched to a session and not matched (they add no usage), and how many sessions have a Paseo parent that is not one of your sessions (their relationship shows as Unknown). Each `linkedPrs` item of a `Session` gains `mergedAt` (an instant), so the Usage tree's `#number` link can open Delivery on the day the PR merged, with every author, instead of on the current week where an older PR would not be listed. Nothing else in this contract changed.

**M7 delta (Implementation):** `ProviderKpi` gains `coveredFrom` (a date or null). The `note` value `From <date> only` is a marker, not display text: the client builds "From Mar 14, 2026 only" from `coveredFrom`, as the Usage ledger does from its own `coveredFrom`. `GET /api/overview`, `/api/series`, `/api/records` and `/api/models` are served. Until M9, `accounts` is an empty list and `coverage.accounts` lists ChatGPT and Claude with status `notconnected`; `coverage` (sources, github, accounts) describes the machine, so it ignores `repos` (`github.tracked` counts every active repo, `github.inaccessible` the ones GitHub no longer grants). A tracked repo GitHub no longer grants still gets a `repoRows` entry: its `mergedPrs` and `linkedPrs` are null (not collected) and its local tokens and root sessions are shown. `kpis.linkedPrs` and each PR's `linkClass` read the effective link classes (they follow the links M8 writes; see the M8 delta). `kpis.mergedPrs.previous.label` is `Yesterday`, `Previous day`, `Last week` or `Previous N days`. `GET /api/records` takes `limit` (default 30, at most 100) and `GET /api/models` ignores `author`; both answer `400` for a bad range or limit. Nothing else in this contract changed.

**M6 delta (Implementation):** `SourceStatus.id` gains `github`, so the GitHub sync reports through the same row, banner, Retry and issue count as the local sources. The four GitHub account routes are served, and `GET /api/sources` returns `accounts: [GitHub]` when the process has the GitHub integration (it is left out otherwise). For `AccountStatus.reason` the GitHub card uses `keychain_refused`, `reconnect` and `login_mismatch` (`gh` and the saved App sign-in belong to different GitHub logins: the status stays `existing`, `via: gh`, and `statusText` names both logins). The card is computed at most once every 10 seconds, and again at once after any change made through these routes. Until M9, `chatgpt` answers `POST connect` and `POST disconnect` with `422 invalid_input` and a plain sentence, `claude` the same for both, and an unknown account answers `404 not_found`. `PUT /api/accounts/github/app` refuses any field other than `clientId` with `400 invalid_input`. The repo writes, `GET /api/prs` (the list; the detail and link routes are M8) and `GET /api/year` are served. Adding a repo that GitHub will not hand to the connected sign-in stores nothing and answers `422 repo_inaccessible` with `details.reason` (`not_found`, `forbidden`, `moved` or `app_not_installed`) and `details.repo`; `app_not_installed` also carries `details.owner` and `details.installUrl`. No connection answers `422 github_not_connected` (or `github_app_required` with `details.guideUrl` when the one-time App setup is still to do). `POST /api/repos/{owner}/{name}/recheck` answers `200 Repo` whether or not the repo can be read now (its `accessState` says which). Until the link engine (M8) every PR in `GET /api/prs` is `linkClass: unlinked`, and `author=mine` means the PR's author is the connected GitHub login. Nothing else in this contract changed.

**T5 delta (Design D5–D7 refresh):** `Session` gains `startedAt`, `startedBasis`, `linkStatus` and class-bearing `linkedPrs` (replacing the count-only `suggestedPrCount`); `SourceStatus` gains `consecutiveFailures`. Nothing else in this contract changed. Everything is proposed and uncompiled.

Supporting contract for [TECH.md](../../TECH.md). The single local server process exposes this JSON API to the browser UI on the same origin, `http://127.0.0.1:<port>`. It is not a public or remote API. Nothing here has been compiled or run; it is the proposed contract the implementation must satisfy.

**Source of truth.** Implementation writes the schemas below as `zod` schemas in `src/shared/contracts/`, used by both server validation and client parsing. This document is the reviewable copy. A contract test (`test/contract/openapi.test.ts`) checks that every route and response shape here exists in code. When they diverge, change both in the same commit.

## Setup progress and API boundary

Setup uses the D7 **wrapping pill indicator**, implemented as a product-owned ordered list, superseding the old design-to-code mapping to Astryx `Stepper`. It has three fixed labels: Local sources, Accounts, Repositories. The existing transient client `step` (zero-based 0/1/2) selects the body, `SetupProgress.activeStep` and the app-bar `Step N of 3` caption together. It is not sent to this API or persisted; reload begins at Local sources. Exactly one list item has `aria-current="step"`; earlier items show a check and an accessible done announcement, meaning passed in the flow even when skipped. Checks do not assert source, account or repository success. Back/Continue/Skip change only that client position; request errors leave it unchanged. The list itself is not interactive. Responsive/state styling and the complete nine-screen comparison are in [Setup indicator reconciliation](design-to-code.md#setup-indicator-reconciliation).

The accepted M10 boundary remains controlling: Discover takes an empty body and only checks source locations/status and GitHub/ChatGPT account status. It records location/status without a collection attempt and **imports no transcript, usage or history**. Local sources can be missing, denied or partial without requiring a picker or account connection. Use the returned location/status; do not add a history read to imitate the prototype's fixture dates. Before Finish, launch and timer do not start a refresh. Claude's optional manual capture setup stays on Sources & repos. GitHub's `gh`/App fallback and the ChatGPT Codex sign-in disclosure are retained.

Finish calls `POST /api/setup/complete`, remains on Repositories while pending, and keeps that step and the inline error on failure. Success returns `202 RefreshRun`, refreshes bootstrap state and navigates to Overview with import progress. Zero sources/repos are allowed. Repeated Complete retains the existing idempotency rule; changing the indicator must not add another request/run. No progress field, connection prerequisite or new Claude endpoint is introduced.

## Conventions

- **Transport and security:**
  - For the standalone listener, requests whose `Host` header isn't `127.0.0.1:<port>` or `localhost:<port>` get `421` (DNS-rebinding guard).
  - No CORS headers are ever sent.
  - Every non-GET API request must carry `Content-Type: application/json` and `X-Agent-Productivity-Request: 1`, otherwise `403`. Browsers can't send that header cross-site without a CORS preflight this server never approves.
  - All HTTP listeners bind to loopback. A managed backend exposes only token-authenticated Claude Code hook ingestion on its local listener when that integration is available. The explicit browser actions start a separate Tailscale Serve listener for the same managed backend. It verifies the configured HTTPS authority and the host owner's Serve identity. Report data requires a [Paseo browser session](#paseo-browser-handoff) or the owner's browser cookie. The unlock form exchanges the code in the owner's private data directory for the eight-hour owner cookie. See [Paseo setup](../delivery/setup.md#open-agent-hq-from-paseo-desktop).
- **Dates:**
  - `YYYY-MM-DD` values are calendar dates in the **report timezone**, the machine's IANA zone recorded in `app_meta.report_timezone`.
  - Instants are ISO-8601 UTC strings.
- **Filters** (shared query parameters on every analytics route):

  | Param | Type | Default | Applies to | Validation |
  | --- | --- | --- | --- | --- |
  | `start`, `end` | date | current Monday-start week (owner decision r6) | all dated records | `lookbackStart ≤ start ≤ end`. `end` may run past today only up to the end of the current week or month (the period presets). Out of range → `400 invalid_range`. |
  | `gran` | `day`\|`week`\|`month` | `day` for ≤ 45 days, `week` for ≤ 200, else `month` | buckets | — |
  | `repos` | comma-separated canonical ids | all | local usage **and** delivery | Unknown ids are ignored and echoed in `scope.ignoredRepos`. When set, sessions with unknown or untracked repo are excluded (design copy). |
  | `provider` | `all`\|`codex`\|`claude` | `all` | local usage only | — |
  | `author` | `mine`\|`all` | `mine` | delivery only | `mine` = PR author equals the connected GitHub login |

  Every response echoes the applied `scope` so the UI can print scope lines.
- **Errors:** `{"error": {"code": string, "message": string, "retryable": boolean, "details"?: object}}`. Messages are plain English and never contain file contents, tokens or prompts (P-31).

  | Code | HTTP | Meaning |
  | --- | --- | --- |
  | `invalid_input` | 400 | Validation failed (`details.fields`) |
  | `invalid_range` | 400 | Date range outside the lookback |
  | `forbidden_origin` | 403 / 421 | Host or CSRF guard |
  | `not_found` | 404 | Unknown PR, session, repo or run |
  | `already_tracked` | 409 | Repo already active |
  | `refresh_running` | 409 | A refresh is running. `details.runId` names it. |
  | `reset_in_progress` | 409 | Wait for the app reset to finish before retrying. |
  | `repo_inaccessible` | 422 | GitHub returned 404/403 for the repo |
  | `github_not_connected` | 422 | Repo add or sync needs a GitHub connection |
  | `github_app_required` | 422 | gh isn't signed in and no GitHub App client ID is saved yet. `details.guideUrl` points to the setup guide. |
  | `claude_settings_unreadable` | 422 | The Claude Code settings file exists but isn't valid JSON, or can't be read. Nothing was changed. |
  | `claude_statusline_unsupported` | 422 | The existing `statusLine` isn't a `command` type, so it can't be chained. Nothing was changed. |
  | `claude_settings_conflict` | 409 | The preview is stale, the requested action does not match the capture phase, the saved install edit cannot be verified, or a settings file still references the hook during removal. Also `PUT /api/hq/claude-hooks`: a settings file kept changing while HQ was updating it, so it was not written. |
  | `claude_hooks_blocked` | 422 | `PUT /api/hq/claude-hooks`: a Claude Code settings file cannot be changed, so HQ left it as it was. `details.reason` is one of `unreadable`, `not_json`, `not_an_object`, `unsupported_shape`, `unsupported_layout` (the file is valid JSON but its text cannot be edited by a local change that leaves every other byte alone and reads back as exactly the intended settings, e.g. nested deeper than 64 levels, or removing HQ's entries would change what a repeated key resolves to: HQ never rewrites a file from a parsed copy), `backup_unusable` (the one-time copy beside the file, `settings.json.agent-productivity-backup`, is empty or is not a settings file: nothing was changed or overwritten, `details.files` names that file, home-relative, and the message tells the owner to look at it), `not_writable` (also: the one-time backup could not be proven, the file is read-only, not the owner's, in a folder that cannot be written, or has a hard link HQ was not given) or `unsupported_path` (HQ's data folder or Node path has a control character, a lone surrogate or more than 1,024 characters, so no command can be built and read back; spaces, quotes, `$`, backticks, backslashes and any other characters are supported). The message is fixed: it never carries the file's text or an absolute path (`backup_unusable` names the copy, home-relative, as `rollback_failed` names its files). When a failed change could not take back everything HQ had written (the owner saved over it, or it could not be removed) `details.left` names it (`script`, `registry`, `backup`, `temp`), and the message says so; HQ never deletes a file that is no longer exactly what it wrote. **Every refusal of the action, whatever its code (this one, `claude_settings_conflict`, `claude_hooks_unavailable`, `claude_hooks_stale`, `claude_hooks_failed`), carries the same `details.left` and the same closing sentence whenever anything was left behind**: one builder makes them all, and the page shows the message. |
  | `claude_hooks_unavailable` | 422 | `PUT /api/hq/claude-hooks`: this session has no Claude Code integration, or HQ found no Claude Code folder on this computer. |
  | `claude_hooks_stale` | 409 | `PUT /api/hq/claude-hooks`: the request carried no `preview`, or one that is not the current fingerprint of what the change would do (a settings file, the script or the plan changed since the owner was shown it). Nothing was written; read the preview again. The message is fixed. |
  | `claude_hooks_failed` | 500 | `GET` or `PUT /api/hq/claude-hooks`: `details.reason` is `unreadable` (the status could not be read at all), `registry_failed` (the running app could not publish where it listens, so nothing was turned on and every file is as it was) or `rollback_failed` (a change failed part-way and a settings file could not be put back: `details.files` names each such file, home-relative, and the message repeats it; a copy of the original is saved beside it). |
  | `upstream_unavailable` | 502 | GitHub, Codex app-server or Paseo failed. `retryable: true`. |
  | `internal` | 500 | Unexpected. Logged with a correlation id returned in `details.correlationId`. |
- **Caching:** all responses are `Cache-Control: no-store`. Freshness is explicit in payloads (`lastSuccessAt`).
- **Idempotency:**
  - `PUT` and `DELETE` are idempotent.
  - `POST /api/repos` with an already-active repo returns `409 already_tracked` and doesn't duplicate (P-15). With a *stopped* repo it reactivates it (P-18).
  - `POST /api/refresh` while one runs returns `409` with the running id.

## Endpoints at a glance

| Method and path | Purpose | Screen / flow |
| --- | --- | --- |
| `GET /api/health` | Liveness, version, schema version | boot |
| `GET /api/bootstrap` | Setup state, report timezone, today, lookback, GitHub login, issue count | app shell |
| `GET /api/overview` | KPIs, coverage strip, account cards, repo table, recent merges | Overview |
| `GET /api/series` | Aligned chart buckets with coverage | Overview chart, Trends chart, table view |
| `GET /api/year` | Daily merge counts for the 12-month grid | Trends › A year of merges |
| `GET /api/records` | PRs and sessions inside one bucket | Records drawer, Trends records |
| `GET /api/prs` | Merged PR table with link-basis counts | Delivery |
| `GET /api/prs/{prId}` | Evidence items and candidate sessions | Delivery › expanded PR |
| `PUT` / `DELETE /api/prs/{prId}/links/{sessionId}` | Owner link decision / undo | Delivery evidence actions |
| `GET /api/usage/categories` | Per-provider token category ledgers | Usage ledgers |
| `GET /api/usage/groups` | Repo, Untracked and Unknown group summaries | Usage tree (collapsed) |
| `GET /api/usage/groups/{groupKey}/roots` | Roots with children and unknown-relationship sessions, paged | Usage tree (expanded) |
| `GET /api/models` | Token share per model within each provider | Trends › tokens by model |
| `GET /api/sources` | Local sources, accounts, GitHub, refresh state | Sources & repos, coverage strip, banner |
| `GET /api/hq` | Live roster of agents on this machine, grouped into sessions, plus each feed's status. Polled every 2 s while visible; no SSE | HQ |
| `GET /api/hq/claude-hooks`, `PUT /api/hq/claude-hooks` | Preview, and turn on or off, the Claude Code hooks that tell HQ exactly when an agent needs the owner (the owner's opt-in switch) | Sources & repos › Know when Claude Code needs you, and the first-visit HQ dialog |
| `POST /api/hq/hooks/claude` | What Claude Code's hook script posts: five fields and a bearer token. Loopback listener only, never the browser's | The hook script |
| `POST /api/refresh`, `GET /api/refresh/{runId}` | Start or poll a refresh | App bar Refresh, banner Retry, source Retry |
| `GET` / `POST /api/repos`, `DELETE /api/repos/{owner}/{name}`, `POST /api/repos/{owner}/{name}/recheck` | Tracked repo management | Sources & repos, Setup step 3 |
| `POST /api/accounts/{account}/connect`, `GET /api/accounts/{account}/connect/{loginId}`, `POST /api/accounts/{account}/disconnect` | Provider-owned connection flows | Setup step 2, Sources |
| `PUT /api/accounts/github/app` | Save the GitHub App client ID (owner choice P2) | Setup step 2 / Sources, when gh isn't signed in |
| `POST /api/accounts/claude/plan-limits/check` | One account check, returning current status and the saved report | Sources › Show Claude plan limits |
| `GET /api/accounts/claude/usage-capture/preview`, `PUT /api/accounts/claude/usage-capture` | Read restoration instructions and verify legacy hook removal | Sources › Remove old status line |
| `GET /api/repos/discover` | One page of repository metadata for the specified connected account | Setup and Sources › Find a repository |
| `POST /api/setup/discover`, `POST /api/setup/complete` | First-launch flow | Setup |
| `POST /api/setup/reset` | Clear local state and return to onboarding | Sources & repos |

## OpenAPI 3.1

```yaml
openapi: 3.1.0
info:
  title: Agent Productivity HQ local API
  version: 0.1.0-proposed
  description: Same-origin JSON API served by Agent Productivity HQ on 127.0.0.1.
servers:
  - url: http://127.0.0.1:{port}
    variables: { port: { default: "4317" } }
components:
  parameters:
    start: { name: start, in: query, schema: { type: string, format: date } }
    end: { name: end, in: query, schema: { type: string, format: date } }
    gran: { name: gran, in: query, schema: { type: string, enum: [day, week, month] } }
    repos: { name: repos, in: query, description: comma-separated canonical owner/name ids, schema: { type: string } }
    provider: { name: provider, in: query, schema: { type: string, enum: [all, codex, claude], default: all } }
    author: { name: author, in: query, schema: { type: string, enum: [mine, all], default: mine } }
  headers:
    AgentProductivityRequest: { description: Required on non-GET requests, schema: { type: string, const: "1" } }
  responses:
    Error:
      description: Error envelope
      content: { application/json: { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } }
  schemas:
    ErrorEnvelope:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message, retryable]
          properties:
            code: { type: string, enum: [invalid_input, invalid_range, forbidden_origin, not_found, already_tracked, refresh_running, reset_in_progress, repo_inaccessible, github_not_connected, github_app_required, github_account_changed, claude_settings_unreadable, claude_statusline_unsupported, claude_settings_conflict, claude_hooks_blocked, claude_hooks_unavailable, claude_hooks_stale, claude_hooks_failed, upstream_unavailable, internal] }
            message: { type: string }
            retryable: { type: boolean }
            details: { type: object, additionalProperties: true }
    Provider: { type: string, enum: [codex, claude] }
    PaseoQuotaResponse:
      type: object
      required: [providers]
      properties:
        providers:
          type: array
          items:
            type: object
            required: [provider, source, usedPercent, resetsAt, refreshedAt, stale, canCheck, windows]
            properties:
              provider: { $ref: "#/components/schemas/Provider" }
              source: { anyOf: [{ type: string, enum: [paseo, direct] }, { type: "null" }] }
              usedPercent: { type: [number, "null"], description: Usage of the general seven-day subscription limit }
              resetsAt: { type: [string, "null"], format: date-time }
              refreshedAt: { type: [string, "null"], format: date-time }
              stale: { type: boolean }
              canCheck: { type: boolean, description: Paseo lacks a current general weekly reading for this provider }
              windows:
                type: array
                description: Weekly windows scoped to a model, feature, or surface
                items:
                  type: object
                  required: [id, label, usedPercent, resetsAt, source, refreshedAt, stale]
                  properties:
                    id: { type: string }
                    label: { type: string }
                    usedPercent: { type: number }
                    resetsAt: { type: [string, "null"], format: date-time }
                    source: { type: string, enum: [paseo, direct] }
                    refreshedAt: { type: [string, "null"], format: date-time }
                    stale: { type: boolean }
    Scope:
      type: object
      required: [start, end, gran, repos, provider, author, timezone]
      properties:
        start: { type: string, format: date }
        end: { type: string, format: date }
        gran: { type: string, enum: [day, week, month] }
        repos: { type: array, items: { type: string } }
        ignoredRepos: { type: array, items: { type: string } }
        provider: { type: string, enum: [all, codex, claude] }
        author: { type: string, enum: [mine, all] }
        timezone: { type: string, description: IANA zone of the report }
    UsageCoverage:
      description: >
        ok = covered and collected; partial = part of the bucket precedes available history;
        unavailable = entirely before available history; stale = after a failed refresh, not yet collected;
        none = source never found on this machine; future = bucket starts after today.
      type: string
      enum: [ok, partial, unavailable, stale, none, future]
    DeliveryCoverage:
      description: ok = tracked repos synced; syncing = initial backfill in progress; none = no tracked repos; future = after today.
      type: string
      enum: [ok, syncing, none, future]
    TokenCount:
      description: Provider headline total (owner rule r6). null when coverage is unavailable/none/future; 0 means covered with no activity.
      type: [integer, "null"]
    Bucket:
      type: object
      required: [start, end, label, short, prs, delivery, tokens, usage]
      properties:
        start: { type: string, format: date }
        end: { type: string, format: date }
        label: { type: string, example: "Mon, Nov 2, 2026" }
        short: { type: string, example: "Mon 2" }
        partOfRange: { type: boolean, description: true when the bucket is clipped by the selected range }
        prs: { type: [integer, "null"], description: null when delivery is none/future }
        delivery: { $ref: "#/components/schemas/DeliveryCoverage" }
        tokens:
          type: object
          properties: { codex: { $ref: "#/components/schemas/TokenCount" }, claude: { $ref: "#/components/schemas/TokenCount" } }
        usage:
          type: object
          description: per-provider coverage plus the combined rail value
          properties:
            codex: { $ref: "#/components/schemas/UsageCoverage" }
            claude: { $ref: "#/components/schemas/UsageCoverage" }
            rail: { $ref: "#/components/schemas/UsageCoverage" }
    SourceStatus:
      type: object
      required: [id, name, status]
      properties:
        id: { type: string, enum: [codex, claude, paseo, github], description: "M6: github is the PR sync's own row (its latest attempt, last success, rate-limit or reconnect message). The Sources page lists codex, claude and paseo under On this machine; github appears in the GitHub and tracked-repository sections and in the banner, Retry and issue count like any source." }
        name: { type: string }
        status: { type: string, enum: [checking, ok, partial, failed, notfound, denied, notrunning, needspassword] }
        location: { type: [string, "null"], description: path or URL shown in mono }
        oldestDate: { type: [string, "null"], format: date }
        sessions: { type: [integer, "null"] }
        hasRetainedData: { type: boolean, description: "Whether the local database still has records from this source. This covers recorded usage, merged PRs, or stored Paseo agent metadata. If omitted, the client makes no retained-data claim." }
        unreadable: { type: integer }
        unsupported: { type: integer }
        lastSuccessAt: { type: [string, "null"], format: date-time }
        lastAttemptAt: { type: [string, "null"], format: date-time }
        lastAttemptResult: { type: [string, "null"], enum: [succeeded, partial, failed, null] }
        consecutiveFailures: { type: integer, minimum: 0, description: "T5. Failed attempts in a row since the last attempt that was not a failure. 0 after any succeeded or partial attempt. The client words the banner's attempt line from it: 1 → 'refresh failed <day>, <time>'; 2 or more → 'refresh failed again <day>, <time>' (Design D7 Retry outcome). 'Today' when lastAttemptAt falls on today's report-timezone date, else the date." }
        staleAfter: { type: [string, "null"], format: date, description: last date fully collected before a failed refresh }
        message: { type: [string, "null"], description: one plain sentence, no file content }
        retentionNote: { type: [string, "null"], example: "Claude Code keeps transcripts for 30 days unless you change cleanupPeriodDays." }
    AccountStatus:
      type: object
      required: [id, name, status]
      properties:
        id: { type: string, enum: [github, chatgpt, claude] }
        name: { type: string }
        status: { type: string, enum: [existing, connected, notconnected, needsapp, reconnect, unavailable, connecting, failed] }
        statusText: { type: string }
        login: { type: [string, "null"], description: GitHub login (github only) }
        via: { type: [string, "null"], enum: [gh, app, codex, statusline, claude_code, null] }
        planLimits:
          type: object
          required: [state, lastCheckedAt, retryAt, report]
          properties:
            state: {type: string, enum: [unchecked, ok, signed_out, credential_denied, unsupported, reconnect, limited, failed]}
            lastCheckedAt: {type: [string, "null"], format: date-time}
            retryAt: {type: [string, "null"], format: date-time}
            report: {anyOf: [{$ref: "#/components/schemas/AccountReport"}, {type: "null"}]}
        appClientIdSaved: { type: [boolean, "null"], description: github only; true once a GitHub App client ID is stored }
        captureEnabled: { type: [boolean, "null"], description: claude only; legacy field, false after retirement }
        captureHealth:
          type: [object, "null"]
          description: claude only. Recorded state for guided removal of a legacy status line.
          required: [phase, state, recorded]
          properties:
            phase: { type: string, enum: [off, awaiting_edit, active, awaiting_removal, needs_attention] }
            recorded: { type: boolean }
            state: { type: string, enum: [off, awaiting_edit, awaiting_removal, waiting, ok, no_limits, idle, replaced, node_missing, settings_unreadable, profile_changed, state_unreadable, legacy_unverified] }
            lastInvokedAt: { type: [string, "null"], format: date-time }
            capturedAt: { type: [string, "null"], format: date-time }
            settingsPath: { type: [string, "null"], description: the recorded Claude Code settings file }
            projectOverrides: { type: integer, description: known project directories that define their own statusLine (presence only) }
            backupPath: { type: [string, "null"], description: path of a retained legacy backup }
        reason: { type: [string, "null"], description: "why the card is not plainly connected; github uses keychain_refused, reconnect, login_mismatch", example: "Claude doesn't offer account usage to other apps." }
    AccountReport:
      type: object
      required: [account, unit, scopeLabel, refreshedAt]
      properties:
        account: { type: string, enum: [chatgpt, claude], description: "Claude reports contain saved subscription windows or legacy readings; always unit percent" }
        unit: { type: string, enum: [tokens, percent] }
        periodTokens: { type: [integer, "null"], description: sum of daily buckets inside the selected period; null if buckets absent }
        bucketSpan: { type: [object, "null"], properties: { start: { type: string, format: date }, end: { type: string, format: date } }, description: dates actually covered by returned buckets }
        rateLimits:
          type: array
          items: { type: object, required: [limitId, usedPercent], properties: { limitId: { type: string }, label: { type: [string, "null"] }, usedPercent: { type: number }, windowMinutes: { type: [integer, "null"] }, resetsAt: { type: [string, "null"], format: date-time } } }
        provenance: {type: string, enum: [claude_code_oauth, claude_statusline]}
        scopeLabel: { type: string, example: "ChatGPT subscription plan limits" }
        localSameWindow: { type: [integer, "null"], description: this machine's Codex provider_total over the same dates; shown beside, never added }
        windowDiffers: { type: boolean }
        refreshedAt: { type: string, format: date-time, description: The fetch time of the displayed window for the ChatGPT weekly report }
        stale: { type: boolean, description: The ChatGPT weekly report is stale after a failed quota read or when the saved window expires }
    Session:
      type: object
      required: [id, provider, kind, nameLead, named, providerSessionRef, tokens, startedAt, startedBasis, firstEventAt, lastEventAt, linkStatus, linkedPrs]
      properties:
        id: { type: integer }
        provider: { $ref: "#/components/schemas/Provider" }
        kind: { type: string, enum: [root, child, unknown] }
        relationshipLabel: { type: string, enum: ["Root session", "Native subagent", "Paseo child agent", "Unknown relationship"] }
        nameLead: { type: string, description: recorded name, else relationshipLabel (never invented) }
        named: { type: boolean }
        nameSource: { type: [string, "null"], enum: [provider_title, paseo, null] }
        paseo: { type: [object, "null"], properties: { agentId: { type: string }, workspace: { type: [string, "null"] } } }
        providerSessionRef: { type: string, description: shortened id shown as "Session ID:" }
        repo: { type: [string, "null"] }
        repoGroup: { type: string, enum: [tracked, untracked, unknown] }
        model: { type: string }
        tokens: { type: integer, description: provider_total within the requested scope }
        startedAt:
          type: string
          format: date-time
          description: "T5. The one session time the UI shows, labelled 'Started' everywhere (Design D7: usage tree row and phone card, record lists, Delivery evidence item, add-link options). Set once from the source's own start record, never recomputed from retained events, so retention pruning cannot move it later. See data-and-sources › Session start time."
        startedBasis:
          type: string
          enum: [source_start, first_event]
          description: "source_start = the provider's recorded session or thread creation time. first_event = that was not available, so the earliest usage event time is used. The UI shows the same 'Started' label for both and puts 'First recorded activity; this source doesn't record a start time' in the time's accessible description when the basis is first_event."
        firstEventAt: { type: string, format: date-time, description: earliest retained usage event. Internal to windows and tie-breaks; not shown as a label. }
        lastEventAt: { type: string, format: date-time, description: latest usage event. Used for suggestion windows; not shown as a label (Product defers an activity range). }
        parentId: { type: [integer, "null"] }
        childCount: { type: integer }
        linkStatus:
          type: string
          enum: [linked, unlinked, repo_not_tracked, repo_unknown, prs_not_collected]
          description: >
            T5 (Design D5 usage-link-status). How to word the Linked PRs cell.
            linked = at least one effective evidence, owner or suggested link (listed in linkedPrs).
            unlinked = repo is tracked and its PRs were collected, and no effective link exists. This is the only state that may say 'Unlinked'.
            repo_not_tracked = session repo is a GitHub repo that is not an active tracked repo: 'Repo not tracked, so PRs not checked'.
            repo_unknown = no repo recorded: 'No repo recorded, so PRs not checked'.
            prs_not_collected = repo is tracked but its PRs could not be checked yet (access inaccessible, or first backfill not complete): the UI says so in words and never says Unlinked. Copy for this case is not in the D7 design (returned to Design); interim 'PRs for this repo aren't collected yet'.
        linkedPrs:
          type: array
          description: Effective links only, ordered evidence, then owner, then suggested, then newest merge first. Links marked incorrect or dismissed are not listed. Empty unless linkStatus is linked.
          items:
            type: object
            required: [prId, repo, number, mergedAt, class]
            properties:
              prId: { type: string }
              repo: { type: string }
              number: { type: integer }
              mergedAt: { type: string, format: date-time, description: "When the PR merged. The Usage tree's #number link opens Delivery on that day (in the report timezone) with every author, so the PR is on the page it lands on." }
              class: { type: string, enum: [evidence, owner, suggested], description: "same vocabulary and badge as Delivery: Evidence link, Owner-confirmed, Suggested" }
    LinkClass: { type: string, enum: [evidence, owner, suggested, unlinked] }
    PullRequest:
      type: object
      required: [id, repo, number, title, url, mergedAt, author, mergedBy, authoredByMe, linkClass, linkedSessionCount, suggestedCount, providers]
      properties:
        id: { type: string, description: GitHub node id }
        repo: { type: string }
        number: { type: integer }
        title: { type: string }
        url: { type: string, format: uri }
        mergedAt: { type: string, format: date-time }
        author: { type: [string, "null"] }
        mergedBy: { type: [string, "null"] }
        authoredByMe: { type: boolean }
        linkClass: { $ref: "#/components/schemas/LinkClass" }
        linkedSessionCount: { type: integer, description: evidence + owner links }
        suggestedCount: { type: integer }
        providers: { type: array, items: { $ref: "#/components/schemas/Provider" } }
    EvidenceItem:
      type: object
      required: [session, effectiveClass, basis, basisText, actions]
      properties:
        session: { $ref: "#/components/schemas/Session" }
        effectiveClass: { type: string, enum: [evidence, owner, suggested, rejected] }
        sourceClass: { type: [string, "null"], enum: [evidence, suggested, null], description: computed claim kept even when overridden }
        basis: { type: string, enum: [pr_reference, commit_match, same_branch, same_repo_window, owner] }
        basisText: { type: string }
        actions: { type: array, items: { type: string, enum: [confirm, dismiss, reject, restore, remove] } }
    Repo:
      type: object
      required: [id, displayName, trackingState, accessState]
      properties:
        githubNodeId: {type: [string, "null"]}
        id: { type: string }
        displayName: { type: string }
        trackingState: { type: string, enum: [active, stopped] }
        accessState: { type: string, enum: [ok, inaccessible, unknown] }
        accessError: { type: [string, "null"] }
        mergedPrsLast12Months: { type: integer }
        backfillComplete: { type: boolean }
        lastSyncSuccessAt: { type: [string, "null"], format: date-time }
        stoppedAt: { type: [string, "null"], format: date-time }
    LinkHealth:
      type: object
      required: [state, lastSuccessfulAt]
      properties:
        state: { type: string, enum: [fresh, stale, unavailable], description: Stale keeps the previous computed result. Unavailable means there is no usable rebuild. }
        lastSuccessfulAt: { type: [string, "null"], format: date-time }
    RefreshRun:
      type: object
      required: [id, state, startedAt, sources, linkRebuild]
      properties:
        id: { type: integer }
        state: { type: string, enum: [running, succeeded, partial, failed, interrupted] }
        startedAt: { type: string, format: date-time }
        finishedAt: { type: [string, "null"], format: date-time }
        linkRebuild: { type: [string, "null"], enum: [pending, succeeded, failed, interrupted, null], description: The computed-link stage result for this run. Null when links were already fresh or the run has no recorded stage. A failed rebuild with a successful import yields a partial run. }
        sources:
          type: object
          additionalProperties:
            type: object
            properties:
              state: { type: string, enum: [queued, running, succeeded, partial, failed, skipped] }
              imported: { type: integer }
              duplicatesSkipped: { type: integer }
              unreadable: { type: integer }
              message: { type: [string, "null"] }
    HqAgent:
      description: >
        One coding agent on this machine. No prompt, response, tool name or argument, permission detail or error text is ever part
        of it: `activity` is a coarse category, never a tool name. `parentId` is set only when the parent is on the roster;
        `parentAway` says the agent has a parent that is not.
      type: object
      required: [id, provider, kind, parentId, parentBasis, parentAway, title, repo, workspace, state, activity, waitReason, confidence, since, lastActivityAt, startedAt, seenBy]
      properties:
        id: { type: string, description: opaque and stable while the agent is on the roster }
        paseoAgentId: { type: string, description: same-host Paseo navigation target when known in a managed installation }
        reviewPending: { type: boolean, description: true for an unread Paseo completion or error and false for an acknowledged Paseo error }
        backgroundWorkActive: { type: boolean, description: Paseo reports work that continues outside the foreground turn }
        confirmedEmpty: { type: boolean, description: empty thread retained to link its descendants }
        provider: { type: string, enum: [codex, claude, other] }
        kind: { type: string, enum: [root, child] }
        parentId: { type: [string, "null"] }
        parentBasis: { type: [string, "null"], enum: [native, paseo, null], description: where the parent link came from }
        parentAway: { type: boolean }
        title: { type: [string, "null"] }
        repo: { type: [string, "null"], description: owner/name }
        workspace: { type: [string, "null"] }
        state: { type: string, enum: [starting, working, waiting, idle, error, finished] }
        activity: { type: string, enum: [thinking, responding, reading, editing, command, delegating, planning, tool, none] }
        waitReason: { type: [string, "null"], enum: [permission, question, plan_approval, null] }
        confidence: { type: string, enum: [reported, inferred], description: reported by the provider or Paseo; inferred from a transcript's silence }
        since: { type: string, format: date-time, description: when state last changed }
        lastActivityAt: { type: string, format: date-time }
        startedAt: { type: [string, "null"], format: date-time }
        seenBy:
          type: object
          required: [paseo, transcript]
          properties: { paseo: { type: boolean }, transcript: { type: boolean } }
    HqFeed:
      description: >
        One source of the live roster and whether it is running, so an empty HQ can say why it is empty. `unavailable` is a source this
        process has no feeder for (Paseo's source off, or a process that does not read this machine's Claude Code and Codex transcripts).
      type: object
      required: [id, status]
      properties:
        id: { type: string, enum: [paseo, claude, codex] }
        status: { type: string, enum: [unavailable, setup_incomplete, starting, live, notrunning, needspassword, notfound, denied, failed] }
    HqResponse:
      type: object
      required: [generatedAt, feeds, agents, truncated, exactPrompts]
      properties:
        generatedAt: { type: string, format: date-time }
        feeds: { type: array, items: { $ref: "#/components/schemas/HqFeed" } }
        agents: { type: array, items: { $ref: "#/components/schemas/HqAgent" } }
        truncated: { type: boolean, description: the roster was cut to its cap }
        exactPrompts:
          type: string
          enum: [off, on, needs_repair, unavailable]
          description: >
            Whether Claude Code's hooks (the owner's opt-in switch, `PUT /api/hq/claude-hooks`) tell HQ exactly when an agent outside
            Paseo is waiting. `off`: not turned on. `on`: HQ's entries are in the Claude Code settings and match this app. `needs_repair`:
            HQ's entries are there but no longer match (an upgrade, a moved data folder, a missing script). `unavailable`: this process has
            no Claude Code integration, no Claude Code folder was found, or a settings file cannot be changed. It words the page; the
            roster's own `confidence` says which agents were reported.
    ClaudeHooksStatus:
      description: >
        The preview and the status of the switch, computed from what is on disk now. `files` are the user-level `settings.json` of every
        Claude Code folder that exists (`$CLAUDE_CONFIG_DIR`, else `~/.config/claude` and `~/.claude`), shown home-relative; a project's
        settings are never changed. `events` are the hook events that get an entry. `command` is the exact command each entry runs
        (empty when HQ cannot build one: `unsupported_path`). Nothing here carries the file's own text, a token or a log. `plans` has
        one entry per action the state offers: off offers `on` (and `off` too when `leftover` is set, to try the removal again); on
        offers `off`; needs_repair offers `repair` and `off`; unavailable offers none.
      type: object
      required: [state, reason, files, events, command, preview, plans, leftover, ownFolder]
      properties:
        state: { type: string, enum: [off, on, needs_repair, unavailable] }
        reason:
          type: [string, "null"]
          enum: [no_claude_folder, settings_blocked, unsupported_path, entries_changed, script_missing, node_missing, registry_unpublished, cleanup_incomplete, null]
          description: >
            Why the state is `unavailable` (`no_claude_folder`; `settings_blocked`: see `files`; `unsupported_path`: HQ's data folder or
            Node path cannot be put in a shell command and read back), `needs_repair` (`entries_changed`: HQ's entries are not exactly
            what this app writes, including a handler of HQ's inside a group with a matcher or beside the owner's handlers;
            `script_missing`: the hook script is missing, differs, or is not a file the command can run and nobody else can change;
            `node_missing`: the Node the command names cannot be run (repair cannot fix this: only `off` is offered; restart HQ);
            `registry_unpublished`: the running app has not published where it listens, or the registry is one the installed hook
            script would refuse (the script's own rules are applied), so a hook could not reach it; `unsupported_path` with entries present: only turning off is offered) or `off` with
            `cleanup_incomplete` (HQ's entries are gone from the settings but its own script or registry could not be removed: see
            `leftover`). `null` when `off` with nothing left, or `on`. `on` means all of: every file holds exactly HQ's complete,
            unfiltered entries, the script is there with this app's content in a file the command can run and nobody else can change,
            the Node the command names can run, and (once the server listens) the registry is one the installed hook script accepts
            (the same rules, applied by one function) and says this process's pid, port and token.
        files:
          type: array
          items: { $ref: "#/components/schemas/ClaudeHooksFile" }
        events: { type: array, items: { type: string, enum: [PermissionRequest, Notification, Stop, SessionStart, SessionEnd] } }
        command: { type: string }
        preview:
          type: string
          pattern: "^[0-9a-f]{64}$"
          description: >
            The fingerprint of the first action the state offers (the same as that action's `plans[...].preview`); with none offered, of
            turning on, so a request is answered by why it cannot be made rather than as stale. It is not a secret and not an
            authorisation: it says only that the write is the one that was shown.
        plans:
          type: object
          properties:
            on: { $ref: "#/components/schemas/ClaudeHooksPlan" }
            off: { $ref: "#/components/schemas/ClaudeHooksPlan" }
            repair: { $ref: "#/components/schemas/ClaudeHooksPlan" }
        leftover:
          type: [object, "null"]
          required: [folder, items]
          description: >
            HQ's own files still in its hook folder while the switch is `off` (`reason: cleanup_incomplete`); null otherwise.
          properties:
            folder: { type: string, description: "HQ's hook folder, home-relative where it can be" }
            items: { type: array, items: { type: string, enum: [script, registry] } }
        ownFolder: { type: string, description: "HQ's hook folder as the owner knows it (home-relative where it can be): where `ownFiles` and `leftover` are" }
    ClaudeHooksFile:
      type: object
      required: [path, exists, state, reason]
      properties:
        path: { type: string, description: "home-relative (~/.claude/settings.json) when under the home folder, else absolute" }
        exists: { type: boolean, description: a missing file is created when the switch is turned on }
        state: { type: string, enum: [absent, present, needs_repair, blocked], description: "absent: no HQ entry; present: HQ's five entries exactly as previewed; needs_repair: some HQ entry that does not match; blocked: it cannot be changed (or, in a plan, the action's edit cannot be made)" }
        reason: { type: [string, "null"], enum: [unreadable, not_json, not_an_object, unsupported_shape, unsupported_layout, not_writable, backup_unusable, null] }
    ClaudeHooksPlan:
      description: >
        What confirming ONE action would do, computed from the files as they are now. `files` are the settings files the action writes
        (turn on: every file that gets entries; repair: every file whose entries are replaced or added; turn off: only the files that
        hold HQ's entries), each blocked with a `reason` when HQ cannot make that change. `ownFiles` are HQ's own files, in `ownFolder`,
        the action writes (on, repair) or deletes (off); the plan is exact (what the action writes, replaces or deletes is exactly what is
        listed, plus the one-time copy of a settings file it replaces, and a file that is not listed is not touched). `preview` is this
        action's fingerprint (sha256) of the plan, the command, the observed condition of HQ's own files (the script, the Node, the
        registry, what is left behind) and the bytes of every settings file it was computed from; another action has another one for
        the very same files. `PUT` sends it back.
      type: object
      required: [preview, files, ownFiles]
      properties:
        preview: { type: string, pattern: "^[0-9a-f]{64}$" }
        files: { type: array, items: { $ref: "#/components/schemas/ClaudeHooksFile" } }
        ownFiles: { type: array, items: { type: string, enum: [script, registry] } }
paths:
  /api/paseo-handoff:
    post:
      description: Managed Tailscale listener only. Exchanges a single-use Paseo launch ticket for a report and management credential.
      parameters:
        - { name: X-Agent-Productivity-Request, in: header, required: true, schema: { const: "1" } }
        - { name: Origin, in: header, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [ticket]
              properties:
                ticket: { type: string, pattern: "^[A-Za-z0-9_-]{43}$" }
      responses:
        "200":
          description: Scoped browser credential
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [credential]
                properties:
                  credential: { type: string, pattern: "^[A-Za-z0-9_-]{43}$" }
        "400": { $ref: "#/components/responses/Error" }
        "401": { $ref: "#/components/responses/Error" }
        "403": { $ref: "#/components/responses/Error" }
        "413": { $ref: "#/components/responses/Error" }
        "421": { $ref: "#/components/responses/Error" }
        "503": { $ref: "#/components/responses/Error" }
  /api/health:
    get:
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: object, properties: { status: { const: ok }, version: { type: string }, schemaVersion: { type: integer } } } } } }
  /api/bootstrap:
    get:
      responses:
        "200":
          description: App shell state
          content:
            application/json:
              schema:
                type: object
                required: [setupComplete, timezone, today, lookbackStart, issues]
                properties:
                  setupComplete: { type: boolean }
                  timezone: { type: string }
                  today: { type: string, format: date }
                  lookbackStart: { type: string, format: date, description: today minus 365 days }
                  githubLogin: { type: [string, "null"] }
                  greetingName: { type: [string, "null"], description: GitHub profile name's first word if set, else null (UI then greets without a name) }
                  paseoManaged: { const: true, description: The session uses Paseo provider quota reports }
                  issues: { type: array, items: { type: object, properties: { kind: { type: string, enum: [source, account, repo] }, id: { type: string }, label: { type: string } } } }
  /api/overview:
    get:
      description: The standalone ChatGPT entry in accounts contains one verified general Codex quota window of 10080 minutes with unit percent. The report is independent of the filters and is omitted when no verified weekly reading is available. If the refresh leaves the general weekly window unreadable, the last verified reading keeps its original fetch time and becomes stale. Managed sessions use /api/paseo-quota and receive an empty accounts array here.
      parameters: [ { $ref: "#/components/parameters/start" }, { $ref: "#/components/parameters/end" }, { $ref: "#/components/parameters/repos" }, { $ref: "#/components/parameters/provider" }, { $ref: "#/components/parameters/author" } ]
      responses:
        "200":
          description: Overview payload
          content:
            application/json:
              schema:
                type: object
                required: [scope, kpis, coverage, accounts, repoRows, recentPrs, linkHealth]
                properties:
                  scope: { $ref: "#/components/schemas/Scope" }
                  linkHealth: { $ref: "#/components/schemas/LinkHealth" }
                  kpis:
                    type: object
                    properties:
                      mergedPrs: { type: object, properties: { value: { type: [integer, "null"] }, delivery: { $ref: "#/components/schemas/DeliveryCoverage" }, previous: { type: object, properties: { label: { type: string }, value: { type: [integer, "null"] }, outsideLookback: { type: boolean } } } } }
                      linkedPrs: { type: object, properties: { value: { type: [integer, "null"] }, of: { type: [integer, "null"] }, suggestedOnly: { type: integer } } }
                      localTokens: { type: object, additionalProperties: false, properties: { codex: { $ref: "#/components/schemas/ProviderKpi" }, claude: { $ref: "#/components/schemas/ProviderKpi" } } }
                      rootSessions: { type: object, properties: { value: { type: [integer, "null"] }, unknownRelationship: { type: integer }, crew: { type: array, items: { $ref: "#/components/schemas/Provider" }, maxItems: 10 } } }
                      childAgents: { type: object, properties: { value: { type: [integer, "null"] }, paseo: { type: integer }, native: { type: integer }, crew: { type: array, items: { $ref: "#/components/schemas/Provider" }, maxItems: 10 } } }
                  coverage: { type: object, properties: { sources: { type: array, items: { $ref: "#/components/schemas/SourceStatus" } }, github: { type: object, properties: { tracked: { type: integer }, inaccessible: { type: integer } } }, accounts: { type: array, items: { $ref: "#/components/schemas/AccountStatus" } }, lastRefreshAt: { type: [string, "null"], format: date-time }, refreshFailed: { type: boolean } } }
                  accounts: { type: array, items: { $ref: "#/components/schemas/AccountReport" } }
                  repoRows: { type: array, items: { type: object, properties: { group: { type: string, enum: [tracked, untracked, unknown] }, repo: { type: [string, "null"] }, accessState: { type: string }, mergedPrs: { type: [integer, "null"] }, linkedPrs: { type: [integer, "null"] }, tokens: { type: object, properties: { codex: { $ref: "#/components/schemas/TokenCount" }, claude: { $ref: "#/components/schemas/TokenCount" } } }, rootSessions: { type: integer } } } }
                  recentPrs: { type: array, maxItems: 6, items: { $ref: "#/components/schemas/PullRequest" } }
                  periodMergedCount: { type: integer }
                  trueZero: { type: boolean, description: every in-scope source covered the whole elapsed range and there were no events or merges (quiet panel) }
        "400": { $ref: "#/components/responses/Error" }
  /api/paseo-quota:
    get:
      description: Read the managed Paseo session's weekly subscription percentages, independent of local token counts and roster availability. A passive read uses the daemon or retains the result of a prior explicit check.
      responses:
        "200": { description: Codex and Claude quota readings, content: { application/json: { schema: { $ref: "#/components/schemas/PaseoQuotaResponse" } } } }
        "404": { $ref: "#/components/responses/Error" }
  /api/paseo-quota/{provider}/check:
    post:
      description: Recheck Paseo and use the selected provider's existing sign-in for a direct limits check only when Paseo has no usable general weekly reading.
      parameters: [ { name: provider, in: path, required: true, schema: { $ref: "#/components/schemas/Provider" } }, { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      responses:
        "200": { description: Updated quota readings, content: { application/json: { schema: { $ref: "#/components/schemas/PaseoQuotaResponse" } } } }
        "404": { $ref: "#/components/responses/Error" }
  /api/series:
    get:
      parameters: [ { $ref: "#/components/parameters/start" }, { $ref: "#/components/parameters/end" }, { $ref: "#/components/parameters/gran" }, { $ref: "#/components/parameters/repos" }, { $ref: "#/components/parameters/provider" }, { $ref: "#/components/parameters/author" } ]
      responses:
        "200": { description: Buckets, content: { application/json: { schema: { type: object, required: [scope, buckets], properties: { scope: { $ref: "#/components/schemas/Scope" }, buckets: { type: array, items: { $ref: "#/components/schemas/Bucket" } }, unavailableText: { type: [string, "null"], example: "History unavailable before Mar 14, 2026" } } } } } }
        "400": { $ref: "#/components/responses/Error" }
  /api/year:
    get:
      parameters: [ { $ref: "#/components/parameters/repos" }, { $ref: "#/components/parameters/author" } ]
      responses:
        "200": { description: 12-month daily merge counts (delivery only), content: { application/json: { schema: { type: object, required: [start, today, counts, total, daysWithMerge], properties: { start: { type: string, format: date }, today: { type: string, format: date }, counts: { type: object, additionalProperties: { type: integer }, description: date -> merged PRs; absent date = covered zero } , total: { type: integer }, daysWithMerge: { type: integer }, busiestDay: { type: [object, "null"], properties: { date: { type: string, format: date }, count: { type: integer } } }, delivery: { $ref: "#/components/schemas/DeliveryCoverage" } } } } } }
  /api/records:
    get:
      parameters: [ { $ref: "#/components/parameters/start" }, { $ref: "#/components/parameters/end" }, { $ref: "#/components/parameters/repos" }, { $ref: "#/components/parameters/provider" }, { $ref: "#/components/parameters/author" }, { name: limit, in: query, schema: { type: integer, default: 30, maximum: 100 } } ]
      description: start/end here are one bucket's dates, as /api/series gives them. A bucket that runs past today is read as it is (nothing exists after today; coverage is judged over the elapsed days). limit cuts each list, never the totals; a limit outside 1..100 is 400 invalid_input with details.fields.limit.
      responses:
        "200": { description: Records in a bucket, content: { application/json: { schema: { type: object, properties: { scope: { $ref: "#/components/schemas/Scope" }, prs: { type: array, items: { $ref: "#/components/schemas/PullRequest" } }, prTotal: { type: integer }, sessions: { type: array, items: { $ref: "#/components/schemas/Session" } }, sessionTotal: { type: integer }, coverage: { type: object, properties: { codex: { $ref: "#/components/schemas/UsageCoverage" }, claude: { $ref: "#/components/schemas/UsageCoverage" }, delivery: { $ref: "#/components/schemas/DeliveryCoverage" } } } } } } } }
        "400": { $ref: "#/components/responses/Error" }
  /api/prs:
    get:
      parameters: [ { $ref: "#/components/parameters/start" }, { $ref: "#/components/parameters/end" }, { $ref: "#/components/parameters/repos" }, { $ref: "#/components/parameters/author" }, { name: linkClass, in: query, schema: { type: string, enum: [all, evidence, owner, suggested, unlinked], default: all } }, { name: q, in: query, schema: { type: string, maxLength: 200 } }, { name: cursor, in: query, schema: { type: string } }, { name: limit, in: query, schema: { type: integer, default: 50, maximum: 200 } } ]
      responses:
        "200": { description: Merged PRs ordered by mergedAt desc, content: { application/json: { schema: { type: object, required: [linkHealth], properties: { scope: { $ref: "#/components/schemas/Scope" }, linkHealth: { $ref: "#/components/schemas/LinkHealth" }, counts: { type: object, properties: { all: { type: integer }, evidence: { type: integer }, owner: { type: integer }, suggested: { type: integer }, unlinked: { type: integer } } }, items: { type: array, items: { $ref: "#/components/schemas/PullRequest" } }, nextCursor: { type: [string, "null"] }, inaccessibleRepos: { type: array, items: { type: string } } } } } } }
  /api/prs/{prId}:
    get:
      parameters: [ { name: prId, in: path, required: true, schema: { type: string } } ]
      responses:
        "200": { description: Evidence detail, content: { application/json: { schema: { type: object, properties: { pr: { $ref: "#/components/schemas/PullRequest" }, evidence: { type: array, items: { $ref: "#/components/schemas/EvidenceItem" } }, candidates: { type: array, maxItems: 30, description: local sessions in the same repo up to 3 days before merge, not already listed, items: { $ref: "#/components/schemas/Session" } } } } } } }
        "404": { $ref: "#/components/responses/Error" }
  /api/prs/{prId}/links/{sessionId}:
    put:
      description: Record an owner decision. Idempotent. Never alters the computed source claim. Confirm and Link a session send confirmed, Dismiss sends dismissed, Mark incorrect sends rejected; Restore, Remove link and every Undo are the DELETE below or a PUT of the decision the pair had before (TECH › Owner link decision transitions). A change the transition table does not allow from the pair’s current state is 400 invalid_input; an unknown PR or session is 404 not_found.
      parameters: [ { name: prId, in: path, required: true, schema: { type: string } }, { name: sessionId, in: path, required: true, schema: { type: integer } }, { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      requestBody: { required: true, content: { application/json: { schema: { type: object, required: [decision], properties: { decision: { type: string, enum: [confirmed, rejected, dismissed] } } } } } }
      responses:
        "200": { description: Updated item, content: { application/json: { schema: { $ref: "#/components/schemas/EvidenceItem" } } } }
        "400": { $ref: "#/components/responses/Error" }
        "404": { $ref: "#/components/responses/Error" }
    delete:
      description: Take the owner decision back (Restore, Remove link, and the Undo of Confirm, Dismiss, Mark incorrect or Link a session). The computed class shows again. Idempotent; 204 even if no decision existed.
      parameters: [ { name: prId, in: path, required: true, schema: { type: string } }, { name: sessionId, in: path, required: true, schema: { type: integer } }, { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      responses: { "204": { description: removed } }
  /api/usage/categories:
    get:
      parameters: [ { $ref: "#/components/parameters/start" }, { $ref: "#/components/parameters/end" }, { $ref: "#/components/parameters/repos" }, { $ref: "#/components/parameters/provider" } ]
      responses:
        "200":
          description: Per-provider ledgers
          content:
            application/json:
              schema:
                type: object
                properties:
                  scope: { $ref: "#/components/schemas/Scope" }
                  codex: { type: object, properties: { coverage: { $ref: "#/components/schemas/UsageCoverage" }, coveredFrom: { type: [string, "null"], format: date }, sessions: { type: integer }, input: { type: integer }, cachedInput: { type: integer, description: subset of input }, output: { type: integer }, reasoning: { type: integer, description: subset of output }, total: { type: integer, description: input + output } } }
                  claude: { type: object, properties: { coverage: { $ref: "#/components/schemas/UsageCoverage" }, coveredFrom: { type: [string, "null"], format: date }, sessions: { type: integer }, inputUncached: { type: integer }, cacheWrite: { type: integer }, cacheRead: { type: integer }, output: { type: integer }, total: { type: integer, description: sum of the four } } }
                  paseoNote: { type: [string, "null"], description: partial/unmapped Paseo note shown above the tree }
  /api/usage/groups:
    get:
      parameters: [ { $ref: "#/components/parameters/start" }, { $ref: "#/components/parameters/end" }, { $ref: "#/components/parameters/repos" }, { $ref: "#/components/parameters/provider" } ]
      responses:
        "200": { description: Group summaries, content: { application/json: { schema: { type: object, properties: { scope: { $ref: "#/components/schemas/Scope" }, groups: { type: array, items: { type: object, properties: { key: { type: string, description: "repo id, '__untracked' or '__unknown'" }, label: { type: string }, note: { type: [string, "null"] }, roots: { type: integer }, sessions: { type: integer }, tokens: { type: object, properties: { codex: { type: integer }, claude: { type: integer } } } } } } } } } } }
  /api/usage/groups/{groupKey}/roots:
    get:
      parameters: [ { name: groupKey, in: path, required: true, schema: { type: string } }, { $ref: "#/components/parameters/start" }, { $ref: "#/components/parameters/end" }, { $ref: "#/components/parameters/repos" }, { $ref: "#/components/parameters/provider" }, { name: cursor, in: query, schema: { type: string } }, { name: limit, in: query, schema: { type: integer, default: 15, maximum: 100 } } ]
      responses:
        "200": { description: Roots (newest first) with children; orphans whose parent is outside the filters; unknown-relationship sessions, content: { application/json: { schema: { type: object, properties: { roots: { type: array, items: { allOf: [ { $ref: "#/components/schemas/Session" }, { type: object, properties: { children: { type: array, items: { $ref: "#/components/schemas/Session" } } } } ] } }, orphans: { type: array, items: { $ref: "#/components/schemas/Session" } }, unknownRelationship: { type: array, items: { $ref: "#/components/schemas/Session" } }, nextCursor: { type: [string, "null"] }, remaining: { type: integer } } } } } }
  /api/models:
    get:
      parameters: [ { $ref: "#/components/parameters/start" }, { $ref: "#/components/parameters/end" }, { $ref: "#/components/parameters/repos" }, { $ref: "#/components/parameters/provider" } ]
      responses:
        "200": { description: Share within each provider (never across), content: { application/json: { schema: { type: object, properties: { codex: { $ref: "#/components/schemas/ModelShare" }, claude: { $ref: "#/components/schemas/ModelShare" } } } } } }
        "400": { $ref: "#/components/responses/Error" }
  /api/sources:
    get:
      responses:
        "200": { description: Source and account status, content: { application/json: { schema: { type: object, properties: { sources: { type: array, items: { $ref: "#/components/schemas/SourceStatus" } }, accounts: { type: array, items: { $ref: "#/components/schemas/AccountStatus" } }, chatgptCoverage: {type: object, required: [unit], properties: {unit: {type: string, enum: [percent, tokens]}, stale: {type: boolean}, bucketSpan: {type: [object, "null"], properties: {start: {type: string, format: date}, end: {type: string, format: date}}}}}, running: { type: [integer, "null"], description: active refresh run id } } } } } }
  /api/hq:
    get:
      description: >
        The live roster of coding agents on this machine, held in memory and never stored. The page polls it every 2 s while visible
        (10 s after an error); there is no SSE or WebSocket. A process with no live feeder answers 200 with every feed `unavailable`
        and no agents.
      responses:
        "200": { description: Live roster, content: { application/json: { schema: { $ref: "#/components/schemas/HqResponse" } } } }
  /api/hq/claude-hooks:
    get:
      description: >
        Preview and status of the Claude Code hooks switch, with one plan (files, HQ's own files, fingerprint) for each action the
        state offers. Reads the settings files and writes nothing. Without a Claude Code integration it answers 200 with `state:
        unavailable` and no files. A read that cannot finish is a fixed `500 claude_hooks_failed`.
      responses:
        "200": { description: Status and preview, content: { application/json: { schema: { $ref: "#/components/schemas/ClaudeHooksStatus" } } } }
        "500": { $ref: "#/components/responses/Error" }
    put:
      description: >
        Turn the switch on, repair it, or turn it off. `enabled: false` is `off`; `enabled: true` is `on` when no file holds HQ's
        entries, else `repair`. `preview` must be the fingerprint of THAT action's plan as `GET` returned it (`plans.<action>.preview`);
        a request without it, with one that is no longer current, or with another action's, writes nothing (`409 claude_hooks_stale`).
        A merge, never a replace: other settings and other hooks are kept, only HQ's own handler objects (whose command is exactly
        HQ's shape) are added, replaced or removed, and nothing is written when nothing would change (idempotent: an event that already
        holds exactly HQ's one entry is left alone, and a second handler is never added). HQ never rewrites a settings file from a
        parsed copy: the only writer makes local edits to the file's own text, so the byte-order mark, line endings, final newline,
        indentation, key order, number and string spellings, repeated keys (the last member is the effective one, and the only one HQ
        reads or edits; earlier ones are dead text and stay), file mode and every other byte are kept. The edited text is parsed again and must be
        exactly the intended settings, else the file is refused (`422 claude_hooks_blocked`, `unsupported_layout`) and nothing is
        written; there is no whole-file fallback. A file that is not valid UTF-8 or JSON is refused the same way. The change is all or nothing
        across every Claude Code folder's settings: everything is staged first (temp files, owner-only, beside the file), the first
        change to a file saves a copy beside it, PROVEN before the file is replaced (created exclusively, owner-only and read back
        equal in a temp beside it and published whole under the final name with `link`; or an existing regular, readable, non-link file
        there that is not empty and reads as a settings file, which is never overwritten; an empty or unreadable one is refused with
        `backup_unusable`, naming it in `details.files`; a folder, link, pipe or unreadable file there refuses the change with
        `not_writable`), and each file is observed again as the last step before it is replaced (after its staged file is sealed, with
        nothing but the comparison between the observation and the rename):
        its bytes, device, inode, size, modification time, mode, owner and group, and its folder's identity and writability must be
        what was read (a file that is not is never overwritten; the change is computed again, up to three times, then `409
        claude_settings_conflict`); a file that is read-only, not the owner's or in a folder that cannot be written is refused
        (`not_writable`). Every file HQ renames (the staged update, the roll-back copy) is sealed immediately before the rename (the file HQ
        created, owner-only, one name, exactly the bytes HQ computed) and then given the observed file's whole permission word
        (setuid, setgid and sticky included; a bit the platform will not keep refuses the change). An edit whose result HQ's own
        reader would not read (over 4 MiB in bytes, nested deeper than 64 levels) is refused (`unsupported_layout`); a backup that is
        not a file of its own (the settings file, a link or hard link to it or to an HQ file, inside HQ's folder) is refused
        (`not_writable`), and two paths to one settings file through a symlink chain are one target, while two hard links are each a
        target (each written, each with its own copy and plan line); a file with another name HQ was not given is refused
        (`not_writable`). If a replace fails the files already replaced are
        put back (each only while it is still exactly what HQ wrote) and verified, and a file that cannot be put back is named (`500
        claude_hooks_failed`, `details.reason: rollback_failed`). A settings symlink is written through to its target. Turning on
        also installs the script and publishes the registry first; if the registry cannot be published nothing is turned on (`500
        claude_hooks_failed`, `registry_failed`); on any failure what HQ wrote is taken back only while it is still exactly what it
        wrote, and what is not is left and named (`details.left`). A path HQ cannot quote for a shell command and read back is refused
        before anything is written (`422 claude_hooks_blocked`, `unsupported_path`). Turning off removes HQ's script and registry
        too, but only those its confirmed plan lists (`plans.off.ownFiles`) and only while each is still the file the plan recorded; a
        file that is not is left and reported. The "Remove HQ's files" retry is this same `off` action in the `off` state, with its own
        plan and fingerprint. If they cannot be removed the answer is still the new status, read from disk, with `reason:
        cleanup_incomplete` and `leftover`. Changes are made one at a time. The answer is the new status, read from disk.
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      requestBody: { required: true, content: { application/json: { schema: { type: object, required: [enabled], additionalProperties: false, properties: { enabled: { type: boolean }, preview: { type: string, maxLength: 200, description: "the `plans.<action>.preview` for the action the owner chose; required in effect: without a current one for that action the answer is 409 claude_hooks_stale" } } } } } }
      responses:
        "200": { description: The new status, content: { application/json: { schema: { $ref: "#/components/schemas/ClaudeHooksStatus" } } } }
        "400": { $ref: "#/components/responses/Error" }
        "409": { $ref: "#/components/responses/Error" }
        "422": { $ref: "#/components/responses/Error" }
        "500": { $ref: "#/components/responses/Error" }
  /api/hq/hooks/claude:
    post:
      description: >
        What Claude Code's hook script posts. Served ONLY on the loopback listener (never on the Tailscale one, where it is a 404) and
        only when the process has the Claude Code integration. It needs `Authorization: Bearer <token>`, a random token made at each
        server start and handed to the script through the owner-only registry file; a missing or wrong token is `401` with an empty
        body and no log line (compared in constant time, checked before the body is read). The header must be exactly `Bearer <token>`
        (capital B, one space, base64url characters): a header sent twice or comma-joined, a lowercase scheme, extra spaces or tabs and
        any other form are the same `401`. The content type must be `application/json` (optionally `; charset=utf-8`), else `400`. The
        body is bounded (8 KiB, else `413` with an empty body), decoded as strict UTF-8 (invalid bytes or a byte-order mark are `400`;
        nothing becomes a replacement character) and strictly the five fields below: any other key, wrong type or shape is `400` with
        one fixed message that says nothing of why. An event name HQ does not use is accepted and
        ignored (`204`). Events are kept in memory only, the latest per session.
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [hook_event_name, session_id]
              additionalProperties: false
              properties:
                hook_event_name: { type: string, minLength: 1, maxLength: 40, description: "letters only; PermissionRequest, Notification, Stop, SessionStart and SessionEnd are used; others are ignored" }
                session_id: { type: string, minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" }
                notification_type: { type: string, minLength: 1, maxLength: 64, description: "letters, digits and ._:-; permission_prompt and idle_prompt are used" }
                reason: { type: string, minLength: 1, maxLength: 64, description: "why a session ended; letters, digits and ._:-" }
                cwd: { type: string, minLength: 1, maxLength: 1024, description: "an absolute path (POSIX, or a Windows drive letter) with no control characters, line or paragraph separators or lone surrogates" }
      responses:
        "204": { description: Accepted, or ignored }
        "400": { $ref: "#/components/responses/Error" }
        "401": { description: Missing or wrong token (empty body) }
        "413": { description: Body over the bound (empty body) }
  /api/refresh:
    post:
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      requestBody: { content: { application/json: { schema: { type: object, properties: { sources: { type: array, items: { type: string, enum: [codex, claude, paseo, github, chatgpt_account] }, description: omitted = all } } } } } }
      responses:
        "202": { description: Started, content: { application/json: { schema: { $ref: "#/components/schemas/RefreshRun" } } } }
        "409": { $ref: "#/components/responses/Error" }
  /api/refresh/{runId}:
    get:
      parameters: [ { name: runId, in: path, required: true, schema: { type: integer } } ]
      responses:
        "200": { description: Run status, content: { application/json: { schema: { $ref: "#/components/schemas/RefreshRun" } } } }
        "404": { $ref: "#/components/responses/Error" }
  /api/repos:
    get:
      responses:
        "200": { description: Active and stopped repos, content: { application/json: { schema: { type: object, properties: { active: { type: array, items: { $ref: "#/components/schemas/Repo" } }, stopped: { type: array, items: { $ref: "#/components/schemas/Repo" } } } } } } }
    post:
      description: Add (or re-activate a stopped) repo. Input is owner/name or a github.com URL. Checks access before tracking.
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      requestBody: { required: true, content: { application/json: { schema: { type: object, required: [input], properties: { githubAccount: { type: object, required: [login, via], properties: { login: { type: string, minLength: 1, maxLength: 100 }, via: {type: string, enum: [gh, app]} } }, repositoryNodeId: {type: string, minLength: 1, maxLength: 256}, input: { type: string, maxLength: 300 } } } } } }
      responses:
        "201": { description: Tracked (new or reactivated; reactivation restores retained history without duplicates), content: { application/json: { schema: { allOf: [ { $ref: "#/components/schemas/Repo" }, { type: object, properties: { reactivated: { type: boolean } } } ] } } } }
        "400": { $ref: "#/components/responses/Error" }
        "409": { $ref: "#/components/responses/Error" }
        "422": { $ref: "#/components/responses/Error" }
        "502": { $ref: "#/components/responses/Error" }
  /api/repos/discover:
    get:
      description: List accessible repositories for the active connection. Results are temporary and newest pushes are first.
      parameters:
        - { name: login, in: query, required: true, schema: {type: string, minLength: 1, maxLength: 100} }
        - { name: via, in: query, required: true, schema: {type: string, enum: [gh, app]} }
        - { name: page, in: query, schema: {type: integer, exclusiveMinimum: 0} }
      responses:
        "200":
          description: One page, with local tracking status matched by GitHub identity
          content:
            application/json:
              schema:
                type: object
                required: [repositories, nextPage]
                properties:
                  nextPage: {type: [integer, "null"], exclusiveMinimum: 0}
                  repositories:
                    type: array
                    items:
                      type: object
                      required: [displayName, nodeId, pushedAt, visibility, trackingState, trackedRepoId]
                      properties:
                        displayName: {type: string}
                        nodeId: {type: string, minLength: 1, maxLength: 256}
                        pushedAt: {type: [string, "null"], format: date-time}
                        visibility: {type: string, enum: [public, private, internal]}
                        trackingState: {type: string, enum: [untracked, active, stopped]}
                        trackedRepoId: {type: [string, "null"]}
        "400": { $ref: "#/components/responses/Error" }
        "409": { $ref: "#/components/responses/Error" }
        "422": { $ref: "#/components/responses/Error" }
        "502": { $ref: "#/components/responses/Error" }
  /api/repos/{owner}/{name}:
    delete:
      description: Stop tracking. Keeps imported history within retention. Idempotent.
      parameters: [ { name: owner, in: path, required: true, schema: { type: string } }, { name: name, in: path, required: true, schema: { type: string } }, { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      responses: { "204": { description: stopped }, "404": { $ref: "#/components/responses/Error" } }
  /api/repos/{owner}/{name}/recheck:
    post:
      parameters: [ { name: owner, in: path, required: true, schema: { type: string } }, { name: name, in: path, required: true, schema: { type: string } }, { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      responses: { "200": { description: Re-checked, content: { application/json: { schema: { $ref: "#/components/schemas/Repo" } } } } }
  /api/accounts/{account}/connect:
    post:
      description: >
        Starts a provider-owned flow. github: if `gh` is signed in, returns {mode: existing}; else if a GitHub App client ID
        is saved, starts the device flow and returns userCode + verificationUri (server polls GitHub at its interval);
        else 422 github_app_required. chatgpt (owner choice P4): Codex app-server account/login/start returns authUrl
        (browser) — the UI states "This signs Codex in on this computer too." claude: 422. Use POST /api/accounts/claude/plan-limits/check to check limits with the current Claude Code sign-in.
      parameters: [ { name: account, in: path, required: true, schema: { type: string, enum: [github, chatgpt, claude] } }, { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      responses:
        "200": { description: Flow started or already connected, content: { application/json: { schema: { type: object, properties: { loginId: { type: [string, "null"] }, mode: { type: string, enum: [existing, browser, device] }, authUrl: { type: [string, "null"], format: uri }, userCode: { type: [string, "null"] }, verificationUri: { type: [string, "null"], format: uri }, expiresAt: { type: [string, "null"], format: date-time } } } } } }
        "422": { $ref: "#/components/responses/Error" }
        "502": { $ref: "#/components/responses/Error" }
  /api/accounts/github/app:
    put:
      description: >
        Save (or replace) the client ID of the owner's personal GitHub App (owner choice P2). Not a secret; stored in app_meta.
        Validates shape only (non-empty, ≤ 40 chars, [A-Za-z0-9.]+, typically "Iv…"); a wrong ID surfaces at connect time as
        incorrect_client_credentials or device_flow_disabled. Never accepts a client secret.
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      requestBody: { required: true, content: { application/json: { schema: { type: object, required: [clientId], additionalProperties: false, properties: { clientId: { type: string, maxLength: 40, pattern: "^[A-Za-z0-9.]+$" } } } } } }
      responses:
        "200": { description: Saved, content: { application/json: { schema: { $ref: "#/components/schemas/AccountStatus" } } } }
        "400": { $ref: "#/components/responses/Error" }
  /api/accounts/claude/plan-limits/check:
    post:
      description: Check the active Claude Code profile once in a standalone session. Refresh mode requires a previous successful check for that profile. Expected provider failures are returned as account states. Managed sessions use /api/paseo-quota/claude/check.
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      requestBody: { content: { application/json: { schema: { type: object, properties: { mode: { type: string, const: refresh } }, additionalProperties: false } } } }
      responses:
        "200": { description: Saved reading and check outcome, content: { application/json: { schema: {type: object, required: [account], properties: {account: {$ref: "#/components/schemas/AccountStatus"}}} } } }
        "400": { $ref: "#/components/responses/Error" }
        "422": { $ref: "#/components/responses/Error" }
  /api/accounts/claude/usage-capture/preview:
    get:
      description: Read the restoration instructions for a recorded legacy installation.
      parameters: [ { name: action, in: query, schema: { type: string, const: remove } } ]
      responses:
        "200":
          description: Instructions for restoring the recorded profile
          content:
            application/json:
              schema:
                type: object
                required: [action, settingsPath, files, backupPath]
                properties:
                  action: { type: string, const: remove }
                  settingsPath: { type: string }
                  files:
                    type: array
                    items:
                      type: object
                      required: [path, exists, current, next, hookReferenced]
                      properties:
                        path: { type: string }
                        exists: { type: boolean }
                        current: {}
                        next: { type: [object, "null"] }
                        hookReferenced: { type: boolean }
                  backupPath: { type: [string, "null"] }
        "400": { $ref: "#/components/responses/Error" }
        "409": { $ref: "#/components/responses/Error" }
        "422": { $ref: "#/components/responses/Error" }
  /api/accounts/claude/usage-capture:
    put:
      description: Verify the recorded profile before removing legacy hook files. The owner makes all provider settings edits.
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - { type: object, required: [action], additionalProperties: false, properties: { action: { type: string, const: begin_remove } } }
                - { type: object, required: [action], additionalProperties: false, properties: { action: { type: string, const: verify_remove } } }
      responses:
        "200": { description: New state, content: { application/json: { schema: { type: object, required: [account], properties: { account: { $ref: "#/components/schemas/AccountStatus" } } } } } }
        "400": { $ref: "#/components/responses/Error" }
        "409": { $ref: "#/components/responses/Error" }
        "422": { $ref: "#/components/responses/Error" }
  /api/accounts/{account}/connect/{loginId}:
    get:
      parameters: [ { name: account, in: path, required: true, schema: { type: string } }, { name: loginId, in: path, required: true, schema: { type: string } } ]
      responses: { "200": { description: Poll, content: { application/json: { schema: { type: object, properties: { state: { type: string, enum: [pending, connected, failed, expired, cancelled] }, account: { $ref: "#/components/schemas/AccountStatus" }, message: { type: [string, "null"] } } } } } } }
  /api/accounts/{account}/disconnect:
    post:
      description: >
        Stops the dashboard using that account. github (App route) deletes the Keychain entry; github (gh route) just stops
        reading the gh token until Connect is pressed again. chatgpt stops calling account reads — it does NOT log Codex out. Imported data is kept.
      parameters: [ { name: account, in: path, required: true, schema: { type: string, enum: [github, chatgpt] } }, { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      responses: { "200": { description: Disconnected, content: { application/json: { schema: { $ref: "#/components/schemas/AccountStatus" } } } } }
  /api/setup/discover:
    post:
      description: "First-launch discovery (M10 delta). Only looks. It records each source's status and location on its row, imports nothing, reads no transcript and never takes a path from the client (the body is empty)."
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      responses: { "200": { description: Discovery results (no import yet), content: { application/json: { schema: { type: object, properties: { sources: { type: array, items: { $ref: "#/components/schemas/SourceStatus" } }, accounts: { type: array, items: { $ref: "#/components/schemas/AccountStatus" } } } } } } } }
  /api/setup/complete:
    post:
      description: "Marks setup complete (with the report timezone, in one transaction) and starts the first full refresh (202 with run). Allowed with zero repos and zero sources. A repeat changes nothing and starts no second run (M10 delta)."
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      responses: { "202": { description: Started, content: { application/json: { schema: { $ref: "#/components/schemas/RefreshRun" } } } } }
  /api/setup/reset:
    post:
      description: "Resets a configured installation and returns 204 after clearing its current data. The app waits for active requests and the current refresh to finish. After a successful reset, bootstrap reports setupComplete false. Provider sign-ins can be used again through Connect, and Setup discovers local sources again."
      parameters: [ { name: X-Agent-Productivity-Request, in: header, required: true, schema: { type: string, const: "1" } } ]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, required: [confirmed], additionalProperties: false, properties: { confirmed: { type: boolean, const: true } } } } }
      responses:
        "204": { description: Reset finished or setup was already incomplete }
        "400": { description: Confirmation required, content: { application/json: { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } }
        "409": { description: Reset in progress or legacy Claude settings still need attention, content: { application/json: { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } }
        "422": { description: Claude Code hooks could not be removed safely, content: { application/json: { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } }
        "500": { description: Reset failed or a local SQLite reader prevented journal cleanup, content: { application/json: { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } }
```

`ProviderKpi` and `ModelShare` complete the schema set:

```yaml
ProviderKpi:
  type: object
  required: [coverage]
  properties:
    coverage: { $ref: "#/components/schemas/UsageCoverage" }
    value: { type: [integer, "null"], description: null when coverage is unavailable/none }
    note: { type: [string, "null"], enum: ["From <date> only", "Cached; recent days missing", null] }
    coveredFrom: { type: [string, "null"], format: date, description: the date the note "From <date> only" names; null otherwise }
ModelShare:
  type: object
  properties:
    coverage: { $ref: "#/components/schemas/UsageCoverage" }
    rows: { type: array, items: { type: object, properties: { model: { type: string }, tokens: { type: integer }, sessions: { type: integer }, sharePercent: { type: integer } } } }
```

## Behaviour notes the schema can't express

- **Totals reconcile across granularities (P-11).** `series` sums are computed from the same event set for every `gran`, so day, week and month totals over a covered interval are equal.
- **True zero vs unavailable (P-05).** A covered bucket with no events returns `0`. A bucket before `oldestDate` returns `null` with `unavailable`. A bucket after today returns `null` with `future` (D3 "Upcoming, no data yet").
- **Scope echo (P-12, P-37).** `accounts[]` in `/api/overview` ignores `repos` and `provider` filters except to choose which provider cards to show. Its `scopeLabel` says it is the account's own report and that what it counts is not confirmed (the live E4 comparison found the figure below this machine's own total, so it is not called account-wide); the card adds a notice when the figure is lower than this machine's.
- **Undo (P-26).** The client's Undo calls `DELETE` (for confirm, reject and add) or re-`PUT`s the previous decision (for remove), using the toast's captured prior state.
- **Refresh concurrency.** Per-source locks run inside one run. Polling `GET /api/refresh/{id}` every 1 s while `running` is the only push mechanism. There is no SSE or WebSocket in MVP.
- **Claude Code hooks (HQ).** The switch is the one place the app changes a provider's settings, and only when the owner presses it. `GET /api/hq/claude-hooks` is the preview and never writes. `PUT` adds (or removes) one entry for each of five events (`PermissionRequest`, `Notification`, `Stop`, `SessionStart`, `SessionEnd`) in the user-level `settings.json` of each existing Claude Code folder, as the shape `hooks.<Event>[] = { hooks: [{ type: "command", command, timeout: 3 }] }`. The ingest route reads five fields and refuses the rest; it is mounted on the loopback listener only, and a request that reaches the Tailscale listener finds no such route. Its answers carry no detail, and a wrong token is not logged. The route and its token are described in data-and-sources › Claude Code hooks.
- **Live roster (HQ).** `GET /api/hq` answers from an in-memory roster and never writes SQLite. The HQ page polls it every 2 s while the tab is visible, and every 10 s after a failed request; there is no SSE or WebSocket. A process with no live feeder answers 200 with all three feeds `unavailable`, no agents and `truncated: false`. The payload carries state words, a coarse activity category, timestamps, opaque ids and the title, repo and workspace labels; it never carries a prompt, response, tool name or argument, permission detail or error text. `exactPrompts` says whether the owner's Claude Code hooks switch is on; an agent whose hook reported that it waits has `confidence: reported`.
