# HQ

Open **HQ** from the dashboard navigation after finishing Setup. It shows agents on the computer running Agent Productivity HQ. If you open the dashboard from another device through Paseo, you see the daemon Mac’s sessions.

## Find the session that needs you

Each room represents a session. A solo agent gets its own room; when HQ can identify a parent and its helpers, it groups them together. The **Sessions** roster below the illustration gives the same activity in text and puts sessions with a waiting agent first.

| What you see | What to do |
| --- | --- |
| **Editing**, **Reading**, or **Running a command** | The agent is working. Check the roster to see which helper is doing the work. |
| **Needs you** | The source reported a wait. When available, HQ names the reason, such as permission, a question, or plan approval. Return to that agent’s original session to respond. |
| **May be waiting for you** | HQ inferred a possible wait from recent activity. Check the session before assuming it needs an answer. |
| **Idle for…** | The elapsed time tells you how long the agent has been idle. |
| **Something went wrong** | Open the original session for the error details. |

## Where the status comes from

HQ uses recent local Claude Code and Codex session activity and, when available, the local Paseo daemon. While HQ is visible, the roster normally refreshes every two seconds. It is held in memory. For historical token totals or merged PRs, use **Overview**, **Usage**, or **Delivery**.

For Claude Code sessions running outside Paseo, you can opt into more precise wait reporting. In **Sources & repos**, open **Know when Claude Code needs you**, review **What will change**, and confirm **Turn on**. You can also choose **Not now** on HQ’s first-visit prompt and use the roster immediately. The [setup guide](../delivery/setup.md#let-claude-code-tell-hq-when-it-needs-you-optional) explains the hook events, settings changes, repair, and removal.

## When the room is empty

If HQ says **A quiet one**, its available feeds have no running agents to show. If a feed reports an access or connection problem, follow its status message first: a session from that source may be missing. If HQ says it **couldn’t refresh**, the visible roster is its last successful reading. Use **Retry** to check again.
