import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  type AccountReport,
  type ConnectPollResponse as ConnectPollSchema,
  type ConnectResponse as ConnectSchema,
} from '../../shared/contracts/accounts.ts';
import { ApiError } from '../../shared/contracts/errors.ts';
import type { AccountStatus } from '../../shared/contracts/sources.ts';
import { dateInZone, minDate, rangeBounds } from '../../shared/domain/periods.ts';
import {
  LOGIN_WAIT_MS,
  startChatgptLogin,
  type LoginFlow,
  type LoginOutcome,
} from '../collectors/chatgpt/login.ts';
import { readObserved, recordObserved, type Observed } from '../collectors/chatgpt/observed.ts';
import type { LaunchAppServer } from '../collectors/chatgpt/ports.ts';
import type { Db } from '../db/open.ts';
import {
  localTokensBetween,
  markChatgptConnected,
  markChatgptDisconnected,
  readAccountSnapshot,
  readChatgptConnection,
  readChatgptReportOutcome,
  readCodexQuotaLimit,
  readDailyTokenSpan,
  readDailyTokens,
  type RateLimitRow,
} from '../db/queries/accounts.ts';

// The ChatGPT account, as the owner sees it (data-and-sources › ChatGPT account report; local-api › AccountStatus, AccountReport and
// the connect, poll and disconnect routes). Three things, none of which reads or writes a provider's files:
//
//   chatgptStatus        the card's status, from stored rows (what the last read found, and the owner's Connect and Disconnect)
//   buildChatgptWeeklyReport  the Codex weekly quota shown on Overview
//   buildChatgptReport   the account report used for Sources coverage
//   createChatgptAccounts  Connect (Codex's own browser sign-in, owner choice P4), the poll of it, and Disconnect
//
// The collector (collectors/chatgpt/collector.ts) is the only writer of what the report shows. Nothing here starts a program: the
// sign-in goes through the `LaunchAppServer` port it is given.

type ConnectResponse = z.infer<typeof ConnectSchema>;
type ConnectPollResponse = z.infer<typeof ConnectPollSchema>;

export const CHATGPT_NAME = 'ChatGPT';
// What the card may say about its own scope. It does not say "account-wide": the owner's live comparison (E4) found the account's
// figure BELOW this machine's own Codex total for the same dates, which an account-wide total cannot be, so what the figure counts
// is not confirmed. The card says it is the account's own report and that its scope is unconfirmed; the card itself adds a notice
// whenever the figure is lower than this machine's (components/AccountCard).
export const ACCOUNT_SCOPE_LABEL =
  'Reported by your ChatGPT account · what it counts is not confirmed';

const iso = (ms: number): string => new Date(ms).toISOString();

// ---- the card ---------------------------------------------------------------------------------------------------------------

export interface StatusOptions {
  /**
   * The status uses stored observations. "Last report <time>" is the time of the last successful read.
   */
  now?: number | (() => number);
  /** The report timezone, so "last report <time>" reads in the owner's time. */
  timezone: string;
  /** True while a sign-in started here is waiting for the browser. Only the service knows; the Overview does not pass it. */
  connecting?: boolean;
}

/** "Nov 4, 12:00 PM" in the report timezone. */
function formatWhen(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}

/**
 * The ChatGPT card's status (data-and-sources › Discovery: existing, connected, notconnected, unavailable, reconnect, failed), from
 * stored rows alone: it never starts Codex, so Sources can poll it. What the last read found is the collector's own note
 * (`collectors/chatgpt/observed.ts`); a card that has never been read says Not connected until the first refresh looks.
 */
