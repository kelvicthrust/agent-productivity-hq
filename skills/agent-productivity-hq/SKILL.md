---
name: agent-productivity-hq
description: Open the Agent Productivity HQ dashboard to view agent usage and merged pull requests, or stop the local dashboard when explicitly requested.
---

# Agent Productivity HQ

Run the dashboard on the Mac whose agent usage the user wants to see.

- If [the private release candidate instructions](private-rc.md) are installed beside this skill, use the exact command from that file. Keep using the local archive if the command fails, and report the error.
- For a published installation on Apple Silicon macOS with Node 22.x (22.16.0+) or any stable 24.0.0+, run `npx --yes @kelvicthrust/agent-productivity-hq`.
- Append `stop` only when the user requests that the dashboard stop.

The launcher waits until the dashboard is ready, prints its URL, and tries to open it in the default browser. Give the user the printed URL. Use the dashboard's Setup screen for GitHub and account connections.
