# Set up Agent Productivity HQ

Start or reuse the dashboard on the Apple Silicon Mac that holds the user's agent history. Run the commands on that Mac under the macOS account whose activity the user wants to see. Complete the shell steps yourself when you have access to that machine and the required permissions.

## 1. Check the host

Use an ARM64 Node.js runtime. The launcher supports Node 22.x starting at 22.16.0, or stable Node 24.0.0 and newer. Check the runtime and confirm `npx` is available.

```sh
node -p '`${process.platform} ${process.arch} ${process.version}`'
command -v npx
```

Expect `darwin arm64` and a compatible version. If your shell is on another machine or the runtime is unavailable, identify the missing prerequisite and give the user the [Terminal command](#terminal-fallback) to run on the target Mac once it is ready.

## 2. Start or reuse the dashboard

The launcher uses the npm registry and npm cache. Starting the app requires write access to its runtime and data directories under `~/Library/Application Support/` by default, plus access to local sockets. Use the user's existing data directory and launch settings when they have configured them.

```sh
npx --yes --fetch-retries=0 @kelvicthrust/agent-productivity-hq --no-open
```

The launcher waits for the dashboard to be ready and prints its URL. If the shell denies network, filesystem, or socket access, use the agent's normal permission flow if available and retry once with the needed access. If the restriction persists, report the error and give the user the [Terminal command](#terminal-fallback).

If the Mac can run the launcher locally but cannot reach npm, follow the [release archive instructions](https://github.com/kelvicthrust/agent-productivity-hq/blob/main/docs/delivery/setup.md#run-a-release-archive-with-npx) and add `--offline` before `--package` when running the verified archive. For port conflicts and other startup errors, follow the [recovery guide](https://github.com/kelvicthrust/agent-productivity-hq/blob/main/docs/delivery/setup.md#when-something-is-wrong).

## 3. Verify and share the URL

On the same Mac, check `/api/health` at the URL printed by the launcher. This example uses the default address.

```sh
curl -fsS --max-time 5 http://127.0.0.1:4317/api/health
```

Expect `"status":"ok"` in the response. Give the user the dashboard URL and direct them to complete **Setup** in the browser on first launch. The user can choose which sources and accounts to connect there. If the shell blocks the health check, tell the user that verification is pending and have them open the printed URL on the Mac.

Keep the standalone listener on loopback. To open HQ from another device, use the [Paseo and Tailscale setup](https://github.com/kelvicthrust/agent-productivity-hq/blob/main/docs/delivery/setup.md#open-agent-hq-from-paseo-desktop) and verify the private URL before sharing it.

## Terminal fallback

Run this in Terminal on the Apple Silicon Mac that holds the agent history. The launcher prints the URL and opens it in the default browser.

```sh
npx --yes @kelvicthrust/agent-productivity-hq
```
