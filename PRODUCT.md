# Agent Productivity HQ — Product brief

Revision P4 · 2026-11-04 · Product stage · Dashboard experience and automatic local setup refinement

This brief refines the dashboard experience and setup direction: a familiar dashboard experience and automatic collection from the machine where the dashboard is installed, with only relevant Claude/ChatGPT and GitHub account connections required. It preserves the prior scope, subscription-overall-usage option, and partial/manual traceability standard. The four owner submissions are the only direct customer evidence. Source feasibility conditions remain explicit; formal requirements do not establish working integrations or receiving-stage acceptance.

## Product intent

Build a private dashboard running on Kelvin’s machine for a daily or weekly review: **what merged, where agent usage went, and which sessions can be linked to that work**. Offer day, week, and month views across up to a trailing year. Lead with delivered work, with usage alongside it and source coverage available from Sources and each metric.

Treat merged PRs as a useful delivery signal. Tokens, session counts, and spawned agents describe activity and resource use; none establishes quality, time saved, or effective output by itself. The MVP has no composite productivity score. Work such as research, design, and abandoned experiments can be valuable without producing a PR, and a merge can represent very different amounts of work.

The smallest distinctive slice is Codex + Claude Code history, a manually maintained GitHub repo list, and honest links between merged PRs and multi-agent work in Paseo. A generic token dashboard already has credible alternatives. The optional Paseo sidebar launcher opens the web dashboard. A view-only live HQ of the agents running now is in scope (see Non-goals and later opportunities); its illustrated scene is later work.

## Audience, problem, and evidence

**Audience:** Kelvin, reviewing his own coding-agent work. The MVP serves a single user and collects local activity automatically from its installation host. Overall usage may come from subscription data with its actual scope disclosed. A local browser dashboard remains an experience hypothesis, not a selected frontend architecture.

**Owner evidence:** historical workflow record asks for local Codex/Claude usage and general stats, particularly Paseo multi-agent work; daily/weekly/monthly reflection up to one year; manually tracked repos; merged PRs linked back to agents. It explicitly defers the pixel visualizer and potential Paseo plugin. This establishes Kelvin’s desired job, not a validated definition of productivity or evidence of demand from other users.

**Scoped follow-up:** historical workflow record selects the P1 recommendations for the review goal, data footprint, personal PR scope, and traceability standard. Kelvin specifies one source machine and says overall token usage may come from subscription data. That permits a different source for overall usage; it does not establish that either subscription exposes tokens, a yearly history, or session attribution. The scoped directions are carried forward below rather than asked again.

**Formalization input:** historical workflow record directs the P2 discovery-readiness step and repeats the P1 traceability choice. P3 generates the brief and requirements for that scope. This is direction to formalize Product, not evidence of source compatibility, product benefit, or a broader lifecycle decision.

**Experience/setup clarification:** historical workflow record asks for familiar dashboard conventions with appropriate filters/charts/graphs and removes the need to select a machine. P4 makes the installation host automatic, discovers supported local sources, and limits required account connections to Claude, ChatGPT, and GitHub as relevant. This replaces P3’s source-machine/location selection journey; it does not demonstrate that credentials expose all required data.

**Problem hypothesis:** answering that job currently requires reconciling provider usage, agent/session context, and GitHub outcomes. We have not observed Kelvin doing that reconciliation, inspected his data, or established his present workaround or its cost.

**Intended advantage:** move from separate usage counters and PR lists to a reviewable account of resource use and delivery, retaining unknowns instead of making up attribution. The chosen output signal is merged PRs; the usefulness of the joined view still depends on actual source coverage and Kelvin’s experience with it.

[Research and alternatives](docs/product/discovery-evidence.md) links the inspected primary sources, their claims, experience implications, and access limits. The documentation supports investigating local data and parent/session relationships; it does not prove compatibility with Kelvin’s installed versions or available history.

## MVP scope

