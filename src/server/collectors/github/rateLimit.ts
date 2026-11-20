// What GitHub's "try later" answers look like and when they say to try again (TECH › GitHub delivery › Failure modes).
// One copy, read by the request session (client.ts) and by the sign-in check (auth.ts): both must tell a limit from a refusal
// the same way, and both must keep the time GitHub gave so a screen can say "waiting until <time>" instead of "couldn't be reached".

/** GitHub asks a client that hit a secondary limit without saying when to wait at least a minute. */
export const DEFAULT_BACKOFF_MS = 60_000;

/**
 * Whether a 403 is a rate limit (primary or secondary) rather than a refusal. `retry-after` or an empty quota says so; `text`
 * is the body of the answer when the caller has read it ("rate limit" or "abuse" in GitHub's own sentence).
 */
export function isRateLimited(headers: Headers, text = ''): boolean {
  return (
    headers.get('retry-after') !== null ||
    headers.get('x-ratelimit-remaining') === '0' ||
    /rate limit|abuse/i.test(text)
  );
}

/** When a limited answer says to try again, in epoch ms: `retry-after` (seconds or a date), else the quota's reset time. */
export function waitUntil(headers: Headers, nowMs: number): number {
  const retry = headers.get('retry-after');
  if (retry !== null) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
    const date = Date.parse(retry);
    if (Number.isFinite(date)) return date;
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) {
    return reset * 1000;
  }
  return nowMs + DEFAULT_BACKOFF_MS;
}
