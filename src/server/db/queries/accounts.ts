import { z } from 'zod';
import { ClaudePlanLimitsState } from '../../../shared/contracts/sources.ts';
import { inTransaction, type Db } from '../open.ts';
import { getMeta, setMeta } from './meta.ts';

// Account-reported usage and Codex thread names, the SQL half (data-and-sources › ChatGPT account report, › Claude account report).
// The collectors (collectors/chatgpt, collectors/claudeAccount) read the provider's own report and call the writers below; the
// services build the Overview and Sources answers from the readers. Nothing here knows the app-server or the status-line file.
//
// What an account figure may and may not do, enforced by what these functions can reach:
//   - it lives in its own tables (`account_snapshot`, `account_daily_tokens`) and is never written to `usage_event`, `session`
//     totals, a repo row or a link, so it can never be added to local usage or drawn into a trend (P-35 to P-38);
//   - the local Codex tokens over the same dates are READ beside it (`localTokensBetween`) and never combined with it (P-36);
//   - a percent window keeps its own unit, window length and reset time; a percentage is never turned into tokens (P-34);
//   - the only text stored from the provider is a thread NAME on a session (`applyCodexThreadNames`): never a preview, a message,
//     an e-mail address or an account id.

/** The two accounts that report usage. GitHub is a connection, not a usage report. */
export type ReportedAccount = 'chatgpt' | 'claude';

const LIMIT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- Codex thread names ----------------------------------------------------------------------------------------------------

/** The longest name a session row keeps (code points). A thread name is a short title, never a paragraph. */
export const THREAD_NAME_MAX = 160;

// Control characters and line separators are exactly what this removes, so the rule that flags them is turned off for this one line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * A thread name as it is stored: control characters and line breaks become spaces, runs of white space collapse, the ends are
 * trimmed and the result is cut at `THREAD_NAME_MAX` code points. A value that is not a string, or empty once cleaned, is null:
 * the session keeps whatever name it has.
 */
export function cleanThreadName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  const points = [...cleaned];
  return points.length > THREAD_NAME_MAX
    ? points.slice(0, THREAD_NAME_MAX).join('').trimEnd()
    : cleaned;
}

/** What `thread/list` gives that is worth keeping: the thread's id (the Codex session id) and its name. Nothing else. */
export interface CodexThreadName {
  threadId: string;
  name: string | null;
}

export interface ThreadNameResult {
  /** Sessions whose name this call set or changed. */
  named: number;
  /** Threads whose session already carried exactly this name from the provider. */
  unchanged: number;
  /** Threads with no usable name, or whose id is no stored Codex session. */
  skipped: number;
}

/**
 * Names Codex sessions from `thread/list`, in one transaction. A thread matches the Codex session whose own id equals the thread
 * id, and no other (never a title, a folder or a time). The name is the PROVIDER's own, so it replaces a name Paseo gave and an
 * earlier provider name (a renamed thread), and the Paseo join never takes it back (it names only where the provider recorded
 * none). A thread with no usable name leaves the session as it is. Writes no token, event, parent or preview text.
 */
export function applyCodexThreadNames(
  db: Db,
  threads: readonly CodexThreadName[],
): ThreadNameResult {
  const result: ThreadNameResult = { named: 0, unchanged: 0, skipped: 0 };
  inTransaction(db, () => {
    const find = db.prepare(
      "SELECT id, recorded_name, name_source FROM session WHERE provider = 'codex' AND provider_session_id = ?",
    );
    const set = db.prepare(
      "UPDATE session SET recorded_name = ?, name_source = 'provider_title' WHERE id = ?",
    );
    for (const thread of threads) {
      const name = cleanThreadName(thread.name);
      if (name === null || typeof thread.threadId !== 'string' || thread.threadId === '') {
        result.skipped += 1;
        continue;
      }
      const session = find.get(thread.threadId) as
        { id: number; recorded_name: string | null; name_source: string | null } | undefined;
      if (session === undefined) {
        result.skipped += 1;
      } else if (session.recorded_name === name && session.name_source === 'provider_title') {
        result.unchanged += 1;
      } else {
        set.run(name, session.id);
        result.named += 1;
      }
    }
  });
  return result;
}

// ---- Percent windows and lifetime figures -----------------------------------------------------------------------------------

