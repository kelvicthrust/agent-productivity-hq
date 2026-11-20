# Claude capture fixtures

**Synthetic.** Every value here is invented. The shapes come from `docs/tech/data-and-sources.md` › Status-line snapshot and from
Claude Code's [status line](https://code.claude.com/docs/en/statusline) and [settings](https://code.claude.com/docs/en/settings) documentation: a settings file is strict JSON whose
`statusLine` is `{ type: "command", command, padding? , … }`, and a status-line command receives session JSON on stdin with
`version` and `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at` in epoch seconds). Nothing here is read from a
real Claude Code folder, and nothing in it is a credential.

`SENTINEL_*` strings stand where real text, paths, model names or keys would be. The tests copy these files into a throwaway
`CLAUDE_CONFIG_DIR` whose path contains a space, and prove that no sentinel from a hook's input ever reaches the snapshot.

Reset times are far in the future (`4102441200` and `4102444800`, January 2100) or far in the past (`1000000000`, 2001), so no
fixture depends on today's date. The few tests that need the clock pass the hook an explicit time instead.

## `settings/` (a user-level Claude Code settings file)

| File                            | What it is                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `other-keys.json`               | No `statusLine`; credential-looking keys that must never be copied, moved or read into a record                    |
| `command-with-padding.json`     | A command status line with `padding` and `hideVimModeIndicator`, between two other keys; prints ANSI and two lines |
| `command-plain.json`            | The smallest command status line                                                                                   |
| `command-trailing-comment.json` | A command ending in a `# comment`, which would swallow a `; fi` written on the same line                           |
| `non-command.json`              | A `statusLine` that is not `type: "command"`: refused as unsupported                                               |
| `not-an-object.json`            | Valid JSON that is an array: refused as unreadable                                                                 |
| `invalid-comments.txt`          | A `//` comment: not strict JSON, refused as unreadable (`.txt` so Prettier leaves it alone)                        |
| `invalid-trailing-comma.txt`    | A trailing comma: the same                                                                                         |

## `project/` (a project's `.claude/settings.json`)

`with-status-line.json` defines its own `statusLine`; `without-status-line.json` does not. They exist to count project overrides
(presence of the key only; the value is never kept).

## `stdin/` (what Claude Code writes to the status-line command)

`full.json` (both windows, version, and sentinels in every field the hook must not save), `five-hour-only.json`,
`seven-day-only.json`, `no-rate-limits.json` (the API-key and Console sign-in case), `reset-windows.json` (both windows already
past), `invalid-windows.json` (a string percentage, a negative one and a version that is not a version), `over-100.json`,
`malformed.txt` (cut off mid-value), `not-an-object.json`.
