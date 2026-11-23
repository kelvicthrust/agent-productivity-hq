# Agent Productivity HQ — Technical specification

The current Sources flow uses a user-initiated Claude plan check, rechecks on manual refresh
after a successful reading for the active profile, and a GitHub repository picker with grouped
source coverage. The [data and sources](docs/tech/data-and-sources.md) and
[local API](docs/tech/local-api.md) contracts describe these boundaries.

**HQ addition (M0):** a view-only live view of the coding agents running on this machine. `GET /api/hq` ([local API](docs/tech/local-api.md)) answers from an in-memory roster behind a server-side `HqService`, which the page polls every 2 s while visible. Nothing is written to SQLite, no new outbound host or dependency is added, and the contract carries no prompt, response, tool name or argument, permission detail or error text. M1 wires the Paseo feeder: a listing polled every 2 s over one connection to the local daemon (the same loopback address the batch collector uses, so no new outbound host), opened by the first request and closed after 30 s without one; see [Live roster (HQ)](docs/tech/data-and-sources.md#live-roster-hq). The `claude` and `codex` feeds follow the Claude Code and Codex transcripts that are being written, in memory, in the folders the batch importers already read: HQ therefore also shows agents started outside Paseo (a terminal, the Claude and Codex desktop apps) and Claude Code's own subagents, with a coarse activity for working agents. Their states are inferred from the transcript, never reported, and are marked `confidence: 'inferred'`; a transcript has no permission prompt or liveness, so those cannot be known ([the transcript feeds](docs/tech/data-and-sources.md#the-transcript-feeds)). The Tailscale listener serves `/api/hq` under the same owner-checked guards from the same service.

This specification includes earlier design contracts and feasibility gates. Historical statements
about proposed work, missing evidence, or acceptance apply to their original revisions; they are
not a current security or release assessment. Sanitized [research](docs/archive/tech/research.md)
and [implementation history](docs/archive/implementation/execution-record.md) retain useful context.
Private workflow receipts and machine-specific provenance are excluded.

The Setup indicator uses wrapping pills. The chart budget is the maximum sampled warm redraw
work, measured separately for pointer, keyboard and resize; p95 alone cannot establish that ceiling.
The remaining verification gaps stay open until revision-specific evidence resolves them.

## Contents

1. [Technical overview](#technical-overview)
2. [Decisions for review](#decisions-for-review)
3. [Problem and scope](#problem-and-scope)
4. [Standards and technology](#standards-and-technology)
5. [System and implementation architecture](#system-and-implementation-architecture)
6. [Flows, state and data](#flows-state-and-data)
7. [Explicit interfaces and models](#explicit-interfaces-and-models)
8. [Critical logic](#critical-logic)
9. [Failure modes and recovery](#failure-modes-and-recovery)
10. [Non-functional architecture](#non-functional-architecture)
11. [Design system to code](#design-system-to-code)
12. [Verification plan](#verification-plan)
13. [Delivery slices](#delivery-slices)
14. [Open decisions and gates](#open-decisions-and-gates)
15. [Implementation handoff](#implementation-handoff)
16. [Provenance](#provenance)

## Technical overview

**Outcome.** Kelvin opens a local web page and sees, for a day, week or month up to a year back, **what merged in his tracked repos, where his Codex and Claude Code usage went on this machine, and which agent sessions are linked to those merges**. Unknowns stay visible: unavailable history, unknown parentage, unlinked PRs and stale sources.

**How it works.**

1. **One local server process** runs on Kelvin's Mac, bound to `127.0.0.1`.
2. It **discovers** Codex and Claude Code log folders and the Paseo daemon automatically, with no picker.
3. It **imports** usage records incrementally into a local SQLite database, deduplicating every provider request.
4. It **syncs** merged PRs for the repos Kelvin tracks. It uses his GitHub CLI sign-in, or a one-time in-dashboard sign-in through his own GitHub App.
5. It **reads** the ChatGPT account usage report through Codex's own sign-in.
6. It **links** PRs to sessions using evidence found in the logs (PR URLs and commit SHAs), plus labelled suggestions and Kelvin's own confirmations.
7. A **React app** served by the same process shows the Design D7 screens (D4 composition with the D5–D7 repairs) using data from a same-origin JSON API.

Dashboard data stays in local SQLite. The optional [Paseo plugin](docs/delivery/setup.md#open-agent-hq-from-paseo-desktop) starts the packaged service on the selected daemon Mac. The native screens use Paseo's daemon management permission and a fixed set of reporting, setup, and management operations over child-process IPC. The plugin borrows the daemon's Paseo SDK connection for agent listings and weekly account limits. The explicit browser actions attach a separate loopback listener that checks the exact Serve authority and Tailscale owner. Reset and Claude Code settings are available through that owner-checked path. Both interfaces use the same application state and SQLite owner.

```text
 ┌──────────────────────────── Kelvin's Mac (installation host) ──────────────────────────────┐
 │                                                                                             │
 │  Browser (React SPA) ──same-origin HTTP──▶  dashboard server (Node 26, 127.0.0.1:4317)      │
 │   Overview · Trends · Delivery · Usage ·    ├─ http/      Hono routes, host+CSRF guard      │
 │   HQ · Sources · Setup                      ├─ services/  metrics · delivery · links · repos│
 │   TanStack Query cache, URL filters         ├─ collectors/ (refresh runner, per-source lock)│
 │                                             │    codex ──reads──▶ ~/.codex/{sessions,archived_sessions}/*.jsonl(.zst)
 │                                             │    claude ─reads──▶ ~/.claude/projects/**, ~/.config/claude/projects/**
 │                                             │    paseo ──ws────▶ Paseo daemon ws://127.0.0.1:6767/ws  (enrichment only)
 │                                             │    chatgpt ─stdio─▶ `codex app-server` child ──▶ (OpenAI, Codex's own sign-in)
 │                                             │    github ──https─▶ api.github.com  (token: `gh auth token`, else GitHub App user token from macOS Keychain)
 │                                             │    claude_account ──https─▶ Anthropic subscription usage (explicit check only)
 │                                             └─ db/  SQLite (node:sqlite) ~/Library/Application Support/agent-productivity/agent-productivity.db
 │                                                                                             │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
   Trust boundaries: browser↔server (loopback + Host allowlist + CSRF header); server↔local files (read-only, except the owner's
   opt-in Claude Code hooks switch); local hook script↔server (loopback only, random per-run bearer token);
   server↔Paseo daemon (loopback, no password); server↔providers (TLS, provider-owned auth).
```

**Selected architecture** (proposed; see [Decisions for review](#decisions-for-review)):
- React 19 + React Router 8 (Data mode, client-rendered SPA) + Vite.
- Tailwind CSS v4 + Astryx with one generated token contract.
- TanStack Query for server state; URL search params for filters.
- Node 26 LTS server using Hono and zod.
- Built-in `node:sqlite`.
- Vitest and Playwright Test.
- pnpm, strict TypeScript, ESLint and Prettier.

**Readiness limits.**
- No personal source has been inspected. Codex, Claude Code and Paseo field shapes, ChatGPT report contents and the evidence rate in Kelvin's transcripts are **feasibility experiments E1–E7**. They run as Implementation slice 0 and block only their own integrations ([gates](#open-decisions-and-gates)).
- **Claude plan usage has no documented pull interface.** The owner chose the documented push route (an opt-in status-line hook, P3 = a). It reports only while Claude Code runs, only for subscribers, and not from projects that define their own status line. Real behaviour on Kelvin's machine is experiment E8.
- The D7 design has not been rendered by anyone who left evidence, and its checks (script execution, contrast, keyboard, screen reader) were not run. The owner said they verified D4 (historical review); Design holds no capture. Rendered checks are a Verification obligation.
- **"Started" is not yet tied to a real field.** The rule and fallback are defined; E1 and E2 confirm them on Kelvin's records.

## Decisions for review

Accepted context is carried forward and not re-asked. Proposals need the owner's review before the dependent implementation slice. The Review tab carries one item per open row.

| # | Topic | Status | Recommendation | Consequence |
| --- | --- | --- | --- | --- |
| A1 | Product name, default period (This week), system rounded font, light theme only, token total rule "all categories counted once", partial/manual traceability, Kelvin-authored default + all-merges view | **Accepted** (Product P1–P4, Design r6–r8) | Carried as constraints | — |
| A2 | Rendered 390/320/1280 checks deferred to Verification | **Accepted** (Design r8) | Verification owns the capture checklist, automated as a Playwright helper | Layout defects may surface after implementation |
| P1 | Architecture and stack | **Owner chose: approve** (r11, topic-scoped) | Single local Node server + React SPA, as above | Fixes the project's shape for every slice |
| P2 | GitHub connection route | **Owner chose** (r11): reuse `gh`, with an in-dashboard sign-in as fallback | `gh auth token` first. Otherwise a GitHub App device-flow sign-in, token in the macOS Keychain ([data-and-sources › GitHub delivery](docs/tech/data-and-sources.md#github-delivery)). | One-time App registration and installation (including on org repos you track); one native dependency |
| P3 | Claude account report | Opt-in status-line snapshot with manual settings edits | Sources previews the user-level edit. Crew prepares its hook and verifies the edit before collecting the 5-hour and 7-day percentages and resets. | Crew writes only its own data. The owner edits or restores their `statusLine`. |
| P6 | What the hook prints when you have **no** status line today | **Owner chose** (r13): the compact usage line | With no previous status line, the row shows `5h 23% · 7d 41%` from the saved snapshot; a reset, unknown or invalid window is omitted, never shown as 0%. | You see a small readout in Claude Code's status row. The footer-hints change is disclosed in the preview. With a previous status line nothing is added. |
| P4 | ChatGPT "Connect" behaviour | **Owner chose** (r11): start Codex's own ChatGPT sign-in | The button opens ChatGPT's sign-in page through the Codex App Server. The UI says "This signs Codex in on this computer too." | Provider-owned flow; the side effect is disclosed |
| P5 | Feasibility experiments E1–E7 as Implementation slice 0 | **Owner chose: approve** (r11, topic-scoped) | Plan in [data-and-sources › Feasibility experiments](docs/tech/data-and-sources.md#feasibility-experiments). E6 extended for the GitHub App; E8 added for the owner's Claude status-line choice (P3 = a). T5 adds a session-start criterion to E1 and E2. | Adapters ship only after their experiment passes |
| T5-1 | Session "Started" time source and fallback | **Owner chose: approve** (historical review, topic-scoped; real fields still confirmed in E1/E2) | `Session.startedAt` from the provider's own start record, set once, never recomputed; falls back to first usage if a source has no start record; same "Started" label either way. | Review the rule. Real fields confirmed in E1/E2; a wording change returns to Design only if a provider's start and first usage are far apart. |
| T5-2 | Phone Usage tree renders as a nested list below 640px | **Owner chose: approve** (historical review) (supersedes the T1 note that kept it a table) | Same approach as Delivery: a list component, not a CSS override of table display. Appearance follows D5/D6/D7. | Two renderers of one data set; one shared expanded-set. Table semantics stay reliable in each mode. |
| T5-3 | Usage-tree link status contract | **Owner chose: approve** (historical review; the Design copy case stays returned to Design) |
| T5-4 | Proceed on D7 as design intent while Design's own gates stay open | **Owner chose: approve** (historical review, topic-scoped). Design's gates (design-quality needs-owner, D5–D7 review, rendered checks) remain open with Design and Verification. | Implementation may plan on D7; defects return to Design. | Server returns class-bearing `linkedPrs` and `linkStatus`; "Unlinked" only when the repo is tracked and collected. A tracked repo whose PRs aren't collected yet gets words, not Unlinked. | One more designed-copy case is needed from Design (non-blocking; interim wording provided). |

## Problem and scope

**Problem.** Answering "what merged, where did agent usage go, and which sessions link to it" currently means reconciling Codex and Claude Code logs, Paseo's multi-agent context and GitHub merge history by hand (PRODUCT.md › Audience, problem, and evidence; a hypothesis, not an observed workflow). The dashboard joins these sources locally while keeping their scopes, units and unknowns honest.

**In scope** (PRODUCT.md › MVP scope, P-01–P-44):
- Automatic discovery on the installation host.
- Codex and Claude Code usage import with dedupe.
- Paseo enrichment.
- Tracked-repo merged PRs.
- PR-to-session evidence, suggestions and owner decisions.
- ChatGPT account report.
- Period review across 12 months.
- Coverage and recovery states.
- Local retention.
- The D7 screens at desktop and phone widths.

**Non-goals** (unchanged from PRODUCT.md):
- No productivity score, cost or $, streaks, or cross-provider token total.
- A view-only live HQ is in scope. The web and native Paseo clients poll its memory-only roster. Live agent control and alerts are outside scope.
- No multi-machine sync, hosted accounts, sharing or team analytics.
- Agent Productivity HQ changes a provider's settings only when the owner turns on a switch that says exactly what will change, and can undo it. Today that is HQ's Claude Code hooks (entries in the user-level `settings.json`, 2026-11-19); nothing else is ever written to a provider. Removal of a legacy Claude status-line hook still requires the owner to restore the recorded setting. No reconstruction of deleted logs.
- No extra GitHub statistics.

**Technical constraints:**
- Local-only data; the only egress is the GitHub API and the Codex app-server's account reads (P-30).
- No conversation bodies or secrets persisted (P-31).
- Setup requires only GitHub, plus optional ChatGPT and Claude connections and the repo list (P-41).
- Readable local usage works with no account (P-44).
- WCAG 2.2 AA target.
- Single user, single machine.

## Standards and technology

### Guidance and version sources

Use the pinned package manifest and workspace configuration for executable versions. The
supporting technical contracts describe the layer, source and security boundaries; archived
research records distinguish historical evidence from current verification.

### Selected stack

Versions are the current lines found in research (2026-11-06). Exact versions are pinned at setup in `package.json` with the lockfile committed; a newer patch must not silently change behaviour.

| Concern | Choice | Why | Evidence |
| --- | --- | --- | --- |
| Runtime | **Node.js 26 LTS** | Current LTS line. Built-in SQLite, fetch, zlib. Paseo SDK needs ≥ 22. | R17, R8 |
| Package manager, language | **pnpm**, **TypeScript strict** | Frontend-standards new-project defaults | profile |
| UI | **React 19** | Astryx requires React ≥ 19 | R14 |
| Routing | **React Router 8 (8.5.x), Data mode** with `createBrowserRouter` | Client-rendered local app with route-level data prefetch and URL search params, under our control (R16). Framework mode's SSR adds a rendering layer with no product benefit here. | R16 |
| Build | **Vite** with `@tailwindcss/vite` | Profile pairing; Tailwind v4 plugin | R18 |
| Styling and components | **Tailwind CSS v4.3** + **Astryx** (`@astryxdesign/core`, `@stylexjs/stylex`, stock theme extended by `defineTheme`) | Required foundation. Tailwind bridge layering per R13. | R13–R15 |
| Server state | **TanStack Query** | Caching, invalidation after refresh/mutations, request dedupe. One copy of server state. | profile (example, chosen for need) |
| HTTP server | **Hono** + `@hono/node-server` | Small typed router on web-standard Request/Response. Easy middleware for Host/CSRF guards. | judgment |
| Validation and contracts | **zod** schemas shared server↔client | One schema source for validation, types and the OpenAPI copy | judgment |
| Persistence | **`node:sqlite`** (built-in, synchronous) with WAL | No native addon, single writer, ACID upserts for dedupe. Stability is *release candidate* (R17). **Fallback:** `better-sqlite3`, with the same SQL behind the `db/` module, if E-setup finds a blocking defect. | R17 |
| Paseo | **`@getpaseo/client`** | Official SDK; loopback daemon | R7–R10 |
| Codex account | `codex app-server` child process (JSON-RPC over stdio) | Supported interface reusing Codex's sign-in (P-42) | R6 |
| GitHub | Native `fetch` against REST + GraphQL. Token via `gh auth token`; fallback is a GitHub App user token from the device flow (owner choice P2). | Three call shapes don't justify Octokit | R11, R12, R20 |
| Secret storage (GitHub App token only) | **`@napi-rs/keyring`** (MIT; Rust `keyring` binding, macOS Keychain backend, prebuilt per-platform binaries) | The owner accepted one native dependency (P2). The Keychain keeps the refresh token out of the database and files. | R24 |
| Tests | **Vitest** (unit/integration), **Playwright Test** (E2E, a11y via `@axe-core/playwright`, rendered checks) | Profile defaults; Vite-native | profile |
| Lint/format | ESLint (typescript-eslint, react-hooks, jsx-a11y, import boundaries) + Prettier | Profile | profile |

**Rejected alternatives:**
- **Next.js:** its server model is request-scoped rendering. The product needs a long-lived scheduler, child processes, a WebSocket client and a single SQLite writer in one local process, which fit a plain Node server better.
- **React Router Framework mode (SSR):** server rendering has no benefit for a single local user and still needs the background process.
- **Electron or Tauri desktop app:** packaging and update cost with no requirement for it. A browser on localhost meets the experience.
- **ccusage as a runtime library:** its reports are aggregates without per-session cwd, parentage or evidence refs. It's kept as a **verification oracle** (`ccusage … --json --offline`) for E1/E2 and reconciliation tests.
- **`@astryxdesign/charts` / third-party chart libraries:** the design needs dual-panel, separate-axis charts with coverage rails and hatching. Ported custom SVG is smaller and exact.
- **Octokit:** unnecessary weight.
- **Server-Sent Events:** 1-second polling during a refresh is enough.

## System and implementation architecture

### Layers

| Layer (module) | Purpose | Responsibilities | May depend on | Must not |
| --- | --- | --- | --- | --- |
| `src/shared/contracts` | One definition of every API shape | zod schemas and inferred types for filters, payloads and errors | zod | import server or client code |
| `src/shared/domain` | Pure product rules, testable without I/O | Period and bucket math in the report timezone, coverage classification, provider totals, link classification, scope labels | contracts | touch DB, network or files |
| `src/server/db` | The only SQLite access | Open DB (WAL, busy timeout), migrations, typed query functions, transactions | `node:sqlite`, domain | leak SQL outside this module |
| `src/server/collectors` | Read external sources into normalized records | `runner` (orchestration, per-source locks, refresh_run), `codex`, `claude`, `paseo` (the 15-minute batch collector, and the on-demand live feed behind HQ), `live` (HQ's on-demand Claude Code and Codex transcript feeds: in-memory tails of the files being written, a whitelist projection and a pure state machine), `github`, `chatgpt`, `evidence` (in-memory ref extraction), `repoResolve` | db, domain, Node fs/zlib/child_process, Paseo SDK, fetch | write files outside the app data dir, write provider config, persist text bodies |
| `src/server/integrations/claudeHooks` | The owner's opt-in switch for Claude Code hooks (HQ) | Previews and installs or removes HQ's five hook entries in the user-level `settings.json` of each existing Claude Code folder (a guarded merge written by local edits to the file's own text, never printed from a parsed copy and with no whole-file fallback, all or nothing across files: everything staged first, a proven backup that is a file of its own (never the settings file, a link or hard link to it or to an HQ file, or inside HQ's folder), every staged file sealed (same file, one name, owner-only, exactly the computed bytes) and given the whole permission word, THEN a compare-and-swap of the destination's bytes, inode, mode, owner and folder as the last step before each rename (nothing but the comparison between the observation and the rename), hard links each a target and a file with a name HQ was not given refused, a result that HQ's own reader would read back (size in bytes, depth), roll-back with verification from a sealed copy or the original bytes in memory, every undo conditional on the artifact still being what the change wrote, symlink written through, one change at a time, in a fixed order that a crash after any step leaves honest; every file-system step through one module, `fsguard.ts`; a write needs the fingerprint of the plan for the action the owner confirmed: turn on, repair or turn off each have their own, an exact plan covering the observed condition of HQ's own files, derived again before the first write); builds and recognises the command in one module and refuses a path it cannot quote (`unsupported_path`); decides "deliverable" in one place (`deliver.ts`) by the hook script's own trust and reading rules, imported from the script; copies the hook script into the data folder and writes and removes the owner-only registry (pid, port, token) only through one guard (real folder directly inside the data folder, regular files, HQ's own by content); ships `assets/claude-hook.mjs` | shared contracts, Node fs, `claudeCapture` file helpers, `collectors/discovery` (config folders) | change any provider setting but HQ's own entries; print a settings file from a parsed object; delete a file it did not write; read a hook's message, tool input or prompt; write a project's settings |
| `src/server/integrations/claudeCapture` | Prepares and verifies the manual Claude Code settings edit | Read-only preview and verification of the user-level `statusLine` key; ships the hook script; reads its snapshot and computes capture health | shared contracts, Node fs | edit provider settings; read Claude credentials; prepare without a matching digest; remove a referenced hook |
| `src/server/services` | Answer product questions | `metrics` (series, KPIs, coverage), `delivery` (PR lists, year grid), `links` (effective classes, decisions), `usage` (ledgers, tree), `repos`, `accounts`, `setup`, `retention`, `hq` (the live roster behind `GET /api/hq`: in-memory, nothing persisted, polled; `gate` starts the feeds on demand and stops them when idle, `roster` is pure and merges Paseo's agents with the transcript sessions, `service` builds the response field by field from the contract) | db, domain, collectors (to trigger runs) | parse source formats |
| `src/server/http` | The local API | Hono app, Host allowlist + CSRF guard, zod validation, error envelope, static SPA serving, CSP headers | services, contracts | contain business rules |
| `src/server/main.ts` | Process lifecycle | Config (port, data dir), boot (migrate → mark interrupted runs → retention → start scheduler → listen), graceful shutdown | all server modules | — |
| `src/client/app` | Shell | Router, app bar, `SideNav` / `PhoneTabBar` (HQ is an app-bar link below 720px, not a sixth tab), filter bar (provided per route through `lib/filterSlot.tsx` and placed under each page title by `components/PageHeader.tsx`; only the filter groups a route uses, none on Sources), banner, focus management, query client | client features/components, contracts | call `fetch` outside `lib/api` |
| `src/client/features/*` | One per screen: overview, trends, delivery, usage, hq, sources, setup, records-drawer | Route component, data hooks (TanStack Query), screen-specific components | components, lib, contracts | import another feature's internals |
| `src/client/components` | Shared product UI | `AlignedChart`, `YearGrid`, `Buddy`, `CrewArt`, `CoverageStrip`, `KpiCard`, `ProviderLedger`, `TokenLedger`, `SessionIdentity`, `SessionLinks`, `TokenStack`, `UsageTreeTable` / `UsageTreeList` (T5: one renders, chosen by a media query), `LinkBadge`, `StatusTag`, `AccountCard`, `ScopeLine` | Astryx, theme, lib | fetch data |
| `src/client/lib` | Plumbing | `api.ts` (fetch + zod parse + CSRF header), query keys, URL filter codec, `copy.ts` | contracts | — |
| `src/client/theme` | One token contract | Generated tokens.css / tailwind.css / crewTheme.ts, globals.css | generated from `design-system/DESIGN.md` | hand-edit generated files |

ESLint import boundaries enforce the "may depend on" column. Processes: one Node process, plus a short-lived `codex app-server` child during a ChatGPT read. The Paseo daemon, GitHub and OpenAI are external systems.

### Annotated tree (proposed; nothing exists yet)

```text
kelvin-usage-pilot/
├─ PRODUCT.md DESIGN.md TECH.md design-system/ docs/          # existing authoritative context (unchanged by code)
├─ package.json pnpm-lock.yaml tsconfig*.json vite.config.ts eslint.config.js playwright.config.ts
├─ scripts/generate-tokens.ts                                # YAML → tokens.css / tailwind.css / crewTheme.ts; --check mode
├─ src/
│  ├─ shared/contracts/{filters,overview,series,prs,usage,sources,repos,accounts,errors}.ts
│  ├─ shared/domain/{periods,coverage,tokens,linking,scope}.ts      # pure; unit-tested
│  ├─ server/main.ts
│  ├─ server/http/{app,guards,errors,static}.ts + routes/*.ts
│  ├─ server/db/{open,migrate}.ts + migrations/001_init.sql + queries/*.ts
│  ├─ server/collectors/runner.ts
│  ├─ server/collectors/{codex,claude,paseo,github,chatgpt,claudeAccount,evidence,repoResolve}/…
│  ├─ server/integrations/claudeCapture/{plan,apply,revert,snapshot,health}.ts + assets/claude-statusline.mjs   # owner-exception module (P3 = a)
│  ├─ server/services/{metrics,delivery,links,usage,repos,accounts,setup,retention}.ts
│  └─ client/{main.tsx,app/,features/{overview,trends,delivery,usage,sources,setup,records-drawer}/,components/,lib/,theme/}
└─ test/
   ├─ fixtures/{codex,claude,paseo,github}/…                     # synthetic reconstructions from E1–E6 (no real content)
   ├─ fixtures/seed.ts                                           # D3/D4 fixture world → temp SQLite for E2E
   ├─ contract/openapi.test.ts
   └─ e2e/{journeys,states,a11y,responsive}.spec.ts + helpers/containment.ts
```

## Flows, state and data

### Journey traces

Format: user action → screen/component → state owner → domain logic → interface/data boundary → visible result or recovery.

| Journey (PRODUCT.md) | Trace |
| --- | --- |
| **J1 Set up coverage** | First load → `GET /api/bootstrap` says `setupComplete=false` → router redirects to `/setup` → Step 1 calls `POST /api/setup/discover` → `collectors/*/discover()` checks default roots, the daemon and `codex` on PATH (no import) → rows show Looking… then Found / Not found / Access denied / Not running → Step 2 `POST /api/accounts/{github,chatgpt}/connect` → GitHub: `gh auth token` + `GET /user` (existing). Otherwise, if a GitHub App client ID is saved, device flow: show `userCode` and the github.com/login/device link, the server polls at GitHub's `interval`, then stores the token in the Keychain. If no client ID is saved, show the one-time "Register your GitHub App" guide with a client-ID field (`PUT /api/accounts/github/app`). ChatGPT: app-server `account/read` (existing) or `account/login/start` → `authUrl` opened by the browser → poll `GET …/connect/{loginId}` → Step 3 `POST /api/repos` → `GET /repos/{o}/{n}` → tracked, or field error with input kept (P-16) → "Finish setup" → `POST /api/setup/complete` → 202 run → Overview with skeletons and source "Importing…" until the run ends. Recovery: any step can be skipped; nothing found → empty states (P-40, P-44). |
| **J2 Review a period** | Period segment / custom range → `FilterBar` writes URL search params → `useFilters()` parses the URL (state owner: URL) → TanStack Query keys `['analytics', route, scope]` → `GET /api/overview` and `/api/series` → `services/metrics` builds report-timezone buckets (`domain/periods`) and coverage (`domain/coverage`) → SQL aggregates over UTC bounds → KPIs, aligned chart and repo table render with scope lines → click or Enter on a bucket opens the `RecordsDrawer` (transient state) → `GET /api/records` → "Open in Delivery/Usage" navigates with the bucket's dates in the URL. Back/forward restores filters. |
| **J3 Understand multi-agent work** | Usage route → `GET /api/usage/categories` + `/api/usage/groups` → expand a repo group (transient expanded-set) → `GET /api/usage/groups/{key}/roots` → roots with children (native subagent or Paseo parentage), orphans and an Unknown relationship group → `SessionIdentity` leads with the recorded name or relationship, then provider · model · **Started** `Session.startedAt`. Each row's Linked PRs cell is `SessionLinks`: `#number` + badge per effective link, or Unlinked, or words when the repo wasn't checked (`Session.linkStatus`, [data-and-sources › Usage-tree link status](docs/tech/data-and-sources.md#usage-tree-link-status)). At ≥ 640px `UsageTreeTable` renders; below 640px `UsageTreeList` renders the same rows as cards. The expanded-set is shared by both (state owner: the Usage feature). Tokens are per-session `provider_total` within scope, never double-counted because Paseo adds no events. |
| **J4 Trace a merge** | Delivery route → `GET /api/prs` → expand a row → `GET /api/prs/{id}` → evidence items with basis text → Confirm / Dismiss / Mark incorrect / Remove / Link a session → `PUT` or `DELETE /api/prs/{id}/links/{sid}` → `services/links` writes `owner_link_decision` in one transaction → response item → TanStack invalidates `['analytics']` → toast with Undo (re-issues the inverse request) → focus returns to the row toggle. Refresh never overwrites decisions (P-27). |
| **J5 Recover from collection failure** | Scheduler or app bar Refresh → `POST /api/refresh` → runner per-source lock → Codex read fails (EACCES / unparseable) → that source is `failed`; earlier rows untouched (P-07) → `GET /api/sources` shows `lastAttemptResult=failed`, `staleAfter` → Banner "Showing cached data…" + Retry → `POST /api/refresh {sources:["codex"]}` → the Retry button shows "Retrying…" (disabled, `aria-busy`) while `GET /api/refresh/{id}` reports the source `queued`/`running` → incremental re-read by offsets; dedupe keys make re-import idempotent (P-08). **Success:** banner clears, toast "Codex refreshed · N new sessions imported. Records already imported were skipped." **Fails again:** `source_state.consecutive_failures` goes up, the banner stays with cached data and its attempt line reads "Codex refresh failed again today, <time>", and the toast says "Codex still couldn't be refreshed. Cached data is still shown, and nothing was duplicated." (D7) |
| **Stop/restart tracking** | Sources › Stop tracking → confirm panel → `DELETE /api/repos/{o}/{n}` → `tracking_state=stopped` → leaves active views. Re-add → `POST /api/repos` → `reactivated: true`, the same rows reappear with no duplicates (P-17, P-18). |

### State ownership

| State | Owner | Lifetime and persistence | Synchronization |
| --- | --- | --- | --- |
| Usage events, sessions, refs, PRs, repos, decisions, account reports, source status | **SQLite** (server) | 12-month retention. Repos and decisions kept. | Written only by collectors and services. Single writer. |
| Server data in the UI | **TanStack Query** cache | `staleTime` 30 s, refetch on window focus | Invalidate `['analytics']` and `['sources']` when a refresh run finishes or any mutation succeeds. No other copies of server state in React state. |
| Route and filters (`start`, `end`, `gran`, `repos`, `provider`, `author`), Delivery `linkClass`/`q`, Trends selected bucket `sel` | **URL** | Survives reload, links, back/forward | Defaults omitted from the URL. No params = This week (owner default). |
| Drawer bucket, open popover, expanded rows/groups, chart focus index, toasts/Undo payload, repo-input text and error, setup step | **Component/transient** | Until navigation or reload | Repo input and error kept on failure (P-16) |
| Live HQ roster | Server memory (`HqService`); in the UI, the TanStack Query cache under its own key `['hq']`, not under `analytics` | Nothing persisted; the server's roster lives while its feeds run (opened by a request, closed after 30 s idle), the client's copy for the page | Polled every 2 s while the tab is visible, 10 s after a failed request. No SSE. |
| Refresh run progress | SQLite `refresh_run` + in-memory locks | Run row persists; locks are process-only | Client polls `GET /api/refresh/{id}` every 1 s while running |
| Scheduler | Server memory | Process lifetime | Every 15 min while running, plus at boot |

### Refresh run state machine

```text
event: POST /api/refresh | scheduler tick | setup complete
guard: no run in state 'running'  (else 409 refresh_running → client attaches to the running id)
run.state: running
  stage 1 (parallel): codex, claude        → each: queued → running → succeeded | partial | failed
  stage 2: paseo enrichment                → succeeded | failed | skipped(notrunning)
  stage 3: github sync (per active repo)   → succeeded | partial(rate_limited/inaccessible) | failed | skipped(not connected)
  stage 4: chatgpt_account reads           → succeeded | partial | failed | skipped(not connected/unavailable)
  stage 5: retention
  stage 6: link recompute when retained inputs are dirty or no usable rebuild exists
           pending → succeeded | failed; null if already fresh
run.state on finish: combine attempted source results and any link rebuild failure
  succeeded if all succeeded or there were no attempts
  partial if a source was partial, or a success and a failure occurred
  failed if there were failures and no source even partially succeeded
on boot: any run still 'running' → 'interrupted'; any pending link stage → 'interrupted'
side effects: source_state rows updated per source; toasts derive from run result; no data is deleted by a failed stage
```

Schema [005](src/server/db/migrations/005_link_inputs.sql) marks computed links dirty in the same
transaction as a change to their stored inputs. The runner checks link health after collecting
sources and applying retention. A clean skip preserves the last successful rebuild time and
reports `linkRebuild: null`. Replacement links, the fresh state and the new success time commit
together. A failed or interrupted rebuild leaves pending changes dirty. The previous usable
computation is stale while the inputs are dirty, and link health is unavailable until the first
usable rebuild. Overview and Delivery read retained link health independently of the latest run.

### Owner link decision transitions

| Current effective class | Event | Guard | Next | Side effect | Visible |
| --- | --- | --- | --- | --- | --- |
| suggested | Confirm | — | owner | upsert decision `confirmed` (prior = suggested + basis) | Badge "Owner-confirmed". Toast with Undo. |
| suggested | Dismiss | — | (hidden) | upsert `dismissed` | Item removed. Toast with Undo. |
| evidence | Mark incorrect | — | rejected | upsert `rejected` (source claim kept) | Struck badge, "Source claim kept…", Restore |
| rejected | Restore | — | evidence | delete decision | Evidence badge |
| owner (confirmed or added) | Remove link | — | computed class (suggested or none) | delete decision | Reverts; toast with Undo |
| none | Link a session | session in candidates (same repo, ≤ 3 days before merge) | owner | upsert `confirmed` (prior = none) | New owner item |
| any | Undo (toast) | within toast lifetime | prior | inverse request | Prior state |

A refresh recomputes `pr_session_link` but never touches `owner_link_decision` (P-27).

## Explicit interfaces and models

- **HTTP API:** complete OpenAPI 3.1 contract, error codes, idempotency and security headers in [docs/tech/local-api.md](docs/tech/local-api.md).
- **Persistence:** SQLite DDL, field semantics, missingness and retention in [data-and-sources.md › Persistence](docs/tech/data-and-sources.md#persistence-sqlite).
- **Source formats and normalization:** [data-and-sources.md › Codex](docs/tech/data-and-sources.md#codex-local-rollouts), [Claude](docs/tech/data-and-sources.md#claude-code-transcripts), [Paseo](docs/tech/data-and-sources.md#paseo-enrichment), [GitHub](docs/tech/data-and-sources.md#github-delivery), [ChatGPT](docs/tech/data-and-sources.md#chatgpt-account-report).
- **Component contracts:** [design-to-code.md › Component map](docs/tech/design-to-code.md#component-map).

Core internal TypeScript contracts (declared types, proposed, not compiled):

```ts
// src/shared/domain/tokens.ts
export type Provider = 'codex' | 'claude';
export interface CodexTokens { input: number; cachedInput: number; output: number; reasoning: number }   // cachedInput ⊂ input, reasoning ⊂ output
export interface ClaudeTokens { inputUncached: number; cacheWrite: number; cacheRead: number; output: number } // separate categories
export const providerTotal = {
  codex: (t: CodexTokens) => t.input + t.output,                                   // owner rule r6
  claude: (t: ClaudeTokens) => t.inputUncached + t.cacheWrite + t.cacheRead + t.output,
};

// src/server/collectors/types.ts — every local adapter implements this
export interface SourceAdapter {
  id: 'codex' | 'claude';
  discover(env: NodeJS.ProcessEnv, home: string): Promise<DiscoveryResult>;        // no import; never prompts
  import(ctx: ImportContext, signal: AbortSignal): AsyncIterable<NormalizedBatch>; // incremental from source_file offsets
}
export interface DiscoveryResult { status: 'ok'|'notfound'|'denied'|'partial'; roots: string[]; files: number; message?: string }
export interface NormalizedBatch {
  file: { path: string; size: number; mtimeMs: number; headHash: string; readOffset: number; state: FileState; unreadableLines: number };
  sessions: SessionUpsert[];        // keyed (provider, providerSessionId). T5: carries startedAt + startedBasis ('source_start' | 'first_event'); the upsert only ever moves started_at earlier
  events: UsageEventInsert[];       // keyed (provider, dedupeKey) → INSERT … ON CONFLICT DO UPDATE (last line wins, Claude) / DO NOTHING (Codex)
  refs: SessionRefInsert[];         // identifiers only (pr_url | commit | branch)
}

// src/shared/domain/coverage.ts
export type UsageCoverage = 'ok'|'partial'|'unavailable'|'stale'|'none'|'future';
export function providerCoverage(bucket: {start: string; end: string}, src: {found: boolean; oldestDate?: string; staleAfter?: string}, today: string): UsageCoverage;

// src/shared/domain/linking.ts
export type LinkBasis = 'pr_reference'|'commit_match'|'same_branch'|'same_repo_window';
export function classify(pr: PrForLinking, sessions: SessionForLinking[], refs: RefIndex): ComputedLink[];
export function effectiveClass(computed: ComputedLink | undefined, decision: OwnerDecision | undefined): 'evidence'|'owner'|'suggested'|'rejected'|'hidden'|'none';
```

## Critical logic

### Report timezone and buckets (P-09, P-10, P-11)

- `reportTimezone` = the machine's IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`), stored at setup and re-read at boot. A change re-buckets on the next query, because events are stored in UTC.
- `today` = the calendar date in `reportTimezone`. `lookbackStart = today − 365 days`.
- Presets:
  - This week = Monday-start week containing today (the end may be after today).
  - This month = calendar month.
  - Last 30/90 days and Last 12 months end today.
  - Custom is clamped to `[lookbackStart, today]`.

```text
# labelled pseudocode — src/shared/domain/periods.ts + services/metrics.ts
bucketsFor(start, end, gran):
  day   → one bucket per calendar date
  week  → Monday-start weeks, clipped to [start, end]  (partOfRange flag when clipped)
  month → calendar months, clipped
utcBounds(date) = [zonedMidnight(date, tz), zonedMidnight(date + 1 day, tz))   # 23/24/25-hour days at DST handled here
series SQL: WITH b(i, s, e) AS (VALUES …utcBounds per bucket…)
            SELECT b.i, ue.provider, SUM(ue.provider_total) FROM b JOIN usage_event ue ON ue.occurred_at >= b.s AND ue.occurred_at < b.e
            JOIN session s ON s.id = ue.session_id WHERE <provider filter> AND <repo filter> GROUP BY b.i, ue.provider
merged PRs: same bounds on pull_request.merged_at, filtered by tracked+active repos, repo filter, author rule
```

`zonedMidnight` uses `Temporal.ZonedDateTime` if Node 26 exposes `Temporal` unflagged, otherwise `@date-fns/tz` (checked at setup). The same event set feeds every granularity, so totals match across day, week and month (P-11). Unit tests cover events at 23:59/00:00 local and both DST transitions for `America/Los_Angeles`.

### Coverage (P-04, P-05, P-07)

For each provider and bucket:
- `future` if bucket start > today.
- `none` if the source was never found.
- `unavailable` if bucket end < the source's oldest imported date.
- `partial` if it straddles the oldest date.
- `stale` if the source's last attempt failed and bucket end > `staleAfter` (the last fully collected date).
- `ok` otherwise.

The rail value combines the in-scope providers the same way the prototype does. Delivery is `none` with no active tracked repos, `syncing` while any in-scope repo's backfill is incomplete, `future` after today, and `ok` otherwise. A covered bucket with no events is `0`; uncovered buckets are `null` and never drawn as zero.

**True zero** (quiet panel) requires all of:
- every in-scope provider is `ok` across the elapsed part of the range;
- at least one active tracked repo with delivery `ok`;
- zero events and zero merges.

### KPI definitions (PRODUCT.md › Metrics)

| KPI | Definition |
| --- | --- |
| Merged PRs | Distinct `pull_request` rows with `merged_at` in range, repo active and in filter, author rule applied. The comparison uses the previous equal-length range, or "outside the 12-month lookback". |
| Linked PRs | Distinct merged PRs in range whose effective class is evidence or owner. "with suggestions only" = class suggested. |
| Recorded local tokens | Per provider `SUM(provider_total)` of events in range and scope, **never summed across providers**, with the provider's coverage note |
| Root sessions | Distinct sessions with `kind='root'` having ≥ 1 event in range (a resumed root counts once). "N with unknown relationship" = distinct `kind='unknown'` with events. |
| Child agents | Distinct `kind='child'` with a known parent and ≥ 1 event in range, split by Paseo vs native (`parent_basis` / `native_kind`) |
| Account-reported | ChatGPT daily-bucket sum for the selected dates, or a percent snapshot. Separately labelled and never added (data-and-sources › ChatGPT). |

### Dedupe and idempotent import (P-03, P-08)

- Each file is tracked by `(path, size, mtime, headHash, readOffset)`.
- A file that grew is read from `readOffset`, stopping at the last complete newline so partial writes wait for the next run. A file that shrank or changed `headHash` is re-read from 0.
- Every event is upserted on `(provider, dedupe_key)`:
  - Codex: `sessionId:cumulativeTotal` or `sessionId:resp:responseId`.
  - Claude: `message.id:requestId`.
- So archive copies, re-reads, replays and Retry can't inflate totals.
- Each file's batch commits in **one transaction** with its offset. A crash mid-file replays that file safely.

### Attribution

Specified in [data-and-sources.md › Attribution](docs/tech/data-and-sources.md#attribution-classifying-pr-session-links):
- Evidence comes from recorded PR references or commit matches.
- Suggestions come from same repo (and branch) within 48 h before the merge, at most 3 per PR.
- Owner decisions override and persist.
- Tokens are never allocated to PRs.

### Session start and link status (T5)

```text
# labelled pseudocode — collectors upsert + services/usage; declared, not executed
upsertSession(row, incoming):
  if row is new:
    started_at    = incoming.startedAt ?? incoming.firstEventAt
    started_basis = incoming.startedAt ? 'source_start' : 'first_event'
  else:
    if incoming.startedAt and incoming.startedAt < row.started_at:  # an older line turned up
        started_at = incoming.startedAt; started_basis = 'source_start'
    # never recompute from usage_event rows (366-day retention would move it later)

linkStatus(session, activeTrackedRepos, repoState):
  links = effectiveLinks(session)  # evidence | owner | suggested only
  if links.nonEmpty                         → 'linked'
  if session.repo_id is null                → 'repo_unknown'
  if session.repo_id not in activeTrackedRepos → 'repo_not_tracked'
  if repoState(session.repo_id).access != 'ok' or not backfill_complete → 'prs_not_collected'
  else                                      → 'unlinked'

attemptLine(source):   # banner and Sources, Design D7
  n = source_state.consecutive_failures
  n >= 2 ? "<Name> refresh failed again <today|date>, <time>" : "<Name> refresh failed <today|date>, <time>"
```

Runner rule: on a finished source attempt, `consecutive_failures = 0` for `succeeded` or `partial`, else `+ 1`; it is updated in the same transaction as `last_attempt_*`. A skipped source (not found, not connected) does not change it.

### Retention

Daily and at boot, delete events and PRs older than `today − 366 days` and any orphans. Never prune repos, decisions on live PRs, or settings (P-29).

## Failure modes and recovery

| Situation | Detection | Visible outcome | Retained state | Recovery |
| --- | --- | --- | --- | --- |
| Source folder absent | `ENOENT` on all roots | Source "Not found" + "If you use it here, run it once, then check again" | Prior imports kept | Check again / next refresh |
| Permission denied | `EACCES`/`EPERM` on root or file | "Access denied" (Codex/Claude). Strip marker; banner if it was previously ok | Prior imports kept; other files still read | Fix permissions → Retry |
| Malformed or unsupported lines / `.zst` without decoder | Parse error per line; unknown record shape | Source "Partial · N unreadable". Usage notice. Never shows raw content. | Good lines imported | Adapter update; Retry |
| File truncated, rotated or deleted | size < offset or headHash change; file missing | Nothing alarming; deleted sources keep imported history | Events kept (P-29) | Automatic re-read |
| Claude transcripts older than 30 days deleted by Claude Code | Expected (R3) | "Claude Code keeps transcripts 30 days by default" note on Sources. Coverage "from <oldest imported>". | Everything already imported | Import runs every 15 min while the server runs |
| Partial line during concurrent write | No trailing newline | Nothing | Offset stops before the partial line | Next run |
| Paseo daemon not running | `ECONNREFUSED` | "Paseo not running · showing the last snapshot from <date>" | Prior snapshots and mappings | Starts automatically next run |
| Paseo password-protected | Auth error on connect | "Paseo needs a password, which isn't supported in normal setup" | Prior snapshots | None in MVP (P-41); limitation listed |
| `codex` not on PATH or not signed in to ChatGPT | spawn ENOENT / `account.type ≠ chatgpt` | ChatGPT card "Not connected" or "Unavailable: Codex CLI not found"; local usage unaffected (P-44) | Last report kept, marked stale | Connect ChatGPT / install Codex |
| app-server hangs or errors | 10 s per-call timeout; JSON-RPC error | Card "Couldn't update; last report <time>" | Last report | Child killed; next run |
| GitHub 401 | Response status | Account "Reconnect needed"; banner if delivery stale | PRs kept | `gh auth login` / reconnect → Retry |
| GitHub App token expired (8 h) | `expiresAt` reached, or 401 | None if refresh succeeds | Tokens in Keychain | Automatic refresh with the refresh token (device-flow tokens need no client secret, R11; confirmed in E6), then retry once |
| GitHub App refresh fails (`bad_refresh_token`, 6-month expiry, revoked) | Token endpoint error | Account "Reconnect needed · Connect GitHub" | PRs kept; Keychain entry deleted | Device flow again |
| Device flow: code expired / user cancelled / `slow_down` | `expired_token` / `access_denied` / `slow_down` | "The code expired, start again" / "Sign-in was cancelled". Polling backs off +5 s on `slow_down`. | Nothing stored | Start again |
| Device flow disabled on the App, or wrong client ID | `device_flow_disabled` / `incorrect_client_credentials` | Field error under the client-ID input naming the App setting to change | Client ID kept for editing | Fix the App settings → Connect |
| GitHub App not installed on a tracked repo's owner (user token can't see it, R20) | 404 on repo check while using the App token | Repo "Inaccessible": "Install your Agent Productivity HQ GitHub App on {owner} and give it this repository", with a link to the App's install page | Input kept (P-16) | Install → Check again |
| Keychain access refused or locked | `@napi-rs/keyring` error | Account "Couldn't read the saved GitHub sign-in from your Keychain" | — | Allow access in the macOS prompt, or Connect again |
| Claude settings are invalid JSON or unreadable | Settings reader | Needs attention when capture is recorded | Provider settings untouched | Correct the file and retry |
| Claude settings can't take HQ's hook entries (not UTF-8, not JSON, not an object, a `hooks` value that can't be merged into, a layout that can't be edited locally (`unsupported_layout`), read-only or not the owner's, no provable backup, a path that can't be quoted (`unsupported_path`), or changing under the write), the result would be more than HQ can read back (over 4 MiB, too deep), the one-time copy would not be a file of its own, the preview is stale or is another action's (or HQ's own files changed under it), the registry can't be published (or is one the hook script would refuse), a file can't be put back after a part-way failure, or HQ's own files can't be removed after turning off | Hooks installer preview and `PUT /api/hq/claude-hooks` | "Not available" with the reason in the preview, or the refusal's fixed sentence; `422 claude_hooks_blocked` / `409 claude_settings_conflict` / `409 claude_hooks_stale` / `500 claude_hooks_failed` (`registry_failed`, or `rollback_failed` naming the file); a turn-off that could not remove HQ's files is `off` with `cleanup_incomplete` and `leftover`, and the page says so | Every file is byte for byte as it was (or the failure names the file that is not, and its backup stays); no temp file is left; the script and registry are undone, but only while still exactly what the change wrote: anything else is left and named (`details.left`, on every refusal whatever its code; shutdown removes the registry this process published, following it through a restoration); a registry that cannot be deleted is neutralised (token blanked) | Correct the file, read what will change again, or try again |
| The app is not running when a hook fires | The script finds no registry, a stale pid or a refused connection | Nothing: the script exits 0 quietly and Claude Code carries on; HQ guesses as before | None | Start the app |
| Existing `statusLine` isn't a command | Install preview | The hook can't chain the existing status line | Provider settings untouched | Use a command status line or leave capture off |
| Preview changed before preparation | Profile path, target or digest differs | Review the new preview | Preparation refuses the stale preview | Open the current preview |
| Another status line replaced the wrapper | Recorded wrapper check | Needs attention | Owner's edit remains in place | Review setup or remove capture |
| Hook can't run | Node, script or config check | Needs attention | Shell fallback when Node or script is missing | Review setup or remove capture |
| Profile changed or a link now points elsewhere | Recorded profile binding | Needs attention | Original hook stays in place | Edit the recorded settings and verify removal before a new setup |
| No hook invocation yet (`waiting`) or no recent activity (`idle`) | `invoked_at` absent or older than 7 days | "Waiting for Claude Code…" / "No recent Claude Code activity. Last update <time>." | Last snapshot kept | Use Claude Code |
| Sign-in doesn't report plan limits (`no_limits`) | Hook invoked, `rate_limits` never present | "Your Claude Code sign-in doesn't report plan limits." | — | None (API-key and Console sign-ins don't) |
| Snapshot file corrupt, unknown `v` or invalid | zod validation | Collector `failed`: "Couldn't read the Claude snapshot" | Previous percentages kept | Next hook run rewrites it |
| Window past its `resets_at` with no new snapshot | `resets_at` < now | "Weekly window reset <when>." (or that window's own label) instead of the old percentage | — | Use Claude Code |
| Project defines its own `statusLine` | Presence-only check of known project settings | "In N projects Claude Code uses a project status line, so the dashboard sees no usage from them." | — | Owner's choice; the dashboard never edits project settings |
| Data directory removed while the hook is installed | Wrapper script is absent | Needs attention if the leftover wrapper is detected | The original command in the wrapper's fallback can still run | Review setup or manually remove the reference |
| GitHub 404/403 on a repo | Repo check or sync | Repo "Inaccessible", PRs excluded from active views with notice | Rows kept | Check again |
| GitHub rate limit (primary or secondary) | `rateLimit.remaining`, 403/429 + headers | Source "Waiting for GitHub rate limit until <time>" | Partial sync kept (per-page commits) | Automatic at reset |
| Offline | fetch network error | GitHub/ChatGPT "Couldn't reach …"; local sources still import | All data | Next run |
| Duplicate Refresh click / scheduler overlap | Run in `running` | Button busy; second request attaches to the same run (409 → attach) | — | — |
| Server crash or restart mid-refresh | Boot finds `running` | Run shown "interrupted" in diagnostics | Committed per-file batches | Next run continues from offsets |
| Data directory owned by a second instance | Instance ownership check | On the same port, startup prints the existing address and exits. On a different port, the branded recovery page directs the owner to the running copy. | First instance owns the database | Use the existing instance |
| DB corrupt or migration fails | `PRAGMA quick_check` at boot / migration error | Branded recovery page names the database and gives steps for moving it aside. | Old DB untouched | Owner moves the file and restarts if they choose to import again from available logs |
| Disk full | `SQLITE_FULL` / ENOSPC | Branded recovery page at startup. An import fails with "Not enough disk space to import". | Committed data | Free space → restart or Retry |
| Clock or timezone change | tz differs at boot | Report re-labelled with the new zone | UTC events unchanged | Automatic |
| Account report window ≠ period | Compare dates | Warning notice on card; never in trends (P-35) | — | — |
| Repo add input invalid | `parseRepo` fails | Field error, input kept (P-16) | — | Edit and resubmit |
| Link decision request fails | Non-2xx | Toast "Couldn't save your change"; UI reverts (no optimistic persistence) | Prior decision | Retry |
| Retry pressed and the source fails again (T5, D7) | Run source state `failed`, `consecutive_failures ≥ 2` | Banner stays with cached data and the attempt line "<Source> refresh failed again <time>"; Sources shows the same line; toast "…nothing was duplicated." Retry is enabled again. | Everything already imported; offsets not advanced past the failure | Fix the cause → Retry; the next success clears the banner and resets the counter |
| Retry pressed and a run is already going (T5) | `409 refresh_running` | Button stays "Retrying…" and attaches to the running run | — | — |
| Provider has no session start record (T5) | Adapter finds no start field in the file or thread | "Started" shows the first recorded usage time. Its accessible description says it is the first recorded activity. | `started_basis = first_event` | Wording returns to Design only if E1/E2 show a large gap |
| Session's repo PRs not collected (T5, D5) | `linkStatus = prs_not_collected` (tracked repo inaccessible or still backfilling) | Linked PRs cell says so in words and never "Unlinked" | Links already stored | Repo check again, or the first sync finishes |

## Non-functional architecture

### Security and privacy

| Risk | Mechanism | Owning boundary | Verification |
| --- | --- | --- | --- |
| Other devices reach the API | Bind loopback only. The managed plugin adds an owner-checked Tailscale Serve entry point | `server/main.ts` | Test: server refuses to start with a non-loopback host; port scan from another interface fails |
| Malicious web page uses DNS rebinding or cross-site writes | `Host` allowlist (`127.0.0.1:<port>`, `localhost:<port>`) → 421. No CORS headers. Non-GET requires `X-Agent-Productivity-Request: 1` + JSON content type. | `http/guards.ts` | Integration tests: wrong Host → 421; missing header → 403; `Origin` cross-site POST blocked |
| Conversation content or secrets persisted (P-31) | Evidence extraction stores identifiers only. Parsers never put line text into errors or logs. No token or cookie fields read from transcripts. GitHub token from `gh` held in memory per sync, never written. The GitHub App access and refresh tokens live **only** in the macOS Keychain (service `agent-productivity`, account `github-app-user-token`), never in SQLite, logs or API responses. The App client ID (not a secret) is stored in `app_meta`. | `collectors/*`, `collectors/github/auth.ts`, logger redaction | DB content test after importing fixtures with sentinel strings ("SENTINEL_PROMPT…"): zero matches in DB, logs or API responses. Test that no `ghu_`/`ghr_` prefix appears in DB, logs or responses. |
| Data leaves the machine (P-30) | No analytics, telemetry or error-reporting SDKs. Outbound HTTP only via `lib/net.ts`, which enforces an allowlist: `api.github.com` always, `github.com` only for the device-flow endpoints `/login/device/code` and `/login/oauth/access_token`. There is no Anthropic entry: Claude plan usage arrives through a local file, not a network call (P3 = a). The `codex app-server` child's own traffic is the disclosed ChatGPT read. | server | Integration test with a fetch interceptor: only allowlisted hosts and paths. Playwright: browser requests only to `127.0.0.1`. Owner network inspection during Verification. |
| Local file permissions | Data dir `0700`, DB/logs `0600`; hook scripts, config, snapshot, settings backups and the hooks registry `0600` (the `claude-hooks` folder `0700`) | `server/main.ts`, `integrations/claudeCapture`, `integrations/claudeHooks` | Unit test on created modes |
| A local process posts hook events to the server (HQ's Claude Code hooks, opt-in) | `POST /api/hq/hooks/claude` is mounted on the loopback listener only, never on the Tailscale one. It needs a random token (`crypto.randomBytes`, new at each start, held in memory and in an owner-only registry file, compared with `timingSafeEqual`, checked before the body is read; missing, wrong, duplicated or malformed is `401` with no detail and no log line). The body is `application/json`, bounded, strict UTF-8 and strictly five fields of fixed shapes (event name, session id, notification type, reason, absolute folder): the script reads no other field and applies the same rules before sending, and the server refuses anything else with one fixed `400` and stores nothing. Events are kept in memory only, the latest per session, bounded in number and age with constant work per request, and dropped at shutdown. The script prints nothing, always exits 0 and gives up within about 1.5 s: a timer armed first ends it whatever is outstanding, every file access is asynchronous, and the registry is trusted only as a small regular file of the current user closed to group and others. | `http/routes/hqHooks.ts`, `integrations/claudeHooks`, `services/hq/hookStore.ts` | `test/server/hq-hooks-routes.test.ts` (token, bounds, strict schema, no log), `test/server/hq-hooks-wire.test.ts` (loopback only, registry lifecycle), `test/claudeHooks/script.test.ts` (five fields only, with `SENTINEL_*` in the rest) |
| Agent Productivity HQ edits Claude Code's settings (HQ's hooks switch, opt-in, previewed, undoable) | The edit is a merge made by local edits to the file's own text (no parsed copy is ever printed, there is no whole-file fallback, and the result must read back, last key wins, as exactly the intended settings, else `unsupported_layout`), so every other byte (byte-order mark, line endings, final newline, indentation, key order, number and string spellings, repeated keys, mode, the owner's other hooks) is kept; only handler objects in exactly HQ's command shape are added, replaced or removed (a handler of HQ's inside a group with a matcher or beside the owner's handlers is `needs_repair`, and removal never takes the owner's group or handlers). A file that cannot be understood, is read-only or not the owner's, has no provable backup, or changes between the read and the write is refused with a fixed code and left as it was. A change is all or nothing across every settings file: staged first, each file compared again (bytes, inode, size, time, mode, owner, group, folder) as the last step before its rename, files already replaced put back and verified (a file that cannot be is named); every undo only while the artifact is still what the change wrote; a copy beside it is proven before a file is replaced (exclusive create read back, or an existing regular readable file, never overwritten); a settings symlink is written through; changes are one at a time. `on` means deliverable (entries, script and published registry all as this app wrote them). The owner explicitly chooses the settings action. The server refuses a write whose preview fingerprint is missing, stale or from another action. Only user-level settings are touched. HQ's own artifacts are created, written, read and deleted only through one guard. | `integrations/claudeHooks` | `test/claudeHooks/install.test.ts`, `write.test.ts`, `settings.test.ts`, `entries.test.ts` (matchers and owner groups, every combination), `fidelity.test.ts` (BOM, line endings, indentation, key order, mode, byte-identical round trip), `layout.test.ts` (repeated keys, odd numbers and strings, hostile files, seeded sweeps), `transaction.test.ts` (all or nothing, the owner saving at every step, the preview fingerprint, what "on" means), `backup.test.ts`, `swap.test.ts` (mode, owner, folder at the swap), `undo.test.ts` (conditional undo), `cleanup.test.ts` (incomplete removal), `commandPaths.test.ts` (build and recognise, real `sh`), `plans.test.ts` (per-action previews), `ownFiles.test.ts` (the guard, every operation) |
| A legacy status-line hook runs code inside Claude Code on updates | The owner restores the previous `statusLine` using the removal flow. Agent Productivity HQ no longer edits the `statusLine` key (the only provider settings it writes are HQ's opt-in hook entries). | `integrations/claudeCapture`, `assets/claude-statusline.mjs` | Temporary settings and hook fixtures cover byte preservation, stale preview refusal, legacy state, and paused removal. |
| Child process injection | `spawn('codex', ['app-server'])` with an args array and no shell | collectors/chatgpt | Code review |
| Supply chain | Small dependency set. pnpm lockfile. pnpm blocks dependency install scripts except an explicit allowlist (`onlyBuiltDependencies`, likely empty). `pnpm audit` in checks. | repo | Review stage |
| XSS | React escaping. No `dangerouslySetInnerHTML`. CSP `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`. Repo and PR titles rendered as text. | http/static, client | ESLint rule + E2E with a PR title containing markup |

### Performance (proposed budgets; owner may change)

The benchmark uses a **synthetic year**: 150k usage events, 6k sessions, 2k PRs across 6 repos, seeded by `test/fixtures/seed.ts --scale year`.

| Obligation | Budget | Mechanism | Verified by |
| --- | --- | --- | --- |
| Overview interactive after navigation | ≤ 1.0 s p95 for `/api/overview` + `/api/series` | Indexed time-range scans, bucket-bounds join, no N+1 | Vitest bench against seeded DB; Playwright timing |
| Filter change → updated chart | ≤ 300 ms p95 server time | Same | Bench |
| Usage tree group expansion | ≤ 300 ms for 15 roots | Paged roots query | Bench |
| Incremental refresh with no new data | ≤ 3 s | Offset-based reads; skip unchanged files by size/mtime/headHash | Integration timing |
| Claude hook overhead per status-line update | ≤ 100 ms p95 added to the owner's own status line (Node start-up included) | Dependency-free script, capture phase check and atomic snapshot write before chaining | E8 measures it on the installation host; a CI-style script test records the in-process time |
| First full import | Progress shown per source; UI stays responsive | Per-file transactions; `setImmediate` yields between batches of 500 lines | Manual on owner data (E1/E2) |
| UI rendering | Warm chart redraw work ≤ 16 ms for **every sampled operation** at 365 buckets; measure the actual inclusive year (366 buckets in the retained run) and report its count | Precomputed layout, memoized SVG | Browser-clock maximum for pointer, keyboard and full relayout separately; p50/p95 are diagnostic. [Measurement and check](#chart-redraw-measurement-and-check). A React profiler spot check can diagnose but does not replace this boundary measurement. |

#### Chart redraw measurement and check

**Proposed clarification (FRAME_BUDGET_DEFINITION), with the ceiling retained.** "Per frame" describes the work that must fit into the rendering budget for an already loaded chart. It is **not** a p95 allowance: every observed warm redraw in each measured class must be at most 16ms. The measurement is finite evidence, not a promise about every future frame. Do not average the classes or discard a slow sample. The existing script measures this boundary but its final sentence checks only p95 (`scripts/measure-browser.ts` › `chartReport`); a successful exit means the measurement ran, not that a budget passed.

**Operation and clock.** Trends, Last 12 months by day, synthetic year world (150k usage events, 6k sessions, 2k PRs, 6 repos), 1280 × 900. The retained query `start=2025-11-04&end=2026-11-04&gran=day` contains **366** inclusive daily buckets; this is stronger workload coverage than the old row's 365, not permission to omit the extra bucket. After the script's warm-up (30 pointer and 30 keyboard redraws, 4 resizes and frame sampling), measure:

- **Pointer and keyboard work:** `performance.now()` immediately before the synthetic event → the mutation observer sees React's DOM commit → forced `document.body.getBoundingClientRect()` finishes. Keep 200 samples of each at default `--samples 200`.
- **Full relayout work:** the `ResizeObserver` callback's timestamp → chart DOM commit and forced layout complete, as implemented by the script. Keep 40 alternating 80%/full-width resizes; report this start point separately from event dispatch. It measures neither the earlier wait for the observer nor total paint latency.
- **Next-paint timing, cold draw and frame cadence:** report separately. The script's rAF/MessageChannel callback is a next-paint proxy including scheduling wait; it is not isolated redraw work. Initial series-response-to-DOM/paint includes cold initialization, so the existing Overview/navigation obligation remains applicable there. Intervals between rAF callbacks include the display cadence (about 16.7ms at 60Hz); comparing those intervals to the 16ms work ceiling would test a different quantity. This clarification adds no cold-draw, paint-latency or missed-frame allowance and waives none of the existing navigation/import requirements.

**Retained environment and observations.** [Browser measurements](test/bench/BROWSER-RESULTS.md) describe a historical headless run over synthetic data. The build was served through browser request interception. The report does not identify the exact browser executable or application commit. These observations do not establish current candidate performance.

| Retained operation | Samples | p95 | Maximum | Relation to the 16ms warm-work ceiling |
| --- | --- | --- | --- | --- |
| Pointer work | 200 | 1.1ms | **1.2ms** | Within in this sample |
| Keyboard work | 200 | 1.2ms | **1.3ms** | Within in this sample |
| Full relayout work | 40 | 3.7ms | **4.1ms** | Within in this sample |
| Pointer to next paint proxy | 200 | 18.2ms | **18.9ms** | Separate diagnostic, includes frame wait |
| Keyboard to next paint proxy | 200 | 17.9ms | **18.6ms** | Separate diagnostic, includes frame wait |
| Relayout to next paint proxy | 40 | 18.2ms | **18.7ms** | Separate diagnostic, includes frame wait |
| Cold series answer → bars in DOM | 5 | 21.8ms | **21.8ms** | Initial draw, not a warm redraw |
| Cold series answer → paint proxy | 5 | 28.1ms | **28.1ms** | Initial draw, not a warm redraw |
| Idle / pointer-sweep frame intervals | 120 / 180 | 16.7 / 16.7ms | **16.8 / 16.8ms** | Cadence diagnostic; sweep over 25ms: 0/180 |

The retained report also records a **33.3ms** maximum browser frame interval during first import (no >50ms frame or long task), under the separate import responsiveness obligation. No maxima are deleted or relabelled as passing redraw work. Pointer/keyboard no-change counts are both zero in the report.

**Explicit check for Implementation/Verification (declared, not executed against a new build):**

```text
for class in [pointerWork, keyboardWork, fullRelayoutWork]:
  require finite samples and the declared sample count (default 200, 200, 40)
  missing/no-change redraws or incomplete measurement => inconclusive, not pass
  report n, p50, p95, max without hiding slow observations
  classWithinCeiling = max(rawSamples[class]) <= 16  # compare before rounding
overallWithinCeiling = all three complete classes are within the ceiling
# next-paint proxy, cold draw, cadence and import responsiveness keep separate labels
```

**Check performed here:** static inspection of the measuring boundaries, statistic and retained table; numerical comparison of the three published maxima to 16ms. The retained sample is within the ceiling. A tail case of 199 × 1ms plus 1 × 32ms has p95 1ms and maximum 32ms, showing why p95 alone cannot check this obligation.

**Code-repair disposition:** **yes, measurement/reporting repair is required** in `scripts/measure-browser.ts` so the budget conclusion uses unrounded maxima, distinguishes incomplete measurements, and retains p95 and all diagnostic maxima. Keep its measurement-only exit semantics explicit; do not silently turn exit 0 into a performance pass. In the separately authorized repair, verify a ≤16ms set passes, an isolated >16ms tail fails even with low p95, and an incomplete set is inconclusive, then rerun the browser measurement on the intended production candidate with its application/build revision and browser version recorded. **No chart application repair is indicated by the retained work timings.** Native-browser/owner-machine performance remains unverified by these headless samples. This turn authorizes or performs none of that code work, and the owner must accept this clarification before dependent execution.

### Reliability

- Single writer, WAL and per-file transactions.
- Idempotent imports (dedupe keys).
- Interrupted-run marking and per-source isolation (one failing source never blocks others).
- The scheduler never overlaps runs.
- Graceful shutdown waits ≤ 5 s for the current transaction.

### Observability

- Structured JSON logs (level, ts, source, runId, correlationId, code) to `<data>/logs/agent-productivity.log`, rotated at 5 × 5 MB, with redaction (never line text or tokens).
- `refresh_run` and `source_state` are the operational record shown on Sources.
- `/api/health` reports liveness.
- **Product analytics: none.** This is a single-user local tool, and the owner evaluates the joined review qualitatively (PRODUCT.md › Success conditions). implementation-signals.md is satisfied by diagnosable failures and defined recovery; no vendor is added.

### Accessibility

- WCAG 2.2 AA target, with the Design D1/D4 model:
  - skip link, landmarks, focus to `h1` on route change;
  - keyboard chart with live readout and table equivalent;
  - dialog focus traps;
  - Undo on reversible actions;
  - colour-independent encodings;
  - visible focus ring.
- Plus the decisions in [design-to-code › Responsive and accessibility decisions](docs/tech/design-to-code.md#responsive-and-accessibility-decisions), including (T5) list components instead of CSS-overridden tables below 640px, and keyboard-focusable local scrollers for the wide desktop tables.
- Retry state ("Retrying…") is exposed with `aria-busy` and a polite announcement; the evidence level of every Usage-tree link is text, not colour.
- Verified by axe on every route and state, keyboard-only E2E for J2–J5, and a manual VoiceOver pass in Verification.

## Design system to code

Full mapping in [docs/tech/design-to-code.md](docs/tech/design-to-code.md). Key points:

- **One token contract.** `design-system/DESIGN.md` YAML is canonical. `scripts/generate-tokens.ts` emits the CSS variables (same names as the D4 `tokens.css`), Tailwind `@theme` and the Astryx `defineTheme` overrides. `pnpm tokens:check` fails on drift. A parity test proves generated values equal the D4 mirror.
- **Astryx + Tailwind v4** wired with the explicit cascade-layer order from Astryx's docs. Product tokens are layered over a warm stock theme.
- **Astryx components** for shell, nav, buttons, segmented controls, popovers, drawer, bottom sheet, toast, table, stepper, empty and skeleton. **Custom components** for the aligned chart, year grid, buddies, coverage strip, ledgers, session identity, link badges and account card.
- **Prototype reuse:** chart and year-grid geometry, buddy and icon SVG, copy and `parseRepo` are ported. String rendering, `takeEnter`, fixtures, timers and the "private" access rule are replaced. `data.js` becomes the E2E seed. `containment-check.js` becomes a Playwright helper.
- **D5–D7 delta (T5):** [design-to-code › D5–D7 delta](docs/tech/design-to-code.md#d5d7-delta-t5) maps each repair to a component, contract or check. The token contract is unchanged (`tokens.css` byte-identical).
- **Design hand-offs settled:**
  - two nav instances so DOM order matches visual order;
  - 44 px phone targets;
  - 16 px phone inputs;
  - `viewport-fit=cover`;
  - list-based phone tables, now including the Usage tree (T5, supersedes T1);
  - no-wrap data cells with a keyboard-focusable local scroller on desktop (T5, D7);
  - container queries relied on;
  - filters in the URL with a fixed This-week default.
- **Session titles:** Codex `thread/list.name` (R6) and Claude transcript titles if persisted (E1) become the lead when present, ahead of Paseo names and the relationship fallback, per D4's rule.

## Verification plan

Checks are run by Implementation during development and independently re-assessed by Verification. "Fixture" means synthetic reconstructions from E1–E6 or the D3/D4 seed world; nothing uses real conversation content.

| Req | Check | Type |
| --- | --- | --- |
| P-01, P-02 | Fixture rollouts/transcripts import with session provenance; E1/E2 reconciliation against `ccusage … --json --offline` on owner data (0-token difference) | Unit + experiment |
| P-03 | Re-import, archived duplicate, `.zst` twin, Codex replayed prefix, Claude streamed duplicate lines → totals unchanged | Unit |
| P-04 | File with corrupt lines → good lines kept; `unreadable` count shown; no raw text in API or UI | Integration + E2E |
| P-05 | Range before oldest → hatch "History unavailable"; covered empty day → 0 / quiet panel | E2E (seed states) |
| P-06, P-07, P-08 | Simulated EACCES on Codex → failed status, last success shown, cached data readable; Retry after fix → imports, no duplicates | Integration + E2E |
| P-09 | Today / This week (default) / This month / Custom within 12 months; out-of-range rejected | E2E + API |
| P-10 | Events at local 23:59/00:00 and DST boundaries bucket correctly | Unit (`periods.ts`) |
| P-11 | Same interval: day sum = week sum = month sum | Unit + API property test |
| P-12, P-37 | Repo filter changes usage and delivery; provider changes usage only; author changes delivery only; account card stays account-wide | API + E2E |
| P-13 | Bucket click/Enter opens drawer with the matching records | E2E |
| P-14, P-15, P-16 | Add by URL and by owner/name persists across restart; re-add → 409, no duplicate; inaccessible input stays editable with error | Integration (GitHub mocked) + E2E |
| P-17, P-18 | Stop tracking removes from active views; re-add restores retained PRs once | Integration + E2E |
| P-19, P-20, P-21 | Closed-unmerged excluded; merge-date boundaries; author ≠ merger follows author rule; row links to the GitHub PR URL | Unit + E2E |
| P-22 | Paseo agent ↔ provider session mapped once; unmapped labelled | Unit (fixture) + E3 |
| P-23 | Root/child edges only from native or Paseo records; missing parent → Unknown relationship | Unit + E2E tree |
| P-24, P-25 | Evidence / suggested / unlinked classes with basis; multi-session PR counts once | Unit (`linking.ts`) + E2E |
| P-26, P-27 | Confirm, reject, add, remove and undo; decisions survive restart and a refresh that recomputes links | Integration + E2E |
| P-28 | Provider totals follow the owner rule; subsets never re-added (ledger arithmetic test) | Unit + E1/E2 |
| P-29 | After deleting fixture logs and restarting, in-window metrics and links remain | Integration |
| P-30 | Outbound allowlist test; browser requests only to loopback; owner network inspection | Integration + E2E + manual |
| P-31 | Sentinel-string scan of DB, logs and API responses after import | Integration |
| P-32 | Keyboard-only J2–J5; axe zero serious/critical; table equivalents; colour-independent encodings | E2E + manual VoiceOver |
| P-33–P-36 | Mocked app-server: token buckets, percent-only, null buckets, window ≠ period; 100/60 overlap shows 100 and 60 separately, never 160 | Integration + E2E |
| P-33, P-34, P-35 (Claude plan usage via the hook) | Hook script run as a child process with fixture stdin: percentages and reset times captured; absent window keeps an unreset old one; reset window dropped; concurrent older snapshot ignored; malformed stdin still prints the chained output and exits 0. Collector turns the file into percent snapshots; the card shows percentages only, "Subscription tokens unavailable", each window's own reset time, and "… window reset <when>." after `resets_at`. No percentage ever reaches series, repo rows or links. | Unit + integration + E2E |
| Compact usage line (owner choice P6) | Hook script run as a child process with no previous status line, fixture stdin and a fixed clock: both windows → `5h 23% · 7d 41%`; only one valid window → just that part; a window with `resets_at` in the past, `null`, `NaN` or a string → omitted, never `0%`; none valid → empty output; values round and clamp to 0–100; a window absent from this update but still valid in the saved snapshot still prints; output is plain text with no escape codes and at most 17 characters (the widest line, `5h 100% · 7d 100%`; the owner answered that the earlier 14 was miscalculated, since the example above it is already 15); with a previous status line the output is that status line's output and nothing else. The preview's `sampleStatusRow` equals what the script would print for the sample input, and is `null` when a previous status line is kept. | Unit (script) + integration (preview) |
| Claude capture manual install/removal (temporary profiles) | In a temporary `CLAUDE_CONFIG_DIR`, verify read-only preview, unchanged settings bytes, durable pending states, a stale or retargeted preview, a wrong manual edit, legacy adoption and retained backup, and removal after a profile switch. | Integration and browser |
| P-38 | Account-only scenario creates no sessions or links | Integration |
| P-39, P-40 | First launch with fixture homes in default and override locations → found, no picker; absent/denied → statuses | Integration (temp HOME) + E2E setup |
| P-41, P-43 | Setup UI contains no API-key, password, cookie or folder fields (DOM assertion). The only extra field is the non-secret GitHub App client ID, shown only when `gh` isn't signed in (owner choice P2). Connections open provider pages (github.com/login/device, ChatGPT sign-in). | E2E |
| P-42 | Existing `gh` / Codex sign-in → no login prompt. A valid Keychain App token → no device-flow prompt. | Integration (stubbed CLIs, mocked device flow, in-memory keyring) + E4/E6 |
| P-44 | No accounts connected + local fixtures → usage loads; account cards "Not connected" | E2E |
| Design D4–D7 | 1280/390/320 on Overview, expanded Usage (roots **and child rows with their badges**), recovery, Delivery evidence, Trends year grid: containment helper reports no FAIL; screenshots captured; duplicated-header check. The owner's "verified" on D4 (historical review) is their statement with no capture or tool output attached, so Verification still runs its own pass. | Playwright rendered (Verification-owned) |
| D5 usage-link-status | Seeded sessions of each `linkStatus`: Evidence link, Owner-confirmed and Suggested show `#number` plus the Delivery badge in that order; a tracked, collected, unlinked session shows Unlinked; untracked, unknown-repo and PRs-not-collected sessions show words and **never** "Unlinked" (text assertions at 1280 and 390). The Usage badge text equals the Delivery badge text for the same link. | Integration (`services/usage`) + E2E |
| D5/D6 phone Usage cards | At 390 and 320: each session card shows provider, model and Started **exactly once** (count assertion), then Tokens and Linked PRs on one labelled line; below 640 the tree is a `<ul>` (no `<table>` with overridden display); expand/collapse works from the keyboard; axe clean | E2E |
| D7 table layout | At 1280: every Provider, Model, Started and Merged cell renders on one line (text-range client-rect count = 1; extends the containment helper); a narrower window scrolls the wrapper, whose `region` is focusable (axe `scrollable-region-focusable`); repository and session Tokens share one right edge; every repository row lays out its `TokenStack` the same way | E2E (containment helper) |
| D7 plural labels | `plural` unit tests: "1 root · 1 session", "2 roots · 8 sessions", "1 child", "2 children", "1 source issue" | Unit |
| D7 Started label | Every place a session time appears (tree row, phone card, record lists, Delivery evidence item, add-link option) reads "Started"; value equals `Session.startedAt`; `source_start` and `first_event` fixtures; pruning events older than 366 days does not move `started_at`; an older line moves it earlier, a newer one does not | Unit (adapters, upsert) + E2E |
| D7 Retry outcomes | Stub the run via `page.route`: held `running` → button "Retrying…", disabled, `aria-busy`; `succeeded` → banner and issue count clear and the toast appears; `failed` with `consecutive_failures` 2 → banner stays with cached data, attempt line says "failed again", toast says nothing was duplicated, Retry enabled; first failure says "failed" not "failed again". Real EACCES run on a temp fixture home covers the same path server-side. | E2E + integration |
| Session start field on real records | E1/E2: earliest line `timestamp` / `session_meta.timestamp` present and at or before the first usage event; gap recorded for 3 sessions | Experiment |
| Tokens | `pnpm tokens:check`; token parity with D4 `tokens.css`; `--color-action` change reaches Astryx Button + app UI | Script + E2E screenshot diff |
| Stack | Manifests, lockfile, imports, build; no styled-components (ESLint `no-restricted-imports`) | CI-equivalent local checks |
| Setup indicator reconciliation (T6) | All three steps at 1280/390/320: wrapping pills, current/done semantics and captions agree; no connected track, clipped labels or sideways page overflow. Preserve check-only discovery, skippable steps, GitHub/ChatGPT flows, Sources-only Claude capture and zero-repo Finish. [Nine-screen criteria and retained comparisons](docs/tech/design-to-code.md#setup-indicator-reconciliation). | Later authorized repair: rendered comparison, containment, keyboard/assistive technology and affected Setup E2E checks; not rerun in T6 |
| Chart frame-budget definition (T6) | For each complete pointer/keyboard/relayout sample set, unrounded maximum ≤16ms; p95 alone cannot pass. Keep cold/paint/cadence/import diagnostics separate and retain their maxima. [Explicit check and reporting repair](#chart-redraw-measurement-and-check). | T6: source/table/numerical assessment only. Later authorized reporting repair: tail/missing-sample checks and a new candidate-bound browser run |

**Commands** (to be created by Implementation): `pnpm typecheck`, `pnpm lint`, `pnpm test` (Vitest), `pnpm test:e2e` (Playwright, seeded DB, fixed clock and `TZ=America/Los_Angeles`), `pnpm tokens:check`, `pnpm build`. The repository host and CI aren't selected yet. Checks run locally until Delivery.

## Delivery slices

| Slice | Contents | Depends on | Exit evidence |
| --- | --- | --- | --- |
| **S0 Foundation + feasibility** | Scaffold (pnpm, TS strict, ESLint/Prettier, Vite, RR8, Tailwind v4 + Astryx, Hono, `node:sqlite`, Vitest, Playwright), token generator + parity test, seed DB, guards, migrations. **Experiments E1–E7** with findings and synthetic fixtures. | Owner review of P1, P5 | Clean-checkout install/dev/build/test; E-findings files; token propagation screenshot |
| **S1 Local usage** | Codex + Claude adapters (including `startedAt`), refresh runner (including `consecutive_failures`), sources API, Usage page (ledgers, tree table and phone list; link status without PRs yet shows the not-checked words), coverage, Sources page (local) | E1, E2 pass | P-01–P-08, P-23 (native), P-28, P-29, P-39, P-40 tests green; start-time, plural and phone-card tests green |
| **S2 Delivery** | GitHub auth (gh reuse + GitHub App device flow + Keychain + refresh), repos, sync, Delivery table, year grid | E6. App registered and installed by the owner (one-time guide in Setup). | P-14–P-21 green; device-flow, refresh and not-installed paths tested |
| **S3 Review surfaces** | Filters/URL, series, Overview, Trends, records drawer, phone layouts | S1, S2 | P-09–P-13, P-32 partial, D4–D7 rendered checks |
| **S4 Attribution + Paseo** | Evidence extraction, linking, owner decisions, Paseo enrichment; Usage-tree `linkedPrs` / `linkStatus` fully populated | E3, E5, S1, S2 | P-22–P-27, P-31 green; D5 link-status tests green |
| **S5 Accounts** | ChatGPT report and connect (P4 decided); Claude plan usage through the status-line snapshot (P3 = a decided): `integrations/claudeCapture`, hook script, collector, card and Sources setup and removal actions with previews | E4 and **E8** (the P6 compact-line behaviour is decided) | P-33–P-38, P-41–P-44 green; capture install/revert tests green; E8 findings recorded |
| **S6 Setup + hardening** | First-launch flow, recovery states, retention job, a11y pass, budgets bench | S1–S5 | Full matrix; ready for Verification |

Commits are integrated milestone commits per slice (product-implementation owns the plan).

## Open decisions and gates

The historical design selected local collection, `gh` sign-in reuse with a GitHub App fallback,
and Codex-owned ChatGPT sign-in. Legacy Claude status-line installation required an explicit,
previewed, reversible user action; it does not authorize changing provider settings generally.
The current standalone Claude plan-check boundary is described in the source contract.

These feasibility gates remain evidence requirements, not a public-release approval. Historical
acceptance and missing observations do not establish a current candidate assessment.

**Experiment gates** (pass criteria in [data-and-sources.md](docs/tech/data-and-sources.md#feasibility-experiments)):

| Gate | Blocks if it fails |
| --- | --- |
| E1 | Claude adapter (T5: also whether a start record exists; failure does not block, it selects the `first_event` fallback) |
| E2 | Codex adapter (same T5 note) |
| E3 | Paseo names and parentage. On failure, Product decides before the multi-agent view is narrowed. |
| E4 | ChatGPT report |
| E5 | Evidence-link coverage. Partial/manual still ships. |
| E6 | Delivery (gh route and GitHub App route) |
| E8 | Claude plan-usage card and the install/revert path. On failure the install is not shipped; the owner decides again. |
| E7 | UI foundation. Token or component conflicts go back to Design. |

**Returned to other owners** (non-blocking):
- **Product:** retitle PRODUCT.md (pending since r7).
- **Product:** record the P3 = a exception to the non-goal "provider setting changes" (user-level Claude Code `statusLine` key only; opt-in, previewed, reversible). No requirement ID changes: P-33–P-35 are met for percentages only, and P-42/P-43 are unaffected because no credential is involved. No scope change is proposed.
- **Design** (T2, updated in T3): two new states come from owner choices and have no designed screen:
  - the GitHub App register / client-ID / device-code flow (P2);
  - the Claude plan-usage switch, preview panel and health line (P3 = a), plus a second smaller line for the 5-hour window on the designed percent card.

  Implementation composes them from existing parts ([design-to-code › Designed state → behaviour](docs/tech/design-to-code.md#designed-state--behaviour)) unless Design supplies a treatment first.
- **Design** (T5, non-blocking; owner-visible because it adds a designed-copy case):
  - the Usage-tree Linked PRs cell needs copy for "repo tracked but its PRs aren't collected yet" (`prs_not_collected`; interim "PRs for this repo aren't collected yet");
  - should the tree show a link the owner marked incorrect (T5 hides it; Delivery shows it struck through)?
  - the "Started" wording stands unless E1/E2 show a provider's start and first usage far apart.
- **Design and owner (not Technical's gates, listed so they are not lost):** the design-quality loop ended at needs-owner; D5–D7 are not owner-reviewed (the "Review D7's changes" item and "What should a session's single time be called?" are Design's open items); D7 is not rendered. Technical proceeds on D7 as design intent. A rejection of any D5–D7 change returns to Design and changes only the Usage tree, Delivery table or recovery banner mapping.
- **Design:** consider moving the three D4 layout tokens into the YAML. Delivery has a new `syncing` coverage state during initial PR backfill, shown with the existing importing/skeleton treatment; Design may want a specific treatment.

## Implementation handoff

Use the current package manifest, [setup guide](docs/delivery/setup.md) and
[project task map](AGENTS.md) for commands and ownership. Keep implementation changes within the
source, privacy and metric contracts above. Sanitized historical records preserve earlier gaps;
new verification must identify the source and environment actually assessed.

## Provenance

This public specification preserves engineering contracts and known verification limits. Internal
workflow receipts, input-bundle identifiers and personal machine paths are held only in the private
backup. See the [sanitized archive](docs/archive/README.md) for revision-scoped history.