export function chatgptStatus(db: Db, options: StatusOptions): AccountStatus {
  const card = { id: 'chatgpt', name: CHATGPT_NAME } as const;
  if (options.connecting) {
    return { ...card, status: 'connecting', statusText: 'Waiting for sign-in…', via: 'codex' };
  }
  const connection = readChatgptConnection(db);
  const notConnected = (reason: string | null): AccountStatus => ({
    ...card,
    status: 'notconnected',
    statusText: 'Not connected',
    via: null,
    ...(reason === null ? {} : { reason }),
  });
  if (connection.disconnected) return notConnected('disconnected');

  const observed = readObserved(db);
  const state: Observed | null = observed?.state ?? null;
  switch (state) {
    case 'ok':
    case null:
      // Never read: a sign-in just finished here reads Connected until the first read says otherwise; no sign-in is Not connected.
      if (state === null && connection.connectedAt === null) return notConnected(null);
      return connection.connectedAt === null
        ? {
            ...card,
            status: 'existing',
            statusText: 'Using your existing Codex sign-in',
            via: 'codex',
          }
        : { ...card, status: 'connected', statusText: 'Connected through Codex', via: 'codex' };
    case 'signed_out':
      return notConnected('signed_out');
    case 'unsupported':
      return {
        ...card,
        status: 'unavailable',
        statusText:
          'Unavailable: this Codex sign-in doesn’t report ChatGPT usage (API-key and Bedrock sign-ins don’t)',
        via: null,
        reason: 'unsupported_sign_in',
      };
    case 'no_codex':
      return {
        ...card,
        status: 'unavailable',
        statusText: 'Unavailable: Codex CLI not found',
        via: null,
        reason: 'codex_not_found',
      };
    case 'reconnect':
      return {
        ...card,
        status: 'reconnect',
        statusText: 'Reconnect needed: sign in to ChatGPT again',
        via: 'codex',
        reason: 'reconnect',
      };
    case 'failed': {
      const last =
        readAccountSnapshot(db, 'chatgpt').fetchedAt ??
        readDailyTokenSpan(db, 'chatgpt')?.fetchedAt ??
        null;
      return {
        ...card,
        status: 'failed',
        statusText:
          last === null
            ? 'Couldn’t read your ChatGPT usage'
            : `Couldn’t update; last report ${formatWhen(last, options.timezone)}`,
        via: 'codex',
        reason: 'read_failed',
      };
    }
  }
}

// ---- the report -------------------------------------------------------------------------------------------------------------

export interface ReportOptions {
  /** The selected dates, inclusive, in the report timezone. */
  start: string;
  end: string;
  timezone: string;
  /** Epoch ms, or the app's clock. */
  now: number | (() => number);
}

/** "5-hour", "Weekly", "3-day", "90-minute": how long a percent window is, from its own length in minutes. */
export function windowLabel(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes % 10080 === 0) return minutes === 10080 ? 'Weekly' : `${minutes / 10080}-week`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function allowReport(db: Db, observation: ReturnType<typeof readObserved>): boolean {
  const observed = observation?.state;
  return (
    !readChatgptConnection(db).disconnected &&
    observed !== 'signed_out' &&
    observed !== 'unsupported' &&
    observed !== 'no_codex'
  );
}

function reportIsStale(
  observation: ReturnType<typeof readObserved>,
  outcome: ReturnType<typeof readChatgptReportOutcome>,
): boolean {
  // Older databases recorded only account-wide failures. A later component read supersedes that observation.
  return (
    outcome?.result === 'failed' ||
    (observation !== null &&
      (observation.state === 'failed' || observation.state === 'reconnect') &&
      (outcome === null || observation.at > outcome.at))
  );
}

function reportWindow(limit: RateLimitRow) {
  return {
    limitId: limit.limitId,
    label: windowLabel(limit.windowMinutes),
    usedPercent: limit.usedPercent,
    windowMinutes: limit.windowMinutes,
    resetsAt: limit.resetsAt === null ? null : iso(limit.resetsAt),
  };
}

const WEEKLY_LIMIT_MINUTES = 10_080;