/** One percent window of an account's own report (ChatGPT's rate-limit buckets, Claude's five-hour and seven-day windows). */
export interface RateLimitInput {
  /** The provider's id for the window (`primary`, `five_hour`, ...). Letters, digits and `_.:-` only. */
  limitId: string;
  /** Percent used, as the provider reported it (not clamped here: a card clamps what it draws). */
  usedPercent: number;
  /** The window's length in minutes, or null when the provider did not say. */
  windowMinutes: number | null;
  /** When the window resets (epoch ms), or null. */
  resetsAt: number | null;
}

export interface RateLimitRow extends RateLimitInput {
  /** When this report was fetched (epoch ms). For Claude it is the snapshot's own `captured_at`. */
  fetchedAt: number;
}

/**
 * Replaces an account's percent windows with the latest report, in one transaction: a window in `limits` is stored (or updated),
 * and a window the account no longer reports is removed, because the newest report is the truth. A failed read must not call this,
 * so the last report stays. Throws on a malformed window (a program error: the collectors validate the provider's answer first).
 */
export function replaceRateLimits(
  db: Db,
  account: ReportedAccount,
  limits: readonly RateLimitInput[],
  fetchedAt: number,
): number {
  return inTransaction(db, () => writeRateLimits(db, account, limits, fetchedAt));
}

function writeRateLimits(
  db: Db,
  account: ReportedAccount,
  limits: readonly RateLimitInput[],
  fetchedAt: number,
  quota: 'codex' | null = null,
): number {
  for (const limit of limits) {
    if (!LIMIT_ID.test(limit.limitId)) throw new RangeError('limitId is not a plain identifier');
    if (!Number.isFinite(limit.usedPercent) || limit.usedPercent < 0) {
      throw new RangeError('usedPercent must be a finite number of at least 0');
    }
    if (limit.windowMinutes !== null && !Number.isSafeInteger(limit.windowMinutes)) {
      throw new RangeError('windowMinutes must be a whole number or null');
    }
    if (limit.resetsAt !== null && !Number.isSafeInteger(limit.resetsAt)) {
      throw new RangeError('resetsAt must be epoch milliseconds or null');
    }
  }
  const keep = limits.map((limit) => limit.limitId);
  const existing = db
    .prepare("SELECT limit_id FROM account_snapshot WHERE account = ? AND kind = 'rate_limit'")
    .all(account) as { limit_id: string }[];
  const remove = db.prepare(
    "DELETE FROM account_snapshot WHERE account = ? AND kind = 'rate_limit' AND limit_id = ?",
  );
  for (const row of existing) if (!keep.includes(row.limit_id)) remove.run(account, row.limit_id);
  const upsert = db.prepare(
    `INSERT INTO account_snapshot (account, kind, limit_id, unit, value, window_minutes, resets_at, fetched_at, codex_quota)
     VALUES (?, 'rate_limit', ?, 'percent', ?, ?, ?, ?, ?)
     ON CONFLICT (account, kind, limit_id) DO UPDATE SET unit = excluded.unit, value = excluded.value,
       window_minutes = excluded.window_minutes, resets_at = excluded.resets_at,
       fetched_at = excluded.fetched_at, codex_quota = excluded.codex_quota`,
  );
  for (const limit of limits) {
    upsert.run(
      account,
      limit.limitId,
      limit.usedPercent,
      limit.windowMinutes,
      limit.resetsAt,
      fetchedAt,
      quota === 'codex' ? 1 : 0,
    );
  }
  return limits.length;
}

/**
 * The lifetime token figure of an account, kept with its own label and never shown as a period total (data-and-sources). `null`
 * removes it (the report no longer carries one).
 */
