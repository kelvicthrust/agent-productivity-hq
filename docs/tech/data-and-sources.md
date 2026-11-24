# Data, sources and persistence (T1–T5, scoped clarification T6)

**T6 scope, 2026-11-16:** source, normalization and Claude capture decisions stand. The frozen accepted bundle's Codex accounting repairs and ChatGPT-report evidence limits below are preserved. This revision only makes the settled Setup boundary explicit beside discovery; the progress-indicator reconciliation lives in [design-to-code](design-to-code.md#setup-indicator-reconciliation) and [local-api](local-api.md#setup-progress-and-api-boundary). It does not authorize collection or settings changes.

**T5 delta (Design D5–D7 refresh):**
- New [Session start time](#session-start-time) rule: `session.started_at` and `started_basis` back the single "Started" label.
- New [Usage-tree link status](#usage-tree-link-status) rule: the Linked PRs cell needs a class per link and an honest "not checked" state.
- `session` gains `started_at` and `started_basis`; `source_state` gains `consecutive_failures`.
- E1 and E2 gain a session-start and title criterion.

Everything else is unchanged from T4.

Supporting contract for [TECH.md](../../TECH.md). It defines what each source is, how records are read, normalized, deduplicated and stored, and how sessions are linked to PRs. Field names marked **(verify E#)** come from a source description or reasonable expectation, not from an inspected sample. Implementation must confirm them in the named experiment before shipping the adapter. Everything here is a proposal for owner review until the technical spec is accepted.

## Source taxonomy

| Source id | What it is | Boundary | Consumption record? | Requirement links |
| --- | --- | --- | --- | --- |
| `codex` | Codex rollout JSONL files on this machine | Installation host | **Yes**: usage events | P-01, P-03, P-28, P-39, P-40 |
| `claude` | Claude Code transcript JSONL files on this machine | Installation host | **Yes**: usage events | P-02, P-03, P-28, P-39, P-40 |
| `paseo` | The local Paseo daemon's agent directory | Installation host (daemon at `127.0.0.1:6767`) | **No**: enrichment only (names, workspaces, parentage) | P-22, P-23 |
| `github` | GitHub API, for the tracked repos only | GitHub.com, via the active GitHub connection | No. Delivery records. | P-14–P-21 |
| `chatgpt_account` | Codex App Server account reads | ChatGPT account report (what it counts is not confirmed) | No. Account-reported aggregate, kept separate. | P-33–P-38, P-41–P-43 |
| `claude_account` | Manual checks through the local Claude Code sign-in | Current subscription windows | No. Provider percentages and reset times only. | P-33, P-34, P-35 |

**Invariants:**
- Paseo never adds tokens.
- Account reports are never added to local usage, split by repo, or used to create links (P-36–P-38).
- Each underlying provider request is counted once (P-03).

## Discovery (automatic, no picker)

**First-launch boundary retained from the accepted M10 local API contract:** until Finish, discovery checks locations/status and records those findings only; it does not import or read transcript history to calculate oldest dates, sessions or token totals. The first full refresh starts through Complete, not launch or timer before Setup is finished. A real discovered location replaces D7's synthetic history-date sentence. The full rules and Complete idempotency remain in [local-api › Setup progress and API boundary](local-api.md#setup-progress-and-api-boundary). Indicator checks mean an earlier screen was passed, not that discovery or sign-in succeeded. Claude plan capture remains an optional, previewed Sources & repos action; no Connect Claude control or setting write is added to Setup.

Discovery runs at first launch, on **Check again**, and before each refresh. It never asks for a path. Each step checks the documented default and the documented override variable, in order, and records what it found.

| Source | Roots checked, in order | Found when | Status values |
| --- | --- | --- | --- |
| `codex` | Each entry of `$CODEX_HOME` (comma-separated, per R1), else `~/.codex`. In each: `sessions/` and `archived_sessions/`. | At least one `*.jsonl` or `*.jsonl.zst` file is readable | `ok`, `notfound`, `denied` (EACCES/EPERM on a root or file), `partial` (some files unreadable or unsupported), `failed` (last attempt errored), `checking` |
| `claude` | `$CLAUDE_CONFIG_DIR` (each comma-separated entry), else both `~/.config/claude/` and `~/.claude/`. In each: `projects/`. | At least one `projects/*/*.jsonl` is readable | as above |
| `paseo` | `ws://127.0.0.1:6767/ws`. `PASEO_HOME` is recorded for diagnostics only. | `connect()` resolves and `agents.list` succeeds | `ok`, `notrunning` (**Not running**), `needspassword` (**Needs a password**), `failed`, `checking`. The most recent snapshot is mentioned only while stored agent records exist. |
| `chatgpt_account` | `codex` on `PATH` → spawn `codex app-server` (stdio) → `initialize` → `account/read` | `account.type === "chatgpt"` | `existing` (signed in before the dashboard), `connected`, `notconnected`, `unavailable` (no `codex` binary, or API-key/Bedrock auth, which `account/usage/read` doesn't support per R6), `reconnect` (auth error), `failed` |
| `github` | 1. `gh auth token` if `gh` is on `PATH` and signed in (P-42). 2. Otherwise the GitHub App user token from the macOS Keychain (owner choice P2). | `GET /user` returns 200 | `existing` (via gh), `connected` (via App), `notconnected`, `needsapp` (no gh sign-in and no client ID saved yet), `reconnect` (401 / refresh failed), `failed`. The response includes `via: gh | app`. |

The dashboard changes a provider's settings only when the owner turns on a switch that says exactly what will change, and it can undo that. Today there is one: HQ's Claude Code hooks ([Claude Code hooks](#claude-code-hooks-the-owners-opt-in-switch)), which add entries to the user-level `settings.json` of each Claude Code folder, nothing else. Nothing else is ever written to a provider: it never changes `cleanupPeriodDays`, Codex `config.toml`, Paseo `config.json`, or any other Claude Code setting. *(Until 2026-11-19 this read "never writes provider configuration on its own"; the owner lifted that rule for this one opt-in switch. The history of the retired status-line capture below is unchanged.)*

Source status tracks discovery and availability separately from refresh attempts. A timestamp
for a successful attempt does not prove that any records were collected or are still retained.
The optional `hasRetainedData` field reports whether the database currently has records from
that source.

Provider-side effects happen only on an explicit owner action:
- the ChatGPT sign-in signs Codex in on this machine (owner choice P4);
- the GitHub App token lives in the Keychain (P2);
- the Claude plan button authorizes one credential read and one request to Anthropic. The owner restores any previously installed status line.

## Codex local rollouts

**Files.** Read `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl`, plus their `.jsonl.zst` twins. Two precedence rules follow R1:
- A plain file beats its `.zst` twin.
- A `sessions/` copy beats an `archived_sessions/` copy with the same relative rollout path.

Precedence decides which file is *read*. Dedupe keys (below) still protect against double counting if precedence misses a copy. Zstandard decoding uses `node:zlib` if Node 26 supports it (verify E2). Otherwise `.zst` files are counted as `unsupported` and surfaced as partial coverage.

**Record types used** (field names verify E2):

| Line | Fields used | Meaning |
| --- | --- | --- |
| `session_meta` | `id` (thread/session id), `timestamp`, `cwd`, `git.{repository_url, branch, commit_hash}`, `source` / originator, parent-thread reference for spawned subagents if present, `cli_version` | One per rollout. Gives identity, working directory and repo hints. |
| `turn_context` | `model` | Model for the usage that follows (R1) |
| `event_msg` with `payload.type = "token_count"` | `info.total_token_usage.{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`, `info.last_token_usage.{…}`, `timestamp` | **Cumulative** totals for the thread, plus the last request's delta when present (R1) |
| `token_usage_record` (compaction) | response id, token fields | Extra compaction usage. Counted once per response id, only when a `compacted` line names that id and no advancing `token_count` already carried it (R1; see the pseudocode below). |
| Message / tool-result lines | Text, scanned **in memory only** for evidence refs (see [Evidence extraction](#evidence-extraction-in-memory-only)) | Never persisted |

**Normalization.** The M5 repair uses [ccusage comparison rules](../implementation/ccusage-rules.md) backed by synthetic fixtures. A later private Codex comparison reported agreement on the original sample.

```text
for each rollout file (in path order):
  meta    = first session_meta         # T5: session upsert carries startedAt = meta.timestamp (basis source_start), see Session start time
                                       # fork = payload.forked_from_id, else source.subagent.thread_spawn.parent_thread_id; fork instant = the first line's timestamp
  model   = null
  prev    = null                       # previous cumulative total of this thread
  for each line in order:
    turn_context        -> model = line.model
    compacted C         -> remember C.payload.compaction_response_id
    token_count with info (cumulative total T, request's own usage L):
      advanced = T is absent or T != prev
      usage    = L if advanced and L is present, else T - prev (per category, never below 0)
      prev     = T when present
      clamp cached <= input and cache_write <= input - cached; skip when input, cached, cache_write, output and reasoning are all 0
      emit UsageEvent{ provider: codex, sessionKey: meta.id, occurredAt: line.timestamp, model: model ?? 'unknown',
                       input, cachedInput, cacheWrite, output, reasoning,
                       dedupeKey: session + timestamp text + model + every figure }
    token_usage_record R (compaction request):
      emit one more event ONLY IF a compacted line names R.response_id AND no advancing token_count right after R already carried R's usage
      dedupeKey: 'resp:' + R.response_id           # one per response id, in the first rollout that has it, wherever it was copied
  fork replay (a rollout that names a parent):
      skip its leading events while each equals, in every field, the parent's event at the same position
      (the parent's own events, without any replay of its own, up to the fork instant);
      the first mismatch ends the replay. If position 0 does not match (the parent is not among the files),
      skip the burst at the head: events at most 1000 ms apart, the first within 1000 ms of the rollout's own start.
      A compaction request the parent recorded at or before the fork instant is not counted again.
```

A counter reset (a total that goes down) is not a special case any more: the request's own `last_token_usage` is counted when the total changed, and without it the per-category difference never goes below zero. Replayed history is found by comparing a child's events with its parent's, not by timestamps or markers: Codex stamps copied lines after the child's start, which is why the earlier timestamp rule found none.

**Token semantics (Codex):**
- `cached_input ⊂ input`, `cache_write ⊂ input` (stored in `cache_write_tokens` as a part of input, never added to the total) and `reasoning ⊂ output`.
- Provider total = `input + output`. This is the owner-confirmed rule (Review r6). Fields are stored separately and totals are never re-added. P-28 is verified against `ccusage codex session --json` on the same files (E2).

**Titles and kinds.** On refresh, if `codex` is available, call `thread/list` with `sourceKinds: []` (all kinds) and `archived` both `false` and `true`. Store only `thread.name` as the recorded title, and the source kind to classify the thread:
- `cli` / `vscode` / `exec` / `appServer` → **root**
- `subAgent*` → **child** (parent from the rollout's parent reference, or `unknown` if absent)
- `unknown` → **unknown**

`preview` is the first user message and is never stored (P-31). If `codex` isn't available, kinds come from `session_meta.source` (verify E2) and titles are absent.

## Claude Code transcripts

**Files read:**
- `projects/<project>/<session>.jsonl` → main session
- `projects/<project>/<session>/subagents/*.jsonl` → **child** sessions of `<session>`, with native parentage recorded by location (R3)

**Files skipped:** `*.orphaned-*.jsonl` and `*.jsonl.superseded-*`. These are set-aside copies (R3), and reading them would double count. Their usage is still protected by the dedupe key if a later layout changes.

**Line fields used** (verify E1): `type`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`, `isSidechain`, `message.id`, `message.model`, `requestId`, and `message.usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`. A title or summary line, if Claude Code persists one, is stored as the recorded title (verify E1; R4 shows a `session_name` concept exists).

**Normalization:**
- Each assistant message with `usage` becomes one usage event.
- `dedupeKey = message.id + ':' + requestId`. For repeated copies, prefer the main thread, then the larger total, then a copy with speed metadata, then the first file and line in import order. Parsing and database writes use the same ranking. The winning copy supplies all token categories and the session that owns the usage event.
- `occurredAt = timestamp`.
- **T5:** the session upsert carries `startedAt` = the earliest line `timestamp` in the file, of any line type (basis `source_start`; see [Session start time](#session-start-time)).
- **Token semantics (Claude):** uncached input, cache write (`cache_creation_input_tokens`), cache read and output are **separate** categories. Provider total = the sum of all four (owner-confirmed rule; matches R4's definition of total input).

**Retention reality.** Claude Code deletes transcripts after `cleanupPeriodDays` (default 30, R3), so a first import can see at most that much Claude history. The dashboard imports every 15 minutes while running and retains normalized metrics for 12 months (P-29). The Sources page states the 30-day default in plain words and does not change it.

`~/.claude/stats-cache.json` (R3) holds aggregates shown by `/usage`. Its format is undocumented, so it isn't used. E1 records whether it could backfill daily totals later. That would need a new owner decision.

## Repo association (sessions → GitHub repos)

1. Use the recorded `cwd`. Walk up to the nearest `.git` (a directory, or a `gitdir:` file for worktrees, resolving to the main repo's config).
2. Read `remote "origin".url` from that config file. This reads local git config only and runs no `git` command.
3. Canonicalize `git@github.com:Owner/Name.git`, `https://github.com/Owner/Name(.git)` and `ssh://git@github.com/Owner/Name` to lowercase `owner/name`.
4. Fallback: Codex `session_meta.git.repository_url` (verify E2).
5. No remote, or a non-GitHub remote → `repo = null` → **Unknown repo** group.
6. A GitHub repo that is not tracked → **Untracked repos** group.

Cache the cwd→repo resolution per directory for the run. A deleted directory keeps the session's previously stored repo.

## Session start time

Design D7 shows **one** time per session, labelled "Started" everywhere a session appears. Design's own note says the prototype's time is only a fixture and that Technical must confirm what real records offer. The real field is not yet observed, so this section defines the rule and the fallback. The experiments settle it.

| Provider | Preferred start (verify) | Fallback |
| --- | --- | --- |
| Codex | `session_meta.timestamp` of the rollout (verify E2). If `codex` is available, `thread/list`'s `createdAt` is a cross-check (a third-party mirror of the app-server README shows `createdAt` as Unix seconds; not confirmed against the upstream source or the owner's version, E2). | Earliest usage event |
| Claude Code | `timestamp` of the **earliest line of any type** in the session's main transcript (verify E1). A subagent file uses its own earliest line. | Earliest usage event |

Rules:
- `started_at` is **set once**, when the session row is first created, and afterwards only moved **earlier** (an older line turns up). It is never recomputed from retained usage events, so the 366-day event pruning cannot make a long-lived session look as if it started later.
- `started_basis` is `source_start` when the preferred field was read, otherwise `first_event`.
- A resumed session keeps its original start (the label means when the session began, not when it was last used). No end time or range is shown (Product defers it).
- `first_event_at` and `last_event_at` stay in the table for windows and suggestions. `last_event_at` drives the 48-hour suggestion window. Neither is shown as a label.
- **If E1 or E2 shows that a provider offers no start record at all**, the basis is `first_event` for that provider. The label stays "Started", with an accessible description saying it is the first recorded activity. A first usage event comes seconds to minutes after a real start, so the label is not materially wrong, but that is a Design wording decision. It returns to Design only if the experiments show a larger gap (for example, a session whose first usage event is long after its first line).

## Paseo enrichment

On each refresh, if the daemon is reachable, call `agents.list({ filter: { includeBackground: true } })`. Also request archived agents if the SDK supports it (verify E3). For each agent, upsert a `paseo_agent` snapshot: `id`, `title`, `provider/model`, `runtimeInfo.sessionId`, parent agent id, `workspaceId` (plus a workspace label if exposed), `cwd`, `labels`, `archivedAt`, `first_seen_at` and `last_seen_at`. `lastUsage` (cost) is not stored.

**Identity join (P-22):** `paseo_agent.provider_session_id = session.provider_session_id` within the same provider. If it matches:
- The session gets `recorded_name = paseo.title` (if no provider title).
- It gets `paseo_agent_id` and `workspace_label`.
- If the session has no native parent, the Paseo parent becomes its parent via the parent agent's mapped session, with `parent_basis = 'paseo'`.

If the parent agent is unmapped, the relationship is `unknown` (P-23: no fabricated edge). An agent with no matching session stays an **unmapped Paseo agent**. It is visible in Sources diagnostics and adds no tokens.

**History limits.** The daemon is a live directory, not a ledger (R9; product evidence). The dashboard accumulates snapshots from first install onward. Agents archived before install are covered only if E3 shows they can be listed. Paseo coverage starts at the first successful snapshot ("Paseo agent metadata from <date>").

## Live roster (HQ)

`GET /api/hq` ([local API](local-api.md)) answers from an in-memory roster of the coding agents running now, filled by three feeds that run only while someone is looking: Paseo's live listing, and the Claude Code and Codex transcripts that are being written ([the transcript feeds](#the-transcript-feeds)). When the owner has turned on [Claude Code's hooks](#claude-code-hooks-the-owners-opt-in-switch), their events are a fourth input: they arrive whether or not anyone is looking, are held in memory only, and are read when a roster is built. The Paseo feed is a second, separate use of the Paseo daemon: the 15-minute batch collector above is unchanged, stores what it stores, and shares only the failure classification (`collectors/paseo/errors.ts`) with the live feed. The transcript feeds read the same provider folders the batch importers read, in memory, and share their file and line readers. Nothing in the roster is written to SQLite.

**Verification status.** Earlier reviews exercised the pinned Paseo SDK with an in-memory socket and a loopback peer. A dropped connection and reconnect against a real daemon remain unverified.

**Transcript feed coverage.** The transcript formats below came from read-only field inspection. The repository also has synthetic coverage for the state machine, file discovery, tail reader, feeds, merge and boot wiring. Real permission prompts, live interrupts and performance with large transcript stores remain outside the recorded coverage.

### The Paseo live feed

`collectors/paseo/live.ts` holds one connection to the daemon while someone is looking:

1. Open a client (`openPaseoLiveClient`: no password and no auth header, SDK reconnect off, 8 s connect timeout, as the batch opener, but with SDK logging silenced so a failing listing never prints the daemon's error text) and connect. It is built on the SDK's `DaemonClient` (`@getpaseo/client/internal/daemon-client`, version pinned exactly) rather than `createPaseoClient`, because the public client's configuration has no transport option, and over the SDK's own Node transport (`createHostTransportFactory`, the public `@getpaseo/client/node` export, which uses the SDK's `ws` dependency; this package imports no `ws`) rather than Node's global `WebSocket`; see "Closing the socket" below.
2. Every 2 s (`LIVE_POLL_MS`) list up to 200 unarchived agents, including background agents, **without** `subscribe`. Paseo orders that page by status priority, then last update. When the page is truncated, request up to 60 more results filtered to agents that require attention, then merge by agent id. If the optional request fails, keep the primary page. After an optional request times out, that connection uses the primary page for subsequent polls. The feed reports `live` only after the first listing has been projected into the kept roster (`live.ts`: `replace(listed)` runs before `setStatus('live')`, and `ready()` resolves in `setStatus`), so a live Paseo feed never has an empty roster that it has not read yet. The primary page’s `pageInfo.hasMore` is reported as `truncated`. Each answer is projected through `readLiveAgent` the moment it arrives and is not referenced afterwards. No subscription is held, so nothing of the SDK's survives a call: a plain listing is one request/response through `sendRequest`, whose waiter is deleted when the answer arrives, and the SDK retains raw data only inside `observe()` subscription handles (`connection/owned.js`), which the feed never creates.
3. Every listing has HQ's own deadline (`LIVE_LIST_TIMEOUT_MS`, 5 s) and a look at the connection state before and after. With SDK reconnect off a closed socket changes the SDK's connection state and rejects what is pending on it, but a daemon that simply goes quiet leaves the SDK waiting for its own 60 s default, so the feed does not wait for it. A drop found between two polls is a `connection_lost`; a listing past its deadline is `list_timeout` (or `connection_lost` when the connection is found not to be up).
4. The feed owns reconnecting. A failed connect is classified with the batch collector's helpers into `notrunning` / `needspassword` / `failed`. A failed or timed-out poll, or a drop, closes the client, empties the roster, reports `failed` (or `needspassword`) and retries after 1, 2, 4 ... up to 30 s, each wait shortened by up to 20 % at random; a daemon asking for a password is not asked again within a minute. `stop()` aborts a connect or listing in flight, closes the client and leaves no timer or socket. The log carries a failure code only, never a message and never the number of agents the daemon listed or whether it had more than one page, and only a code from a fixed list in `live.ts` (`LOGGABLE_CODES`: the feed's own codes, the SDK's request-timeout and connection-lost codes and the common network error codes); anything else is logged as `failed`, because a daemon can put any string in an error's `code`. The batch collector's own classification and logging are unchanged.

**Closing the socket.** Node's global `WebSocket` (undici) cannot be force-closed and has no close timeout: `close()` sends a close frame and waits for the peer, and with a peer that says nothing it stayed in `CLOSING` for more than 125 s in a check on Node 26.3.1 (undici 8.5.0), keeping its connection open after HQ had stopped. The live client therefore does not use it: the SDK's Node transport sends the close frame and then calls the `ws` socket's `terminate()` at once, so `stop()` leaves no connection even to a silent daemon. Two tests in `liveSocket.test.ts` cover it: one closes the live client with no listener or peer and checks the SDK's `ws` socket is `terminate()`d (it runs inside a sandbox), and one closes it against a loopback peer that completes the handshake and then never answers and checks the peer sees the connection end (it is skipped, with a printed reason, where the sandbox forbids listening on loopback; a skipped run is not a pass). Nothing remains open here, but the guarantee rests on the SDK's transport and the exact SDK version.

**Inbound allowlist.** HQ asks the daemon one question, the plain listing, but the SDK parses and keeps what a daemon pushes on its own: with a daemon that advertises background workspaces without owned subscriptions or workspace multiplicity, SDK 0.15.3 activates its legacy workspace adapter (`connection/legacy-workspaces.js`), which caches every `agent_update` (agent error text and permission details included) in the client. So the live client's transport is wrapped (`allowlistTransport`, `collectors/paseo/liveTransport.ts`) and only these inbound frames reach the SDK; everything else is dropped before the SDK parses, validates or stores it: `pong` (the answer to the SDK's liveness ping), `hello.rejected` (so a password-protected daemon is still reported as one), a `session` `status` whose payload is `server_info` (the handshake reply that moves the client to connected; it is reduced to named fields, see below), and a `session` `fetch_agents_response` or `rpc_error` whose `requestId` is that of a `fetch_agents_request` HQ itself sent and that has not been answered yet. Frames that are not text (terminal output, file transfer, host routing, chunks) and anything that is not JSON are dropped too, and the hello sets `binary_chunking_v1` to false so a daemon never splits a frame into chunks that cannot be told apart before reassembly. What the SDK keeps from the handshake is only what the filter rebuilds: the SDK holds the parsed frame for as long as the client lives, so the transport forwards a new `server_info` frame made field by field from an explicit list (`serverInfoFrame`): the `serverId` the SDK requires and the three feature flags HQ's flow reads (`backgroundWorkspaces`, which the listing's `includeBackground` requires, plus `ownedSubscriptions` and `workspaceMultiplicity`, which choose how the SDK routes subscriptions). The connection's `permissions`, `hostname`, `version`, `sourceId`, `capabilities`, `protocolVersion` and every other feature flag are dropped, and a handshake with no usable `serverId` is dropped. Close and error text is replaced the same way, because the SDK keeps it in `lastError` and its disconnected state: a socket close keeps its numeric code and takes one of a fixed set of reasons (`Password required` and `Incorrect password`, the two the SDK and `errors.ts` read as a password-protected daemon, when the daemon sent exactly those; otherwise none, so the SDK reports `Transport closed (code N)`), and a transport error becomes `Transport error`, keeping only a plain machine code such as `ECONNREFUSED`. The listing's answer is returned to the feed and is not stored by the client when nothing is subscribed (a test asserts that no agent id, folder or `lastError` from a listing remains in the client, that no connection grant stays in the handshake, and that a close reason does not). `liveInbound.test.ts` checks this for the filter alone and for the pinned SDK over an in-memory socket, for three daemon feature sets.

**Fields read** from an agent snapshot: `id`, `provider`, `cwd`, `title`, `labels['paseo.parent-agent-id']`, `runtimeInfo.sessionId`, `status`, `activeTurn.startedAt`, `pendingPermissions[].kind` (the first one's kind only), `requiresAttention`, `attentionReason`, `attentionTimestamp`, `updatedAt`, `createdAt`, `archivedAt`, `providerUnavailable`, and the entry's project `workspaceName`. Each agent is copied field by field into a fixed record (`liveAgent.ts`), so a field that is not named is never kept. Text from the daemon is bounded (`lib/liveText.ts`): an agent id, a session id or a parent id longer than 256 characters is not one (an agent with such an id is not kept, the other two are absent), a working directory longer than 4096 characters is absent, and a title, a workspace name or a provider name is cut to 1000 characters.

The live feed also uses the presence of `activeTurn`, a positive `backgroundWork.count`, and explicit nulls for both `lastUserMessageAt` and `persistence`. It keeps only the flags derived from those values. The native bridge projects the same metadata from its existing agent listing. Both clients use the listing without requesting conversation history.

**Never read, stored, logged or returned:** `lastError`, a permission's `name`, `input`, `description`, `title`, `detail` or `metadata`, notification titles and bodies, `lastUsage`, any message text. No title, folder, agent id or session id is logged, and nothing derived from the roster either (see [What HQ logs](#what-hq-logs)). The tests set each of these to a `SENTINEL_*` string and assert it appears in neither the service output nor the log.

### State mapping

Every state here is `confidence: 'reported'` (Paseo said it; nothing is inferred from silence). `activity` is `none` for every Paseo-reported state: Paseo's snapshot has no coarse activity, and a permission's tool name is deliberately not used. When a transcript is joined to the agent and Paseo says it is running, the transcript supplies the activity (see [the roster](#the-roster)). The first matching row wins.

| Paseo | HQ state | Notes |
|---|---|---|
| `archivedAt` set, or the agent is removed | not on the roster | |
| pending permissions, or attention reason `permission` | `waiting` | wait reason from the first permission kind: `question` is `question`, `plan` is `plan_approval`, anything else `permission` |
| status `error`, `providerUnavailable`, or attention reason `error` | `error` | Stays on the roster while Paseo flags it for attention or reports background work. Otherwise it expires after 30 min. |
| status `running` or an active turn | `working` | `since` is `activeTurn.startedAt` when present |
| status `initializing` | `starting` | |
| attention reason `finished` and `requiresAttention` | `finished` | Stays ready to review while the flag is set. |
| status `closed` | `finished` | For 60 s after `updatedAt`, or as long as background work continues. |
| `idle`, attention reason `finished` and an attention time under 10 min old | `finished` | |
| `idle`, `updatedAt` under 30 min old or background work active | `idle` | Background work keeps the room visible independently of the foreground state. |
| `idle`, older | not shown | Paseo keeps non-archived agents indefinitely |

The existing windows are the constants `CLOSED_FINISHED_MS` (60 s), `FINISHED_ATTENTION_MS` (10 min) and `IDLE_VISIBLE_MS` (30 min) in `collectors/paseo/liveState.ts`.

### The roster

`services/hq/roster.ts` turns what the feeds keep into `HqAgent`s, built field by field from the contract. Paseo's agents and the transcripts' sessions are merged first: one **entity** is one agent as Paseo, a transcript or both see it.

**The ownership rule** (`roster.ts`, the same four points in its header comment). Ownership and ids are decided first, over **all** the agents; the cap only removes entries afterwards.

1. A roster id, once shown for an agent, stays with that agent for as long as it is continuously visible. An agent that already holds an id (the memo has one for its own key) keeps it, full stop; an agent never seen before derives its id from the session key when it owns the session, else from its own Paseo key; an id is never given to two entries.
2. Ownership of a session key is sticky. A session key is owned by the Paseo agent that owned it before, if that agent is still present and still names that session; otherwise by the best of the current claimants (most recently updated, then lowest agent id). Only the owner is joined with the transcript and answers to the session key.
3. A claimant that does not own the session has the id of its own Paseo key and is not joined with the transcript.
4. A native parent link resolves to the **owner** of the parent session. If that owner is not on the capped roster the child is `kind: 'child'`, `parentId: null`, `parentAway: true`; another claimant never stands in for it. A Paseo parent label resolves to the labelled agent's entry or is away in the same way. A cycle is refused.

- **The join.** A Paseo agent's `runtimeInfo.sessionId` is the provider's own session id: a Claude Code main transcript's file name, a Codex `session_meta.id`. A Paseo agent and a transcript session of the same provider (`normaliseProvider`) with the same session id are one entity, `seenBy` both. A session is owned by one Paseo agent only (rule 2 above); an agent Paseo's own rules do not show (idle for more than 30 min) is not a claimant and does not take a transcript, which is then shown on its own.
- **State when both see it.** Paseo's reported `waiting`, `error`, `starting`, `finished` (closed) and `idle` win outright, with `activity: 'none'`. When Paseo says `running` the state stays Paseo's (`confidence: 'reported'`, Paseo's `since`) and the transcript supplies `activity` while its own state is working; it is never promoted: an inferred wait in the transcript does not turn a running agent into a waiting one. `lastActivityAt` is the later of Paseo's `updatedAt` and the transcript's last conversation line; `startedAt` is Paseo's `createdAt`, else the Codex `session_meta` time. A session only a transcript sees is `confidence: 'inferred'` (see [the mapping](#the-mapping)), with `activity` only while working. When the owner has turned on Claude Code's hooks, a session that **no Paseo agent owns** also takes what its latest hook event says (a reported permission wait, a finished or idle turn, a start, an end), unless the transcript has a later conversation line; for a session Paseo owns the hooks are not read ([the rules](#claude-code-hooks-the-owners-opt-in-switch)).
- **Parents.** Two sources: the provider's own record (**native**: a Claude Code subagent's `<session>/subagents/` folder, a Codex thread's spawner named in `session_meta` as `parent_thread_id` or `forked_from_id`, the batch importer's rule) and Paseo's `paseo.parent-agent-id` label. Native wins; Paseo's label fills a gap where the provider names no parent; an edge is never invented from anything else. A native claim names `claude:<id>` / `codex:<id>` and finds the **owner** of that session among all the entities (rule 4 above), including a Paseo agent that owns the session but whose transcript is not being followed; a Paseo agent that merely claims the same session is not that owner and is never substituted. An edge exists only when the parent entity is itself on the roster after the cap; otherwise the agent is `kind: 'child'`, `parentId: null`, `parentAway: true`. An agent whose ancestor chain enters any cycle (its own, a two-agent loop, a loop it only leads into, native and Paseo edges mixed) gets no edge and makes no parent claim: it is a root. `parentBasis` is `native` or `paseo`.
- **Ids.** `'a'` plus the first 12 hex characters of `sha256(key)`: opaque. An entity's **keys** are `paseo:<agent id>` (a Paseo agent) and, when it owns a provider session, `claude:<sessionId>` / `codex:<sessionId>` (the join key `(provider, providerSessionId)`); a transcript-only session has the session key. The service keeps a **key memo** while the feeds run: every key of an entity is remembered at once with its id and the poll it was built in, and the owner of each session key with the Paseo agent that owned it. Each poll decides ownership (rule 2), then ids, for all entities before the cap: an entity looks its keys up in the memo, its own first (`paseo:<id>`, or the session key for a transcript-only session) and then the session it owns, and takes the first id that nobody has taken. Who is decided first: an entity that held its own key's id in the previous poll (continuously visible), then one that held it longer ago, then one that only has the session's id, then a new one; a Paseo agent before a transcript-only session; then by key. So a returning claimant cannot take the id of an agent that has been visible all along, and the result depends neither on display order nor on the order Paseo lists agents in. Only after every entity that has an id to keep has taken it do new agents derive theirs: `sha256` of the session key when they own one (so the same agent has the same id whichever feed sees it, and again after a stop and a start that forgot the memo), else of their own Paseo key (`rosterId`); a derived id that is taken is rehashed with a counter. A Paseo outage that leaves only the transcript, a transcript that appears while Paseo is down, a Paseo agent that learns its session id later, and the reverse of each, keep the id already shown. A key (and an owner) not seen for 30 min is forgotten, each table holds at most 500 entries (the oldest go first; what the poll in progress wrote is never dropped for the bound), and the whole memo is dropped when the feeds stop (nothing about the agents survives while nobody is looking).
- **Title, workspace, repo.** The main Paseo agent uses the workspace display title from the current listing. For children and agents whose workspace title is missing, the order is the Paseo agent title, the stored session title from `db/queries/hq.ts › readLiveSessionLabels`, and the native subagent label when available. The API returns null when all applicable sources are missing. Workspace: Paseo's project workspace name, else the last segment of the working directory, else the stored workspace label. Repo: the stored `session.repo_id` of an imported session, else the repo from the working directory with the ingestion resolver (`collectors/ingest/repo.ts`), which reads local git configuration only and needs no database. A resolver is rebuilt every minute so its per-folder memory cannot go stale, and it is dropped when the feeds stop, so no folder or `.git` path is kept while nobody is looking.
- **Empty threads.** After the join, HQ treats a thread as empty when Paseo explicitly reports no submitted prompt or saved session, with no provider session id, matched transcript activity, turn, background work or attention. An empty thread stays in the roster only to link eligible descendants. Missing prompt or saved-session fields and malformed work indicators leave the agent eligible for the recent idle list. An expired, unarchived Paseo parent may stay as context for an actionable descendant. A live entity that already owns the provider session keeps it. A child with an explicit Paseo parent still links to that exact parent.
- **Order and cap.** Waiting agents come first, then errors that still need attention or have unknown attention, active work, unread results, available ancestors of those agents, and finally recent idle. Each group is ordered by most recent activity and then by a stable key. At most 60 agents are returned. `truncated` is true when the cap cuts eligible agents or the primary 200-entry page has more results.
- **Times.** Every time that enters HQ's kept state passes `lib/liveTime.ts › liveTime` at the boundary where it enters: a transcript line's `timestamp` and a Codex `session_meta` time (an invalid one is the time the line was seen at), a followed file's modified time (an invalid one is not followed), and Paseo's `updatedAt`, `createdAt`, `attentionTimestamp` and `activeTurn.startedAt` (an invalid one is absent, and `updatedAt` falls back to `createdAt`, then to now). A time is valid when it is finite and between 2000-01-01 and 24 h ahead of the clock: a finite number outside what a JavaScript `Date` holds (±8.64e15 ms) makes `toISOString()` throw, and a time far ahead of the clock would keep an agent on the roster for ever. The roster checks every time again (`buildRoster`): a bad time is replaced by now (or dropped where the field is optional) and counted.
- **The answer never fails because of an agent.** Each agent is built inside its own guard: one that cannot be built is left out (its children then say the parent is away), a failing repo or label lookup is "no repo" or "no label", and the whole list is checked against the contract (`HqAgent`) before it is returned, leaving out what does not satisfy it. The service wraps the reads and the build in one more guard: if everything fails the feed statuses are still answered with no agents. A repair is logged once per run with a fixed code (`roster_repaired`, `roster_failed`), never a count.

### The transcript feeds

`collectors/live/` holds two feeds, `claude` and `codex`, with the Paseo feed's lifecycle (`start`, `stop`, `ready`, `status`, and a read of what they see now). They run only while HQ is being viewed (the demand gate below) and after first-launch Setup is finished, and exist only in a process that reads this machine (`boot` is given `local`, as it is for the batch adapters; otherwise the feed is `unavailable`). Nothing is written to SQLite or to disk.

#### What the transcripts show (experiment E9)

E9 (`scripts/experiments/e9-live-activity.ts`) reads recent transcripts within the approved roots and records only counts and histograms of recognized record fields. Histogram identifiers are bounded and content, paths, titles and session IDs are excluded.

| Entry point | Read by HQ |
| --- | --- |
| Claude Code terminal, the Claude desktop app's Code tab, and SDK clients writing provider transcripts | Yes, through the configured Claude Code projects roots |
| Codex terminal, Codex desktop, and ChatGPT handoffs that run in Codex | Yes, through the configured Codex session roots |
| Cowork or desktop-native chats outside the configured provider roots | No |

HQ does not read `entrypoint`, `originator` or `source` to tell a terminal from an app (it would be one more field read): a session started anywhere looks the same. A session that runs remotely or in the cloud, or whose transcript is deleted, is not on this machine and cannot be seen.

**What the records say.** Observed shapes, and what each is used for:

| Moment | Claude Code | Codex |
| --- | --- | --- |
| A prompt arrives | A `user` line whose content is a string or a `text` block and that is not `isMeta` | `event_msg` `task_started`, and a `response_item` `message` with role `user` |
| The assistant thinks | An `assistant` line holding a `thinking` block. Lines are written one block each, when the message is complete, and carry the message's `stop_reason` (`tool_use` or `end_turn`): thinking is **not seen while it happens**, only inferred from the last prompt or result | `response_item` `reasoning` |
| It writes text | `assistant` line with a `text` block | `response_item` `message`, role `assistant` |
| A tool call starts | `assistant` line with a `tool_use` block (`id`, `name`): Bash, Read, Edit, Write, Agent, ToolSearch, SendMessage, Skill, AskUserQuestion, WebSearch, WebFetch, ExitPlanMode, TaskStop, Monitor and many MCP tools | `response_item` `custom_tool_call` (`exec`) or `function_call` (`send_message`, `wait_agent`, `spawn_agent`, `request_user_input`, …), with a `call_id` |
| A tool result | A `user` line with a `tool_result` block (`tool_use_id`, `is_error`); `toolUseResult` and `permissionDecision` ride on it | `custom_tool_call_output` / `function_call_output` with the same `call_id` |
| The turn ends | `assistant` line with `stop_reason` `end_turn`; and a `system` line with subtype `turn_duration` right after | `event_msg` `task_complete` |
| An API error | An `assistant` line with `isApiErrorMessage: true`. A `system` `api_error` line is a failed attempt that Claude Code retries | An `event_msg` `error` is in Codex's own event list; its live behavior remains unverified |
| An interrupted turn | **No structural record.** The user line written when the person interrupts holds text starting `[Request interrupted`; some records also carry the key `interruptedMessageId`. HQ reads only that key, so most interrupts look like a new prompt | `event_msg` `turn_aborted` |
| A permission or approval request | **Not written.** `permission-mode` / `mode` lines record the mode (`normal`, `auto`), and `permissionDecision` is written on the tool result *after* the decision | **Not written** (no approval event was seen) |
| Spawned work | `<session>/subagents/agent-*.jsonl`, every line `isSidechain` | `session_meta` `source` an object with `subagent.thread_spawn.parent_thread_id`, or `forked_from_id`; thread source `subagent` or `guardian_review` |

Records that mean nothing for the state: Claude Code's `attachment` (hook results and notices, most of the lines), `api-request` / `api-request-blob` / `api-request-shape` (a request log; the blobs repeat message content, so they are never read as conversation), `queue-operation`, `last-prompt`, titles (`custom-title`, `ai-title`, `summary`), `agent-name`, `pr-link` and others; Codex's `token_count`, `item_completed`, `thread_settings_applied`, `turn_context`, `world_state`, `compacted`.

A file can end on housekeeping records. HQ uses the last conversation record to derive turn state.

An active Claude Code subagent can outlive its parent's live window. For a child the feed already
follows, HQ checks the exact main transcript in the same project using the same containment rules
and bounded tail reader. It caches only the file identity and projected parent metadata for the
duration of the feed. A parent whose last recognized conversation is past the live window joins
the crew as idle context while a child needs attention. An existing live parent, eligible Paseo parent, or
effective `SessionEnd` keeps its precedence. If HQ cannot verify the old parent, the child keeps
its separate roster entry.

#### Roots, files, reading

- **Roots.** Claude Code: `projects/` of each `$CLAUDE_CONFIG_DIR` entry, else `~/.config/claude` and `~/.claude`; the file rules are the batch importer's (`classifyTranscript`: main transcripts and `<session>/subagents/*.jsonl`; set-aside `*.orphaned-*` and `*.superseded-*` copies skipped). Codex: `sessions/**/*.jsonl` of each `$CODEX_HOME` entry, else `~/.codex`. **Never followed:** `archived_sessions/`, `.jsonl.zst` files, and any folder outside these (no desktop-app folder). The roots are worked out again at every full listing, so a changed environment is seen without a restart.
- **Finding the files that are being written.** `collectors/live/recent.ts`. A full listing of the roots (`confined.ts › listWithin`, not the batch walker) at most once a minute (`FULL_LISTING_EVERY_MS`) keeps the files modified in the last 15 minutes, newest first, at most 48. Between listings only what is known is looked at: a `stat` of each followed file, and a listing of the few folders where a new file would appear (Claude Code: the folder of each followed file and each followed session's `subagents/` folder; Codex: the folder of each followed file and today's and yesterday's `YYYY/MM/DD` folder, by UTC and by local date). A new project folder, or a file that went quiet and was written again, is found by the next full listing, so within a minute.
- **Containment.** `collectors/live/confined.ts`. The batch importers follow symbolic links (a one-off import the owner started); HQ reads on a timer for whoever opens the page, so it does not. **The rule: below a provider root no path component may be a symbolic link, ever.** A path is acceptable only when its `realpath` is exactly the real path of the root plus its path below the root (which proves that no component below the root is a link) and `lstat` says a regular file (for a folder, a directory). One function, `checkBelow`, is that rule, and the full listing (every folder before it is read, every file before it is accepted; a dirent that is a link is skipped without being resolved), the incremental look (every hot-folder stamp and every followed-file stat) and the open all call it, so they cannot diverge. The root itself may be a link (it is the owner's approved location; its real path is worked out once per listing). **A folder is enumerated only through a handle whose identity has been verified** (`readDirectoryWithin`, the one function that lists a folder: the root, a project folder, a `subagents` folder, a Codex date folder, in the full listing and in the incremental look alike): the rule is checked and its `lstat` gives the folder's device and inode; the folder itself is then opened with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` and the handle's `fstat` must be a directory with that device and inode (otherwise `ESTALE`, and the handle is closed), so a path swapped for a link after the check cannot be opened, and a link in an ancestor opens another folder that fails the identity check. The names are then read **through that handle where the platform allows it** (the descriptor path `/proc/self/fd/<fd>`, which is the open directory itself whatever the path now leads to), and otherwise by path **with the handle held, followed by a second check**: the path must still pass the rule and still have the held handle's device and inode, or every name read is discarded (`ESTALE`). Which mode is in use is found once per process by a self-check (a handle on this program's own folder is read by the descriptor path and by the path; the descriptor path is used only when both give the same names): **Linux reads through the descriptor** (by the kernel's semantics; not exercised on the machine this was built on), **macOS cannot** (it answers `ENOTDIR` to a directory at `/dev/fd/<fd>`, found on macOS with Node 26) **and reads by path and checks again**. In that mode a path that is swapped to another folder between the open and the read, and swapped back before the second check, is the one thing not detected: the by-path read has then listed another folder's names. They are names only, they are kept nowhere, and every name is checked by the rule individually before anything is done with it (a name from a folder that is not this one fails the `realpath` equality or does not exist), so it cannot lead to a file outside the root being opened. Likewise the one `open` of a folder whose ancestor was swapped before the open (Node has no open relative to a verified parent) reaches the other folder, is refused on identity and closed without a name being read. The handles are tracked by the feed's `OpenFiles` like file handles (so `stop()` waits for them) and are closed whatever happens: a failing `fstat`, a failing read, an identity mismatch and an abort mid-enumeration each leave the count at zero (tested). A full listing opens one handle per folder. So a link to another place, inside the root or outside it, to a file or to a folder, at any depth, is refused, and so are a socket, FIFO, device or directory where a file is expected and a dangling link (none of them throws). At read time (`openWithin`) the rule is checked, the original path is opened with `O_NOFOLLOW` and without blocking (`O_NONBLOCK`, so a FIFO cannot hold the loop), and the handle must be a regular file with the device and inode of the `lstat` that check made and of the listing; otherwise the read is refused (`EACCES` for refused or not a regular file, `ESTALE` for a different file, `ENOENT` for gone) and retried at the next tick. Everything read from that file, including the head hash and a Codex rollout's first line, goes through that one handle, and the handles a feed opens are tracked by the feed (`OpenFiles`, see [Stop semantics](#stop-semantics)). **The repo lookup** reads a session's working directory, which is arbitrary text from a transcript (or Paseo's `cwd`); it is the batch importers' own resolver (`collectors/ingest/repo.ts`, used by `codex/index.ts` and `claude/index.ts` with the same transcript `cwd`), so HQ adds no new kind of exposure: it only ever `stat`s `<folder>/.git` going up from the working directory (at most 64 steps, absolute paths only), and reads `config` (and, for a `.git` file, the `gitdir:` target's `commondir` and `config`) at most 256 KiB each, and keeps only a GitHub `owner/name` from an `origin` URL. The one change made for HQ's sake, which the batch importers share, is that these small reads open with `O_NONBLOCK` and refuse a non-regular file, so a FIFO named `.git`, `config` or `commondir` cannot stop the (synchronous) lookup; results for regular files are unchanged.
- **Tailing in memory.** `collectors/live/tail.ts`, with the batch importer's own `LineReader` (opted into a byte budget) and the same replaced-or-appended rule as `planRead`, read through the one open handle. The first time a file is seen only the last 256 KiB are read. Whether that window starts in the middle of a line is decided by **the byte before it** (`alignedStart`): a newline there means the window starts on a line and nothing is discarded; anything else means everything up to and including the first newline of the window is discarded. The first non-empty record is never the signal (a window can start exactly at a newline, and its only complete record is kept), an empty or blank first complete line is just consumed, CRLF is handled by the line reader, and a window with no newline at all consumes nothing and waits (the state is marked `unaligned`; the next read aligns again). A file shorter than the window is read from its start. Afterwards only what was appended is read, from the end of the last complete line, and a trailing line without a newline is taken only when it is complete JSON. A file that is now shorter than what was read, or whose first bytes changed, was replaced: it is read from its end again and its session starts over. A file that has grown by more than 4 MiB since the last read is read from its end too, but its session carries on, told that lines went unread (as for a dropped long line). A Codex rollout's identity is its first line (`session_meta`, from at most the first 256 KiB of the file), read when the file is first followed; the thread id in the file name is the fallback.
- **Per-tick bounds.** Every 2 s (`TRANSCRIPT_POLL_MS`) a feed follows at most **48 files**; each is read for at most **1 MiB per tick**, counted in bytes consumed: every complete line counts, whether it was handed over, dropped for its length or empty (`LineReader`'s `stopAfterBytes`), so a flood of long or blank lines is read a megabyte at a time like any other. It stops between lines, a line in progress is finished first (one line is at most the 4 MiB catch-up bound), and a trailing line with no newline yet is left for the next read; the read goes only up to the size the file had when it was listed; a first sight reads at most 256 KiB. A line longer than **512 KiB** is dropped by the reader without being held (`LIVE_MAX_LINE_BYTES`). The reader gives the event loop a turn every 500 lines, counting every line, empty or dropped ones included. The 256 KiB first-sight window and the jump to a file's end when it is more than 4 MiB behind are both below the per-tick limit, so the limit applies from where the read starts. Worst case for one tick is therefore bounded by file count times 1 MiB, and a flood of appended data is skipped, not caught up on.
- **Status.** No root exists: `notfound`. A root exists and cannot be read: `denied`. Another failure of the look: `failed` (retried at the next tick). A root that exists with no recently written file is `live` with no agents. **`starting`** lasts until the first complete tick is over: the roots found **and** each followed file read once (a file that could not be read counts as tried and is retried next tick). If that has not happened `FIRST_READ_DEADLINE_MS` (10 s, by the feed's clock, checked after each file) after the feed started, it reports what it has read so far. A feed that finds its roots again after `notfound` is `live` only after its reads too. `ready()` resolves at the moment the status changes, so the service's cold wait ends then, and a snapshot taken during the first read reports `starting`, no agents and `truncated: false`.

#### What is read from a line, and what never is

A line is parsed and then read through a **whitelist**; the kept record is built field by field and the parsed object is not referenced afterwards (`claudeActivity.ts`, `codexActivity.ts`).

- **Claude Code reads:** `type`, `subtype`, `timestamp`, `cwd`, `isSidechain`, `isMeta`, `isApiErrorMessage`, the presence of `interruptedMessageId`, `message.stop_reason`, and of each `message.content` block its `type`, a tool call's `id` and `name`, and a tool result's `tool_use_id`. Whether a user line's content is text is a type check; the text is never looked at.
- **Codex reads:** `type`, `timestamp`, `payload.type`; of a `response_item` its `role`, `call_id` and a call's `name`; of `session_meta` `id`, `timestamp`, `cwd`, `forked_from_id` and `source` (to classify the thread and name its parent, with the batch importer's `classifySource`). For a spawned thread, the first record supplies `agent_nickname`, then `agent_role`, from the payload or `source.subagent.thread_spawn`.
- **Claude Code subagent metadata.** HQ reads only `agentType` from the exact adjacent `agent-<id>.meta.json` of a followed child. The file must pass the transcript containment checks and fit within 16 KiB. Missing, unreadable, or malformed metadata is retried on later ticks while the child is followed. Once a label is available, the tracker holds it until the transcript leaves the feed or is replaced.
- **The tool name** is mapped on the spot to a category (below) and dropped: it is never kept, logged or returned.
- **Never read, kept, logged or returned:** any `content`, `text`, `thinking`, `input`, `output`, `arguments`, `summary` or `error` string, `toolUseResult`, `permissionDecision`, `attachment`, conversation title records, subagent task descriptions, branch names, repository URLs, `base_instructions`, token counts, `entrypoint`, `originator`. No line text, path, file name or id is ever put in a log or an error: the logs carry fixed application codes (`tick_failed`, `list_failed`) and statuses. The tests set every one of these to a `SENTINEL_*` string and assert it appears in no feed output, no service output and no log.

Text from a transcript is bounded (`lib/liveText.ts`): a working directory longer than 4096 characters is not kept, a Codex `session_meta` id or parent id longer than 256 characters is not one (the file name's thread id stands in for the id), and the workspace shown from a folder name is cut to 1000 characters. A provider subagent label is trimmed and capped at 1000 characters. A line that makes a tracker throw counts as a line that could not be read; a session that cannot be read when the roster is built is left out of that answer.

What a feed keeps per followed file, in memory, while it runs: the file's path, size, modified time, read offset and head hash; the session id and parent session id; the working directory; a recorded subagent label when available; and the state machine (phase, times, and for each tool call still waiting its id, start time and category). `stop()` drops all of it.

#### The mapping

Tool names to categories (`toolCategory.ts`, fixed tables; a name not in them is `tool`):

| Category (`activity`) | Claude Code | Codex |
| --- | --- | --- |
| `reading` | Read, Grep, Glob, LS, NotebookRead | read_file, list_dir, grep_files, view_image |
| `editing` | Edit, MultiEdit, Write, NotebookEdit | apply_patch |
| `command` (long-running) | Bash, bash, PowerShell, KillShell | exec, shell, shell_command, exec_command, write_stdin, local_shell_call |
| `delegating` (long-running) | Agent, Task, SendMessage | spawn_agent, wait_agent, wait, send_message, send_input, followup_task, list_agents, close_agent, resume_agent |
| `planning` | TodoWrite, TaskCreate/Update/List/Get, EnterPlanMode; **ExitPlanMode asks for plan approval** | update_plan |
| `tool` | everything else, including MCP tools, WebFetch, WebSearch, Skill, ToolSearch; BashOutput, TaskOutput and Monitor are long-running; **AskUserQuestion asks a question** | everything else; **request_user_input and request_user_input_async ask a question** |

State per session (`machine.ts`, shared by both providers; pure and unit-tested). All of it is `confidence: 'inferred'`. Times are in `heuristics.ts`.

| Situation | State | `activity` |
| --- | --- | --- |
| A prompt arrived, or a result came back and nothing waits | `working` | `thinking` |
| A thinking block / reasoning item | `working` | `thinking` |
| Assistant text with the turn open | `working` | `responding` |
| A tool call is waiting for its result | `working` | the newest waiting call's category |
| The turn ended (`end_turn` / `task_complete`) | `finished` for 60 s, then `idle` | `none` |
| An API error (Claude Code) / an `error` event (Codex) | `error`, until something else is written | `none` |
| An interrupted turn (`interruptedMessageId` / `turn_aborted`) | `idle` | `none` |
| The conversation has been silent 120 s and no call waits | `idle` | `none` |
| A waiting call that asks (AskUserQuestion, request_user_input) | `waiting`, wait reason `question`, at once | `none` |
| A waiting ExitPlanMode | `waiting`, wait reason `plan_approval`, at once | `none` |
| A waiting call that is **not** a long-running kind, with no result after 10 s | `waiting`, wait reason `permission` (inferred; the client says "May be waiting for you") | `none` |
| Nothing that counts (see below) for 15 min | not on the roster | |

`since` is the start of the turn for `working`, the moment the state began otherwise (a derived change, such as `finished` to `idle`, is stamped with the time it became true). `lastActivityAt` is the last conversation line. A line that is too long to read counts as activity and clears the waiting calls, so it can never read as "waiting". At most 64 waiting calls are remembered per session (the oldest is forgotten). A repeated end of turn (Claude Code writes both `end_turn` and `turn_duration`) keeps the first time.

**What keeps a session on the roster** (`machine.ts`, and the two feeds' trackers). Only these count, and the 15 minutes run from the latest of them:

- a **conversation line**: a prompt, thinking, assistant text, a tool call or its result, an end of turn, an interrupt or an API error, and a line too long to read;
- any other line **with a real time of its own, while a turn is open and within the 15-minute roster window**. A bookkeeping record can extend the window for a live turn. Once that window expires, a conversation line is needed to bring the session back, even if no end-of-turn record was written.

A **bookkeeping line** (a title, an attachment, a queue operation, Claude Code's `cost-state`, a Codex `token_count`) written after a turn ended, or before any turn, counts for nothing: it does not start a session, does not keep one on the roster and does not move `lastActivityAt`, because it says when a file was touched, not when the conversation happened. A line with **no usable time of its own** (no `timestamp`, or one `liveTime` rejects) is read at the moment it was seen only if it carries a conversation event; with none it is skipped altogether, even while a turn is open, so Claude Code appending untimestamped bookkeeping to yesterday's transcript can neither bring that chat back as an idle room nor keep a half-open turn alive. A consequence: a session that has said nothing yet (no prompt) is not shown until it does.

Timers (`heuristics.ts`): `FINISHED_VISIBLE_MS` 60 s, `QUIET_IDLE_MS` 120 s, `PERMISSION_GUESS_MS` 10 s, `DROP_AFTER_MS` 15 min, `RECENT_WINDOW_MS` 15 min, `FULL_LISTING_EVERY_MS` 60 s, `TRANSCRIPT_POLL_MS` 2 s, `FIRST_READ_DEADLINE_MS` 10 s. The values are starting guesses, kept in one place.

#### What cannot be known without hooks

- **Whether a permission prompt is on screen.** Neither provider writes one. A real prompt for a shell command is invisible (a shell command is a long-running kind, so it is never guessed to be waiting); for an edit or a tool call the guess is "no result after 10 s", which a slow tool also satisfies, and a prompt that is answered quickly is never seen. A run in an auto-approve mode will show the same guess for any slow call.
- **Whether the process is alive.** A session whose process was killed looks like one that went quiet: it reads `working` or `idle` until the 15-minute drop. A session that is open and idle in a terminal for longer than 15 minutes leaves the roster until it writes again.
- **Most interruptions** in Claude Code (see above), **an API error in Codex**, and **thinking in progress** (a message is written when it is complete).
- **Which application started a session** (HQ does not read `entrypoint` or `originator`).
- **A session whose transcript is deleted or not on this machine.**

A real permission request, an interrupted turn and a Codex error followed live have not been observed (see the verification status above). For Claude Code the first of these is what the owner's opt-in [hooks switch](#claude-code-hooks-the-owners-opt-in-switch) answers: with it on, a permission wait is reported, not guessed. Codex has no such hook here, and nothing in this list changes for a session whose hooks have not spoken.

#### Stop semantics

**`stop()` resolves only after every file handle and stream the feed opened is closed and no feed code can run again.** One run (`start()` to `stop()`) owns all its state (controller, file finder, followed files, open handles, status), so a late step of a stopped run can only touch that run's own dead objects, never a restarted feed's. `stop()` aborts the run's signal **synchronously** (before anything is awaited), then (1) `OpenFiles.closeAll()`: refuses new opens, waits for an open in flight (which closes its own handle) and closes every handle that is open, waiting for each close; read streams are destroyed on the abort; and (2) awaits the tick itself. **Nothing in the transcript feeds is raced against the abort** (there is no race helper any more): each step of the tick ends by itself and promptly, the signal is checked between steps (between folder entries, between files, between lines of a chunk, after every await), a stream is destroyed with an `AbortError` on abort, and `stop()` waits for the step that is in flight and for nothing after it. **The roots lookup** is given the run's signal (`roots(signal)`; Claude Code's `projectRoots(configDirs, signal)`), checks it before each root and after each `realpath`, and stops iterating once it has aborted; the finder then does not list any further root. So a stop during the first of several roots resolves after that one call has returned, and no later root is touched (tested for both providers by counting the calls that reach the file system). A tracker's start (`source.start`) is given the signal too and ends at the step in flight (the Codex first-line read opens through the run's handles, which a stop closes, and its stream is destroyed on abort); a start that did not look at its signal would hold the stop, which is the point: nothing is abandoned running. The one residual is a file system call that never answers (a hung network disk): a stop waits for it, because abandoning it would leave the call, and any handle it was about to return, outside the feed's control. **Nothing is assigned to kept state after a stop:** every write follows a check of the run's signal, the file finder works out the next state in locals and assigns it only if the signal has not aborted after its last await, and a feed started again has its own run. `stop()` clears the timer (the only timer is the wait between ticks, which ends on abort), and drops every followed file with its path, offset, head hash, session id, working directory and state machine, and the file finder's own memory; a second `stop()` while one is in progress waits for the same one. The service also drops the repo resolver and the key memo at the same moment, and a roster look that began before the stop (it was waiting for a cold start) builds nothing after it: the service counts its stops and is closed for good by `close()`, so no label query, repo lookup or memo write follows. **Shutdown waits for HQ.** `boot`'s `shutdown()` calls `hq.close()` first of all (so every feed's signal aborts at once, and the service refuses to build anything more), keeps draining requests and listeners meanwhile, and **awaits the close to its end** before anything else is decided and before the database is closed: the roster look reads the database (the stored-label query), and the service's own `closed` flag means no look that was waiting begins one after the close, so an in-flight request cannot touch a closed database. There is no HQ-specific deadline. `shutdown()`'s own deadline (`SHUTDOWN_TIMEOUT_MS`) bounds the drain of requests and the wait for the refresh run, and that is the whole of what it reports as "not everything closed in time" (it then returns without closing the database or releasing the lock, so that unfinished work cannot write unprotected); HQ takes part by running first and by its time being spent from the same deadline, never by being abandoned. A failed boot does the same: it does not reject before `hq.close()` has resolved and the database is closed after it. Because the close is bounded by abort-aware work (sockets hard-closed, reads budgeted, the roots lookup and folder reads ending at the step in flight), the only thing that can delay it is a file system call that never answers (a hung disk); in that case `shutdown()` does not resolve until it answers, and a second interrupt signal ends the process at once (`main.ts`). A request that reaches the app while it is shutting down gets a clean 503 from the listener, or, straight to the app, a valid roster with every feed's state and no agents. The Paseo feed stops the same way: an answer that arrives in the turn of the stop is not kept, and `stop()` closes the client. Tests assert, for a stop during the roots lookup, during the listing (the handle of the folder being read included), during the stat loop, during a read with an open handle, during a tracker's start and during a Codex first-line read, that after `stop()` resolves the feed's own handle count is zero, every handle the process opened for the feed is closed, no timer or pending wait remains, a stopped feed reads nothing, and a restart right after a stop works with no stale session. An error from a file (`ENOENT` mid-read, `EACCES`, a file replaced while reading) stops following that file or retries it at the next tick; it never throws out of the loop and no path or file name is logged.

#### What HQ logs

The log is on disk, so HQ's log lines (the Paseo feed, both transcript feeds, the service and the gate) carry **only application-defined values**: a fixed message, a `source` from `paseo_live`, `claude_live`, `codex_live`, `hq` or `hq_hooks`, and either a `status` (`notrunning`, `needspassword`, `notfound`, `denied`, `failed`) or a `code` from a fixed list (the Paseo feed's `LOGGABLE_CODES`, `tick_failed`, `list_failed`, `roster_repaired`, `roster_failed`, and for the hooks installer `conflict`, `no_folder`, `unreadable`, `not_json`, `not_an_object`, `unsupported_shape`, `not_writable`, `registry_failed`, `stale_preview`, `rollback_failed`). The hook endpoint writes no log line at all, not even for a refused request. There is no count and no flag derived from the roster (the connect line used to say how many agents the daemon listed and whether there was another page; it no longer does), no path, file name, id, title, working directory or error text, and a repair is logged once per run. `test/server/hq/logAllowlist.test.ts` runs each feed, the service and the hooks installer through a whole lifecycle (every refusal included, with a `SENTINEL_*` string in the settings text and the paths) and checks every field of every line against these lists.

### Claude Code hooks: the owner's opt-in switch

Added 2026-11-19. For a Claude Code session that Paseo does not run, HQ can only **guess** that an agent is waiting on a permission prompt: a tool call with no result after 10 s reads "May be waiting for you", because Claude Code writes nothing to its transcript when it asks. The owner can turn on **Know when Claude Code needs you** in Sources & repos or from the first-visit HQ dialog. The switch affects only HQ and installs hooks so Claude Code can tell HQ directly. It is the one place the app changes a provider's settings ([Discovery](#discovery-automatic-no-picker)): the owner chooses whether to install or remove the hooks. Sources & repos explains the settings change beside the buttons and offers the detailed preview separately. The server checks the action’s fingerprint before any write.

**What the documentation says** (code.claude.com/docs/en/hooks, read 2026-11-19; the installed CLI was 2.1.328). The event names HQ uses exist as named: `SessionStart`, `PermissionRequest`, `Notification`, `Stop`, `SessionEnd`. The settings shape is `hooks.<Event>[] = { matcher?, hooks: [{ type: "command", command, timeout }] }`, with `timeout` in **seconds**. A group's `matcher` filters when its handlers run, except that `"*"`, `""` and no matcher all mean "match all" (the three forms are listed in the documentation's matcher table); the documentation does not say whether a group's `hooks` list may be empty. Each event's input carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and its own fields (`notification_type` and `message` on `Notification`, `reason` on `SessionEnd`, `source` on `SessionStart`, `tool_name` and `tool_input` on `PermissionRequest`, `last_assistant_message` on `Stop`). A hook in `~/.claude/settings.json` ("All your projects") runs wherever Claude Code does: "Claude Code fires the same hook events wherever it runs: sessions in the terminal, IDE extensions, the Desktop app, and cloud sessions", except that cloud sessions do not read the local file; the Agent SDK reads user settings unless `settingSources` excludes them. A hook that exits 0 with nothing on stdout changes nothing; "any other exit code, or fails in some other way, such as not starting" is a "non-blocking error. The action goes ahead", and a hook that reaches its `timeout` is cancelled with its output discarded. Plain stdout reaches Claude only for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` and `PostModelSwitch`, so the script prints nothing, ever. `PermissionRequest` "runs when Claude Code is about to ask you for permission", and a hook that returns no decision "leaves the permission flow unchanged". Where the brief's description differed: `Notification(permission_prompt)` fires only "after the prompt has waited about six seconds" (and each keystroke defers it in a terminal), so `PermissionRequest` is the immediate signal and the notification is the one that also covers a sandboxed command's network prompt, for which `PermissionRequest` does not run; `idle_prompt` fires about 60 s after Claude finished, not at once; `Stop` "does not run if the stoppage occurred due to a user interrupt" (the transcript's interrupt line covers that); `SessionStart` also fires on `compact`, mid-session; and `SessionEnd` has a default budget of 1.5 s. Hooks are held back from every settings file until the folder's workspace trust dialog is accepted, and `disableAllHooks` or a managed `allowManagedHooksOnly` turns them off: HQ then simply hears nothing and keeps guessing. "Direct edits to hooks in settings files are normally picked up automatically by the file watcher", so a running session usually begins to report without a restart.

**What is installed.** One entry for each of the five events, in the user-level `settings.json` of every Claude Code folder that exists (`$CLAUDE_CONFIG_DIR`, each comma-separated entry, else `~/.config/claude` and `~/.claude`, the same folders discovery reads; a folder that does not exist is not created, and a project's `.claude/settings.json` and `settings.local.json` are never touched):

```json
"hooks": { "<Event>": [ { "hooks": [ { "type": "command", "command": "<HQ's command>", "timeout": 3 } ] } ] }
```

The command is `: agent-productivity-hq-hook; if [ -x "<node>" ] && [ -f "<script>" ]; then "<node>" "<script>"; fi`: an absolute Node (the one running the app, as the status-line wrapper did: Claude Code's shell may not have `node` on its `PATH`), and a script in the app's own data folder (`<data>/claude-hooks/agent-productivity-hook.mjs`, copied from `integrations/claudeHooks/assets/`, so the path survives upgrades of the app itself). The leading no-op is how HQ recognises its entries, and the `if` keeps Claude Code quiet when Node or the script has gone. **A handler is HQ's only when its command is exactly that shape and its script is named so**; anything else, including a command a person edited by hand, is theirs and is left alone. One module (`command.ts`) both writes and recognises the command, from the same description `{ node, script }`: a command is recognised only if writing what was read gives the very same text, so whatever HQ writes it recognises, and turning on never adds a second entry beside one it did not recognise (turning on takes out every HQ-shaped handler and adds one, and leaves an event alone that already holds exactly HQ's one entry). **Supported paths:** each path (Node, script) must be absolute (start with `/`), at most 1,024 characters, and contain no control character (U+0000 to U+001F and U+007F to U+009F, which include a line break and NUL), no line or paragraph separator (U+2028, U+2029) and no lone surrogate. Spaces, quotes, `$`, backticks, backslashes, `!` and every other character, in any alphabet, are supported and are run correctly by a real `sh -c` (a test executes them). A data folder or Node path outside that is refused **before anything is written** (`unsupported_path`: state `unavailable` with that reason, `422 claude_hooks_blocked` on a change); entries an install in another folder made can still be turned off. No `matcher` is set, so each entry is unfiltered (the server ignores events it does not use), and the hook is not `async` (a script that finishes in tens of milliseconds, with a hard stop at 1.5 s, needs no background mode, and an async hook could be cancelled at a `SessionEnd`).

**Install and remove** (`integrations/claudeHooks/`, `GET` and `PUT /api/hq/claude-hooks`).

*The preview and its fingerprints, one per action.* `GET` is the preview: the files (home-relative), the events, the exact command, for each file whether HQ's entries are `absent`, `present`, `needs_repair` or the file is `blocked` with a fixed reason (`unreadable`, `not_json`, `not_an_object`, `unsupported_shape`, `unsupported_layout`, `not_writable`), and **a plan for each action the state offers**: `off` offers `on` (and `off` too when HQ's own files were left behind, to try again), `on` offers `off`, `needs_repair` offers `repair` and `off`, `unavailable` offers none. A plan lists exactly what that action writes: turn on, every file that gets entries; repair, every file whose entries are replaced or added; turn off, **only the files that hold HQ's entries**; each with the fixed reason if HQ cannot make that change; and HQ's own files (script, registry) the action writes or deletes. **The plan is exact in both directions:** the files an action writes, replaces or deletes are exactly the files its plan lists, and a file the plan does not list is not touched, not even rewritten with the same bytes (a settings file that already holds exactly HQ's entries, a script that is current and a registry the installed hook script already accepts are listed by no action; the one-time copy of a settings file is the single extra file, made when that file is replaced and none exists). A test records every file-system step of every action in every state and compares it with the plan shown. Each plan has its own `preview`, a SHA-256 fingerprint of the action, the resolved settings files, the bytes of each (their digests), the events, the command, and every observed condition of HQ's own files that decides what the plan lists: the script (current, missing or different, which includes a script the command could not run or that others can write), whether the Node the command names can run, the registry (not asked before the server listens; once it does, whether the installed hook script would accept it as this process's) and HQ's own files left behind, each as it was seen (its bytes, device and inode), so a plan that deletes a leftover is for exactly that file. It writes nothing. `PUT { enabled, preview }` is an action: `enabled: false` is turn off; `enabled: true` is turn on when no file holds an entry of HQ's, else repair. It writes only if `preview` is the fingerprint of **that action's** plan for what is in front of the server **now**, derives the plan again (the settings and HQ's own files) immediately before the first write, and checks it again on the very bytes the change is computed from and on HQ's own files as the action left them; a request with no `preview`, a malformed one, a stale one, or the fingerprint of another action is `409 claude_hooks_stale` and writes nothing, not even the script (and what an action wrote before it saw that another party had changed something is taken back by the rule below). Time is not part of the fingerprint; the registry's condition is, so that a plan that lists the registry (because the hook script would not accept the one on disk, or the server has begun to listen) is another plan than one that does not. In Sources & repos, **Turn on** and **Turn off** read a fresh plan for the pressed action and submit its fingerprint if the reported state still matches the card. **What will change** opens a read-only preview. **Repair**, **Remove HQ's files** and the first-visit dialog retain confirmation after displaying the action’s plan.

*The state.* `off` (no HQ handler in any file), `on`, `needs_repair` or `unavailable` (no Claude Code folder, a file that cannot be changed, or a path HQ cannot quote: reasons `no_claude_folder`, `settings_blocked`, `unsupported_path`). The state is computed from disk on every read, never from what an action meant to do. `off` is `off` with `reason: cleanup_incomplete` and `leftover` (the folder and which of the script and the registry) when HQ's entries are gone from the settings but its own files are still in its folder: a removal that could not finish is never reported as complete, and the page says "Turned off. HQ's entries are removed from Claude Code's settings, but HQ could not remove its own files in <folder>; you can delete them."  **`on` means deliverable**, and only means that, decided by ONE function (`deliver.ts`) that applies the rules the installed script itself applies: every targeted settings file holds exactly HQ's complete, unfiltered entries (below); the script is in the data folder with exactly the content this app ships, as a regular file the owner owns, can read and nobody else can write (the command only reads it, so the exec bits do not matter); the Node the command names is a regular file that can be run; and, once the server listens, the registry is one the installed script would accept (its own rules, **imported from the script and not copied**: a regular file of at most 4 KiB, the current user's, closed to group and others, opened without following a link and looked at again as opened, strict UTF-8, version 1, a live pid, a port from 1 to 65535, a token of the shape the app makes) and says this process's pid, port and token. A parity test gives the same registry fixtures (every mode, size, kind of file, bad value) to the script's own check and to the server's and requires the same verdict, and then asks the status. Anything less is `needs_repair`, with the first reason that applies: `entries_changed` (another data folder or an older path, a missing event, a duplicate, a different timeout, type or extra key, a handler of HQ's inside a group with a matcher or beside the owner's handlers), `script_missing` (missing, different, or not a file the command can run and nobody else can change), `node_missing` (the Node the command names cannot be run: the entries already name the Node this app runs under, so repair cannot fix it, only turning off is offered, and restarting HQ makes the entries name the Node that exists), `registry_unpublished` (the running app could not publish where it listens, the registry is one the hook script would refuse (for instance open to group or others), or it points at another process: two app instances sharing a data folder, the later one wins and the earlier one reports it). Repair fixes every reason but `node_missing`; where it cannot (a folder where the registry should be is not HQ's to replace) it fails with a fixed code and changes nothing. Before the server listens there is no registry to ask for. The page words each reason plainly.

*What HQ's entry is, and what removal takes out.* HQ's entry on an event is **present** only when there is exactly one HQ handler there, exact (`type: "command"`, HQ's command, `timeout: 3` and no other key), **alone in its group**, in a group that filters nothing (no `matcher`, or `""`, or `"*"`, the three match-all forms) and has no key but `hooks`; and HQ has no handler on any other event. A handler of HQ's in any other place (a group with a matcher, a group with the owner's handlers, a second copy, an altered handler, an event HQ no longer uses) is `needs_repair`. Repair and removal take out **HQ's handler objects only**: the owner's handlers, their group's matcher and every key of the group stay. A group is deleted only when it is the shape HQ writes (with no repeated key in its text) and the removal left it empty; an event key only when that left its list empty **and no earlier member of that key exists**; `hooks` only when that left it empty and no earlier `hooks` member exists (with an earlier twin, cutting the effective member out would make the twin effective and change the settings, so an empty `{}` or `[]` is left in its place). A group of the owner's that the removal left with no handler (it has a matcher or another key) stays as `"hooks": []`: the documentation does not forbid an empty list, and it runs nothing. A list or object the owner had empty is left alone unless HQ's own removal is what emptied it (HQ cannot tell afterwards who made an event's list, so an empty list the owner kept on one of HQ's five events is deleted with HQ's group when HQ is turned on and then off; it ran nothing either way).

*Merge, never replace, and fidelity.* `PUT` does the same thing for every file:

- Every other key, event and handler is kept. **HQ never rewrites a settings file from a parsed object.** Its only writer (`splice.ts`) makes local edits to the file's own text: an entry HQ adds is inserted, an entry it removes is cut out, and every other byte is the file's own: the byte-order mark, line endings (the first one found), a final newline or none, indentation (spaces, tabs or a one-line file), key order (including keys that look like numbers), number spellings (`1e400`, `-0`, a 20-digit integer, `1.50`), string spellings (escapes, surrogate pairs written as escapes, a lone surrogate escape, raw astral characters), dead text of a repeated key, the owner's own text of every other setting and hook (groups HQ's handler is not in keep their text, and so do the groups it is in: only the handler's text is cut), and the file's mode. **There is no whole-file fallback.** After the edits the text is parsed again with the same last-key-wins reading as `JSON.parse` and Claude Code, and it must be exactly the intended settings; if the text cannot be edited into that, the operation is refused with `claude_hooks_blocked`, reason `unsupported_layout`, and nothing is written (also for nesting deeper than 64 levels). **Repeated keys:** the LAST member of a key is the effective one and the only one HQ reads or edits; earlier members are dead text and stay untouched (install, repair and removal all act on the last `hooks`, the last member of each event and the last `hooks` of a group). Turning on and then off gives back the original bytes for every file, with one limit: an empty `hooks` object or event list the owner already had cannot be told, once HQ has filled it, from one HQ made, so removal deletes it (the effective settings are identical, and nothing else changes) unless a repeated earlier member would then become effective, in which case it stays as `{}` or `[]` and the bytes are restored exactly. A file that is not valid UTF-8 or JSON (`unreadable` for bytes that are not text; comments are not JSON), is not an object, has an effective `hooks` that is not an object or an HQ event that is not a list (`unsupported_shape`), is over 4 MiB (in bytes, not characters), or is too unusual to edit as above is refused, never treated as empty and never rewritten. **HQ never writes what it could not read back:** an edit is refused (`unsupported_layout`) unless its RESULT passes every limit of the reader the status uses (at most 4 MiB in bytes, valid UTF-8, JSON, an object, at most 64 levels, and reading back as exactly HQ's entries or none), so a file just under the limit is never grown past it; the script (at most 256 KiB, starting as HQ's script does) and the registry (at most 4 KiB, the shape HQ parses and the hook script accepts) are held to the reader of each in the same way. A file that does not exist is the empty object, edited like any other (two-space indentation, final newline, owner-only).
- Idempotent: if the file already has exactly what would be written, nothing is written (the file's bytes and time are untouched). Turning it off when it was never on changes nothing and creates nothing.
- Before anything is written every file is checked, so one that cannot be changed stops the whole change. A file HQ may replace belongs to the current user, is writable by its owner (owner write bit and `access`), in a folder that can be written; one the owner made read-only is left alone (`not_writable`), though its folder would let a rename replace it. This is checked at the read, at the staging, at the last compare and before a roll-back, for turning on, repair, turning off and roll-back alike.
- **All or nothing across the files.** A settings path is resolved once per attempt (`realpath`: a link on the file, or on its folder, as a dotfiles setup has, is the one kind of link followed; see below), and the change is computed from what was read. Everything is then **staged before anything is replaced**: for every file that changes, its new content and, for a roll-back, its old content are written to temp files beside it (exclusive create, owner-only, fsynced), and the one-time backup is **proven** (below). Then the files are replaced one after another, and **for every replacement (the update and the roll-back alike) the order is fixed: seal, then observe, then rename**. (1) The staged file is sealed completely (below: identity, bytes, the final mode and group, read back). (2) Only then is the destination observed, and **the compare-and-swap is the last thing before the rename**: the file is observed again and must be the very file that was read: resolved path, bytes, device, inode, size, modification time, **mode, owner and group, and the folder it is in (device and inode)**, and still writable as above; a file that is not is never overwritten (not writable: refused; anything else changed, **its mode included, which is the mode the staged file was sealed with**: start over from a fresh read). (3) Then the rename, with **nothing but that comparison between the observation and the rename: no `await`, no read, no write** (the observation holds the file open, so the file seen is the file read). A save the owner makes while HQ seals the staged file (including the moment it receives its mode) is therefore seen by the observation: it is kept (the attempt starts over, or the preview is stale), never overwritten. **A staged file is never trusted because it was staged: every file HQ is about to rename into place (the update, the roll-back copy, the script's and the registry's temp) is sealed before the observation and the rename**, on the opened file: the same device and inode HQ created, a regular file (not a link), one name (a second hard link refuses), still owner-only and the current user's, with bytes read back equal to the exact bytes HQ computed; only then is it given the file's **whole permission word** from that very observation (`mode & 0o7777`: setuid, setgid and sticky included; the group first, where HQ may, then the mode), and looked at once more: a bit the platform will not keep (setgid for a group the owner is not in, a sticky bit a platform refuses on a file) refuses the change (`not_writable`) instead of being dropped. A staged update that fails the seal is not installed (the change is refused and the temp is left and named); a roll-back copy that fails it is not installed either: the original bytes HQ keeps in memory are written to a fresh exclusive temp, sealed the same way, and renamed. After each rename the file in place is looked at once more (the same file, those bytes, that mode); one that is not is named by the roll-back below (`rollback_failed`) rather than reported as done. If a file is not the one read, or a replace fails, every file already replaced is put back (each in the same order, seal, observe, rename, and only if it is still exactly what HQ wrote, the same device, inode, bytes, size, time, mode and owner, and can still be written, each read back to verify), the temp files and the backups this attempt made are removed, and the attempt starts over from a fresh read, up to three times (then `409 claude_settings_conflict`); a file that did not exist is created with a hard link, so one that appeared meanwhile is never replaced. A file that could not be put back (the owner saved it after HQ wrote it, say) is **named** (`500 claude_hooks_failed`, `details.reason: rollback_failed`, `details.files`, home-relative), its backup stays, and nothing of the owner's save is overwritten. **Every undo step is conditional on the artifact still being what this change wrote, byte for byte and the same inode** (temp files, the backup, the settings files, the script, the registry); one that is not (the owner saved over it, replaced it with a copy, or it cannot be removed) is left where it is and named in the failure (`details.left`: `script`, `registry`, `backup`, `temp`), never silently; a script that was there before is put back only while the new one is still HQ's. That holds for a failed turn-on, repair and turn-off and for shutdown. Turning on installs the script and publishes the registry **first** (through the guard below), so a failure takes them back by that rule, and a published registry that cannot be read back is `registry_failed` with every settings file as it was (unless a file could not be put back: the script and registry stay then, as that file may hold HQ's entries). The answer to a change is the status read from disk afterwards, not what the change meant to do. The one window left is the instant between the observation returning and the `rename` system call, which no program can close without a lock the other program would also have to take. What happens in it is not silent in one case: the file that was observed stays open, so if the owner wrote into it **in place** in that instant, the rename has replaced it and HQ reads what the file it held now says, puts that text back (sealed, over HQ's own file, only while that is still exactly HQ's file) and starts the change over (or names the file `rollback_failed` when it was a roll-back or could not be put back). A save made by **replacing** the file in that instant (an editor's atomic save) leaves no trace on the file HQ held and is the residual that cannot be detected. The tests act at both moments (`sealed.test.ts`): after the seal and before the observation (kept), and after the observation (the in-place case found and put back).
- A settings path that is a symlink (a dotfiles setup) is written **through** to its target, and stays a link: its target is resolved, the temp files are made beside the target, and the target is resolved again at the last compare and must be the same file; a link pointed elsewhere meanwhile is a changed file. A link onto HQ's own script or registry is refused.
- **Names of one file.** A settings path that reaches a file through a **symlink chain** is one target with every other path that reaches it that way (the folder it really is in, and its name; a folder named twice by a link, `..` or another case is one folder): written once, through to the real file. Two paths that are distinct directory entries of one inode (**hard links**) are **each a target**: a rename updates one entry only, so each is written (its own temp files, its own rename, its own one-time copy and its own line in the plan), in the same all-or-nothing transaction, and after any action every configured pathname holds the intended content (a pair turned on holds the entries under both names, which are two files afterwards). A file that has **a name HQ was not given** (more hard links than the targeted pathnames that are that file, e.g. one outside the Claude Code folders) is **refused** (`not_writable`, shown as blocked in the status and the plan, nothing written): the safer choice, because an update through the targeted names would leave the old content, with or without HQ's entries, under the name HQ will not touch. The count uses the pathnames that still share the original inode at each replacement. A rollback restores the original bytes and permissions, but profiles that shared a hard link may remain separate files.
- **A real backup is required.** Before a file that exists is replaced, a copy is proven beside the path the owner knows, as `settings.json.agent-productivity-backup`: either a regular file this change created, or an already-existing file there that HQ accepts, which is **never overwritten**. **The final name only ever appears complete:** the copy is written to an exclusive, owner-only temp beside it (`.settings.json.agent-productivity-backup.<pid>-<hex>.tmp`), fsynced and read back equal to the original bytes, and only then published under the final name with `link` (which refuses a name that exists), after which the temp name is removed; a process that dies at any step leaves the final name absent or whole, and a temp of a process that is gone is swept like any other temp (`sweepStaleTemps`, which names the backup temps too). An existing file at that name counts as "already saved" only if it is a regular, non-link file that is **not empty and reads as a settings file** (a JSON object, by HQ's own reader); an empty or unreadable one is never trusted and never overwritten: the change is refused with the fixed reason `backup_unusable` (`422 claude_hooks_blocked`, `details.reason`, with `details.files` naming the backup, home-relative, in the message), shown in the status and the plan on the file that would be changed (a file that needs no change is not blocked by it). Anything else at that path (a folder, a link, a named pipe, a file HQ cannot read) refuses the whole change (`not_writable`), writes nothing and is itself left as it is. **The backup is a file of its own.** The resolved settings target, its backup, every temp file and HQ's own script, registry and folder are all different files, compared by resolved path and by device and inode (so a link, a hard link, a `..` segment or a name in another case on a case-insensitive disk cannot make two of them one): a settings file that is a link to its own backup path, a backup that is a hard link to the settings file, to another targeted file or to an HQ file, a backup inside HQ's folder, and a settings file inside HQ's folder each refuse the change with a fixed code (`not_writable`; `unsupported_shape` for a settings file in HQ's folder) before anything is written, and the status shows the file as blocked with that reason. Two targeted paths that are one directory entry (a symlink chain, or one folder named twice) are one target: written once, with one backup; hard links are separate targets with a backup each (above). The copy is left in place by removal; one made by an attempt that ended in no change is removed again (only while it is still what HQ made).
- **The order is fixed, and a process that dies after any step leaves a honest disk.** Turning on and repair: HQ's folder, the script, the registry (each only when its plan lists it), then the settings (stage the update, stage the roll-back copy, make the backup in a temp and publish it whole, seal the update, observe the file, rename the update, remove the roll-back copy). Turning off: the settings first, then the registry, then the script. If the process dies after any one step, each settings file is exactly what it was or exactly what it would be (never half of either), the next status reads what is on disk (HQ's script or registry left behind with the entries gone is `off` with `cleanup_incomplete`; entries with something missing is `needs_repair`; `on` only when it is deliverable), and the opposite action (and the same one again) leaves it clean. A crash test stops the process after every step of turning on, turning off and two repairs, then reads the status and runs the opposite action. Every step of making the backup is crashed in turn (`crash.test.ts`), and after a crash at any step of any action no file HQ made stands under its final name incomplete (the backup whole or absent, the script and the registry each a whole file from a temp renamed over, the settings whole). All of HQ's file-system steps are made by one module (`fsguard.ts`), where the precondition of each kind of step is written beside it, and a test fails if any other module of the integration changes the file system.
- Changes are made one at a time. Removal leaves no HQ entry, removes the registry and the script **that the confirmed plan lists, each only while it is still the file the plan recorded** (bytes, device and inode, which the fingerprint covers), and leaves the backup. A file the plan did not list (a script that was missing when the plan was confirmed and was restored meanwhile, a registry that appeared) or that is no longer what the plan recorded (the owner changed it) is **left and reported**: the answer is `off` with `cleanup_incomplete` and `leftover` naming it, and `cleanup_incomplete` is logged. A removal that cannot finish (the folder is read-only) neutralises a registry it cannot delete where the file itself can be rewritten and has one name (its token blanked, port 0), logs `cleanup_incomplete`, and the answer and every later read say `off` with `cleanup_incomplete` and `leftover`; the page offers **Remove HQ's files** to try again: that is the `off` action in the `off` state, with its own plan (`ownFiles` the leftover, no settings file) and its own fingerprint, which includes each leftover's recorded bytes and inode, so a press confirms deleting those files as they were shown and nothing else. After an upgrade or a moved data folder the state is `needs_repair`, and repair is the same `PUT { enabled: true, preview }`.

*HQ's own files* (`integrations/claudeHooks/ownFiles.ts`). Every create, write, read and delete of HQ's artifacts (the `claude-hooks` folder, the script, the registry and their temp files) goes through one guard that refuses unless the folder is a real folder (not a link), directly inside the data folder, owned by the current user, and the artifact is a regular file directly inside it; anything else is left exactly as it is, whatever is asked (shutdown, boot failure, turning off, repair, turning on). Writes are a temp file made `wx` (owner-only) beside the target and renamed over it (a link where the file goes is replaced, never written through; a folder is refused). **A delete follows the confirmed plan:** a turn-off, a failed action's undo and "Remove HQ's files" delete only the artifacts the action's plan lists (and, for an undo, only what that action itself wrote), each only while it is still in the condition the plan recorded (the same bytes in the same file); shutdown deletes only the registry this process published. The one deletion that is not in a plan is the sweep of **temp files** whose maker's process is gone (a name of the exact `.<name>.<pid>-<hex>.tmp` form, a regular file): HQ's own leftovers of a crashed run, never a settings file, a backup, the script or the registry. A delete also needs the file to be HQ's by content: the script only when it is HQ's (this app's bytes, or an older version of HQ's script, recognised by its first words); a registry at shutdown only when it is still exactly the text this process published (so a registry this process never published, or that another instance has taken over, is never deleted); a registry when turning off only when it has HQ's shape (`{ v: 1, pid, port, token }`, nothing else) and its process is this one or is gone. Shutdown removes the registry this process published only while it is still that exact file (bytes and inode); if it cannot be removed it is neutralised in place, and `close()` never throws. What this process published is **tracked through every write, replacement and restoration** of the registry: an undo that puts back a registry it had replaced (an atomic replacement, so a new inode) sets the record to the restored file, so after a failed turn-on, repair or turn-off, shutdown still removes the registry this process published (the registry and the script are asserted removed, or reported, after each), while a file of the same bytes that anybody else made is left.

**The hook script** (`assets/claude-hook.mjs`, plain Node, no dependencies, like the status-line asset) reads the event from stdin (at most 16 MiB; a larger one is not sent) as strict UTF-8, and builds its message **field by field from five fields only**: `hook_event_name`, `session_id`, `notification_type`, `reason` and `cwd`, each checked for the same shape the server enforces (a field that does not fit is left out of the message; invalid UTF-8 on stdin, or a byte-order mark, sends nothing). It **never reads, holds or sends** `message`, `title`, `tool_name`, `tool_input`, `tool_response`, `prompt`, `last_assistant_message`, `permission_suggestions`, `transcript_path` or anything else: those can hold commands, file contents, prompts and notification text. It finds the app through `registry.json` beside itself (`{ v, pid, port, token }`), checks that the process is alive, POSTs to `http://127.0.0.1:<port>/api/hq/hooks/claude` with `Authorization: Bearer <token>`, the app header and a JSON content type (so the browser guards need no exemption), prints nothing, swallows every error, and always exits 0: the whole run is cut off at about 1.5 s, and a missing registry, a stale pid, a refused connection, a slow app or a malformed event end it quietly. Nothing is written to disk. **It never blocks:** the 1.5 s deadline is a timer armed before anything else, which exits the process with code 0 and no output whatever is outstanding, so nothing after it may hold the main thread: every file access is asynchronous (it runs on libuv's pool, where a call that hangs cannot hold the timer), stdin (a terminal sends nothing; a stdin that never closes ends at the deadline) and the HTTP request (whose own timer destroys it at the deadline, not only on an idle socket) are event-driven, and the only synchronous call after the timer is armed is the signal-0 liveness probe, which never waits. The registry is `lstat`ed first and trusted only if it is a regular file of at most 4 KiB owned by the current user with no group or other permission (a pipe, folder, link, or a file anybody else can read or write is not HQ's), then opened `O_NOFOLLOW | O_NONBLOCK`, checked again as opened, and read with a size cap and strict UTF-8.

**The endpoint and its token.** `POST /api/hq/hooks/claude` is mounted on the loopback listener in a process with the Claude Code integration. In Paseo-managed mode this listener serves only hook ingestion. The Tailscale browser app returns 404 for the hook route after the browser authenticates. It needs the token: 32 bytes from `crypto.randomBytes`, made at each server start, never logged, never returned to the browser, compared with `timingSafeEqual` over SHA-256 digests, and checked before the body is read; a missing or wrong token is `401` with an empty body and no log line; the `Authorization` header must be exactly `Bearer <token>` (capital B, one space, base64url characters): a header sent twice or comma-joined, a lowercase scheme, extra spaces or tabs and any other form are the same `401`. The request must have content type `application/json` (optionally `; charset=utf-8`), and the body is bounded (8 KiB, else `413`), decoded as strict UTF-8 (invalid bytes or a byte-order mark are refused; nothing becomes a replacement character) and strictly the five fields (zod `HqClaudeHookEvent`): any other key, any wrong type or shape (event name letters only; session id, `notification_type` and `reason` of letters, digits and `._:-`; `cwd` an absolute POSIX or Windows drive-letter path of 1 to 1024 characters with no control character, line or paragraph separator or lone surrogate) is `400` with one fixed message that says nothing of why and echoes nothing, and stores nothing. An event name or notification type HQ does not use is accepted and ignored (`204`). The **registry** (`<data>/claude-hooks/registry.json`, mode 0600 in a 0700 folder, written atomically) is written once the server listens and the switch is on (when the owner turned it on and HQ's script is in place: also at the next start, over whatever a killed app left behind, with that run's pid, port and token), and removed when the switch is turned off and at shutdown, by the rules for HQ's own files above; its absence or staleness is harmless to the script. The token therefore lives only in server memory and in that file, which only the owner can read: this is a new trust boundary, local process to server, authenticated by that token ([TECH](../../TECH.md#security-and-privacy)). Any process running as the owner could read the file and post events (the same trust as any program the owner runs can edit the settings file); a process that is not the owner cannot.

**What is kept.** Only in memory, only the **latest event of each session**, reduced at once to a kind (`permission`, `idle`, `stop`, `start`, `end`), the time HQ received it and the working directory the hook named; no notification text, tool or path content. At most 200 sessions, a session with no event for 15 minutes is forgotten, and everything is dropped when the server shuts down. Separately, the store remembers which sessions have **delivered** an event (at most 500, oldest first): that fact outlives the event, lasts as long as the Claude transcript feed keeps following the session, and is forgotten 60 minutes after the session's last event or last reading by the feed. It is dropped at once at `SessionEnd`, though the ended record stays 15 minutes. Turning hooks off clears both tables and ignores late hook events. Claude Code transcript sessions then use the permission guess again. Expiry and eviction take from the oldest end only, so a flood of events costs a bounded amount of memory and constant work per request. A session that ended is kept as an "ended" record for the same 15 minutes, because its transcript is followed for up to 15 minutes after its last line and the record is what keeps it off the roster. The endpoint works whether or not the HQ page is open.

**What the events mean for the roster** (`services/hq/roster.ts › fromHook`), for a Claude Code session keyed by the Claude session id (the transcript's, and Paseo's `runtimeInfo.sessionId`). The same mapping applies in every place HQ can know the session from; what differs is who speaks. The four combinations are: **hook only** (no transcript read yet, no Paseo agent); **hook and transcript**; **hook and Paseo** (a Paseo agent owns the session, no transcript); and **all three**. Each cell below is a test.

| Event | Hook only | Hook and transcript | Hook and Paseo, and all three |
| --- | --- | --- | --- |
| `PermissionRequest`, or `Notification` with `permission_prompt` | `waiting`, wait reason `permission`, `reported`, since the request; until a later event, `SessionEnd` or expiry | `waiting`, `permission`, `reported`, while the event is not older than the transcript's last line (a transcript wait for a question or a plan keeps its own more specific reason, now reported) | Paseo's reported state; the hook is not read |
| `Notification` with `idle_prompt` | `idle`, `reported`, since the notification, title `null`, workspace from the validated `cwd`; **the session exists and is idle until `SessionEnd` or expiry** | `idle`, `reported`, since the notification, while not older than the last line | Paseo's reported state; the hook is not read |
| `Stop` | `finished`, `reported`, for the finished window (60 s), then `idle` (since the window ended), title `null`, workspace from `cwd`, until `SessionEnd` or expiry | `finished` for 60 s, then `idle`, while not older than the last line | Paseo's reported state; the hook is not read |
| `SessionStart` | `starting`, `reported`, for 30 s, then no row (it has said nothing since) | The transcript speaks, inferred: a compaction restarts a session mid-way | Paseo's reported state; the hook is not read |
| `SessionEnd`, any reason | No row | The agent leaves the roster at once, unless the session writes a later line (then it is back as the transcript reads it) | Paseo's reported state stays: a Paseo agent is not removed by a hook |

**Expiry.** The hook store forgets a session's latest event after 15 minutes with no event (and keeps at most 200 sessions, oldest first): at that moment a hook-only row, whatever it showed (waiting, idle, finished then idle, starting), is gone; a session with a transcript is shown from then as the transcript reads it (`inferred`); a Paseo-owned session was never read from the hooks. A `SessionEnd` replaces the session's event with an ended record, which keeps its transcript off the roster for the same 15 minutes and removes a hook-only row at once. Restarting the app forgets every event.

**Precedence.** A hook event speaks only while it is **not older than the session's latest conversation line**: any later evidence (a tool result, a new prompt, assistant output, an interrupt) clears a hook-reported wait, and so does a later hook event. A transcript line dated more than 60 seconds ahead of the clock has no usable time and does not hide a hook event. A `SessionEnd` is judged the same way: if the session writes a later conversation line, it is back on the roster as the transcript reads it. A hook's session id never speaks for a subagent's transcript. A hook-reported permission wait beats a transcript-inferred state. **Paseo's reported states keep the precedence they have today**: for a session a Paseo agent owns, hooks are not read at all. A session only the hooks know (its transcript not yet read, or not yet written) is shown from the hook and joins its transcript, with the same id, when that appears. Once a session has delivered any hook event the 10-second permission guess is **suppressed** for it, even after that event has expired, for as long as its transcript is followed and for 60 minutes after it was last followed or heard from, until its `SessionEnd` (hooks are exact; a subagent's calls follow its main session), and a call that asks a question or a plan is still a wait for sure.

**The limit that remains.** Claude Code emits nothing when the owner **approves** a prompt. After approving a long-running command, HQ keeps showing "needs you" until that command produces a transcript line (its result), or a later hook event arrives. The documentation offers no event that fires on approval: `PreToolUse` runs *before* the permission decision ("PreToolUse hooks run before every tool call, whether or not it needs permission"), so it cannot say the prompt was answered; `PostToolUse` and `PostToolUseFailure` run when the tool has finished, which is when its result line is written anyway, and installing them would start a process for every tool call to learn nothing earlier. They are not installed. A denied prompt, an interrupt and a tool that ends are cleared by the transcript as before. (Auto-approved calls never ask, so they never show.)

**Verification coverage.** Automated checks use temporary Claude Code profiles and simulated events. The timing of live `PermissionRequest` delivery relative to the prompt in Claude Code and the Desktop app's Code tab has yet to be measured.

### The demand gate

`services/hq/gate.ts` and `service.ts`. Every `snapshot()` touches the gate. The first touch starts every feed that exists; an `unref()`'d timer stops them all after `idleMs` (30 s) without a request, so no socket runs and no file is read while nobody has HQ open. A touch while the feeds are stopping queues one restart for when they have stopped. On a cold start `snapshot()` waits up to `coldWaitMs` (1 s) for the feeds that are starting to answer, then reports them as `starting`. While first-launch Setup is unfinished (`waitsForSetup()`) nothing starts and each feed that exists reports `setup_incomplete`. The service exists in a process that has a Paseo source (`boot` given `paseo`: the Paseo feed) or that reads this machine (`boot` given `local`: the Claude Code and Codex feeds); a source that is not on is `unavailable`. Shutdown closes every feed.

### Memory only, and what is not built

The roster, its titles and folders live in the feeds' memory for as long as the feeds run and are dropped when they stop. Nothing is persisted, and the Tailscale listener serves the same service under the same guards, so both listeners share one set of feeds. HQ now shows agents started outside Paseo (Claude Code in a terminal, the Claude desktop app's Code tab, Codex in a terminal, the Codex and ChatGPT desktop apps' Codex sessions), Claude Code's own subagents and a coarse activity for working agents, all inferred from transcripts. Not built: Claude desktop app sessions kept outside `~/.claude` (none found; reading another folder needs an owner decision), Codex hooks and reading chat title records from transcripts. (The opt-in Claude Code hooks, added 2026-11-19, are the one exception to "inferred from transcripts": see below. What they report is held in memory beside the roster and is likewise never stored.)


## GitHub delivery

The picker pages through the authenticated user’s repositories on demand, newest pushes first,
using the same sign-in as tracking. A newly detected GitHub CLI sign-in resolves its login through
`GET /user` so the picker can open during first-launch Setup. The list is temporary. Tracking a selected row verifies its
identity and access again. The GitHub App route respects its installation scope. Typing a complete
slug or GitHub URL also supports repositories outside the suggestions.

**Auth (owner choice P2, Review r11):** `gh` first, with a GitHub App device flow as fallback.

1. **Reuse `gh`.** If `gh auth token` prints a token and `GET /user` returns 200, use it. It's re-read before each sync, never persisted, and refreshed by `gh` itself (R12).
2. **GitHub App device flow** (R11, R20), used only when step 1 fails:
   - **One-time owner setup.** Setup and Sources show a guide:
     - Register a personal GitHub App at github.com/settings/apps/new. Name it "Agent Productivity HQ", homepage `http://127.0.0.1:4317`, webhook off.
     - Tick **Enable Device Flow**.
     - Repository permissions: **Pull requests: Read-only** (Metadata: Read-only is mandatory).
     - Turn on expiring user tokens (the default).
     - **Install** the App on your account and on every organization that owns a repo you track (all or selected repositories). A user access token can reach only repos where the App is installed *and* you have access (R20).
     - Paste the App's **client ID** (`Iv…`; not a secret) into the field. It's saved in `app_meta.github_app_client_id` via `PUT /api/accounts/github/app`. No client secret is ever requested.
   - **Connect:**
     - `POST https://github.com/login/device/code` with `client_id`.
     - The UI shows `user_code` and a link to `https://github.com/login/device`.
     - The server polls `POST https://github.com/login/oauth/access_token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) no faster than `interval`, adding 5 s on `slow_down` and stopping at `expires_in` (15 min) or `access_denied`.
   - **Store:**
     - `{access_token (ghu_…), expires_at, refresh_token (ghr_…), refresh_expires_at}` as one JSON secret in the macOS Keychain.
     - Use `@napi-rs/keyring` `new Entry('agent-productivity', 'github-app-user-token')` (R24).
     - Nothing token-like goes to SQLite, logs or the client.
   - **Refresh:**
     - When `expires_at` is less than 5 minutes away, or on a 401, `POST /login/oauth/access_token` with `client_id`, `grant_type=refresh_token` and `refresh_token`. A client secret isn't required for device-flow tokens (R11; confirmed in E6).
     - Replace both tokens atomically in the Keychain (the old refresh token stops working once used).
     - On `bad_refresh_token`, delete the entry and show *Reconnect needed*.
   - **Disconnect** deletes the Keychain entry. You can revoke the App's authorization yourself on github.com; a later 401 then leads to Reconnect.
3. **Precedence is fixed:** gh, then App. Sources shows which one is in use ("Using your GitHub CLI sign-in" / "Connected through your Agent Productivity HQ GitHub App"). If gh signs out later, the next sync falls back to the App token if one exists.

The connected identity is `GET /user` → `login` (used for "Authored by you"). Both routes must resolve to the same login; a mismatch shows a warning on Sources and the gh login is used.

**Adding a repo:**
1. Parse the input. This is the prototype's `parseRepo` regex, reused and extended to strip `/pulls`, `/tree/...` and trailing paths.
2. Call `GET /repos/{owner}/{name}`:
   - 200 → tracked. The initial lowercased `full_name` becomes the stable local id. Sync uses the stored GitHub node id to keep the current slug and verified aliases up to date. Conflicting slug claims require attention before the dashboard associates usage and evidence through that slug.
   - 404 or 403 → `inaccessible`. The input stays in the client form (P-16). With the App token, a 404 can also mean the App isn't installed on that owner, so the error names the install step.
   - 401 → reconnect needed.

**Sync (GraphQL, per tracked active repo):** Use `node(id: ...)` with the saved repository node id when available. The following named-repository form bootstraps older rows that have no node id.

```graphql
query MergedPRs($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title url mergedAt updatedAt
        author { login } mergedBy { login }
        headRefName baseRefName mergeCommit { oid }
        commits(first: 100) { totalCount nodes { commit { oid } } }
      }
    }
  }
  rateLimit { remaining resetAt cost }
}
```

- **Initial sync** pages until `updatedAt < lookbackStart`, then catches up from the original pass start when the backfill took multiple pages.
- **Incremental sync** uses a one-day overlap from the start of the last completed pass. Each page and its cursor commit together. A restart resumes at the saved cursor. An explicit invalid cursor restarts that pass from its saved cutoff.
- Upsert by `id` (node id): one row per PR, ever (P-15, P-25).
- PRs with more than 100 commits get separately checkpointed follow-up pages. An unchanged commit signature keeps a completed list. The UI's evidence uses the commits GitHub returned, within its listing limit.
- Delivery counts use `mergedAt` only (P-19). `closed` without merge is never stored. Author and merger are separate fields (P-20).
- `rateLimit.remaining < 100` → stop and record `rate_limited` with `resetAt`.
- Secondary-limit 403 or `retry-after` → persist the cooldown, resume with the next tracked repository after the wait, and leave existing data readable (P-07).

**Stop tracking (P-17, P-18):** sets `tracking_state = 'stopped'`. Sync stops and the repo leaves active views. Rows are kept, and re-adding the same canonical id sets it `active` again with no duplicate rows.

## ChatGPT account report

Per refresh, if connected:
- `account/usage/read`:
  - `summary.lifetimeTokens` → stored as a *lifetime* figure with its own label. It is never shown as a period total.
  - `dailyUsageBuckets` → `account_daily_tokens(date, tokens)` (unit `tokens`, scope "Reported by your ChatGPT account · what it counts is not confirmed"; the historical E4 overlap comparison did not establish account-wide scope).
  - Streak fields (`currentStreakDays`, `longestStreakDays`) and `peakDailyTokens` are **not stored and not shown**. Design rule: no streaks.
- `account/rateLimits/read` → `used_percent`, `window_minutes` and `resets_at` snapshots (unit
  `percent`). When the metered map is present, take its `codex` bucket. Older responses can
  identify the general quota with an explicit single-bucket `limitId: "codex"`. A single bucket
  without an ID can still describe percentage coverage in Sources. [Codex App Server rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)

Each read stores its own outcome with its values. A failed read retains that component's previous
data. Overview uses a saved window of exactly 10,080 minutes whose row records the general Codex
quota identity. Existing rows gain an unverified default on upgrade. A successful read without a
verified weekly window clears the Overview reading. If a malformed window leaves the general
weekly quota unreadable, the read fails and retains the previous verified reading. The quota snapshot's fetch time supplies
`refreshedAt`. The snapshot becomes stale after a failed quota read or when the reset time passes.
If the provider omits a reset time, the snapshot becomes stale seven days after it was fetched.
Dashboard filters and the daily token read have no effect on the weekly report.
[Schema 006](../../src/server/db/migrations/006_codex_quota_provenance.sql)

Sources continues to describe the account's available coverage, including the span of saved daily
token buckets when present. Account usage remains separate from local totals, charts, repository
rows, sessions and links.

## Claude account report

**Show Claude plan limits** on Sources makes one protected local POST. The server reads the current
profile’s native sign-in, sends a single GET to the exact HTTPS subscription usage endpoint, and
stores the recognized percentages, reset times and observation time. It keeps credentials in
memory for that check. Redirects are refused. Any sign-in or credential renewal happens in Claude
Code. Concurrent checks share one request; rate-limited checks honor the provider cooldown.

After a successful check, **Refresh** and **Refresh all** use a separate protected POST to
check again for the same active profile. Collection runs independently. Sources and Overview
read the saved report. Setup, startup, navigation, scheduled refreshes and single-source refreshes
use the saved report. A failed check keeps the last successful reading, with its original time and source.
Expired or missing windows do not become zeroes. Limits have no effect on local transcript counts,
historical trends, or attribution.

### Status-line snapshot: design (owner choice P3 = a)

The earlier status-line design is historical. Upgrades suspend it and retain the recorded
profile, resolved target, previous value and recovery files until verified removal. Use **Remove
old status line** on Sources to restore the original setting yourself. Complete removal in the
original installation before [moving to Agent Productivity HQ](../delivery/setup.md#move-from-kelvin-agent-crew).
The [decision report](../archive/implementation/decision-report.md#standalone-claude-plan-checks)
records the trade-off in choosing an undocumented endpoint.

## Resetting Agent Productivity HQ

The confirmation in Sources & repos clears the active installation's local database, diagnostic log history, live HQ state and saved GitHub App credential when it belongs to this installation. The macOS credential slot is shared. Older credentials without an installation ID stay in the Keychain, and the reset installation stops using them. The reset removes only Claude Code hook commands that point to this installation’s script. If an older installation still uses HQ's legacy status line, restore the status line in Accounts before resetting. The reset leaves original provider data and provider sign-ins with their owners. Onboarding discovers local sources again, and GitHub CLI and ChatGPT reconnect only after the owner chooses Connect. Claude plan limits require a fresh check.

## Evidence extraction (in memory only)

While each transcript or rollout line is parsed, its text fields (assistant text, tool calls and tool results) are scanned **in memory** for:

| Ref kind | Pattern | Stored as |
| --- | --- | --- |
| `pr_url` | `https://github.com/{owner}/{name}/pull/{number}` (also `api.github.com/repos/{o}/{n}/pulls/{n}`) | `(session_id, 'pr_url', 'owner/name#number', observed_at)` |
| `commit` | git commit summary output `[{branch}( {extra})? {sha7-40}] …` and `git rev-parse HEAD` 40-hex output inside a tool result | `(session_id, 'commit', sha, observed_at)` |
| `branch` | Claude `gitBranch` and Codex `git.branch` metadata (not text) | `(session_id, 'branch', name, observed_at)` |

Only the matched identifier is stored. Line text, prompts, responses and tool bodies are discarded after the scan and never written to the database, logs or error messages (P-31). The scan is a pure function with fixture tests, including a negative test asserting no other substring reaches storage.

## Attribution: classifying PR-session links

The refresh rebuilds links per PR when stored inputs have changed or a usable prior computation is
unavailable. Owner decisions are applied on read.

**1. Evidence links** (`class = 'evidence'`):
- `pr_url` ref equals `repo#number` → basis `pr_reference` ("PR reference recorded in session").
- A `commit` ref (≥ 7 hex) prefix-matches one of the PR's commit oids or its merge commit → basis `commit_match` ("Session commit matches merged commit").

**2. Suggested links** (`class = 'suggested'`), only when step 1 found nothing for that session:
- `session.repo = pr.repo` and the session's last event falls in `[mergedAt − 48h, mergedAt]`.
- If the session's branch equals `headRefName`, basis `same_branch` ("Same repo and branch · active within 48 h before merge").
- Otherwise basis `same_repo_window` ("Same repo · active within 48 h before merge").
- Keep at most 3 suggestions per PR, most recent first.

**3. Owner decisions** (`owner_link_decision`) are applied on top and never deleted by refresh (P-27):

| Decision | Allowed on | Effective class | Source claim |
| --- | --- | --- | --- |
| `confirmed` | suggested, or no link (manual add) | `owner` | kept (basis shown as "Confirmed by you (was suggested: …)") |
| `rejected` ("Mark incorrect") | evidence | `rejected` (not counted as linked) | kept and shown as struck-through |
| `dismissed` | suggested | hidden | kept internally |
| *(no row)* | — | computed class | — |

Removing an owner link or undoing any decision deletes the decision row. The computed class then reappears unchanged (P-26).

**4. PR class** for filters and KPIs takes the strongest effective link: `evidence` > `owner` > `suggested` > `unlinked`. **Linked PRs** = evidence or owner (P-24, P-25). A PR counts once however many links it has.

Tokens are never allocated to PRs. A linked session's tokens stay on their event dates (PRODUCT.md › Metrics).

### Usage-tree link status

Design D5 requires every Usage-tree session to show its evidence level with Delivery's badge, and to say "Unlinked" only when a check could actually happen. `services/usage` computes `Session.linkStatus` and `Session.linkedPrs[]` (see [local-api](local-api.md)) per session from the same effective classes as Delivery. It does **not** keep a second set of rules.

| Session state | `linkStatus` | Cell shows |
| --- | --- | --- |
| ≥ 1 effective link (evidence, owner or suggested) | `linked` | `#number` plus the Delivery badge for each, ordered evidence, owner, suggested |
| `repo_id` is null | `repo_unknown` | "No repo recorded, so PRs not checked" |
| Repo is a GitHub repo that is not an active tracked repo | `repo_not_tracked` | "Repo not tracked, so PRs not checked" |
| Repo is tracked but inaccessible, or its first backfill is not complete | `prs_not_collected` | Words only, never "Unlinked". Copy is not in D7; interim "PRs for this repo aren't collected yet" (returned to Design). |
| Repo is tracked and collected, no effective link | `unlinked` | The Unlinked badge |

- A link marked incorrect (`rejected`) or dismissed is not listed. If it was the only link, the session is `unlinked`. Delivery still shows the struck-through source claim. Whether the tree should show it is a Design question and is returned as non-blocking.
- Status is computed per request from stored rows, with no extra table. It never changes a link or an owner decision.

## Persistence (SQLite)

**Location:**
- macOS: `~/Library/Application Support/agent-productivity/agent-productivity.db`
- Linux: `$XDG_DATA_HOME/agent-productivity/agent-productivity.db` (default `~/.local/share/...`)

The directory is created with mode `0700` and the file with `0600`. Logs go in `…/logs/`. One writer (the server process) with WAL mode and `busy_timeout = 5000`.

**Migrations.** Numbered SQL files run at boot inside one transaction, tracked in `app_meta.schema_version`. A failed migration aborts boot with a recovery page naming the file path (see TECH › Failure modes). Migrations never drop user decisions or repo lists.

[Schema 005](../../src/server/db/migrations/005_link_inputs.sql) tracks changes to the inputs for
computed PR links through SQLite triggers on sessions, PRs, PR commits, session references and GitHub
repository aliases. This includes deletes during retention. An input write and its dirty marker
commit or roll back together. The migration marks existing links dirty for one rebuild on the next
eligible refresh. A refresh with fresh links preserves the previous successful rebuild time.

```sql
-- 001_init.sql (proposed; STRICT tables)
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  -- schema_version, install_id, setup_completed_at, report_timezone, github_login

CREATE TABLE source_state (
  source_id TEXT PRIMARY KEY CHECK (source_id IN ('codex','claude','paseo','github','chatgpt_account','claude_account')),
  status TEXT NOT NULL, location TEXT, oldest_event_at INTEGER, last_success_at INTEGER,
  last_attempt_at INTEGER, last_attempt_result TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,   -- T5: reset to 0 by any succeeded/partial attempt; +1 per failed attempt; drives "failed again"
  error_code TEXT, error_detail TEXT,
  unreadable_count INTEGER NOT NULL DEFAULT 0, unsupported_count INTEGER NOT NULL DEFAULT 0,
  adapter_version TEXT, extra_json TEXT) STRICT;

CREATE TABLE source_file (
  id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, head_hash TEXT NOT NULL,   -- sha256 of first 4 KiB
  read_offset INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,                  -- ok|partial|unreadable|unsupported|skipped
  unreadable_lines INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER) STRICT;

CREATE TABLE session (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL CHECK (provider IN ('codex','claude')),
  provider_session_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('root','child','unknown')),
  parent_session_id INTEGER REFERENCES session(id), parent_basis TEXT CHECK (parent_basis IN ('native','paseo')),
  native_kind TEXT,                         -- e.g. 'claude_subagent','codex_subagent','paseo'
  recorded_name TEXT, name_source TEXT,     -- 'provider_title'|'paseo'
  repo_id TEXT, repo_basis TEXT, cwd TEXT, git_branch TEXT,
  paseo_agent_id TEXT REFERENCES paseo_agent(id), workspace_label TEXT,
  started_at INTEGER NOT NULL,              -- T5: the "Started" time. Set once, only ever moved earlier, never recomputed from pruned events
  started_basis TEXT NOT NULL CHECK (started_basis IN ('source_start','first_event')),
  first_event_at INTEGER, last_event_at INTEGER, last_model TEXT,
  UNIQUE (provider, provider_session_id)) STRICT;

CREATE TABLE usage_event (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES session(id), occurred_at INTEGER NOT NULL,  -- epoch ms UTC
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,          -- codex: includes cached; claude: uncached only
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,   -- codex subset of input
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,    -- claude separate category
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,     -- claude separate category
  output_tokens INTEGER NOT NULL DEFAULT 0,         -- codex: includes reasoning
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,      -- codex subset of output
  provider_total INTEGER NOT NULL,                  -- codex: input+output; claude: input+cache_write+cache_read+output
  source_file_id INTEGER REFERENCES source_file(id),
  UNIQUE (provider, dedupe_key)) STRICT;
CREATE INDEX usage_event_time ON usage_event (occurred_at);
CREATE INDEX usage_event_session ON usage_event (session_id, occurred_at);

CREATE TABLE session_ref (
  session_id INTEGER NOT NULL REFERENCES session(id), kind TEXT NOT NULL CHECK (kind IN ('pr_url','commit','branch')),
  value TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY (session_id, kind, value)) STRICT;
CREATE INDEX session_ref_value ON session_ref (kind, value);

CREATE TABLE paseo_agent (
  id TEXT PRIMARY KEY, title TEXT, provider TEXT, provider_session_id TEXT, parent_agent_id TEXT,
  workspace_id TEXT, workspace_label TEXT, cwd TEXT, background INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL) STRICT;

CREATE TABLE repo (
  id TEXT PRIMARY KEY,                    -- lowercased owner/name (canonical)
  github_node_id TEXT UNIQUE, display_name TEXT NOT NULL,
  tracking_state TEXT NOT NULL CHECK (tracking_state IN ('active','stopped')),
  access_state TEXT NOT NULL CHECK (access_state IN ('ok','inaccessible','unknown')),
  access_error TEXT, added_at INTEGER NOT NULL, stopped_at INTEGER,
  backfill_complete INTEGER NOT NULL DEFAULT 0, last_sync_started_at INTEGER, last_sync_success_at INTEGER) STRICT;

CREATE TABLE pull_request (
  node_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id), number INTEGER NOT NULL,
  title TEXT NOT NULL, url TEXT NOT NULL, author_login TEXT, merged_by_login TEXT,
  merged_at INTEGER NOT NULL, head_ref TEXT, base_ref TEXT, merge_commit_sha TEXT,
  commits_complete INTEGER NOT NULL DEFAULT 1, UNIQUE (repo_id, number)) STRICT;
CREATE INDEX pull_request_merged ON pull_request (merged_at);
CREATE TABLE pr_commit (pr_node_id TEXT NOT NULL REFERENCES pull_request(node_id), sha TEXT NOT NULL, PRIMARY KEY (pr_node_id, sha)) STRICT;

CREATE TABLE pr_session_link (                   -- computed; rebuilt per refresh
  pr_node_id TEXT NOT NULL, session_id INTEGER NOT NULL, class TEXT NOT NULL CHECK (class IN ('evidence','suggested')),
  basis TEXT NOT NULL, computed_at INTEGER NOT NULL, PRIMARY KEY (pr_node_id, session_id)) STRICT;
CREATE TABLE owner_link_decision (               -- owner-authored; never rebuilt
  pr_node_id TEXT NOT NULL, session_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('confirmed','rejected','dismissed')),
  prior_class TEXT, prior_basis TEXT, decided_at INTEGER NOT NULL, PRIMARY KEY (pr_node_id, session_id)) STRICT;

CREATE TABLE account_daily_tokens (account TEXT NOT NULL, date TEXT NOT NULL, tokens INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (account, date)) STRICT;
CREATE TABLE account_snapshot (
  account TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('lifetime_tokens','rate_limit')), limit_id TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL CHECK (unit IN ('tokens','percent')), value REAL, window_minutes INTEGER, resets_at INTEGER,
  fetched_at INTEGER NOT NULL, PRIMARY KEY (account, kind, limit_id)) STRICT;

CREATE TABLE refresh_run (
  id INTEGER PRIMARY KEY, trigger TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('running','succeeded','partial','failed','interrupted')),
  per_source_json TEXT NOT NULL) STRICT;
```

**Field semantics and missingness:**
- All timestamps are UTC epoch milliseconds. Calendar bucketing happens at query time in the report timezone (see TECH › Critical logic), so a timezone change re-buckets without migration.
- Missing token categories are stored as `0` only when the provider's record type has no such category (Claude Code has no reasoning category; Codex cache-write tokens are a part of its input). A record with a *missing* expected field is counted as `unreadable` and not stored.
- `repo_id NULL` means *unknown repo*, not "no repo".
- `parent_session_id NULL` with `kind = 'unknown'` means the relationship is unknown. It is never treated as a root.
- A stored token category is never recomputed into another category. Display totals come from `provider_total`.

**Retention (P-29):**
- Daily at 03:00 report time, and at boot, delete rows whose `occurred_at` / `merged_at` is before `today − 366 days`.
- Then delete orphaned sessions, refs and computed links.
- `owner_link_decision` rows for PRs that are gone are deleted with them.
- `repo` rows (including stopped ones) and `app_meta` are never pruned.

## Feasibility experiments

PRODUCT.md › Success conditions and feasibility gates requires real-source evidence before each affected integration. These are the experiments, in Implementation slice 0 (see TECH › Delivery slices).

**Rules for every experiment:**
- Capture metadata only.
- Fixtures committed to `test/fixtures/` are **synthetic reconstructions**: real field shapes with invented values, and no prompts, responses, paths outside the repo, or credentials.
- Save original real-source findings privately. The [experiment runbook](../implementation/experiments/README.md) describes the commands, and the [archived execution record](../archive/implementation/execution-record.md#real-source-experiments) summarizes historical outcomes.

| Id | Question | Pass criteria | If it fails | Blocks |
| --- | --- | --- | --- | --- |
| E1 | Claude Code transcript shape on the installed version | Field list confirmed. The `message.id` + `requestId` dedupe rule reproduces `ccusage claude session --json` totals for 3 sessions to within 0 tokens. Subagent files map to their parent. Title presence recorded. **T5:** the earliest line's `timestamp` is present on the main transcript and on a subagent file, and is at or before the first usage event; the gap between the two is recorded for the 3 sessions (see [Session start time](#session-start-time)). | Adjust the parser to the observed shape. If usage fields are absent, return to Product (P-02 unmet). | Claude adapter: P-02, P-03, P-23, P-28 |
| E2 | Codex rollout shape, replay baseline, subagent parent field, `.zst` support | 3 sessions (one with a spawned subagent, one archived) reconcile with `ccusage codex session --json` to within 0 tokens. Parent reference located. `thread/list.name` returned. **T5:** `session_meta.timestamp` is present and at or before the first `token_count`. If `codex` is available, `thread/list`'s `createdAt` is compared with it; the gap is recorded (see [Session start time](#session-start-time)). | Unclassifiable snapshots counted as unreadable, not guessed. Missing parent reference → children show as `unknown`. | Codex adapter: P-01, P-03, P-23, P-28 |
| E3 | Paseo daemon listing | `agents.list({includeBackground: true})` succeeds without a password. `runtimeInfo.sessionId` equals the on-disk session id for one Codex and one Claude agent. Parent edges and workspace labels present. Archived listing support recorded. | No match → Paseo names and parentage unavailable. Show "unmapped" and return the limitation to Product before narrowing the multi-agent view (PRODUCT.md › Success conditions). | Paseo enrichment: P-22, P-23 |
| E4 | ChatGPT account reads | `account/read` reports an existing sign-in with no prompt (P-42). `account/usage/read` returns buckets. Lookback and null fields recorded. One overlapping window compared with local Codex totals. | Buckets null → percent-only card (P-34). No ChatGPT sign-in → card "Not connected", local still loads (P-44). | ChatGPT report: P-33–P-36, P-42 |
| E5 | Evidence availability | For 1 well-linked merged PR, the extractor finds a `pr_url` or `commit` ref in a session. For 1 ambiguous PR, only suggestions appear. No body text persisted (DB grep test). | Few or no evidence refs → partial and manual linking still works (accepted standard). Report the coverage rate to the owner. | Evidence links: P-24, P-25 |
| E6 | GitHub access, both routes (owner choice P2) | **gh route:** `gh auth token` returns `login`, and the GraphQL query returns merged PRs (with commits) for one private tracked repo. **App route:** with the owner's registered App:<br>1. Device flow completes.<br>2. The token is stored in and read back from the Keychain via `@napi-rs/keyring` (a native binary loads on Node 26, arm64).<br>3. The same query works with only Pull requests + Metadata read permissions.<br>4. A forced refresh with **no client secret** succeeds and rotates both tokens.<br>5. A repo whose owner hasn't installed the App returns 404 and maps to the install message.<br>6. An inaccessible repo is handled as expected. | Commits need another permission → add it to the guide. Refresh needs a secret → fall back to non-expiring tokens only if the owner agrees (new decision), otherwise reconnect every 8 h. Keyring binary fails to load → return to the owner before choosing another store. | Delivery: P-14–P-21, P-42, P-43 |
| E8 (owner choice P3 = a) | Claude status-line capture on the installation host | Run against a **temporary `CLAUDE_CONFIG_DIR`** first, then the active profile only after the owner confirms the preview.<br>1. `rate_limits.five_hour` and `seven_day` reach the script for the owner's plan, and the installed Claude Code version is recorded.<br>2. **Chaining is byte-for-byte:** the owner's current status line (if any) renders identically with the wrapper: multi-line output, ANSI colours and OSC 8 links.<br>3. **Footer hints and the compact line (owner choice P6):** with no previous status line, record exactly which footer hints disappear (i) with the compact line `5h 23% · 7d 41%` and (ii) when the script prints nothing (no window known yet). Confirm the compact line renders as plain text in the status row and that an omitted window is not shown as 0%. The preview text is corrected to match what is observed.<br>4. The snapshot is written **before** chaining and still lands when Claude Code cancels the script on a rapid update.<br>5. Two concurrent sessions never replace a newer snapshot with an older one.<br>6. A project-level `statusLine` really does stop snapshots from that project (the documented precedence), and `project_override` counts it.<br>7. The `else` fallback runs the original status line when the data directory or Node is missing, with stdin passed through.<br>8. Manual install and removal verify the expected `statusLine` and leave provider files byte-for-byte unchanged.<br>9. The wrapper works with the space in `~/Library/Application Support/…`.<br>10. Script overhead is measured (budget in TECH › Performance). | **Data absent for the plan** (API-key or Console sign-in) → `no_limits`, card unavailable. **Chaining not byte-for-byte or fallback fails** → do not ship the install; return to the owner. **Footer-hint behaviour differs from what the preview says** → correct the preview text. The owner accepted the hint change with that disclosure; only a materially worse effect (for example, a broken Claude Code status row) returns to the owner before shipping. **Snapshot lost to cancellation** → move the write earlier or make it synchronous at startup. | Claude card: P-33, P-34, P-35 |
| E7 | Astryx foundation | `defineTheme` maps the D4 tokens. Changing `--color-action` reaches an Astryx `Button` and a Tailwind-styled app element in a rendered page. Layer order keeps `className` overrides working. Drawer/Popover motion can take the animate curves or be wrapped. | Return any token or component conflict to Design. Do not drop Astryx without an owner exception. | UI foundation slice |
| E9 | Live activity in transcripts (HQ) | Counts only, over the transcript files modified in the last 24 h below the approved roots: which files each entry point writes, and which records mark a prompt, thinking, a tool call and result, the end of a turn, an API error, an interruption and an approval request. Format observations are recorded in [What the transcripts show](#what-the-transcripts-show-experiment-e9) and no `E9.md` is kept. | An entry point whose files are unreadable, remote or outside the approved roots is reported plainly and not read; a marker that is not written is listed under [what cannot be known](#what-cannot-be-known-without-hooks), never guessed. | HQ transcript feeds |