/** The account's current weekly plan limit. It is independent of local usage and dashboard filters. */
export function buildChatgptWeeklyReport(db: Db, now: number): AccountReport | null {
  const observation = readObserved(db);
  if (!allowReport(db, observation)) return null;

  const weekly = readCodexQuotaLimit(db, WEEKLY_LIMIT_MINUTES);
  if (weekly === null) return null;

  const outcome = readChatgptReportOutcome(db, 'limits');
  const expiresAt = weekly.resetsAt ?? weekly.fetchedAt + WEEKLY_LIMIT_MINUTES * 60_000;
  return {
    account: 'chatgpt',
    unit: 'percent',
    scopeLabel: 'ChatGPT subscription plan limits',
    refreshedAt: iso(weekly.fetchedAt),
    stale: expiresAt <= now || reportIsStale(observation, outcome),
    rateLimits: [reportWindow(weekly)],
  };
}

/**
 * The ChatGPT account report for the selected dates, or null when the card has nothing to show: not connected (or Disconnect was
 * pressed), no sign-in that reports usage, or nothing read yet. What was imported is kept either way and returns with the sign-in.
 *
 *   Daily buckets stored (unit tokens)
 *     periodTokens   the sum of the buckets inside the selected dates, up to today. Null when none falls inside them: a day with
 *                    no bucket is not zero, and the figure is never padded to fit the period.
 *     bucketSpan     the first and last bucket date inside the selection: the dates the figure really covers.
 *     localSameWindow  this machine's Codex tokens over those same dates, shown BESIDE the account figure and never added to it (P-36).
 *     windowDiffers  true when the covered dates are not the selected dates (to today). The card then says which dates it means.
 *   No buckets (null from the account, or never read): the percent card (unit percent, P-34)
 *     rateLimits     each window with its own length and reset time. No periodTokens: a percentage is never turned into tokens.
 *
 * `stale` follows the most recent read of the displayed component. The report keeps its last good figures on a failure (P-07).
 * Account figures reach no chart, repo row, session or link (P-35 to P-38): this function only reads its own tables and the
 * machine's Codex total.
 */
export function buildChatgptReport(db: Db, options?: ReportOptions): AccountReport | null {
  const observation = readObserved(db);
  if (!allowReport(db, observation)) return null;

  const span = readDailyTokenSpan(db, 'chatgpt');
  const outcome = readChatgptReportOutcome(db, span === null ? 'limits' : 'tokens');

  const base = {
    account: 'chatgpt',
    scopeLabel: ACCOUNT_SCOPE_LABEL,
    stale: reportIsStale(observation, outcome),
  } as const;

  if (span === null) {
    const { rateLimits } = readAccountSnapshot(db, 'chatgpt');
    const oldest = rateLimits.reduce((at, limit) => Math.min(at, limit.fetchedAt), Infinity);
    const fetchedAt = rateLimits.length > 0 ? oldest : outcome?.lastSucceededAt;
    if (fetchedAt == null) return null;
    return {
      ...base,
      unit: 'percent',
      refreshedAt: iso(fetchedAt),
      rateLimits: rateLimits.map(reportWindow),
    };
  }

  // Sources needs only the available dates.
  if (!options) {
    return {
      ...base,
      unit: 'tokens',
      bucketSpan: { start: span.first, end: span.last },
      refreshedAt: iso(span.fetchedAt),
    };
  }

  // A day that has not happened has no bucket, so the selection counts only up to today.
  const now = typeof options.now === 'function' ? options.now() : options.now;
  const through = minDate(options.end, dateInZone(now, options.timezone));
  const inside =
    options.start <= through ? readDailyTokens(db, 'chatgpt', options.start, through) : [];
  const first = inside[0];
  const last = inside.at(-1);
  if (first === undefined || last === undefined) {
    // Buckets exist, but none inside these dates: the figure is not zero, it is not reported for them.
    return {
      ...base,
      unit: 'tokens',
      refreshedAt: iso(span.fetchedAt),
      periodTokens: null,
      bucketSpan: null,
      localSameWindow: null,
      windowDiffers: true,
    };
  }
  const covered = rangeBounds(first.date, last.date, options.timezone);
  return {
    ...base,
    unit: 'tokens',
    refreshedAt: iso(
      inside.reduce((at, bucket) => Math.min(at, bucket.fetchedAt), first.fetchedAt),
    ),
    periodTokens: inside.reduce((sum, bucket) => sum + bucket.tokens, 0),
    bucketSpan: { start: first.date, end: last.date },
    localSameWindow: localTokensBetween(db, 'codex', covered.start, covered.end),
    windowDiffers: first.date !== options.start || last.date !== through,
  };
}

