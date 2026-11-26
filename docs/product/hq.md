# HQ

Open **HQ** from the dashboard navigation after finishing Setup. It shows agents on the computer running Agent Productivity HQ. If you open the dashboard from another device through Paseo, you see the daemon Mac’s sessions.

## Find the session that needs you

Each room represents a session. A solo agent gets its own room; when HQ can identify a parent and its helpers, it groups them together. The **Sessions** roster below the illustration gives the same activity in text and puts sessions with a waiting agent first.

HQ uses the Paseo workspace title for the main agent when available. Subagents show their recorded names, with a short ID beside generic names so you can tell them apart. An idle Claude Code parent can stay in the room while its subagents are active. Expand **Recent idle** to see sessions with no current work or follow-up.

| What you see | What to do |
| --- | --- |
| **Editing**, **Reading**, or **Running a command** | The agent is working. Check the roster to see which helper is doing the work. |
| **Needs you** | The source reported a wait. When available, HQ names the reason, such as permission, a question, or plan approval. Return to that agent’s original session to respond. |
| **May be waiting for you** | HQ inferred a possible wait from recent activity. Check the session before assuming it needs an answer. |
| **Ready to review** | A turn finished and Paseo reports that it is still unread. Open it in Paseo to review the result. |
| **Background work running** | The turn has ended and Paseo still reports work running in the background. |
| **Background subagents · last reported …** | Claude Code listed background jobs when it finished its turn. The roster also shows reported shell jobs and monitors. |
| **Idle for…** | The elapsed time tells you how long the agent has been idle. |
| **Something went wrong** | Open the original session for the error details. |

## Spot pending input in the Paseo sidebar

On Paseo clients that support workspace badges, **Needs your answer** appears under the workspace name when Paseo reports pending input. It can appear while the agent is still working. Open the workspace in Paseo to answer the question or handle the approval. The badge clears when the workspace no longer needs input. Look for **Needs your answer** under **Show** in the sidebar if you’ve hidden it.

## Where the status comes from

HQ uses recent local Claude Code and Codex session activity and, when available, the local Paseo daemon. While HQ is visible, the roster normally refreshes every two seconds. It is held in memory. For historical token totals or merged PRs, use **Overview**, **Usage**, or **Delivery**.

For Claude Code sessions running outside Paseo, you can opt into more precise wait reporting. In **Sources & repos**, open **Know when Claude Code needs you** and press **Turn on**. Use **What will change** if you want to inspect the settings files and hook command first. You can also choose **Not now** on HQ’s first-visit prompt and use the roster immediately. The [setup guide](../delivery/setup.md#let-claude-code-tell-hq-when-it-needs-you-optional) explains the hook events, settings changes, repair, and removal.

Once those hooks are on, choose **Report Claude Code background work** in the same settings card. In Paseo, open the owner settings from that card. Each Claude Code report keeps the session in the main roster for up to 15 minutes. An otherwise idle session then moves to **Recent idle**, where the last report stays visible for up to 24 hours. A later report can clear the job count sooner. To see what Claude Code is tracking between reports, open `/tasks` in the original Claude Code session.

## When the room is empty

If HQ says **A quiet one**, its available feeds have no running agents to show. If a feed reports an access or connection problem, follow its status message first: a session from that source may be missing. If HQ says it **couldn’t refresh**, the visible roster is its last successful reading. Use **Retry** to check again.