| Include | Boundary and reason |
| --- | --- |
| Local usage history | Automatically discover supported Codex, Claude Code, and local Paseo metadata on the installation host, using their normal or already-configured locations. No source-machine or log-folder choice is required in normal setup. Provider, model, date, session, token categories, and repo context appear where recorded. Other product surfaces/devices are not implicitly included. |
| Account connections | Reuse existing sign-in through supported interfaces where available; otherwise offer the relevant Claude, ChatGPT, and GitHub account connection. Require no separate dashboard account, model API key, or manual Paseo credential. Manually adding tracked repos remains part of setup. Exact supported connection mechanisms remain technical feasibility work. |
| Subscription-reported overall usage | Use an accessible provider subscription source for overall usage when available, as permitted by the owner. Label the unit, reporting window, freshness, and actual account/product scope; it may be broader than the source machine. This adds no collectors on other machines and promises no new token-history endpoint. |
| Period review | Today, current week, current month, and custom dates within trailing 12 months; daily/weekly/monthly aggregation. Display one report timezone, initially the source machine’s. Use Monday-start weeks as the working default. Missing earlier history stays visible. |
| Tracked repositories | Manually add GitHub repositories, including private repos when access is available. Persist the list; show each repo’s collection state and merged PR history. No automatic account-wide repo tracking. |
| Delivery review | Merged PR count, merge dates, per-repo breakdown, and the underlying PR list with GitHub links. Personal default from the topic direction: PRs authored by Kelvin’s connected GitHub identity; a clearly labeled view includes all merges in tracked repos. |
| Multi-agent context | Separate root sessions, child agents, provider sessions, and Paseo agent/workspace identities. Show recorded relationships and linked usage without counting the same consumption twice. Native provider subagents and separately spawned Paseo agents must not be assumed identical. |
| PR-to-session trace | Show supported evidence links, explicitly labeled candidate associations, and optional owner-confirmed links. A PR may involve several sessions/providers. Unmatched work remains visible. |
| Trust and recovery | Per-source available history, last refresh, incomplete collection, unsupported data, and local persistence of imported metrics/identifying metadata for the lookback. Cached data remains usable when sources are unavailable. |

The local source boundary is the installation host, not a user-selected machine. Supported local locations, versions, and readable data remain feasibility details to discover automatically. Subscription reporting retains its own actual boundary. A one-year view means a year can be selected and imported data can be retained for that window; it cannot guarantee a year of recoverable history on day one. A partially populated year must not look complete.

## Experience intent for Design

The experience should feel familiar to users of dashboarding apps: visible date/repo/provider filters, summary metrics, appropriate charts and graphs, and underlying tables with predictable drill-down. Use time-series views for change over time and comparable breakdowns for repos/providers where the data supports them. Filters, legends, units, reporting periods, and empty/loading/error states must be understandable in the context of the displayed data. This expresses experience intent; Design owns the final screens, chart forms, layout, style guide, and copy treatment within these requirements.

| Area | What Kelvin should understand or do |
| --- | --- |
| Shared controls | Period and timezone govern compatible dated records. Tracked repo scope applies to local usage and delivery; provider applies to usage; author applies to delivery. Subscription totals keep their own window and account scope and do not become repo-filtered. Keep these distinctions evident while drilling down. |
| Overview | Lead with merged PRs. Show recorded local tokens and root/child activity alongside weekly subscription utilization and Claude’s five-hour window. Label local coverage and show when a plan reading is unavailable. The full source checklist lives on Sources. |
| Trends | Aligned delivery and usage charts with the same time axis. Avoid a shared numeric axis that equates tokens to PRs. Select a bucket to see its records. |
| Delivery detail | A readable PR table: repo/title, merge time, author, linked sessions, and link basis. Expand a PR to inspect evidence and other contributors. |
| Usage detail | Repo → root session → children where relationships are known, with provider/model breakdowns. Provide an Unknown repo/relationship group rather than silently dropping records. |
| Sources and repos | Show automatically discovered local sources and account connection status; add/manage tracked repos, inspect coverage, refresh, and recover from access or parsing errors. Keep setup outside the everyday review path. |