// ---- Connect, poll, Disconnect -----------------------------------------------------------------------------------------------

/** What the routes call (routes/accounts.ts). Errors are `ApiError`s, thrown on purpose. */
export interface ChatgptAccounts {
  /** The card for GET /api/sources. */
  status(): AccountStatus;
  /**
   * Starts Codex's own browser sign-in and answers with the address to open (`mode: browser`), or `mode: existing` when Codex is
   * already signed in with ChatGPT (nothing is asked, P-42). No `codex` is a 422; Codex not answering is a 502. Starting another
   * sign-in ends the one that is waiting.
   */
  connect(): Promise<ConnectResponse>;
  /** One poll of a sign-in this process started; the server watches Codex itself. An unknown id is a 404. */
  poll(loginId: string): ConnectPollResponse;
  /** Ends a sign-in that is waiting. Nothing is stored. */
  cancel(loginId: string): void;
  /** Stops the dashboard reading ChatGPT. It does NOT sign Codex out, and what was imported stays. */
  disconnect(): AccountStatus;
  /** Ends a waiting sign-in and its child. For shutdown. */
  close(): void;
  /** Cancels the sign-in and forgets all poll results during reset. */
  clearFlows?(): void;
}

export interface ChatgptAccountsDeps {
  db: Db;
  /** How the app-server is started: collectors/chatgpt/live.ts for real, a scripted one in tests. */
  launch: LaunchAppServer;
  /** Epoch ms. */
  now: () => number;
  /** The report timezone. */
  timezone: string;
  clientVersion?: string;
  callTimeoutMs?: number;
  /** How long the owner has to finish in the browser; ten minutes unless a test shortens it. */
  loginWaitMs?: number;
  /** A sign-in finished here. The process starts a ChatGPT-only refresh so the card fills at once instead of at the next timer. */
  onConnected?: () => void;
}

type FlowState = NonNullable<ConnectPollResponse['state']>;

interface Flow {
  readonly id: string;
  state: FlowState;
  message: string | null;
  readonly login: LoginFlow;
}

/** The designed sentences for the way a sign-in ends or cannot start. Fixed text: nothing the app-server said is in one. */
export const CHATGPT_FLOW_MESSAGE = {
  expired: 'The sign-in took too long. Start again.',
  cancelled: 'Sign-in was cancelled.',
  failed: 'ChatGPT didn’t complete the sign-in. Start again.',
  noCodex:
    'Codex isn’t installed on this computer, so ChatGPT can’t be connected here. Install Codex, then try again.',
  slow: 'Codex didn’t answer in time. Try again in a moment.',
  broken: 'Codex couldn’t start the ChatGPT sign-in. Try again in a moment.',
} as const;

/** Sign-ins kept for `poll` after they end. One runs at a time; the rest are answers still to be read. */
const KEEP_FLOWS = 5;