export function setLifetimeTokens(
  db: Db,
  account: ReportedAccount,
  tokens: number | null,
  fetchedAt: number,
): void {
  if (tokens === null) {
    db.prepare("DELETE FROM account_snapshot WHERE account = ? AND kind = 'lifetime_tokens'").run(
      account,
    );
    return;
  }
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError('lifetime tokens must be a whole number of at least 0');
  }
  db.prepare(
    `INSERT INTO account_snapshot (account, kind, limit_id, unit, value, window_minutes, resets_at, fetched_at)
     VALUES (?, 'lifetime_tokens', '', 'tokens', ?, NULL, NULL, ?)
     ON CONFLICT (account, kind, limit_id) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
  ).run(account, tokens, fetchedAt);
}

export interface AccountSnapshot {
  lifetimeTokens: { value: number; fetchedAt: number } | null;
  rateLimits: RateLimitRow[];
  /** The newest `fetched_at` among the account's rows, or null when it has none. */
  fetchedAt: number | null;
}

/** What is stored about an account's percent windows and lifetime figure. Windows come back ordered by length, then id. */
export function readAccountSnapshot(db: Db, account: ReportedAccount): AccountSnapshot {
  const rows = db
    .prepare(
      `SELECT kind, limit_id, value, window_minutes, resets_at, fetched_at FROM account_snapshot
        WHERE account = ? ORDER BY window_minutes IS NULL, window_minutes, limit_id`,
    )
    .all(account) as {
    kind: 'lifetime_tokens' | 'rate_limit';
    limit_id: string;
    value: number | null;
    window_minutes: number | null;
    resets_at: number | null;
    fetched_at: number;
  }[];
  let lifetimeTokens: AccountSnapshot['lifetimeTokens'] = null;
  const rateLimits: RateLimitRow[] = [];
  let fetchedAt: number | null = null;
  for (const row of rows) {
    fetchedAt = fetchedAt === null ? row.fetched_at : Math.max(fetchedAt, row.fetched_at);
    if (row.kind === 'lifetime_tokens') {
      if (row.value !== null) lifetimeTokens = { value: row.value, fetchedAt: row.fetched_at };
    } else if (row.value !== null) {
      rateLimits.push({
        limitId: row.limit_id,
        usedPercent: row.value,
        windowMinutes: row.window_minutes,
        resetsAt: row.resets_at,
        fetchedAt: row.fetched_at,
      });
    }
  }
  return { lifetimeTokens, rateLimits, fetchedAt };
}

// ---- Daily token buckets (ChatGPT) ------------------------------------------------------------------------------------------

export interface DailyBucket {
  /** The report-timezone date the bucket belongs to (YYYY-MM-DD), as the account reported it. */
  date: string;
  tokens: number;
}

/**
 * Stores the account's daily buckets, in one transaction. `null` means the account reports no buckets at all (the percent-only
 * card, P-34): every stored bucket of the account is removed, so an old sum can never be shown beside a report that has none. An
 * array adds or updates the dates it names and removes nothing, so history accumulates beyond the account's own lookback and a
 * revised day is corrected. Throws on a malformed bucket.
 */
export function replaceDailyTokens(
  db: Db,
  account: ReportedAccount,
  buckets: readonly DailyBucket[] | null,
  fetchedAt: number,
): number {
  return inTransaction(db, () => writeDailyTokens(db, account, buckets, fetchedAt));
}

function writeDailyTokens(
  db: Db,
  account: ReportedAccount,
  buckets: readonly DailyBucket[] | null,
  fetchedAt: number,
): number {
  if (buckets === null) {
    db.prepare('DELETE FROM account_daily_tokens WHERE account = ?').run(account);
    return 0;
  }
  for (const bucket of buckets) {
    if (!DATE.test(bucket.date) || Number.isNaN(Date.parse(`${bucket.date}T00:00:00Z`))) {
      throw new RangeError('a bucket date must be YYYY-MM-DD');
    }
    if (!Number.isSafeInteger(bucket.tokens) || bucket.tokens < 0) {
      throw new RangeError('a bucket must hold a whole number of tokens of at least 0');
    }
  }
  const upsert = db.prepare(
    `INSERT INTO account_daily_tokens (account, date, tokens, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (account, date) DO UPDATE SET tokens = excluded.tokens, fetched_at = excluded.fetched_at`,
  );
  for (const bucket of buckets) upsert.run(account, bucket.date, bucket.tokens, fetchedAt);
  return buckets.length;
}

/** The stored buckets from `start` to `end` inclusive (YYYY-MM-DD), oldest first. */
export function readDailyTokens(
  db: Db,
  account: ReportedAccount,
  start: string,
  end: string,
): (DailyBucket & { fetchedAt: number })[] {
  return (
    db
      .prepare(
        'SELECT date, tokens, fetched_at FROM account_daily_tokens WHERE account = ? AND date >= ? AND date <= ? ORDER BY date',
      )
      .all(account, start, end) as { date: string; tokens: number; fetched_at: number }[]
  ).map((row) => ({ date: row.date, tokens: row.tokens, fetchedAt: row.fetched_at }));
}

/** Every date the account has a bucket for: the first, the last and how many; null when it has none. */
export function readDailyTokenSpan(
  db: Db,
  account: ReportedAccount,
): { first: string; last: string; days: number; fetchedAt: number } | null {
  const row = db
    .prepare(
      `SELECT MIN(date) AS first, MAX(date) AS last, COUNT(*) AS days, MAX(fetched_at) AS fetched_at
         FROM account_daily_tokens WHERE account = ?`,
    )
    .get(account) as {
    first: string | null;
    last: string | null;
    days: number;
    fetched_at: number | null;
  };
  if (row.first === null || row.last === null || row.fetched_at === null) return null;
  return { first: row.first, last: row.last, days: row.days, fetchedAt: row.fetched_at };
}

// ---- ChatGPT report reads -------------------------------------------------------------------------------------------------

type ChatgptComponent = 'tokens' | 'limits';
type ChatgptReadResult = 'succeeded' | 'failed';

function recordChatgptRead(
  db: Db,
  component: ChatgptComponent,
  result: ChatgptReadResult,
  at: number,
): void {
  db.prepare(
    `INSERT INTO chatgpt_report_read (component, result, attempted_at, last_succeeded_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (component) DO UPDATE SET result = excluded.result, attempted_at = excluded.attempted_at,
       last_succeeded_at = COALESCE(excluded.last_succeeded_at, chatgpt_report_read.last_succeeded_at)`,
  ).run(component, result, at, result === 'succeeded' ? at : null);
}

export function recordFailedChatgptRead(db: Db, at: number, component?: ChatgptComponent): void {
  if (component !== undefined) {
    recordChatgptRead(db, component, 'failed', at);
    return;
  }
  inTransaction(db, () => {
    recordChatgptRead(db, 'tokens', 'failed', at);
    recordChatgptRead(db, 'limits', 'failed', at);
  });
}

export function readChatgptReportOutcome(
  db: Db,
  component: ChatgptComponent,
): { result: ChatgptReadResult; at: number; lastSucceededAt: number | null } | null {
  const row = db
    .prepare(
      'SELECT result, attempted_at AS at, last_succeeded_at AS lastSucceededAt FROM chatgpt_report_read WHERE component = ?',
    )
    .get(component) as
    { result: ChatgptReadResult; at: number; lastSucceededAt: number | null } | undefined;
  return row ?? null;
}

export function saveChatgptTokens(
  db: Db,
  report: { lifetimeTokens: number | null; buckets: readonly DailyBucket[] | null },
  at: number,
): void {
  inTransaction(db, () => {
    setLifetimeTokens(db, 'chatgpt', report.lifetimeTokens, at);
    writeDailyTokens(db, 'chatgpt', report.buckets, at);
    recordChatgptRead(db, 'tokens', 'succeeded', at);
  });
}

export function saveChatgptRateLimits(
  db: Db,
  limits: readonly RateLimitInput[],
  at: number,
  quota: 'codex' | null = null,
): void {
  inTransaction(db, () => {
    writeRateLimits(db, 'chatgpt', limits, at, quota);
    recordChatgptRead(db, 'limits', 'succeeded', at);
  });
}

/** Finds a window only when its snapshot identified the general Codex quota. */
export function readCodexQuotaLimit(db: Db, windowMinutes: number): RateLimitRow | null {
  const row = db
    .prepare(
      `SELECT limit_id AS limitId, value AS usedPercent, window_minutes AS windowMinutes,
              resets_at AS resetsAt, fetched_at AS fetchedAt
         FROM account_snapshot
        WHERE account = 'chatgpt' AND kind = 'rate_limit' AND codex_quota = 1
          AND window_minutes = ? AND value IS NOT NULL
        ORDER BY limit_id LIMIT 1`,
    )
    .get(windowMinutes) as RateLimitRow | undefined;
  return row ?? null;
}

// ---- This machine, beside the account figure ---------------------------------------------------------------------------------

/**
 * The tokens this machine recorded for one provider between two instants (`from` inclusive, `to` exclusive, epoch ms): the sum of
 * each event's provider total, the owner rule the Usage ledgers use (Codex: input plus output, the cached and reasoning parts
 * are subsets and are never added again). It is shown BESIDE an account's own figure for the same dates and never added to it.
 */
export function localTokensBetween(
  db: Db,
  provider: 'codex' | 'claude',
  from: number,
  to: number,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(provider_total), 0) AS total FROM usage_event
        WHERE provider = ? AND occurred_at >= ? AND occurred_at < ?`,
    )
    .get(provider, from, to) as { total: number };
  return row.total;
}

// ---- The ChatGPT connection ---------------------------------------------------------------------------------------------------

const DISCONNECTED = 'chatgpt_disconnected';
const CONNECTED_AT = 'chatgpt_connected_at';

export interface ChatgptConnection {
  /** True after Disconnect: the dashboard stops calling the app-server until Connect is pressed again. Imported data stays. */
  disconnected: boolean;
  /** When the owner finished Connect from this dashboard (epoch ms), or null: a sign-in that was there before reads `existing`. */
  connectedAt: number | null;
}

export function readChatgptConnection(db: Db): ChatgptConnection {
  const connectedAt = Number(getMeta(db, CONNECTED_AT));
  return {
    disconnected: getMeta(db, DISCONNECTED) === '1',
    connectedAt: Number.isSafeInteger(connectedAt) && connectedAt > 0 ? connectedAt : null,
  };
}

/** Connect finished here: the dashboard reads again and the card says Connected. */
export function markChatgptConnected(db: Db, at: number): void {
  inTransaction(db, () => {
    setMeta(db, DISCONNECTED, '0');
    setMeta(db, CONNECTED_AT, String(at));
  });
}

/** Disconnect: the dashboard stops reading. It signs nobody out and deletes nothing it has imported. */
export function markChatgptDisconnected(db: Db): void {
  inTransaction(db, () => {
    setMeta(db, DISCONNECTED, '1');
    setMeta(db, CONNECTED_AT, '0');
  });
}

// ---- Folders Claude Code ran in (for the project status-line count) ------------------------------------------------------------

/**
 * The distinct folders Claude Code sessions ran in since `since` (epoch ms, by the session's last event), newest folder first, at
 * most `limit`. The capture's health check looks in each for a project `statusLine` key (presence only) to count the projects
 * whose own status line hides the dashboard's. Only folder paths the app already stored for its own sessions are returned; the
 * capture module receives them as plain input and never reads the database itself.
 */
export function readRecentClaudeCwds(db: Db, since: number, limit = 200): string[] {
  const rows = db
    .prepare(
      `SELECT cwd, MAX(last_event_at) AS latest FROM session
        WHERE provider = 'claude' AND cwd IS NOT NULL AND cwd <> '' AND last_event_at >= ?
        GROUP BY cwd ORDER BY latest DESC, cwd LIMIT ?`,
    )
    .all(since, limit) as { cwd: string }[];
  return rows.map((row) => row.cwd);
}

// ---- Claude plan-limit observations -----------------------------------------------------------------------------------------

const CLAUDE_PLAN_OUTCOME = 'claude_plan_outcome:';
const ClaudePlanOutcomeSchema = z.object({
  state: ClaudePlanLimitsState.exclude(['unchecked']),
  checkedAt: z.int().nonnegative(),
  retryAt: z.int().nonnegative().nullable(),
  snapshot: z
    .object({
      fetchedAt: z.int().nonnegative(),
      rateLimits: z
        .array(
          z.object({
            limitId: z.string().regex(LIMIT_ID),
            usedPercent: z.number().min(0).max(100),
            windowMinutes: z.int().positive().nullable(),
            resetsAt: z.int().nonnegative().nullable(),
          }),
        )
        .min(1),
    })
    .nullable(),
});
export type ClaudePlanOutcome = z.infer<typeof ClaudePlanOutcomeSchema>;

export function readClaudePlanOutcome(db: Db, profile: string): ClaudePlanOutcome | null {
  const value = getMeta(db, CLAUDE_PLAN_OUTCOME + profile);
  if (value === null) return null;
  try {
    const parsed = ClaudePlanOutcomeSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Historical status-line rows keep their source and can fill in the last captured window on upgrade. */
export function retainLegacyClaudeSnapshot(
  db: Db,
  limits: readonly RateLimitInput[],
  capturedAt: number,
): void {
  if (limits.length === 0) return;
  const saved = readAccountSnapshot(db, 'claude');
  if (saved.fetchedAt === null || saved.fetchedAt < capturedAt) {
    replaceRateLimits(db, 'claude', limits, capturedAt);
  }
}

/** Commit each profile's latest attempt and last successful windows in one write. */
export function writeClaudePlanOutcome(
  db: Db,
  profile: string,
  outcome: Omit<ClaudePlanOutcome, 'snapshot'>,
  limits?: readonly RateLimitInput[],
): void {
  const snapshot =
    limits === undefined
      ? (readClaudePlanOutcome(db, profile)?.snapshot ?? null)
      : { fetchedAt: outcome.checkedAt, rateLimits: limits };
  setMeta(db, CLAUDE_PLAN_OUTCOME + profile, JSON.stringify({ ...outcome, snapshot }));
}
