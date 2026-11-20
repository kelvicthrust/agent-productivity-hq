# Reconciling the app with ccusage on your Mac (M5, G5_3)

The milestone's promise is that three sessions per provider add up to **exactly** what `ccusage --json --offline` says, to the
token, on your own history. Nothing in the repository can show that: the fixtures are invented. This tool is how you check it.

It is a developer script, not part of the app. It reads only what the app reads, writes nothing except a temporary database it
deletes, and prints **metadata only**: counts, token numbers and the first eight characters of a session id. It never prints a
prompt, a reply, a path, a project name or a timestamp. Counts and shortened session identifiers
are still private activity metadata; inspect and redact the output before sharing it.

## Before you run it

1. **Run E1 and E2 first** (`docs/implementation/experiments/README.md`): they record what the real files look like. This tool
   assumes the importers' reading of those files is right and measures the totals.
2. Create a private temporary directory in the terminal session used for every example below.
   `mktemp -d` restricts directory access to your user. Keep its reports outside version control
   and remove them when you no longer need them.

   ```sh
   RECONCILE_PRIVATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-productivity-reconcile.XXXXXX")
   ```

3. **ccusage** is only the oracle. This repository does not install it and never will. Have it on
   your `PATH` (`ccusage --version` works), or save its two reports yourself in that private directory:

   ```sh
   ccusage claude session --json --offline > "$RECONCILE_PRIVATE_DIR/claude-ccusage.json"
   ccusage codex session --json --offline > "$RECONCILE_PRIVATE_DIR/codex-ccusage.json"
   ```

   These JSON reports contain project paths. Do not publish them.

## Run it

```sh
node scripts/reconcile-usage.ts --out "$RECONCILE_PRIVATE_DIR/reconcile.txt"
```

or `pnpm reconcile --out "$RECONCILE_PRIVATE_DIR/reconcile.txt"` in the same terminal session. With saved reports instead of ccusage on the path:

```sh
node scripts/reconcile-usage.ts --claude-oracle "$RECONCILE_PRIVATE_DIR/claude-ccusage.json" --codex-oracle "$RECONCILE_PRIVATE_DIR/codex-ccusage.json" --out "$RECONCILE_PRIVATE_DIR/reconcile.txt"
```

It imports your Codex (`CODEX_HOME`, else `~/.codex`) and Claude Code (`CLAUDE_CONFIG_DIR`, else `~/.config/claude` and
`~/.claude`) history into a **temporary** database, so what it compares is what a first import of the files that exist today
would give, not what the running app has stored. It then compares three sessions per provider: the largest, one with subagents
(Claude Code) or a spawned thread (Codex), and the next largest.

## What it prints

For each provider: how many sessions the app and ccusage hold and how many match by id, then one line per compared session with the
difference (app minus ccusage) in every category, and how far the stored **start** is from the first usage. A pass reads:

```text
RESULT: 0-token difference on all 3 compared sessions.
```

| Result                             | Exit | Meaning                                                                                        |
| ---------------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| `0-token difference`               | 0    | G5_3 is shown for that provider on your machine.                                               |
| `DIFFERENCE`                       | 1    | A compared session is off by at least one token. That is a finding, not a failure of the tool. |
| `NOT RUN` / `nothing was compared` | 0    | ccusage was missing, or no session matched. Never counted as a pass: G5_3 is not shown for it. |

## Sharing findings

Real reconciliation reports contain activity counts, token totals and shortened session identifiers.
Keep reports and saved oracles outside Git. Share only the minimum redacted excerpt needed to
investigate a difference; a report containing no conversation text can still reveal private activity.

The [counting rules](ccusage-rules.md) explain the importer and synthetic regression coverage.
Historical private runs are not distributed with this source tree, and their absence makes no
claim about current parity on another installation. A new local run is judged on its own result.

## Why sessions differ: `--diagnose`

If sessions still differ after the importers follow ccusage's rules, the importer alone cannot say why: what decides it is in your files. `--diagnose` reads the same folders again and, in **counts only**, tries each candidate explanation on **every** matched session, not just the three. Its first candidate is the importer itself, computed with the importer's own code:

```sh
node scripts/reconcile-usage.ts --diagnose --out "$RECONCILE_PRIVATE_DIR/diagnose.txt"
```

It prints the usual report and then, per provider:

- how many files it read, how many sessions matched and differ, and a **self-check** that its own re-reading of the importer's rule reproduces the importer's total for every matched session (if that says FAILED, read the rest with care);
- the **candidate rules by how many matched sessions each reproduces exactly**. A rule that reproduces all of them is the cause; none that does is itself a finding;
- for up to eight differing sessions, the facts behind each candidate and the difference to ccusage under each rule (0 means the rule reproduces ccusage for that session);
- up to eight sessions only the app holds, with a reason a counts-only look can give.

The alternatives to the importer are guesses at another way of counting; they are not facts about ccusage 20.0.48.

| Provider    | Candidate                                                           | What it asks                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `as-built`                                                          | the importer today: its parser, its replay filter and its compaction rule, run again over the same files                                                                                                                                                |
| Codex       | replayed parent history (what counts as inherited)                  | `previous-importer` (a snapshot stamped before the thread's own start, on totals), `no-prefix`, `equals-a-parent-snapshot` (leading snapshots equal to one in the parent's rollout), before the last `session_meta`, before the last `ordinal` decrease |
| Codex       | compaction usage (`token_usage_record` with a matching `compacted`) | not added, or added by `usage`, by `turn_token_usage`, or every record added (with the alternatives above)                                                                                                                                              |
| Claude Code | which copy of a message two transcripts both hold counts            | the importer today (main over sidechain, larger total, first path), the importer before it (earliest, main first, path), first path, larger total then first path, main first then first path, earliest then first path, latest, or every copy counts   |

### What a difference can still be

Counted beside the candidates, so a difference that comes from one of these is named rather than guessed:

- **Codex:** per differing session, what the importer made of it (events, compaction events, events skipped as copied from a parent, cache-write tokens inside its input), whether the parent rollout was read here, and the `last_token_usage`, compaction and fork markers of the rollout.
- **Claude Code:** per differing session, advisor entries, entries with no request id, and the **sidechain lines whose message a main-thread line holds under another request id**. ccusage merges those (rule A5 in `docs/implementation/ccusage-rules.md`); the importer does not, so a non-zero count there is the first thing to look at. The other place the two can disagree on which copy survives is a main-thread transcript that holds sidechain-flagged lines: ccusage reads the flag on the line, the importer on the file's place for what is already stored.

It prints only counts, token numbers, booleans, line-type names that are plain words, and the first eight characters of a session id. It never prints (or keeps) a prompt, a reply, a title, a path, a working directory, a branch, a model name or a whole id. A marker's value (such as `history_mode`) appears only when it is one short plain word, else as "present". Review and redact the diagnosis before sharing; counts and shortened identifiers are private metadata. `--selftest` proves the diagnosis on invented homes under `test/fixtures/reconcile-diagnose/`.

## Proving the tool itself

```sh
node scripts/reconcile-usage.ts --selftest
```

runs it on **invented** fixture homes against the fixture oracles: an exact oracle must give 0 on both providers, a one-token-off
oracle must be found in both, ccusage must be asked the way the real one is, and without ccusage both providers must say `NOT RUN`.
This says nothing about your history; it says the tool can tell a match from a one-token difference.
