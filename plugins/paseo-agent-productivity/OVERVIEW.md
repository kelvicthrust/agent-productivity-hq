# Agent HQ

Open Agent HQ in Paseo to see the illustrated building fill with live coding agents. The owls and foxes show what Codex and Claude Code sessions are doing, including sessions started outside Paseo. The live roster below the drawing shows the same activity in text.

Click **Agent HQ** in Paseo 0.16.1 or later. A fresh installation opens Setup. Use **Overview**, **Trends**, **Delivery**, and **Usage** to explore reports, merged pull requests, and token history. Use **Sources & repos** to manage accounts and choose repositories. HQ runs on the Paseo daemon's Apple Silicon Mac, and clients with daemon management permission can read and manage its HQ data.

In the Paseo sidebar, **Needs your answer** marks workspaces with pending input on clients that support workspace badges. Open the workspace to respond. The badge clears when the input is resolved.

Read and copy saved Work Reviews with your existing dashboard access. Open the card on **HQ** or **Overview**, or use **Delivery → Work Review** to browse saved versions and inspect the linked evidence.

**Open full dashboard**, beside **Refresh**, opens HQ in your browser using your existing Paseo permissions and the host owner's Tailscale identity. Use **Sources & repos → Open owner settings** and the Mac owner's unlock code to reset HQ or change Claude Code settings.

The launcher uses an installed compatible Node runtime. If it cannot find one, **Install runtime** downloads the official ARM64 archive from nodejs.org after you choose that action. The launcher verifies the pinned SHA-256 before installing a private copy.

HQ reads local provider transcripts and Paseo session metadata. It stores recorded usage and session metadata on the daemon host and reads Paseo's account reports separately. If Paseo cannot supply a weekly limit, you can explicitly check the provider using an existing sign-in. Optional GitHub access reads tracked pull requests. In owner settings, **Turn on** and **Turn off** apply changes to the optional Claude Code hooks. **What will change** shows which files and commands are involved. Prompt and tool-result text stay out of stored records and plugin responses.

The screenshots use invented sessions.