Use a calm, readable analytical interface. Provider and attribution labels must work without color; charts need a readable table equivalent. Final hierarchy, density, responsive behavior, typography, and visual identity belong to Design. A React web experience inherits the loaded frontend standard’s WCAG 2.2 AA target; actual accessibility remains unverified.

Example guided copy for review: “Recorded usage,” “Linked sessions,” “Suggested association,” and “History unavailable before [date].” Avoid “agent-produced PR,” “hours saved,” and “more productive” unless the underlying claim has separately been established. Visual approval does not establish these claims’ correctness.

## Work Review

From Overview, the owner can request a copyable team update for the selected dates and filters. The report distinguishes personal merges, other authors’ merges, substantive session work, and explicitly recorded open work. Claims link to dated local evidence. A short unrelated exchange in a work session does not belong in the update. Missing excerpts are a coverage limitation.

Generation requires consent to send selected conversation excerpts and work metadata to OpenAI using a separate Work Review sign-in with ChatGPT. Account-report connections remain independent. HQ retains derived notes and versioned reviews within its history window. Opening an existing review uses no model allowance. Revising a closed period requires an explicit request. Automatic updates are deferred until the owner evaluates a real weekly pilot.

## Metrics and interpretation

| Metric | Definition and limits |
| --- | --- |
| Merged PRs | Distinct GitHub PRs whose merge timestamp falls in the selected period, within the displayed repo and author scope. Closed without merge does not count. Author and person who merged are separate identities. A PR linked to three agents is still one PR. |
| Recorded local tokens | Usage recorded on the installation host, grouped by provider/model where known. Preserve each provider’s input/output/cache semantics. Do not sum cached or reasoning subsets into their parent counts twice. A cross-provider total requires verified normalization; provider breakdowns remain the primary presentation. |
| Subscription-reported overall usage | A provider-reported account aggregate, shown with its actual unit, scope, and reporting window. Use it as that provider’s overall token number only if actual token counts are supplied. Do not add it to overlapping local usage, distribute it across repos/agents, or infer a missing-history balance by subtraction. |
| Root sessions with activity | Distinct identified roots with recorded activity in the period, including resumed roots once per selected period. An unidentified relationship is Unknown, not automatically a root. Session count does not mean tasks completed. |
| Child agents with activity | Distinct identified children with activity in the period. Report known parentage and the unknown/unmapped group. A resumed provider thread is not automatically a newly spawned agent. |
| Linked PRs | Distinct merged PRs with at least one evidence-linked or owner-confirmed session. Suggested associations are shown separately. This measures traceability within collected records, not the share of work done by AI. |

Record usage on the dates its source events occurred and PRs on their merge dates. Linking a long-running session to a PR does not move all its historical tokens onto merge day or establish a cost per PR. Do not allocate shared-session usage across PRs without a separate, reviewed rule.

Defer estimated API-equivalent dollar cost, allowance forecasting/alerts, elapsed/active time, code churn, commit counts, and PR cycle-time metrics from the initial slice. Reading a subscription’s native usage summary is now in the source boundary; forecasting capacity and managing the subscription are separate features. Token estimates are not subscription bills, and parallel agent durations are not Kelvin’s working hours.

### Subscription totals and local detail

A subscription reading describes the provider’s named plan window. Overview shows the general
Codex weekly quota identified by ChatGPT and the weekly and five-hour readings from Claude,
where available. The local-token KPIs report activity recorded on this machine. Sources describes
the saved ChatGPT daily-bucket coverage when available.

Show each subscription limit as a percentage with its own window, reset time when supplied, and
freshness. The selected dates and repo filter leave the subscription window intact. A ChatGPT
connection can be healthy while the weekly reading is unavailable, including after an upgrade until
a refresh identifies the general Codex quota. A failed quota refresh may leave a stale reading visible.

