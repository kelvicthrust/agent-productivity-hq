// The script of a stand-in `codex app-server`: which answer each method gets. Two things read it, so a scenario file means the same
// to both: fake-codex.ts (a real child process over stdin and stdout, for the E4 self-test and the live launcher test) and the
// in-process scripted app-server in test/collectors/chatgpt/scripted.ts (which starts nothing). No network, no files: pure.

export interface Notification {
  method: string;
  params?: unknown;
}

/** What a method answers.
 *   `silent`     never answered (the per-call timeout case)
 *   `exit`       the child ends without answering (a crash)
 *   `result`     answered, then each `then` notification is sent (the sign-in's `account/login/completed`)
 *   `error`      answered with a JSON-RPC error
 *   `sequence`   the n-th call of this method gets the n-th entry; the last one answers every call after it (pages of thread/list)
 */
export type Entry =
  | 'silent'
  | 'exit'
  | { result: unknown; then?: Notification[] }
  | { error: { code: number; message: string } }
  | { sequence: Entry[] };

export interface Scenario {
  /** Text sent in a notification before every answer, to prove the client skips what is not its answer. */
  noise?: string;
  methods: Record<string, Entry>;
}

export interface Step {
  /** The lines to write to standard output, in order. */
  lines: string[];
  /** True when the child ends now. */
  exit: boolean;
}

export interface ScenarioServer {
  /** One line of the client's standard input. A notification (no `id`) gets no answer; a request gets its scripted one. */
  handle(line: string): Step;
}

export function createScenarioServer(scenario: Scenario): ScenarioServer {
  const calls = new Map<string, number>();
  const send = (message: unknown): string => JSON.stringify(message);

  function entryFor(method: string): Entry | undefined {
    const entry = scenario.methods[method];
    if (entry === undefined || typeof entry === 'string' || !('sequence' in entry)) return entry;
    const n = calls.get(method) ?? 0;
    calls.set(method, n + 1);
    return entry.sequence[Math.min(n, entry.sequence.length - 1)];
  }

  return {
    handle(line) {
      let message: { id?: number; method?: string };
      try {
        message = JSON.parse(line) as { id?: number; method?: string };
      } catch {
        return { lines: [], exit: false };
      }
      // A notification such as `initialized`.
      if (message.id === undefined || typeof message.method !== 'string')
        return { lines: [], exit: false };

      const lines: string[] = [];
      if (scenario.noise) {
        lines.push(send({ method: 'app-server/notice', params: { text: scenario.noise } }));
      }
      const entry = entryFor(message.method);
      if (entry === 'silent') return { lines, exit: false };
      if (entry === 'exit') return { lines, exit: true };
      if (entry === undefined) {
        lines.push(send({ id: message.id, error: { code: -32601, message: 'Method not found' } }));
      } else if ('error' in entry) {
        lines.push(send({ id: message.id, error: entry.error }));
      } else if ('result' in entry) {
        lines.push(send({ id: message.id, result: entry.result }));
        for (const notification of entry.then ?? []) lines.push(send(notification));
      }
      return { lines, exit: false };
    },
  };
}
