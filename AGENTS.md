# Agent Productivity HQ

Private, local dashboard for merged GitHub PRs and Codex/Claude Code usage. Read the
[README](README.md) for first launch, the [local setup guide](docs/delivery/setup.md) for
configuration and recovery, the [publishing runbook](docs/delivery/publishing.md) for release steps, and the [Delivery handoff](docs/archive/delivery/handoff.md) for the candidate
and assessment limits. This file is a task map; detailed decisions stay in their owning documents.

## Find the contract

- Product behavior and metric meanings: [PRODUCT.md](PRODUCT.md), with
  [discovery evidence](docs/product/discovery-evidence.md).
- Appearance, states and responsive behavior: [DESIGN.md](DESIGN.md),
  [canonical tokens](design-system/DESIGN.md), and the
  [prototype](docs/design/prototype/index.html). Prototype fixtures are synthetic.
- Architecture and ownership: [TECH.md](TECH.md). For source, storage or attribution work, read
  [data and sources](docs/tech/data-and-sources.md). For API changes, read
  [the local API](docs/tech/local-api.md) and update the shared contracts with it. For UI work, read
  [the design-to-code mapping](docs/tech/design-to-code.md).
- Build history and decisions: [execution record](docs/archive/implementation/execution-record.md),
  [decision report](docs/archive/implementation/decision-report.md), and
  [candidate evidence map](docs/archive/implementation/candidate-handoff.md). Preserve sanitized milestone history. Private original reports and workflow receipts are excluded from public snapshots.
  Historical reports and document status labels are bound to their original revisions; they do not
  replace a current candidate assessment.

## Working boundaries

Use the pinned versions and scripts in [package.json](package.json) and
[pnpm-workspace.yaml](pnpm-workspace.yaml). The stack is React Router + Vite, strict TypeScript,
Tailwind + Astryx, Hono and SQLite. Follow the layer/import rules in [TECH.md](TECH.md).
Generate theme files from `design-system/DESIGN.md`; never edit generated theme output by hand.

Keep local usage and account reports separate. Paseo adds enrichment, never tokens. Count a PR once
regardless of its linked sessions, and never allocate session tokens to PRs. Read transcript content in memory only. Retain permitted metadata and evidence identifiers. The [Work Review](docs/tech/data-and-sources.md#work-review) opt-in permits sending selected excerpts to OpenAI and retaining derived notes and reports. Preserve loopback-only
serving, the outbound boundary and approved credential storage. The app changes a provider's settings only when the owner
turns on a switch that says exactly what will change, and can undo it; today that is HQ's Claude Code hooks (entries in the
user-level `settings.json`, 2026-11-19), and nothing else is ever written to a provider. The Claude subscription endpoint can use the active Claude Code sign-in after an explicit plan
check action or an explicit **Refresh** or **Refresh all** action for a previously checked profile. Work Review uses its own Sign in with ChatGPT grant stored in the system credential store.
Legacy status-line settings are restored by their owner. Do not introduce API keys or
broader access to make setup work.

In Delivery, edit only setup/project documentation within the assignment's boundary. Product,
dependency and executable-configuration fixes return to Implementation and the affected assessors.
PDLC owns commits, clean-export exercise and pull-request publication in this managed workflow.
Merge and production release require separate authority.

## Check the affected work

The [README checks table](README.md#checks) names the scripts and their coverage. During code
iteration, use focused existing tests plus `pnpm typecheck` and `pnpm lint` for the affected scope.
API changes need `pnpm test:contract`; token changes need
the token parity script defined in [package.json](package.json); rendered behavior needs
the appropriate functional, accessibility and responsive browser groups. Preserve the full required
project gates for candidate assessment; a focused pass cannot replace them.

For documentation changes, check links, script names, environment-variable descriptions and the
install/build/start order against the repository. The README and local setup guide guards are in
`test/verification/readme.test.ts`; PDLC runs declared checks in the clean export. Do not run runtime
suites solely because a document changed. Do not claim an unrun check or a skipped socket probe
passed. Historical Delivery statements do not establish current check results.

Reuse evidence only when the assessed source, dependencies, configuration, command and environment
remain applicable; rerun affected checks after changes. Independent Verification and code/security
Review remain distinct. Open findings and unassessed boundaries remain open until their responsible
owner returns evidence or a scoped decision; documentation does not close them.
