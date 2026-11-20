# Live transcript fixtures (DRAFT-documented-shape)

Hand-built reconstructions of the Claude Code transcript and Codex rollout shapes that HQ's transcript feeds read, with **invented** values. No line here came from a real session. The shapes (which record types exist, which fields mark a prompt, a tool call, a tool result and the end of a turn) were observed on a real machine by E9 and are described in [data-and-sources › Live roster (HQ)](../../../docs/tech/data-and-sources.md#live-roster-hq); every free-text, input and output field holds a `SENTINEL_<WORD>` string, so tests can prove no text reaches a feed's output, the roster or a log. There is no token-shaped value.

The lines are made by `test/collectors/live/lines.ts`; these files are what it produced for a fixed clock (2026-11-19T10:00:00Z).

| File                                                       | What it holds                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude/projects/<project>/1111….jsonl`                    | A main session: a prompt, thinking, `Read` and `Agent` and `Edit` calls with their results, the closing text with `end_turn`, and `turn_duration` |
| `claude/projects/<project>/1111…/subagents/agent-a1.jsonl` | Its subagent: a sidechain prompt, a `Bash` call and result, and a closing text                                                                    |
| `claude/projects/<project>/2222….jsonl`                    | A session whose last line is a `Write` call with no result                                                                                        |
| `codex/sessions/2026/11/19/rollout-…aaaa….jsonl`           | A rollout: `session_meta`, a turn start, reasoning, an `exec` call and output, a `spawn_agent` call, a message and `task_complete`                |
| `codex/sessions/2026/11/19/rollout-…bbbb….jsonl`           | A spawned thread (`source.subagent.thread_spawn.parent_thread_id` names the first), ending on a `request_user_input` call with no output          |
| `codex/archived_sessions/rollout-…cccc….jsonl`             | An archived rollout (not followed by the live feed)                                                                                               |
| `codex-thin/sessions/2026/11/19/rollout-…dddd….jsonl`      | A rollout with no tool call, so E9's Codex marker criterion fails on it                                                                           |
