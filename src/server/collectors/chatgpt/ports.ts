// The one seam of the ChatGPT integration (data-and-sources › ChatGPT account report, M9). Everything that reaches the Codex
// app-server does so through a `LaunchAppServer`, handed in by whoever builds the app:
//   `pnpm start`   live.ts: `codex app-server` started with an argument array and no shell
//   every test     a scripted app-server (test/collectors/chatgpt/scripted.ts), which starts nothing
// Only live.ts starts a program. The rest of this folder, collectors/codex/names.ts and services/accounts.ts take this port.

/** What waiting for one line of the child's standard output ended with. */
export type NextLine =
  | { kind: 'line'; line: string }
  /** `timeoutMs` passed and nothing arrived. The child may still be running. */
  | { kind: 'timeout' }
  /** The child has ended and everything it wrote has been read. */
  | { kind: 'closed' };

/** One running `codex app-server` child, as the client sees it: JSON-RPC lines in, JSON-RPC lines out. */
export interface AppServerProcess {
  /** Writes one line to the child's standard input (the newline is added here). Writes after the child ended are dropped. */
  send(line: string): void;
  /** The next line of standard output, in order, waiting at most `timeoutMs`. */
  nextLine(timeoutMs: number): Promise<NextLine>;
  /** Stops the child and closes its pipes. Safe to call more than once. */
  kill(): void;
}

/**
 * Starts `codex app-server`. Resolves null when there is no `codex` to start (not installed, not on PATH): that is a state of
 * the machine, not an error. Rejects for anything else that stops the child starting (permissions, a broken install).
 */
export type LaunchAppServer = () => Promise<AppServerProcess | null>;
