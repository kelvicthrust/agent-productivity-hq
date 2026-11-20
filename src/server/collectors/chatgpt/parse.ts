import type { DailyBucket, RateLimitInput } from '../../db/queries/accounts.ts';

// What the Codex app-server's answers become. Synthetic fixtures exercise the supported field shapes.
// Pure functions over JSON that came out of the child: no I/O, no logging, and nothing is kept that the dashboard
// does not store. In particular these never read a message, an e-mail address, an account id or a plan: `account/read` is reduced
// to the KIND of sign-in, `account/usage/read` to a lifetime figure and daily buckets, `account/rateLimits/read` to percent windows.
//
// A provider's answer is never trusted to be well formed (the db writers throw on a malformed value, which is a program error), so a
// malformed item is dropped and counted here instead, and the caller reports the count.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- account/read ----------------------------------------------------------------------------------------------------------

/**
 * The kind of sign-in Codex has. `chatgpt` is the only one with an account usage report (R6); an API key, Bedrock or anything else
 * has none (`unsupported`), and no account at all is `signed_out`.
 */
export type AccountKind = 'chatgpt' | 'signed_out' | 'unsupported';

/** From `account/read`'s result. Anything that is not an object is no usable answer (null), not "signed out". */
export function parseAccount(result: unknown): AccountKind | null {
  if (!isRecord(result)) return null;
  const account = result['account'];
  if (account === null || account === undefined) return 'signed_out';
  if (!isRecord(account)) return null;
  return account['type'] === 'chatgpt' ? 'chatgpt' : 'unsupported';
}

// ---- account/usage/read ----------------------------------------------------------------------------------------------------

export interface UsageReport {
  /** `summary.lifetimeTokens`, or null when the report has none. Shown with its own label, never as a period total. */
  lifetimeTokens: number | null;
  /** The daily buckets, or null when the account reports none at all (the percent-only card, P-34). */
  buckets: DailyBucket[] | null;
  /** Buckets or figures dropped because they were not in a shape this dashboard reads. */
  unreadable: number;
}

const wholeTokens = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * A bucket's `startDate` as a calendar date. The documented shape is a `YYYY-MM-DD` string; an epoch in seconds or milliseconds is
 * also taken (a mirrored README shows Unix seconds for thread times), read as UTC. Anything else is not a date.
 */
function bucketDate(value: unknown): string | null {
  if (typeof value === 'string') {
    const day = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    return day !== undefined && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? day : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const at = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * From `account/usage/read`'s result. Streaks and the peak day are read by nobody here: the design has no streaks, and they are
 * neither stored nor shown. A date that appears twice keeps its last figure, so one day is never counted twice.
 */
export function parseUsage(result: unknown): UsageReport | null {
  if (!isRecord(result)) return null;
  let unreadable = 0;

  const summary = result['summary'];
  let lifetimeTokens: number | null = null;
  if (
    isRecord(summary) &&
    summary['lifetimeTokens'] !== null &&
    summary['lifetimeTokens'] !== undefined
  ) {
    lifetimeTokens = wholeTokens(summary['lifetimeTokens']);
    if (lifetimeTokens === null) unreadable += 1;
  }

  const raw = result['dailyUsageBuckets'];
  if (raw === null || raw === undefined) return { lifetimeTokens, buckets: null, unreadable };
  if (!Array.isArray(raw)) return null;
  const byDate = new Map<string, number>();
  for (const item of raw) {
    const date = isRecord(item) ? bucketDate(item['startDate']) : null;
    const tokens = isRecord(item) ? wholeTokens(item['tokens']) : null;
    if (date === null || tokens === null) unreadable += 1;
    else byDate.set(date, tokens);
  }
  if (raw.length > 0 && byDate.size === 0) return null;
  const buckets = [...byDate].map(([date, tokens]) => ({ date, tokens }));
  return { lifetimeTokens, buckets, unreadable };
}

// ---- account/rateLimits/read -----------------------------------------------------------------------------------------------

export interface RateLimitReport {
  limits: RateLimitInput[];
  quota: 'codex' | null;
  unreadable: number;
}

const LIMIT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** `resetsAt` as epoch milliseconds. The documented figure is Unix seconds; one that is already in milliseconds is kept as it is. */
function resetTime(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value < 1e11 ? value * 1000 : value);
}

/**
 * The keyed view identifies the general Codex quota. The older single-bucket field can fall back to a model-specific quota,
 * so it identifies the general quota only with an explicit Codex meter ID. ID-less windows still describe Sources coverage.
 */
export function parseRateLimits(result: unknown): RateLimitReport | null {
  if (!isRecord(result)) return null;
  const byId = result['rateLimitsByLimitId'];
  if (byId != null && !isRecord(byId)) return null;
  const snapshot = byId == null ? result['rateLimits'] : byId['codex'];
  if (snapshot === null || snapshot === undefined)
    return { limits: [], quota: null, unreadable: 0 };
  if (!isRecord(snapshot)) return null;
  const meterId = snapshot['limitId'];
  if (meterId != null && meterId !== 'codex') {
    return { limits: [], quota: null, unreadable: 0 };
  }
  const quota = byId != null || meterId === 'codex' ? 'codex' : null;
  const limits: RateLimitInput[] = [];
  let unreadable = 0;
  let weeklyUnreadable = false;
  for (const [limitId, window] of Object.entries(snapshot)) {
    if (window === null) continue;
    // Primary and secondary are known windows. Other entries must carry a percentage to count as windows.
    const record = isRecord(window) ? window : null;
    if (
      limitId !== 'primary' &&
      limitId !== 'secondary' &&
      (record === null || !('usedPercent' in record))
    ) {
      continue;
    }
    const used = record?.['usedPercent'];
    const minutes = record?.['windowDurationMins'];
    const windowMinutes =
      typeof minutes === 'number' && Number.isSafeInteger(minutes) && minutes > 0 ? minutes : null;
    if (
      typeof used !== 'number' ||
      !Number.isFinite(used) ||
      used < 0 ||
      !LIMIT_ID.test(limitId) ||
      (quota === 'codex' && minutes != null && windowMinutes === null)
    ) {
      unreadable += 1;
      weeklyUnreadable ||= windowMinutes === null || windowMinutes === 10_080;
      continue;
    }
    limits.push({
      limitId,
      usedPercent: used,
      windowMinutes,
      resetsAt: resetTime(record?.['resetsAt']),
    });
  }
  if (limits.length === 0 && unreadable > 0) return null;
  // A malformed candidate leaves the weekly quota unknown even when a shorter window was readable.
  if (
    quota === 'codex' &&
    weeklyUnreadable &&
    !limits.some((limit) => limit.windowMinutes === 10_080)
  ) {
    return null;
  }
  return { limits, quota, unreadable };
}

// ---- account/login/start ---------------------------------------------------------------------------------------------------

export interface LoginOffer {
  loginId: string;
  /** The ChatGPT sign-in address the browser opens. Always an https address. */
  authUrl: string;
}

/**
 * From `account/login/start`'s result for the browser flow. The address is handed to the owner's browser, so only an `https:` URL
 * is accepted: anything else (a script or file address, a malformed one) is no sign-in.
 */
export function parseLoginOffer(result: unknown): LoginOffer | null {
  if (!isRecord(result)) return null;
  const { loginId, authUrl } = result;
  if (typeof loginId !== 'string' || loginId === '' || loginId.length > 200) return null;
  if (typeof authUrl !== 'string') return null;
  try {
    const url = new URL(authUrl);
    if (url.protocol !== 'https:' || url.hostname === '') return null;
  } catch {
    return null;
  }
  return { loginId, authUrl };
}
