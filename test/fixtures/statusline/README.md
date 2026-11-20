# Status-line fixtures (E8)

**DRAFT-documented-shape.** The shapes follow the [status-line snapshot contract](../../../docs/tech/data-and-sources.md#status-line-snapshot-design-owner-choice-p3--a) and [Claude Code's status line documentation](https://code.claude.com/docs/en/statusline). The command input includes `session_id`, `cwd`, `workspace`, `version` and `rate_limits.five_hour` / `seven_day` with `used_percentage` and `resets_at`.

Every fixture value is invented. Nothing here is a real session, folder, prompt or credential. `SENTINEL_*` strings stand where real text, paths and settings would be, so `test/experiments/sentinel.test.ts` can prove the script never prints or records them.

`samples.jsonl` is what the probe's hook writes, not what Claude Code sends: one `start` line per run (field names, numbers, hashed session and folder ids, the version, `up_ms` from process start) and an `end` line when the run finished. A `start` with no `end` is a run Claude Code cancelled. The hook never writes text, so the one `note` field in `ok`, `bad` and `concurrent-gap` is deliberate: it is text the report must not print.

- `ok/`: shape from TECH › Feasibility experiments (E8 items 1, 4, 5, 6, 10). Eleven runs: both windows, a version, one cancelled run, two sessions whose runs interleave (one arrival carries a lower `five_hour` figure than an earlier one, from the other session), a project-level run in its own folder, p95 well under 100 ms.
- `bad/`: shape from TECH › E8 "If it fails" (`no_limits`; project override leaks; overhead over budget). No `rate_limits`, no version, a project folder that also ran the user-level hook, slow runs, no cancellation, and a settings file with no `statusLine`.
- `concurrent-gap/`: shape from TECH › E8 item 5. Two sessions whose runs interleave (A, B, A, B, A), where session B is never sent `rate_limits`. Used for the concurrent-sessions failure and for footer-hint lists with nothing usable in them.
- `empty/`: shape from TECH › E8 (prepared, not yet used). A wired settings file and no `samples.jsonl`.
- `seed/settings.json`: shape from R5 (Claude Code settings: `statusLine` is `{ type: "command", command, padding }`; `model`, `effortLevel` and `theme` are user-level preferences). A settings file with three plain preferences and five entries that must never be copied (permissions, env keys, `apiKeyHelper`, `awsAuthRefresh`, hooks, all carrying sentinels), used by `--prepare --seed-settings`.
- `seed/credentials-only.json`: same shape source. Only credential-bearing entries, two of them plain words that would pass the value rule if their names were allowed, and an object under an allowed name; nothing may be copied from it.
- `seed/not-json.txt`: shape from TECH › Apply step 2 (invalid JSON is refused). A seed that is not valid JSON.
