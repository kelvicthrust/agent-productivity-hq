# Discovery evidence and alternatives

Revision P4 · Prior research reused; targeted account-access research 2026-11-04 · Supporting source for [the Product brief](../../PRODUCT.md)

## Evidence quality and limits

- **Customer evidence:** The project started with one user’s workflow and evolved through scope, requirements and setup discussions. The latest discovery revision chose familiar dashboard conventions, collection on the installation host and optional relevant account connections. The scope includes account reports and partial, manually correctable traceability. This direction has no interview, diary study, quantitative baseline or broader customer validation behind it.
- **Local observations:** Discovery inspected the initial project and publicly described source interfaces. It did not read personal agent logs, credentials, provider accounts or tracked repositories.
- **Secondary evidence:** the first-party documentation and maintainers’ project descriptions below. Retrieved pages were inspected as text. These are claims about those products, not verified behavior on the installation host. No competitor was installed or exercised, and no authenticated dashboard or rendered interaction was observed.
- **Interpretations/hypotheses:** proposed experience advantages, workflow friction, and scope choices are explicitly recommendations. Source existence does not validate integration, accuracy, suitability, or investment readiness.

## Alternatives and experience implications

| Reference and access | Source claims or inspected description | Interpretation for this product |
| --- | --- | --- |
| [ccusage reports](https://ccusage.com/guide/all-reports), [Claude Code source](https://ccusage.com/guide/claude/), [Codex source](https://ccusage.com/guide/codex/) — public docs | Documents unified daily, weekly, monthly, and session reports, with provider-focused views and JSON output. Codex support is experimental and reconstructs retained logs; local totals can differ from account-wide usage. Its Codex description specifically addresses replayed parent history and archive duplication. | Try or reuse existing reporting capability before writing an independent parser. Terminal reports already answer much of “where did usage go?” The proposed differentiation is delivery linkage and Paseo context. Compatibility and dependency choice are unreviewed; no package is selected or installed. |
| [Claude Code Usage Dashboard](https://github.com/physcom/claude-usage-dashboard) — maintainer README | Describes a local dashboard on ccusage with summary cards, time-series charts, provider/date filters, and an expandable projects/sessions tree. It describes saving daily aggregates so charts can survive source-log cleanup; finer detail still depends on logs. The README calls its animated visual an illustrative mockup. | Borrow the progression from overview to project/session detail and distinguish aggregate retention from evidence retention. The inspected README does not establish merged-PR linkage; this is a candidate gap, not proof that no version supports it. We did not assess actual chart readability, keyboard behavior, latency, typography, or density. |
| [Paseo MCP reference](https://paseo.sh/docs/mcp), [SDK agents](https://paseo.sh/docs/sdk/agents), [SDK events](https://paseo.sh/docs/sdk/events) — official docs | Describes workspace placement separately from parentage, agent metadata/status/activity, provider session identity on handles, and explicit parent relationships. Background agents can be absent from default discovery. Snapshot properties can be stale; reconnecting event subscriptions does not automatically replay missed history. | Preserve distinct agent, provider-thread, and workspace identities. Validate background/archive coverage and current-vs-historical data rather than treating a live list as a yearly ledger. These docs justify a bounded feasibility check, not a claim that the installed version exposes a complete usage history. |
| [GitHub pull request API](https://docs.github.com/en/rest/pulls/pulls), [PullRequest reference](https://docs.github.com/en/graphql/reference/pulls) — official docs | Describes PR retrieval and merge-related metadata. The REST documentation explains that a merge SHA can represent a merge, squash, or rebase result, and can refer to a test merge before a PR merges. | Use actual merge state/time for delivery, not mere PR closure or a populated merge SHA. PR IDs and repository identity support a stable list; branch or commit coincidence alone cannot establish which agent did the work. The API mechanism remains Tech Spec’s decision. |
| [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) — owner-selected maintainer README | Describes animated office characters reflecting activity, waiting/permission bubbles, subagents, and workspace areas. Describes VS Code and standalone forms; Claude Code is its reference integration and other agents are roadmap items. | A useful later reference for ambient state and attention cues. It answers “what needs me now?” rather than the MVP’s period-review job. Preserve as inspiration without promising exact replication, cross-provider support, copied assets, or a licensed integration. No animation or live state transition was exercised. |

The obvious low-investment workaround is usage reports plus GitHub’s PR views and a manually maintained repo list. That is a proposed alternative to compare, not an observed description of observed behavior. A custom build is justified only if the joined review reduces manual reconciliation or reveals something those separate views do not.

The published experience descriptions support hierarchy and workflow comparisons. They do not support an aesthetic score, competitive quality ranking, or a claim that a reference’s visual style will suit this product.

## Source feasibility and accounting cautions

**Codex:** [official advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) documents opt-in OpenTelemetry export. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server) documents active-thread usage notifications and turn events. Neither establishes a recoverable year of historical local usage or permission to alter provider configuration. Live collection is not backfill. Existing local history and supported record semantics must be checked separately. OpenAI Docs was used for these claims.

**Claude Code:** [official monitoring documentation](https://code.claude.com/docs/en/monitoring-usage) documents token metrics and request/session context. Input excludes cache reads/writes in the described metric; the categories must be interpreted accordingly. It describes user and CLI active-time categories, which are not equivalent to human working hours across parallel agents. These capabilities do not establish historical local availability. [Official cost guidance](https://code.claude.com/docs/en/costs) distinguishes estimated cost figures from invoices; a cost display would need a separate accounting definition.

**Joining data:** Paseo metadata could enrich provider usage with agent/workspace relationships. Treat that as context about an existing record, not another consumption record. A parent may include inherited context or an aggregate snapshot, and several agents may share a workspace. Validate the normalization before showing combined counts.

**PR attribution:** strongest useful evidence may be an explicit session-associated PR reference or recorded repository/commit linkage with merge semantics resolved. Repo/branch/time proximity is a suggestion. A GitHub author, bot account, or coauthor trailer alone does not establish a unique agent session. User confirmation is a separate evidence class. “Linked session” does not prove that session solely produced the PR.

**Coverage and retention:** source history may be missing, cleaned up, incomplete, or on a different machine. Retaining aggregate totals alone may leave nothing with which to inspect an old PR/session link. Preserve only the normalized metrics and identifying/link metadata the agreed journey needs; do not duplicate transcript contents or change source retention settings to claim one-year completeness.

All proposed dashboard integrations are **Under Construction**. Public source access was available; personal source compatibility, authenticated GitHub reads, persisted storage, live Paseo connection, and end-to-end attribution were not exercised.

## Subscription source clarification

The follow-up permits subscription data for overall usage. It does not establish that subscription consumption is expressed in tokens, limited to the installation host, or attributable to individual sessions. Product therefore distinguishes **provider overall usage** from **recorded local usage** and retains the source unit, window, scope, and freshness. Neither is added to the other when they overlap.

Public documentation checked for this clarification:

- [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server) describes account token-activity summaries and daily buckets through `account/usage/read`, separately from rate-limit reads. This is evidence that an account source is worth checking; it does not establish availability for the user’s installed version/account, lookback, or a supported integration method for this dashboard.
- [OpenAI subscription guidance](https://learn.chatgpt.com/docs/pricing) distinguishes tokens, credits, and included usage limits and describes shared allowances across local/cloud activity. An allowance or credit value is not a raw token total. No price, conversion rule, or plan-specific allowance has been selected for this product.
- [Claude Code usage guidance](https://code.claude.com/docs/en/costs) distinguishes session tokens from subscription bars and describes recent usage attribution computed from local history. It does not establish a universal annual account-token feed for this dashboard. A percentage or local attribution report cannot be treated as an account-wide token ledger.

These are fetched first-party documentation claims, not observed account behavior. A source that exposes only percentages keeps that label; subscription tokens remain unavailable. A current snapshot does not become a daily or yearly history. Exact subscription access, data fields, and compatibility remain untested. No new credential flow, provider configuration, remote operation, or implementation was performed.

## Automatic local setup and connection evidence

**Owner direction:** use the installation host automatically, discover supported local data without a source-machine/location picker, and require only relevant Claude/ChatGPT and GitHub account connections. The repo list remains intentional manual input from the original request. The requested familiar dashboard experience refines information presentation, not the metric definitions or evidence standard.

**New primary-source checks:** [OpenAI authentication guidance](https://learn.chatgpt.com/docs/auth) describes ChatGPT subscription sign-in in Codex clients, a browser flow, and cached sign-in reuse. [OpenAI App Server guidance](https://learn.chatgpt.com/docs/app-server) describes local/open-source app authentication and account usage reads. These support investigating a provider-owned connection and existing-sign-in route; they do not demonstrate dashboard compatibility with the user’s installation or a complete cross-tool/yearly history.

[Claude Code authentication guidance](https://code.claude.com/docs/en/authentication) describes browser sign-in with a Claude subscription account and cases where an earlier sign-in avoids a new prompt. That establishes Claude Code’s own sign-in behavior, not a general third-party subscription-analytics integration. This Product brief does not select copied tokens/cookies, a provider-password form, or a new API-key dependency.

**Interpretation and feasibility condition:** credentials authenticate an account; local record access, account-report access, and historical completeness still need separate evidence. Readable local records should work independently of optional account reporting. A supported account connection might not provide a particular report or reconstruct missing local logs. Technical work must establish an access route within P-41’s account boundary, or return the concrete source limitation to Product before adding setup requirements. No account login, credential read, local-source scan, provider setting change, or authentication code was performed during discovery.

## Consequential gaps and next learning

| Gap | What it affects | Smallest useful next evidence |
| --- | --- | --- |
| Automatic local discovery and readable sources | The installation host is the source, without a machine-selection step; account aggregates may have broader scope. | Verify discovery in supported normal/already-configured locations and visible missing/denied states. Do not add other-device collectors or a normal-setup folder picker. This Product-only assignment authorizes no collection changes. |
| Supported account connection and subscription fields | Desired setup requires only relevant Claude/ChatGPT and GitHub connections; actual data access is unproven. | Verify permitted sign-in reuse or provider-owned connection and distinguish account success from report/local-read access. Return a concrete conflict before adding other credentials or configuration. |
| Available lookback and source versions | Backfill claim and feasibility of retaining useful evidence. | Scoped inspection of representative metrics/metadata from the selected sources, with sensitive content excluded. |
| Connected GitHub identity and initial repos | The personal rule is merges authored by the connected GitHub user, with an all-tracked-repo alternative view. | Derive identity from the GitHub connection; the user enters the repo list. No repeat product-scope or manual identity-entry question is needed. Preserve author and merger separately. |
| Recoverable Paseo/provider relationships | Whether the distinctive multi-agent view works. | Trace a real root/child workflow to provider IDs, including resume/archive/background behavior when present. |
| Available evidence for the selected partial/manual standard | Actual automatic coverage and how much local evidence survives. | Compare a well-linked merge with an ambiguous/unlinked case. Preserve evidence/suggested/owner-confirmed/unlinked classes; return only a concrete failure to support this experience to Product. |
| Current review workflow and benefit | Whether the joined view improves on existing reports in actual use. | Evaluate against real review questions during Design/pilot. No further discovery response, interview count, or invented numerical threshold is required for this checkpoint. |

## Product evolution

- **Initial scope:** review merged PRs and locally recorded agent usage by time period.
- **P2:** add account-reported subscription usage and explicitly support partial and manually
  corrected traceability while keeping installation-host collection.
- **P3:** formalize P-01–P-38 and carry source feasibility questions into design and technical work.
- **P4:** choose familiar dashboard patterns, automatic local discovery and optional account
  connections. P-39–P-44 specify the setup behavior. Discovery ran no application or private-source
  validation.
