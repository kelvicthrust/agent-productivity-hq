# Implementation decision report

These decisions summarize the major implementation choices in milestone order. The [architecture
specification](../../../TECH.md), [source contracts](../../tech/data-and-sources.md) and [local
API](../../tech/local-api.md) describe the current implementation.

| Milestone | Decision and rationale                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1        | Pin the toolchain and dependencies. Generate theme output from the canonical design tokens so Astryx and Tailwind share the same source.                                                                                                                                             |
| M2        | Use SQLite for normalized records, derive metrics by selected period and repository, and preserve unavailable source coverage separately from measured zero. Keep the app loopback-only and expose a small local API.                                                                |
| M3        | Exercise uncertain provider payloads in isolated probes with invented fixtures. Keep raw transcripts and credentials out of findings. Treat a source experiment as incomplete when any required observation is missing.                                                              |
| M4        | Show coverage alongside recorded metrics, give stale snapshots an explicit recovery path, and keep phone session rows readable at narrow widths.                                                                                                                                     |
| M5        | Normalize provider events by their own accounting rules, preserve incremental progress, and rebuild affected facts when rules change. Keep the matched-window comparison with ccusage reproducible. See the [import decisions](decision-history-m5.md).                              |
| M6        | Reuse a compatible GitHub CLI sign-in or use device authorization with native credential storage. Sync selected repositories and count each merged PR once. The historical broader-grant exception established no minimum-permission proof.                                          |
| M7        | Give charts keyboard and table equivalents. Keep the clicked period when navigating to records and preserve local token and account-report scopes across shared filters.                                                                                                             |
| M8        | Use explicit PR and commit evidence when available, keep proximity as a suggestion, and allow reversible user decisions. Paseo contributes agent context and parentage.                                                                                                              |
| M9        | Keep account-report windows distinct from local collection. Revise the ChatGPT label when the overlap experiment leaves the aggregate scope uncertain. Legacy status-line integration has since been superseded by the on-demand Claude plan check described in the source contract. |
| M10       | Discover locations before importing. Start import after Setup, provide recovery for startup failures and compare rendered states against the design. Judge complete chart redraw classes by unrounded maxima.                                                                        |

The original private decision log includes intermediate proposals and workflow decisions. The
[execution record](execution-record.md) and [delivery handoff](../delivery/handoff.md) preserve
the outcome and known assessment limits.

## Standalone Claude plan checks

An explicit plan check reads the active Claude Code sign-in and requests the account usage report.
After a successful check, an explicit **Refresh** or **Refresh all** can update the same profile.
The dashboard stores normalized report metadata. Credential renewal stays with Claude Code.
Transcript import continues independently, and legacy hook installations retain instructions for
restoring the original setting.

The endpoint is undocumented and may change. Anthropic restricts third-party subscription
credential use. The local action gate limits collection, and distribution remains subject to
provider approval. [Anthropic credential guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