Use local source records for daily token trends and supported local evidence or owner links for
PR/session drill-down. [Source findings and limits](docs/product/discovery-evidence.md#subscription-source-clarification)

### Automatic local setup and account connections

Use the machine where the dashboard is installed as its local source automatically. Discover supported agent records and Paseo metadata in normal or already-configured local locations without asking Kelvin to choose a host, browse log folders, supply a daemon URL, or import files during normal setup. Show what was found and its coverage; absence or denied access is a source state to explain, not a reason to invent history or add a remote collector.

Use supported existing sign-in when available. Request only the relevant Claude/ChatGPT and GitHub account connection when account access is needed; readable local usage must not be gated on an unnecessary provider sign-in. Connections use provider-owned sign-in/authorization rather than dashboard password forms or copied browser cookies. Adding the repos Kelvin wants to track is still intentional user input. Do not require separate model API keys, a new dashboard account, or manual Paseo credentials as normal setup.

This is the required setup experience, not a claim that any provider login supplies a complete data feed. Connection success, local-read access, subscription-report availability, and historical coverage are separate states. If a source cannot be supported within this setup boundary, disclose that source as unavailable and return the concrete integration limitation to Product before introducing another credential/configuration step or reducing the core experience. No provider authentication or personal source access was exercised here. [Connection evidence and limits](docs/product/discovery-evidence.md#automatic-local-setup-and-connection-evidence) records what the public documentation establishes.

Claude plan limits are optional. In Sources & repos, **Show Claude plan limits** checks the
active local Claude Code sign-in and explains that, after a successful reading, pressing
**Refresh** or **Refresh all** checks the same profile again. The result carries provider
percentages, reset times and the time of the check. Setup, page loads, scheduled refreshes and
single-source actions leave that sign-in alone. The owner approved this narrow exception to
P-42/P-43 for the undocumented subscription endpoint. Local Claude Code token history imports independently.

Setup and Sources support searching the connected GitHub account’s accessible repositories and
tracking individual results or pasted repository URLs. The account list is for discovery only.
Sources presents the checklist by machine history, delivery and account reports. Overview leads
with merged work and keeps the coverage labels on individual metrics. Its account section shows
the weekly plan utilization reported by ChatGPT and Claude, plus Claude’s five-hour window.
The local-token KPI remains the place to review recorded tokens.

## Core journeys and exceptions

1. **Set up coverage.** On first launch, the dashboard uses its installation host and automatically discovers supported local records. Kelvin connects only the relevant Claude/ChatGPT and GitHub accounts when needed, then adds the repos he wants tracked. No machine/location picker is required. The dashboard reports readable sources, each source’s oldest available record, account status, and missing access separately. Bad repo input or failed access preserves his entry for correction. A successful account connection with no readable local history shows that limitation; no available history produces an explicit empty state.
2. **Review a period.** Kelvin selects a day, week, or month, sees merged work and usage, then drills into a repo or chart bucket. Filters remain visible. A subscription summary that cannot cover that interval keeps its own window and does not populate the interval’s trends. Unknown coverage and true zero activity have different states. A month with no merges may still contain useful agent work.
3. **Understand multi-agent work.** Kelvin opens a root and its children, sees provider identity and recorded usage, and can inspect the link basis. Shared worktrees, inherited history, resumed threads, and duplicate source copies must not inflate totals. Missing parentage stays Unknown.
4. **Trace a merge.** Kelvin opens a PR, follows any evidence-linked sessions, and can review suggestions. If he confirms or corrects a link, that is labeled owner-confirmed, remains reversible, and does not rewrite the source’s claim. Squash/rebase merges and reused branches may leave no reliable automatic match.
5. **Recover from collection failure.** Kelvin sees the failed source and the last successful refresh while existing history remains readable. Retrying cannot duplicate data. Removing a tracked repo stops its collection and removes it from the active overview; previously imported history is retained locally for re-adding within retention.

## Requirements and observable acceptance

Each row is an independently assessable obligation for the selected slice, not a passing test claim. P-01–P-38 retain their IDs; P-30 now names the installation host. P-39–P-44 express the P4 setup clarification. Conditional source support is bounded by the feasibility gates below: implementation must establish supported source/version fixtures, and a source that lacks a field cannot satisfy the requirement by inventing it.

| ID | Obligation | Observable acceptance |
| --- | --- | --- |
| P-01 | Import supported Codex usage records. | An agreed Codex sample’s recorded usage is represented with source/session provenance. |
| P-02 | Import supported Claude Code usage records. | An agreed Claude Code sample’s recorded usage is represented with source/session provenance. |
| P-03 | Count each underlying usage record once. | Re-importing, archive copies, cumulative snapshots, and replayed parent history do not inflate the sample’s expected total. |
| P-04 | Disclose unsupported or unreadable records. | A partially unreadable sample leaves usable records visible and identifies incomplete collection without exposing raw content. |
| P-05 | Distinguish unavailable history from zero. | Selecting dates before available history shows unavailable coverage; a covered bucket with no events shows zero. |
| P-06 | Show source refresh status. | Each source displays the last successful refresh and the result of the latest attempt, including failure. |
| P-07 | Retain imported data after a refresh fails. | A failed refresh leaves previously imported metrics and PRs readable with their age visible. |
| P-08 | Allow retry after collection failure. | Retrying the failed source updates its status and does not duplicate already imported records. |
| P-09 | Support the requested review periods. | Today/week/month and custom dates within trailing 12 months select records from the displayed interval. |
| P-10 | Apply the displayed timezone to date grouping. | Records around local midnight and daylight-saving changes appear in the correct labeled buckets. |
| P-11 | Support daily, weekly, and monthly aggregation. | The same covered interval yields consistent totals at all three granularities. |
| P-12 | Apply displayed filters consistently within their stated scope. | Repo/date selections reconcile local usage and delivery; provider affects usage only; author affects delivery only. Account summaries retain their disclosed scope under P-37. |
| P-13 | Expose records behind a trend bucket. | Selecting a bucket opens the corresponding usage or PR records under the current scope. |
| P-14 | Persist a manually added tracked repo. | An accessible GitHub repo added by URL or owner/name remains tracked after restart. |
| P-15 | Avoid duplicate tracked repos. | Re-adding the same canonical GitHub repo does not create a second entry or double its metrics. |
| P-16 | Preserve repo input when adding fails. | Invalid/inaccessible repo input remains editable beside an actionable error; no successful connection is implied. |
| P-17 | Stop tracking a removed repo. | Removal stops subsequent collection and excludes that repo from the active overview. |
| P-18 | Preserve retained repo history when tracking stops. | Re-adding that repo restores imported history still within retention without duplicate counts. |
| P-19 | Count merged PRs by merge timestamp. | A closed-unmerged PR is excluded; merges inside/outside the selected interval are included/excluded correctly. |
| P-20 | Make PR authorship scope explicit. | Kelvin-authored and all-tracked-repo views are distinguishable; a PR authored by Kelvin and merged by someone else follows the author rule. |
| P-21 | Link delivery records to their GitHub PRs. | A PR row opens the matching repository and PR number on GitHub. |
| P-22 | Reconcile provider and Paseo identities where supported. | A mapped provider session and Paseo agent describe the same activity once; unresolvable identities are labeled unmapped. |
| P-23 | Represent recorded parent-child relationships. | A known root and children are inspectable as related records; missing parentage does not create a fabricated edge. |
| P-24 | Keep attribution evidence levels visible. | An evidence link shows its basis; a repo/time-only association is suggested; no match is explicitly unlinked. |
| P-25 | Support several session links per PR. | Linking multiple providers/children to one PR preserves one merged PR in every delivery total. |
| P-26 | Allow owner correction of a session link. | Kelvin can add/remove a PR-session association, and the resulting link is labeled owner-confirmed rather than source-proven. |
| P-27 | Persist owner link corrections. | A corrected association survives restart and a source refresh without being silently replaced by a suggestion. |
| P-28 | Preserve provider token semantics. | Sample totals reconcile under the documented provider definitions; cached/reasoning subsets are not counted twice. |
| P-29 | Retain imported metric history for the lookback. | After restart and loss of original sample logs, previously imported in-window metrics remain reviewable, with retained identifiers supporting recorded links. |
| P-30 | Except for an owner-requested Work Review, keep collected dashboard data on the installation host. | Network inspection finds no local usage/transcript upload to an analytics or hosted dashboard service; GitHub and permitted subscription-source reads are identified separately. |
| P-31 | Exclude conversation bodies and secrets from persisted dashboard records. | Inspecting stored dashboard data and error output finds only required metrics/link metadata, plus the derived notes and reports from an explicitly requested Work Review, without conversation bodies, tool bodies, or credentials. |
| P-32 | Provide readable alternatives to charts and color. | The review journeys can be completed by keyboard with labeled controls, visible focus, and equivalent tabular values. |
| P-33 | Support subscription-reported overall usage when available. | An accessible supported account sample supplies the provider overall summary with provenance; an unavailable source leaves local coverage labeled as local. |
| P-34 | Preserve subscription usage units. | Plan windows display utilization as percentages. Recorded local tokens retain their token unit. |
| P-35 | Preserve subscription reporting windows. | A rolling-window or current snapshot sample keeps its original period and does not generate unsupported daily or historical token buckets. |
| P-36 | Avoid adding overlapping aggregate and local usage. | With a stored ChatGPT daily-bucket total of 100 and 60 recorded local tokens over the same dates, Overview shows 60 local tokens and the available plan percentage. Sources carries the daily-bucket coverage. |
| P-37 | Keep account scope visible when filtering by repo. | Selecting a repo changes matching local usage and delivery. The account section keeps its own plan windows and shows that it is outside the repo filter. |
| P-38 | Keep aggregate-only usage out of session attribution. | An account summary with no session evidence creates no repo, parent-child, or PR-session link. |
| P-39 | Use the installation host as the local source automatically. | First launch collects from the installed machine without a machine-selection step or remote-host input. |
| P-40 | Automatically discover supported local source locations. | Fixtures in supported normal/already-configured locations are found without a folder picker or file import; absent or unreadable sources produce a visible source status. |
| P-41 | Limit required account connections to Claude, ChatGPT, and GitHub as relevant. | Normal setup requests only those needed account connections and the tracked repo list; no separate model API key, dashboard account, or manual Paseo credential is required. |
| P-42 | Reuse existing sign-in through supported interfaces when available. | A supported valid existing connection does not prompt for another login. |
| P-43 | Use provider-owned account authorization. | Connecting an account enters a supported provider flow; the dashboard does not collect the provider password or ask for copied browser cookies. |
| P-44 | Keep readable local usage available without account sign-in. | With readable supported local records and no provider account connection, the local usage view loads and any account summary is labeled not connected/unavailable. |

## Success conditions and feasibility gates

The MVP must let Kelvin review a chosen period, explain which tracked PRs merged, inspect Codex and Claude Code usage, and follow available links into his actual Paseo multi-agent work. An agreed sample’s totals must reconcile without duplicate usage or PRs, and gaps must be evident. These are functional success conditions, not measured productivity improvements. No such sample has yet been inspected.

Before implementing the affected integration, verify automatic source discovery on the installation host: both providers’ usage categories and timestamps where present; a real local Paseo root/child workflow and its provider IDs; archived/resumed behavior; and a merged tracked PR with link evidence or a workable manual association. Include an ambiguous/unmatched case and a signed-in account with missing local history. Establish supported existing-sign-in reuse or provider-owned connection within P-41’s boundary. If subscription totals are used, establish actual access, units, account/product scope, available periods, and overlap with local records. No personal source inspection has been performed in these Product attempts. These remain feasibility gates for the affected integration, not reasons to repeat discovery or reopen settled topics without new evidence.

Partial/manual traceability follows the supplied topic direction; it does not need another general permission request. If actual data cannot support even that experience, return the specific limitation to Product before narrowing the workflow. Do not silently substitute an aggregate-only dashboard for the requested multi-agent insight. Complete one-year backfill and account-wide completeness remain unproven until actual coverage is inspected.

No numerical adoption, speed, retention, or productivity-improvement target has been supplied. The next learning objective is whether this joined retrospective view answers Kelvin’s daily/weekly questions better than existing usage tools plus GitHub, with tolerable setup and manual correction.

## Non-goals and later opportunities

- Live agent control, action-needed alerts, and orchestration controls. **In scope since the HQ addition:** a view-only, live **HQ** page showing the coding agents running on this machine now, grouped into sessions (an orchestrator and the agents it spawned). It shows a waiting agent, never notifies about it, and controls nothing. It includes agents started outside Paseo (Claude Code or Codex in a terminal, and the Claude and Codex desktop apps), read from the transcripts those tools already write on this machine; what such an agent is doing is **inferred** from its transcript and shown as inferred (for example "may be waiting for you"), because a transcript records neither a permission prompt nor whether the process is still alive. **Opt-in since 2026-11-19:** the owner can turn on **Know when Claude Code needs you** in Sources & repos or from the first-visit HQ dialog. The switch adds Claude Code hooks, after showing exactly which settings file, events and command will change; Claude Code then tells HQ directly when an agent outside Paseo needs a permission or a turn has finished or a session ended, and HQ words that as reported, not guessed. The hooks send only the event name, the session id, the kind of notification, why a session ended and the folder, never a prompt, command, reply or notification text, and the owner can turn the switch off, which removes only HQ's entries. Nothing changes until the owner acts. It keeps the local-only boundary: the roster is held in memory and nothing about it is stored, and it carries no prompt, response, tool name or argument, permission detail or error text. The [Pixel Agents reference](https://github.com/pixel-agents-hq/pixel-agents) informs its later illustrated scene; its appearance and pixel art are not a requirement.
- **In scope for the Paseo plugin:** setup, the illustrated HQ, historical reports, PR evidence decisions, and source and repository management inside Paseo. The [Paseo setup guide](docs/delivery/setup.md#open-agent-hq-from-paseo-desktop) describes the owner-checked action for reset and Claude Code settings.
- Team analytics, employee comparison, rankings, automated output-quality judgments, a productivity score, or causal claims about agents’ effectiveness.
- Remote source-machine selection, multi-machine sync, hosted dashboard accounts, public sharing, billing reconciliation, provider setting changes (except HQ's opt-in Claude Code hooks switch above, which the owner turns on and off and which adds and removes only its own entries), and reconstruction of missing historical logs.
- Extra GitHub statistics beyond merge history and the metadata needed to understand it. Revisit a specific statistic when it answers a concrete review question.

## Scoped owner direction

P4 carries the earlier topic/formalization directions and applies the experience and setup refinement only to those topics. It replaces P3’s machine/location selection with the installation host and automatic discovery. These directions do not establish final design, working software, or stage completion. They are reflected in the affected requirements, not presented as repeat Review questions.

### Review goal and first slice

Use the retrospective usage-and-delivery slice, with merged PRs as the primary output signal and no productivity score. No additional output metric was requested in the follow-up. The Paseo plugin remains later work, and the pixel visualization is now the view-only HQ described under Non-goals and later opportunities.

### Data footprint and history

Collect local Codex + Claude Code activity, including supported Paseo records, automatically from the installation host. Overall usage may come from subscription data. Keep the account source’s actual scope explicit even if broader than the machine. No additional device collector or general desktop/chat/cloud integration is introduced. Auto-discovery, permitted account access, units, and lookback remain implementation-feasibility details; source-machine selection is no longer a setup task.

### Personal PR scope

Use Kelvin-authored merged PRs as the personal default, plus an explicitly labeled all-merges view for manually tracked repos. Keep PR author and merger distinct. Use the connected GitHub account for the personal identity; Kelvin enters the tracked repo list during setup.

### Traceability standard

Use evidence-linked sessions, visible suggestions, reversible owner confirmation, and an explicit unlinked state. Partial coverage is acceptable. Do not promise universal automatic attribution or use subscription totals to fabricate missing session evidence.

## Discovery readiness checkpoint

Source access, token semantics, history and identity mapping remain feasibility conditions.
Requirements establish intent, not working integrations or measured benefit. New evidence that
changes a product outcome or boundary returns to the affected product topic.

## Design intake

**Product inputs:** this P4 brief, requirements P-01–P-44, the scope directions above, and the [source-linked evidence and guidance baseline](docs/product/discovery-evidence.md). PDLC must identify the actual published revision in a bounded receiving assignment. This section prepares the intake; it is not a receiving assignment or an acceptance record.

**Experience to explore:** a familiar dashboard with appropriate filters, metric summaries, trend/breakdown charts, and tables: period overview → trend or repo → merged PR → linked sessions/root and children. Setup discovers local sources automatically and offers relevant account connections plus repo management. Preserve the primary merged-output signal, local/account scope distinction, partial/manual attribution standard, and the visualizer/plugin deferrals. Use the source taxonomy to distinguish underlying provider activity from Paseo enrichment.

**Required state coverage:** automatic discovery in progress; no local records found; local-read access denied; an existing valid sign-in; an account that needs connection/reconnection; successful account connection with no local history; no tracked repos; true zero activity; unavailable earlier history; partial collection; stale or failed refresh with cached data; inaccessible repo with retained entry; unknown repo/parentage; suggested, evidence-linked, owner-confirmed, and unlinked PRs; a PR involving multiple providers; account-only usage with no session detail; and a subscription window that differs from the selected review period. Design owns how these states are presented and navigated. Include understandable chart loading/empty/error states and visible filter scope; include no machine picker in normal setup.

**Content boundary:** metric meanings, scope labels, and evidence classes come from this brief. Guided copy remains reviewable for correctness separately from visual treatment. Design must not imply that a merge proves quality, a token count proves productivity, or an account summary proves local agent attribution.

| Unresolved item | Owner and next action | Receiving impact |
| --- | --- | --- |
| Local discovery, provider versions, and readable locations | Technical feasibility: verify automatic discovery on the installation host and supported metadata samples. | Design presents found/missing/denied sources, not a machine or log-folder picker. |
| Account access within the requested setup boundary | Technical feasibility: verify supported existing-sign-in reuse/provider-owned connection for relevant Claude/ChatGPT and GitHub sources. | Show connection and coverage separately; do not introduce other credentials or imply account login alone supplies local history. |
| Subscription access, native units/windows, and available lookback | Technical feasibility: verify an accessible read-only source before implementing its integration. | Show optional account reporting and unavailable/partial states; do not promise daily tokens from a snapshot. |
| Provider/Paseo identities and recoverable parentage | Technical feasibility: trace an actual root/child workflow, including resume/archive/background cases where present. | Use supported relationships and explicit unknown states; do not fabricate a complete tree. |
| PR-to-session evidence | Technical feasibility: test a well-linked case and an ambiguous case against P-24–P-27. | Partial/manual links are in scope. If those cannot be supported, return the specific limitation to Product before reducing the experience. |
| GitHub connection and repo list | Setup: derive the personal identity from the connected GitHub account; Kelvin adds the tracked repos. | Keep Kelvin-authored and all-tracked-repo scopes distinct; do not add a manual identity-entry requirement. |
| Value of the joined review | Owner evaluation during Design/pilot using actual review questions. | No measured benefit or numerical productivity target is asserted; refine only the affected outcome if evidence warrants it. |

The receiver must load the actual `product-design` guidance and applicable platform references under the recorded baseline. The React profile was loaded conditionally; this brief selects no framework, architecture, starter, component implementation, or visual identity. The orchestrator owns the next assignment and receiver checks; no Design agent is started by this Product turn.

## Continuity and next owner action

The requirements and feasibility conditions above define the product intent. Source access,
relationship recovery, account scope and the value of the joined review need evidence from the
actual supported installation. Formal requirements and synthetic examples do not establish a
working integration, measured benefit, or release approval.