export function createChatgptAccounts(deps: ChatgptAccountsDeps): ChatgptAccounts {
  const { db, now } = deps;
  const flows = new Map<string, Flow>();
  let running: Flow | null = null;
  // One Connect at a time: a second press waits for the first to finish starting, then replaces it.
  let turn: Promise<unknown> = Promise.resolve();

  const status = (): AccountStatus =>
    chatgptStatus(db, { now: now(), timezone: deps.timezone, connecting: running !== null });

  function finish(flow: Flow, outcome: LoginOutcome): void {
    if (flow.state !== 'pending') return;
    flow.state = outcome;
    flow.message =
      outcome === 'connected'
        ? null
        : outcome === 'expired'
          ? CHATGPT_FLOW_MESSAGE.expired
          : outcome === 'cancelled'
            ? CHATGPT_FLOW_MESSAGE.cancelled
            : CHATGPT_FLOW_MESSAGE.failed;
    if (running === flow) running = null;
    if (outcome === 'connected') {
      markChatgptConnected(db, now());
      recordObserved(db, 'ok', now());
      deps.onConnected?.();
    }
  }

  function cancelRunning(): void {
    if (running === null) return;
    const flow = running;
    finish(flow, 'cancelled');
    flow.login.cancel();
  }

  async function start(): Promise<ConnectResponse> {
    // Codex's browser sign-in listens on this computer for the browser's return, so a second one cannot run beside it.
    cancelRunning();
    const started = await startChatgptLogin(deps.launch, {
      ...(deps.clientVersion === undefined ? {} : { clientVersion: deps.clientVersion }),
      ...(deps.callTimeoutMs === undefined ? {} : { callTimeoutMs: deps.callTimeoutMs }),
      waitMs: deps.loginWaitMs ?? LOGIN_WAIT_MS,
    });

    switch (started.kind) {
      case 'absent':
        recordObserved(db, 'no_codex', now());
        throw new ApiError('invalid_input', CHATGPT_FLOW_MESSAGE.noCodex, {
          status: 422,
          details: { reason: 'codex_not_found' },
        });
      case 'failed':
        throw new ApiError(
          'upstream_unavailable',
          started.why === 'timeout' ? CHATGPT_FLOW_MESSAGE.slow : CHATGPT_FLOW_MESSAGE.broken,
        );
      case 'existing':
        // Already signed in: Connect after Disconnect puts reading back, and nobody is asked for anything (P-42).
        if (readChatgptConnection(db).disconnected) markChatgptConnected(db, now());
        recordObserved(db, 'ok', now());
        deps.onConnected?.();
        return { loginId: null, mode: 'existing' };
      case 'started': {
        const flow: Flow = {
          id: randomUUID(),
          state: 'pending',
          message: null,
          login: started.flow,
        };
        running = flow;
        flows.set(flow.id, flow);
        for (const id of [...flows.keys()].slice(0, Math.max(0, flows.size - KEEP_FLOWS)))
          flows.delete(id);
        void started.flow.done.then(
          (outcome) => finish(flow, outcome),
          () => finish(flow, 'failed'),
        );
        return {
          loginId: flow.id,
          mode: 'browser',
          authUrl: started.flow.authUrl,
          userCode: null,
          verificationUri: null,
          expiresAt: iso(now() + (deps.loginWaitMs ?? LOGIN_WAIT_MS)),
        };
      }
    }
  }

  return {
    status,

    connect(): Promise<ConnectResponse> {
      const next = turn.then(start, start);
      turn = next.catch(() => undefined);
      return next;
    },

    poll(loginId: string): ConnectPollResponse {
      const flow = flows.get(loginId);
      if (!flow) throw new ApiError('not_found', 'That sign-in is not running here. Start again.');
      if (flow.state === 'pending') return { state: 'pending' };
      if (flow.state === 'connected') return { state: 'connected', account: status() };
      return { state: flow.state, message: flow.message };
    },

    cancel(loginId: string): void {
      const flow = flows.get(loginId);
      if (!flow || flow.state !== 'pending') return;
      finish(flow, 'cancelled');
      flow.login.cancel();
    },

    disconnect(): AccountStatus {
      cancelRunning();
      // The dashboard stops reading. Codex stays signed in, and what was imported stays.
      markChatgptDisconnected(db);
      return status();
    },

    close: cancelRunning,

    clearFlows() {
      cancelRunning();
      flows.clear();
    },
  };
}
