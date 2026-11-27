# Public source and distribution readiness

This review records the source disclosure boundary for the sanitized snapshot and the product
findings from that assessment.

## Source disclosure boundary

Original Git history, real local usage reports, account measurements, machine-specific provenance
and internal workflow receipts are excluded from the public snapshot. Sanitized summaries preserve
engineering decisions and unresolved limitations; synthetic fixtures remain labelled as invented.

Publish only a separately reviewed file allowlist with fresh history. Do not change the original
repository's visibility or push its existing branches, tags or commit history to the public remote.
Private backups and detailed scan receipts must stay outside the public tree. Publication itself
requires a separate action after the candidate and its remaining limits have been reviewed.

## Provider credential access

The current Claude plan-check integration reads the active Claude Code sign-in from native secure
storage and sends a bearer token to Anthropic's undocumented subscription usage endpoint. After a
successful check, an explicit Refresh can request another reading. See the
[credential reader](../../src/server/integrations/claudePlan/credentials.ts),
[request implementation](../../src/server/integrations/claudePlan/usage.ts) and
[source contract](../tech/data-and-sources.md#claude-account-report).

The maintainer accepted the risk of retaining this integration in public releases. Anthropic
describes restrictions on third-party use of Claude subscription credentials in its
[credential guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

## Host and access limits

The ordinary loopback listener trusts local processes. It does not isolate different OS users on
a shared computer. The managed listener checks the expected Tailscale owner identity, but a
scripted guard test alone does not establish a complete deployment's proxy configuration.
Keep the ordinary listener out of port-forwarding rules and use a trusted single-user host.
See [request guards](../../src/server/http/guards.ts).

Legacy capture previews can return an installation's saved status-line command. That command may
contain private arguments. Settings-edit concurrency and real credential/network observations
were unresolved in earlier reviews; their historical status is retained in the
[sanitized handoff](../archive/delivery/handoff.md). This documentation cleanup does not close them.

## Historical code findings

The earlier pilot review identified the following issues. These are revision-scoped findings,
not newly reproduced defects or evidence that they have been repaired.

| Finding                                                                                          | Required follow-up                                                                                                                |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| An upgraded database may present an old model-specific ChatGPT window as a general weekly quota. | Assess persisted bucket identity and test ambiguous old readings through failed and successful refreshes. Preserve usage history. |
| Global Refresh may conceal failure of the separate Claude-check HTTP request.                    | Assess the current handler and test collection success with an independent check failure.                                         |
| Some acceptance text still describes earlier account-card comparisons.                           | Reconcile active intent with the approved weekly presentation without rewriting historical results.                               |

## Runtime, licensing and packaging

- Evaluate the runtime actually shipped, its supported patch level and official checksum. Earlier
  dependency-audit results did not cover an embedded Node executable and are not a current audit.
- Preserve all third-party notices and font licenses in the source and their respective packages.
  Earlier packaging reviews reported missing notices; verify the exact final archive rather than
  relying on the source tree. Choose terms for the application's own code before a public release.
- Review the generated package manifest, registry target, dependency closure and installation
  prerequisites. A raw plugin source directory is not the generated distribution package.
- Exercise the exact archive on a second supported machine, including first setup, upgrade,
  restart, disable, uninstall and rollback. Exercise real owner access and denied identities
  through the configured private proxy. Existing synthetic tests do not replace these observations.

## What this cleanup establishes

The cleanup concerns source disclosure and navigation. Check receipts for this candidate belong
with its delivery evidence; historical test counts, approval transcripts and private measurements
are not carried forward as new verification. Open findings require a scoped repair or assessment.
Neither this page nor a clean secret scan grants a security certification or permission to publish.
