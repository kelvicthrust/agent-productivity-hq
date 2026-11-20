# Codex fixtures (DRAFT-documented-shape)

These files are hand-written reconstructions of the Codex rollout shape as TECH documents it, with **invented** values. No line here came from a real session. Every text field (instructions, prompts, replies, titles, branch names, working directories, repository URLs) holds a `SENTINEL_<WORD>_<hex>` string, so the sentinel test can prove the E2 script never prints, writes or records any of them. There is no token-shaped value.

Once E2 has run on a real machine and the field list is confirmed, real field names and shapes replace what was only documented here. The values stay invented.

## Where each shape comes from

| File                                                     | Shape                                                                                                                                                                                                                                                                                                                                                  | Source                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `home/sessions/2026/10/12/rollout-…-aaaaaaaa….jsonl`     | A root rollout. `session_meta` (`id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `git.{repository_url, branch, commit_hash}`), `turn_context` (`model`), `event_msg` with `payload.type = "token_count"` and cumulative `info.total_token_usage` plus `info.last_token_usage`. One snapshot is repeated, to be skipped as a duplicate. | [data-and-sources › Codex local rollouts](../../../docs/tech/data-and-sources.md#codex-local-rollouts), "Record types used (field names verify E2)"                                                                                                     |
| `home/sessions/2026/10/12/rollout-…-bbbbbbbb….jsonl`     | A spawned subagent. Its `session_meta.source` is an object that names the parent thread (`source.subagent.thread_spawn.parent_thread_id`). Its first two snapshots replay the parent's history, and the next two are its own.                                                                                                                          | the same section ("parent-thread reference for spawned subagents if present", "replayed-parent prefix baseline") and R1                                                                                                                                 |
| `home/archived_sessions/rollout-…-cccccccc….jsonl.zst`   | An archived rollout, zstd-compressed. It is the only copy, so it must be decoded.                                                                                                                                                                                                                                                                      | the same section ("Files", `.zst`; Node 26 zstd, verify E2)                                                                                                                                                                                             |
| `home/sessions/2026/10/12/rollout-…-aaaaaaaa….jsonl.zst` | A compressed twin of the root rollout. The plain file wins, so this one is never read and nothing is counted twice.                                                                                                                                                                                                                                    | the same section ("A plain file beats its `.zst` twin")                                                                                                                                                                                                 |
| `home-orphan/`                                           | A spawned subagent whose `session_meta.source` names no parent.                                                                                                                                                                                                                                                                                        | TECH E2 row ("Missing parent reference → children show as `unknown`")                                                                                                                                                                                   |
| `home-corrupt/`                                          | One rollout with one line that is not JSON and one `token_count` cut off mid-line.                                                                                                                                                                                                                                                                     | TECH P-04 and the same section ("Any snapshot it can't classify is counted toward an unreadable tally rather than guessed")                                                                                                                             |
| `home-reset/`                                            | One rollout whose cumulative total starts over mid-file (2200, then 360, then 1000). Each count carries its own `last_token_usage`, which is what the oracle counts after a drop (without one it would take a saturating difference); the event that repeats an earlier total has its own time, so its key is its own.                                 | [data-and-sources › Codex local rollouts](../../../docs/tech/data-and-sources.md#codex-local-rollouts) ("if any category < 0 -> mark file 'reset', ref = ZERO, delta = S")                                                                              |
| `oracle.json`                                            | The `codex session --json --offline` report. **Produced by running ccusage 20.0.48 over `home/`** (`CODEX_HOME=<this folder>/home ccusage codex session --json --offline`). Costs in it come from ccusage's own price table and are not used.                                                                                                          | TECH E2 row of [Feasibility experiments](../../../docs/tech/data-and-sources.md#feasibility-experiments); ccusage is an external oracle, not a dependency                                                                                               |
| `oracle-one-token-off.json`                              | The same report with the subagent's output one token too low, so the reconciliation must fail.                                                                                                                                                                                                                                                         | the same E2 row ("within 0 tokens")                                                                                                                                                                                                                     |
| `fake-ccusage.ts`                                        | Answers `--version` and `codex session --json --offline` with `oracle.json`, for the case where E2 starts ccusage itself.                                                                                                                                                                                                                              | TECH E2 row; `scripts/experiments/lib/CONTRACT.md` (fake programs)                                                                                                                                                                                      |
| `fake-codex.ts`                                          | Speaks JSON-RPC over standard input and output and answers `initialize` and `thread/list` (two live threads on two pages, one archived thread with no name, `createdAt` in Unix seconds). The `createdAt` values are the `session_meta` times, and for the subagent 2 seconds later.                                                                   | [data-and-sources › Session start time](../../../docs/tech/data-and-sources.md#session-start-time) and [Codex titles and kinds](../../../docs/tech/data-and-sources.md#codex-local-rollouts) (a third-party mirror shows Unix seconds; unconfirmed, E2) |

## The compressed files

The two `.jsonl.zst` files are Node's `zlib.zstdCompressSync` of hand-written plain rollouts (the archived rollout has no plain copy kept, and the other is an exact twin of the root rollout). To read one, or to rebuild it after editing the plain text, use Node 26:

```sh
node -e "process.stdout.write(require('node:zlib').zstdDecompressSync(require('node:fs').readFileSync(process.argv[1])))" <file.jsonl.zst>
node -e "process.stdout.write(require('node:zlib').zstdCompressSync(require('node:fs').readFileSync(0)))" < <plain.jsonl> > <file.jsonl.zst>
```

## What the fixtures show about ccusage

Running ccusage 20.0.48 over `home/` gave these observations. They are why E2 compares the way it does, and they are facts about that version only:

- A session is a rollout file, named by its path under `sessions/` without the extension (`2026/10/12/rollout-…`), or by its file name for `archived_sessions/`.
- `inputTokens` is the **uncached** input and `cacheReadTokens` is the cached part, so the full input is their sum. `totalTokens` is input plus output.
- The `.jsonl.zst` rollout is read, the plain file wins over its `.zst` twin, and the subagent's first events are copies of its parent's, found by comparing them with the parent's events and skipped: its own usage is 1700 (the real ccusage 20.0.48 says the same).

## How the Codex adapter uses them

`test/collectors/codex/` reads these folders (as temporary copies when a test changes them). The numbers it expects are the ones under [Numbers](#numbers), checked against `oracle.json` for `home/`, so they are as invented as the files. Nothing in the adapter tests is a finding about a real Codex.

These adapter rules live in `src/server/collectors/codex/rollout.ts`:

- a fork's or spawned subagent's replayed prefix is told by comparison with the parent's own events up to the fork instant (rule X5 of `docs/implementation/ccusage-rules.md`), with a one-second burst fallback when the parent is not among the files (X6): it does not depend on the timestamps of the copied lines.
- the parent reference is `session_meta.source.subagent.thread_spawn.parent_thread_id`; a spawned subagent that names none, or names a thread that was not imported, is kind `unknown` and has no edge.
- a `token_count` whose `info` is `null` carries no usage and is not counted as unreadable.
- `token_usage_record` lines count as one more event only when a `compacted` line names their response id and no advancing count carried them (X4); `home-rules` holds all three cases.

## What the oracle comparison covers

The rules come from the public ccusage 20.0.48 source. `home-rules` and `oracle-rules.json` cover the documented counting cases using invented rollouts, including counter resets. The comparison establishes agreement on those fixtures.

## Numbers

Root rollout: input 2500, cached 1900, output 400, reasoning 90, total 2900. Subagent: input 1400, cached 1100, output 300, reasoning 70, total 1700. Archived: input 2100, cached 1200, output 350, reasoning 80, total 2450. `session_meta.timestamp` comes 6, 30 and 15 seconds before the first own `token_count` of the root, subagent and archived rollout (the subagent's replayed lines are not its own usage).

`home-reset/` is a rollout in the same style with four own events: 1000, then 1200 more, then a restart whose snapshot is all new (360), then 640 more. Its figures are input 2600, cached 1600, output 600, reasoning 130, total 3200.

Keep every file under 64 KB and this folder under 512 KB.

## `home-rules` and `oracle-rules.json`: the counting rules, checked against the real ccusage

Seven invented rollouts (`home-rules/sessions/2026/10/21/`) that hold, one each, the shapes the oracle's rules turn on
(`docs/implementation/ccusage-rules.md`): a root with a compaction request a `compacted` line names, one nobody names and one a
count already carried (`…c1`); a fork that copies the parent's whole history, compactions included, stamped at the fork instant
(`…c2`); a spawned child that copies only the first three of the parent's five events (`…c3`); two forks whose parent is not among
the files, one opening with a burst written at once and one with two real turns far apart (`…c4`, `…c5`); a rollout holding copies of
the parent's first two events beside its own (`…c6`); and one whose `last_token_usage` is not the change in its totals, with a repeated
total and a reset (`…c7`). Every value is invented; prompts and instructions are `SENTINEL_` text.

`oracle-rules.json` is **the saved answer of the real ccusage 20.0.48** on that folder:

```sh
CODEX_HOME=test/fixtures/codex/home-rules ccusage codex session --json --offline > test/fixtures/codex/oracle-rules.json
```

(sorted and indented; no path in it). `test/collectors/codex/rules.test.ts` imports the folder and compares every category of every
session with it. It proves the importer and ccusage agree on these invented rollouts; it says nothing about a real history.
