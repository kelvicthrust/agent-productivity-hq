import { isRecord } from './parse.ts';
import type { AppServerProcess, LaunchAppServer } from './ports.ts';

// JSON-RPC over the app-server's standard input and output, one JSON object per line (R6: no `jsonrpc` header). A session is one
// child: `initialize`, then the `initialized` notification, then the reads, then the caller closes it, which kills the child.
//
// What this file promises (TECH › Failure modes: "app-server hangs or errors"):
//   - every call waits at most CALL_TIMEOUT_MS for its own answer, however much else the child says meanwhile;
//   - a call that is not answered, or whose child ends, is a reply of its own kind, never a throw;
//   - nothing the child says is logged or kept: this file has no logger, an error reply keeps its numeric code and one yes/no
//     (did it sound like a sign-in problem) and drops its sentence, and notifications are looked at and dropped.

/** TECH › Failure modes: the app-server gets 10 seconds per call, then the child is killed. */
export const CALL_TIMEOUT_MS = 10_000;
/** How many lines that are not the answer are skipped while waiting for it, so a chatty child cannot hold a call open. */
const MAX_SKIPPED_LINES = 500;
const METHOD_NOT_FOUND = -32601;

export type Reply =
  | { kind: 'result'; result: unknown }
  /** A JSON-RPC error. `auth` is true when its sentence sounded like a sign-in problem; the sentence itself is dropped. */
  | { kind: 'error'; code: number | null; auth: boolean }
  | { kind: 'timeout' }
  | { kind: 'closed' };

export type Waited =
  | { kind: 'notification'; params: Record<string, unknown> }
  | { kind: 'timeout' }
  | { kind: 'closed' };

export interface RpcSession {
  /** One request and its answer. Notifications and other requests that arrive first are skipped. */
  call(method: string, params: unknown): Promise<Reply>;
  /** Waits for a notification of this method whose params `accept`, up to `timeoutMs`. Used for the browser sign-in's end. */
  waitForNotification(
    method: string,
    accept: (params: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Waited>;
  /** Kills the child. Safe to call more than once. */
  close(): void;
}

/** Whether an error's sentence sounds like a sign-in problem. Looked at in memory only; the sentence is never stored or logged. */
const AUTH_SOUNDING =
  /unauthori[sz]ed|\b401\b|not (?:logged|signed) in|log ?in again|sign ?in again|(?:access|refresh|auth)[ _-]?token|re-?authenticat/i;

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A session over a running child. Exported for the scripted tests; callers use `openSession`. */
export function createSession(
  child: AppServerProcess,
  callTimeoutMs = CALL_TIMEOUT_MS,
): RpcSession {
  let nextId = 1;
  let closed = false;

  /** A request from the child (it asked the client something): answered "method not found" so it never waits on us. */
  const decline = (id: unknown): void => {
    if (!closed)
      child.send(
        JSON.stringify({ id, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } }),
      );
  };

  return {
    async call(method, params) {
      const id = nextId++;
      child.send(JSON.stringify({ id, method, params }));
      const deadline = performance.now() + callTimeoutMs;
      for (let skipped = 0; skipped <= MAX_SKIPPED_LINES; skipped++) {
        const left = Math.ceil(deadline - performance.now());
        if (left <= 0) return { kind: 'timeout' };
        const next = await child.nextLine(left);
        if (next.kind !== 'line') return next;
        const message = parseLine(next.line);
        if (message === null) continue;
        if (typeof message['method'] === 'string') {
          if (message['id'] !== undefined && message['id'] !== null) decline(message['id']);
          continue;
        }
        if (message['id'] !== id) continue;
        const error = message['error'];
        if (error !== undefined && error !== null) {
          const code = isRecord(error) && typeof error['code'] === 'number' ? error['code'] : null;
          const text =
            isRecord(error) && typeof error['message'] === 'string' ? error['message'] : '';
          return { kind: 'error', code, auth: AUTH_SOUNDING.test(text) };
        }
        return { kind: 'result', result: message['result'] };
      }
      return { kind: 'timeout' };
    },

    async waitForNotification(method, accept, timeoutMs) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const left = Math.ceil(deadline - performance.now());
        if (left <= 0) return { kind: 'timeout' };
        const next = await child.nextLine(left);
        if (next.kind !== 'line') return next;
        const message = parseLine(next.line);
        if (message === null || typeof message['method'] !== 'string') continue;
        if (message['id'] !== undefined && message['id'] !== null) {
          decline(message['id']);
          continue;
        }
        const params = message['params'];
        if (message['method'] === method && isRecord(params) && accept(params)) {
          return { kind: 'notification', params };
        }
      }
    },

    close() {
      if (closed) return;
      closed = true;
      child.kill();
    },
  };
}

export type Failure = 'timeout' | 'closed' | 'error' | 'auth';

export type Opened =
  | { kind: 'ready'; session: RpcSession }
  /** There is no `codex` to start on this machine. */
  | { kind: 'absent' }
  /** The child started but did not complete `initialize` (or could not be started: `code` is then the system's error code). */
  | { kind: 'failed'; why: Failure; code?: string };

export interface SessionOptions {
  /** The version the client names itself with in `initialize` (the dashboard's, for the app-server's own logs). */
  clientVersion?: string;
  callTimeoutMs?: number;
}

/** What a failed reply is, as one word: the callers choose the sentence. */
export function failureOf(reply: Reply): Failure | null {
  switch (reply.kind) {
    case 'result':
      return null;
    case 'error':
      return reply.auth ? 'auth' : 'error';
    case 'timeout':
      return 'timeout';
    case 'closed':
      return 'closed';
  }
}

/**
 * Starts the app-server and completes `initialize`, then `initialized`. On any failure the child is killed before this returns, so
 * a caller that gets anything but `ready` has nothing to clean up. The caller that gets `ready` must `close()` the session.
 */
export async function openSession(
  launch: LaunchAppServer,
  options: SessionOptions = {},
): Promise<Opened> {
  let child: AppServerProcess | null;
  try {
    child = await launch();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { kind: 'failed', why: 'error', ...(typeof code === 'string' ? { code } : {}) };
  }
  if (child === null) return { kind: 'absent' };

  const session = createSession(child, options.callTimeoutMs);
  const hello = await session.call('initialize', {
    clientInfo: {
      name: 'agent-productivity',
      title: 'Agent Productivity HQ',
      version: options.clientVersion ?? '0.0.0',
    },
  });
  const failure = failureOf(hello);
  if (failure !== null) {
    session.close();
    return { kind: 'failed', why: failure };
  }
  child.send(JSON.stringify({ method: 'initialized', params: {} }));
  return { kind: 'ready', session };
}
