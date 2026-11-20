# Implementation execution record

This history summarizes the work from M1 through M10 and the assessments that followed. Milestone
acceptance and author-run checks were recorded separately from independent review.

## Milestones

| Milestone                  | Work delivered                                                                                                         | Historical evidence and limits                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 · Foundation            | Pinned Node and pnpm toolchain, project checks, app shell, generated token contract and Astryx/Tailwind bridge.        | The token propagation test observed computed colors. The shell and routes were initially placeholders.                                                                                           |
| M2 · Server and fixtures   | Loopback boot, SQLite schema and migrations, seed data, API contracts, filters and coverage metrics.                   | The seeded and in-process paths were exercised. They did not establish production startup through a real listener.                                                                               |
| M3 · Feasibility kit       | Provider probes, fixtures and runbooks covering usage, account connections, transcript evidence and token propagation. | Review found a credential copy and a write through a symlink in the legacy E8 probe. Corrections followed without a recorded independent milestone recheck.                                      |
| M4 · Usage and sources     | Usage tree, source discovery states, retry and coverage surfaces backed by seeded data.                                | Review found the coverage strip unmounted and Retry showing its idle label during refresh. Corrections followed without a recorded independent milestone recheck.                                |
| M5 · Local import          | Codex and Claude Code parsing, incremental import, freshness, retention and reconciliation tooling.                    | Real-history comparisons differed from ccusage. Review also found that Sources lost the unreadable-record count on reload. Corrections followed. See the [M5 decisions](decision-history-m5.md). |
| M6 · GitHub delivery       | Tracked-repository discovery, merge import and sign-in reuse or a device-code flow.                                    | Review found rate limits presented as sign-in failures. Corrections followed. The live minimum-permission App step failed with broader grants and the owner waived that step.                    |
| M7 · Review surfaces       | Overview, Trends, chart drill-down and record tables with responsive and keyboard interactions.                        | Review found drill-down links rewriting the selected bucket dates. A correction followed without a recorded independent milestone recheck.                                                       |
| M8 · Attribution and Paseo | Explicit and suggested links, manual links and Undo, plus daemon enrichment.                                           | The recorded evidence was synthetic. Live Paseo identity joins and real transcript attribution remained unverified.                                                                              |
| M9 · Account reports       | ChatGPT app-server integration and the historical Claude status-line setup.                                            | The ChatGPT overlapping-window comparison failed. Claude evidence was limited to fixtures and provider documentation under the live-check exception.                                             |
| M10 · Setup and hardening  | First-run discovery, optional sign-in, recovery pages, clean-checkout guard and fidelity review.                       | In-process Setup checks and synthetic browser runs did not establish first launch through a real listener. Exact-candidate coverage, visual differences and independent fidelity remained open.  |

## Real-source experiments

- **E1 and E2:** the early comparisons failed, and the M5 review found differences on its assessed revision. After importer repairs, a later owner-run reconciliation reported zero-token differences. Independent review did not establish wider or current parity.
- **E3 and E5:** no real Paseo or transcript-attribution findings were recorded.
- **E4:** the one-day ChatGPT comparison against local Codex failed. The broader account scope remained unverified.
- **E6:** the live GitHub App minimum-permission step failed with extra grants. The owner approved retaining the broader grants for that historical run.
- **E7:** browser token propagation used repository fixtures.
- **E8:** only the legacy Claude status-line setup step ran. The owner allowed fixture and documentation evidence for the remaining historical checks.

## After M10

Corrections addressed account-report wording, phone layout, Setup step indicators and chart
benchmark reporting. The next independent checks still identified Delivery card and notification
composition, recovery styling, Paseo status wording, missing real-source evidence and
unverified first-launch completion. Recorded chart runs included both passes and misses at the
16 ms ceiling. The owner retained the ceiling and recorded a headless-browser exception, with
native-browser timing still unmeasured.

See the [candidate evidence map](candidate-handoff.md) for test coverage by requirement and the
[delivery build record](../delivery/build-record.md) for the later unresolved assessment findings.
