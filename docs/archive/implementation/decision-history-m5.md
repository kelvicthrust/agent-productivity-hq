# M5 local import decisions

This record summarizes decisions made while adding the Codex and Claude Code importers. See
[Local source contracts](../../tech/data-and-sources.md) and the
[ccusage comparison rules](../../implementation/ccusage-rules.md) for maintained behavior.

- Local adapters report progress as records arrive. Import counts describe what the run wrote,
  and source rows distinguish a missing directory, an unreadable directory, a partial import
  and a failed import. An existing empty source is a discovered source with no recorded usage.
- First launch starts import after Setup. Sources can observe a run started elsewhere. Stored
  oldest dates respect the retention horizon, and a long filesystem location must fit its row.
- Claude accounting assigns duplicated usage to the file holding the surviving copy and retains
  the true start time when usage appears on a later read. The historical importer diagnosed
  sidechain replay under a new request ID without deduplicating it.
- Codex accounting skips inherited replay history and uses the request delta when cumulative
  counters change and the delta is present. Otherwise it uses a per-category difference floored
  at zero. Compaction deduplicates by response identity, and cached and cache-write tokens
  remain part of input.
- Counting-rule changes require rebuilding affected derived facts. The diagnostic cases are
  synthetic regression inputs. Private real-history comparisons remained distinct.
- Compare matched events, categories and windows when reconciling with ccusage. A missing tool or
  unavailable source is an incomplete check. E1 and E2 failed, and the M5 review found differences
  on the revision it assessed. A later owner-run reconciliation reported zero-token differences
  after the importer repairs. Independent review did not establish wider or current parity.
