// How a failed Paseo connection or request is classified. Shared by the 15-minute batch collector (index.ts) and the live feed
// (live.ts) so the two read the same failure the same way. Pure functions of an error; an SDK error's own message is read to
// classify it and is never kept, because the SDK writes agent ids into some of them.

/** A daemon that cannot be used, as a source state: not running, asking for a password, or failed with a machine code. */
export type ConnectionFailure =
  { kind: 'notrunning' } | { kind: 'needspassword' } | { kind: 'failed'; code: string };

/** An SDK error's own `code`, when it is a plain machine code (`ECONNREFUSED`, `DAEMON_REQUEST_TIMEOUT`); never its message. */
export function codeOf(error: unknown): string | null {
  for (const carrier of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (carrier as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(code)) return code;
  }
  return null;
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : '');

/** The SDK's `DaemonAuthenticationError` ("Password required" / "Incorrect password"); E3 recognises it the same way. */
export function isPasswordError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'DaemonAuthenticationError') ||
    /password/i.test(messageOf(error))
  );
}

export const isTimeout = (error: unknown): boolean => /timed out/i.test(messageOf(error));

/**
 * What a failed connect means. With the SDK's WebSocket a refused connection does not arrive as ECONNREFUSED: it arrives as
 * `Transport closed (code 1006)` (or `Transport error`), the same words as any socket that closes before the handshake. Those are
 * read as "nothing is listening", which is what E3 does and what a daemon that is not running looks like. A timeout is a daemon
 * that is there and not answering, so it is a failure, not "not running".
 */
export function connectFailure(error: unknown): ConnectionFailure {
  if (isPasswordError(error)) return { kind: 'needspassword' };
  const code = codeOf(error);
  if (code === 'ECONNREFUSED') return { kind: 'notrunning' };
  if (code !== null) return { kind: 'failed', code: code.toLowerCase() };
  if (isTimeout(error)) return { kind: 'failed', code: 'connect_timeout' };
  if (/^Transport (closed|error)|before connect/i.test(messageOf(error)))
    return { kind: 'notrunning' };
  return { kind: 'failed', code: 'connect_failed' };
}

/** What a failed `agents.list` means: the daemon was there, so this is a failure with a code (or the password asked late). */
export function listFailure(error: unknown): ConnectionFailure {
  if (isPasswordError(error)) return { kind: 'needspassword' };
  const code = codeOf(error);
  if (code !== null) return { kind: 'failed', code: code.toLowerCase() };
  return { kind: 'failed', code: isTimeout(error) ? 'request_timeout' : 'list_failed' };
}

/** A listing that failed because the connection or the daemon went quiet, as opposed to a daemon that refused the request. */
export const isConnectionTrouble = (error: unknown): boolean =>
  isPasswordError(error) ||
  isTimeout(error) ||
  /connection|transport|closed|timeout/i.test(`${codeOf(error) ?? ''} ${messageOf(error)}`);
