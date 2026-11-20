# Claude Code fixtures (DRAFT-documented-shape)

These files are hand-written reconstructions of the Claude Code transcript shape as TECH documents it, with **invented** values. No line here came from a real session. Every text field (prompts, replies, titles, branch names, working directories) holds a `SENTINEL_<WORD>_<hex>` string, so the sentinel test can prove the E1 script never prints, writes or records any of them. There is no token-shaped value.

Once E1 has run on a real machine and the field list is confirmed, real field names and shapes replace what was only documented here. The values stay invented.

## Where each shape comes from

| File                                                           | Shape                                                                                                                                                                                                                                                       | Source                                                                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects/<project>/<session>.jsonl`                           | Main transcript: lines with `type`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`, `isSidechain`, `message.id`, `message.model`, `requestId`, `message.usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}` | [data-and-sources › Claude Code transcripts](../../../docs/tech/data-and-sources.md#claude-code-transcripts), "Line fields used (verify E1)"                            |
| `projects/<project>/<session>/subagents/agent-*.jsonl`         | Subagent transcript, same format, parent recorded by location                                                                                                                                                                                               | the same section, "Files read" (R3)                                                                                                                                     |
| `projects/<project>/<session>.orphaned-<ts>-<suffix>.jsonl`    | A set-aside copy that must be skipped. Here it repeats one assistant line, so reading it would be caught by the dedupe key.                                                                                                                                 | the same section, "Files skipped"                                                                                                                                       |
| `summary` line (session 1) and `custom-title` line (session 3) | Two possible shapes for a persisted title. Session 2 has none. Which one (if any) real files use is what E1 records.                                                                                                                                        | the same section ("A title or summary line, if Claude Code persists one, verify E1")                                                                                    |
| `queue-operation` line (session 2)                             | A non-message line with a `timestamp` that comes before the first user line, to show that the start is the earliest line of **any** type. Lines with no `timestamp` (the title lines) are ignored for the start.                                            | [data-and-sources › Session start time](../../../docs/tech/data-and-sources.md#session-start-time)                                                                      |
| Streamed duplicate (session 1, message 1)                      | Two lines with the same `message.id` + `requestId` and the same usage, one per content block. They count once.                                                                                                                                              | the same section, "Normalization"                                                                                                                                       |
| `oracle.json`                                                  | The `claude session --json --offline` report. **Produced by running ccusage 20.0.48 over `projects/`** (`CLAUDE_CONFIG_DIR=<this folder> ccusage claude session --json --offline`). Costs in it come from ccusage's own price table and are not used.       | TECH E1 row of [Feasibility experiments](../../../docs/tech/data-and-sources.md#feasibility-experiments); ccusage is an external oracle, not a dependency               |
| `oracle-one-token-off.json`                                    | The same report with the output of one session one token too low, so the reconciliation must fail.                                                                                                                                                          | the same E1 row ("within 0 tokens")                                                                                                                                     |
| `projects-orphan/`                                             | One subagent file whose parent session has no main transcript.                                                                                                                                                                                              | the E1 row ("Subagent files map to their parent")                                                                                                                       |
| `projects-corrupt/`                                            | One main transcript with one line that is not JSON and one cut off mid-line.                                                                                                                                                                                | [data-and-sources › Discovery](../../../docs/tech/data-and-sources.md#discovery-automatic-no-picker) and TECH P-04 (corrupt lines counted as `unreadable`, never shown) |
| `fake-ccusage.ts`                                              | Answers `--version` and `claude session --json --offline` with `oracle.json`, for the case where E1 starts ccusage itself.                                                                                                                                  | TECH E1 row; `scripts/experiments/lib/CONTRACT.md` (fake programs)                                                                                                      |

## What the fixtures show about ccusage

Running ccusage 20.0.48 over `projects/` gave these observations. They are why E1 reconciles the way it does, and they are facts about that version only:

- A session in the report is a main transcript. Usage in `<session>/subagents/*.jsonl` is folded into the parent session by **location**, not by the `sessionId` field.
- A transcript at the project root with some other name (for example `agent-*.jsonl`) becomes a session of its own.
- A repeated `message.id` + `requestId` counts once, across files too, so the `.orphaned-` copy does not change a total.

A scratch check outside this repo (twelve generated datasets of about 30 sessions each, compared with E1's totals; none of it is kept here) showed more about ccusage 20.0.48. Of a message streamed over several lines it counts the one with the highest output, which is the last line whenever output only grows. A line with no `requestId` is deduplicated by `message.id` inside its session (with its time when the id is not one the provider issued). A message copied into several files counts once, **in the copy with the larger total (a main-thread copy before a sidechain one), and with equal totals in the file that sorts first by path**, not in the file with the earliest copy (the `config-rules` section below was made to show that against the real binary). E1 reports how many sessions match under each candidate line rule (last, highest-output, first).

## Numbers

Session 1 (with its subagent file): input 25, cache write 520, cache read 14650, output 742, total 15937. Session 2: 7, 915, 900, 294, total 2116. Session 3: 24, 210, 20, 137, total 391. The start of each session comes 5, 8 and 3 seconds before its first usage, and the subagent file 3 seconds.

Keep every file under 64 KB and this folder under 512 KB.

## Adapter fixtures (`config-b/`)

`config-b/` is a second Claude config dir, as `~/.config/claude` sits beside `~/.claude`. The adapter tests (`test/collectors/claude/`) read it together with the folder above, which is itself a config dir (it holds `projects/`). It is **not** under `projects/`, so E1, `fake-ccusage.ts` and `oracle.json` never see it and `pnpm experiments:selftest` reads exactly what it read before. Every value is invented, text fields hold `SENTINEL_<WORD>_<hex>` strings, and the shapes are still the documented ones: **no E1 run has happened**, so nothing here confirms a real field, a real title line or the real streaming behaviour. The oracle files describe the invented data above, not any real session.

| File                                                                        | What it adds                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config-b/projects/<project>/55555555-….jsonl` (session 5)                  | A message streamed over **three** lines whose output grows (12, 60, 143), so the last line is told apart from the first. A line with no `timestamp` before the first dated one, a `queue-operation` line that gives the start, a `system` line, a late `custom-title` line (a rename). |
| the same file                                                               | A `<synthetic>` assistant line with all four token counts zero and no `requestId`: a notice, not usage, so it is neither an event nor an unreadable line.                                                                                                                              |
| `config-b/projects/<project>/55555555-….jsonl.superseded-1760000200-ef56ab` | A set-aside copy that repeats the streamed message with output 999. Reading it would change session 5's total, so a wrong skip is caught.                                                                                                                                              |
| `config-b/projects/<project>/55555555-…/subagents/agent-b7c8d9e.jsonl`      | A second subagent, a child of session 5 by location.                                                                                                                                                                                                                                   |
| `config-b/projects/-fixture-SENTINEL_CWD_a1b2c3-app/22222222-….jsonl`       | A byte-for-byte copy of session 2: the same session seen from two config dirs. It counts once.                                                                                                                                                                                         |

Session 5: input 15, cache write 200, cache read 6350, output 231, total 6796. Its subagent: 7, 40, 1640, 101, total 1788. Its start is the `queue-operation` line, 10 seconds before its first prompt.

## `config-rules` and `oracle-rules.json`: the counting rules, checked against the real ccusage

Five invented transcripts (`config-rules/projects/-fixture-SENTINEL_CWD_d1d2d3-app/`) that hold the shapes the oracle's rules turn on
(`docs/implementation/ccusage-rules.md`): an original session `d1` (a message written twice with the larger total last, a message
with no request id twice, a gateway's made-up id twice, an advisor iteration, a main-thread copy of a message whose sidechain copy is
larger, and two lines ccusage does not count); its subagent; `d0`, a resumed copy whose path sorts first; `d2`, which continues `d1`
with a larger copy of one message; and `d3`, whose lines name a session that has no transcript. Every value is invented; replies and
prompts are `SENTINEL_` text.

`oracle-rules.json` is **the saved answer of the real ccusage 20.0.48** on that folder:

```sh
CLAUDE_CONFIG_DIR=test/fixtures/claude/config-rules ccusage claude session --json --offline > test/fixtures/claude/oracle-rules.json
```

(sorted and indented; no path in it). The run showed that ccusage's session report groups a message by the file of the surviving copy,
not by the `sessionId` its line carries (`d0` is credited with a message `d1` and `d2` also hold, because its file sorts first).
`test/collectors/claude/rules.test.ts` imports the folder and compares every category of every session with it. It proves the importer
and ccusage agree on these invented transcripts; it says nothing about a real history.
