import type { Db } from '../../db/open.ts';
import {
  readChatgptConnection,
  recordFailedChatgptRead,
  saveChatgptRateLimits,
  saveChatgptTokens,
} from '../../db/queries/accounts.ts';
import { applyThreadNames, readThreadNames } from '../codex/names.ts';
import type { AdapterContext, AdapterReport, SourceAdapter } from '../types.ts';
import { recordObserved, type Observed } from './observed.ts';
import { parseAccount, parseRateLimits, parseUsage } from './parse.ts';
import type { LaunchAppServer } from './ports.ts';
import { failureOf, openSession, type Failure, type RpcSession } from './rpc.ts';

// The ChatGPT account collector, stage 4 of a refresh run (id `chatgpt_account`; data-and-sources › ChatGPT account report).
//
// One attempt starts ONE `codex app-server` child, asks it, and kills it before it returns, whatever happened:
//   initialize, initialized, account/read             who is signed in (no prompt, no refresh: P-42)
//   account/usage/read                                lifetime tokens and daily buckets
//   account/rateLimits/read                           the percent windows
//   thread/list (live, then archived)                 the names of Codex sessions (collectors/codex/names.ts)
// Each answer is stored by its own writer from db/queries/accounts.ts, and only a read that SUCCEEDED writes: a failed or silent
// read leaves the last report as it was (P-07), so the card can say "last report <time>".
//
// What is written, and what never is:
//   - the account's lifetime figure and daily buckets (unit tokens), its percent windows (unit percent), and a thread's name;
//   - NOT the e-mail address, plan, account id, streaks, peak day or preview text, and not one word of what the app-server said:
//     there is no logging of message text here, and a failure keeps a fixed sentence, never the provider's.
//   - none of it ever reaches usage events, sessions' totals, a repo row, a link or a trend (P-35 to P-38). Those tables are
//     not reachable from here.
//
// Not attempted (a `skipped` report records nothing, so it never counts as a failed refresh): after Disconnect (the dashboard
// stops calling the app-server, which also stops the names), and when there is no `codex` to start.

export interface ChatgptAdapterOptions {
  /** How the app-server is started: live.ts for real, a scripted one in tests. */
  launch: LaunchAppServer;
  /** The dashboard's version, named in `initialize`. */
  clientVersion?: string;
  /** Per-call timeout; 10 seconds unless a test shortens it. */
  callTimeoutMs?: number;
}

/** Sentences a run and Sources show. Fixed text: nothing the app-server said is ever in one. */
export const CHATGPT_MESSAGE = {
  disconnected: 'ChatGPT is disconnected here, so its account usage isn’t read.',
  noCodex: 'Codex isn’t installed here, so there is no ChatGPT account usage to read.',
  signedOut: 'Codex isn’t signed in to ChatGPT, so there is no account usage to read.',
  unsupported:
    'This Codex sign-in doesn’t report ChatGPT account usage (API-key and Bedrock sign-ins don’t).',
  timeout: 'Codex didn’t answer within 10 seconds. The last report is kept.',
  closed: 'Codex stopped before it answered. The last report is kept.',
  error: 'Codex couldn’t read the ChatGPT account usage. The last report is kept.',
  auth: 'Codex needs you to sign in to ChatGPT again. The last report is kept.',
  usageMissed: 'Couldn’t read the account’s token usage this time; the last totals are kept.',
  limitsMissed:
    'Couldn’t read the account’s usage limits this time; the last percentages are kept.',
  namesMissed: 'Couldn’t read every Codex session name this time.',
} as const;

const FAILED: Record<Failure, { code: string; message: string }> = {
  timeout: { code: 'appserver_timeout', message: CHATGPT_MESSAGE.timeout },
  closed: { code: 'appserver_closed', message: CHATGPT_MESSAGE.closed },
  error: { code: 'appserver_error', message: CHATGPT_MESSAGE.error },
  auth: { code: 'reconnect_needed', message: CHATGPT_MESSAGE.auth },
};

export function createChatgptAdapter(options: ChatgptAdapterOptions): SourceAdapter {
  return { id: 'chatgpt_account', refresh: (context) => refreshChatgpt(context, options) };
}

function failedReport(db: Db, at: number, why: Failure): AdapterReport {
  recordObserved(db, why === 'auth' ? 'reconnect' : 'failed', at);
  const { code, message } = FAILED[why];
  return { result: 'failed', errorCode: code, errorDetail: message, message };
}

function failedAccountRead(db: Db, at: number, why: Failure): AdapterReport {
  recordFailedChatgptRead(db, at);
  return failedReport(db, at, why);
}

async function refreshChatgpt(
  context: AdapterContext,
  options: ChatgptAdapterOptions,
): Promise<AdapterReport> {
  const { db, now, logger } = context;
  if (readChatgptConnection(db).disconnected) {
    return { result: 'skipped', message: CHATGPT_MESSAGE.disconnected };
  }

  const opened = await openSession(options.launch, {
    ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
  });
  if (opened.kind === 'absent') {
    recordObserved(db, 'no_codex', now());
    return { result: 'skipped', message: CHATGPT_MESSAGE.noCodex };
  }
  if (opened.kind === 'failed') {
    logger.warn('the Codex app-server did not start', {
      source: 'chatgpt_account',
      code: 'appserver_start_failed',
      reason: opened.why,
      ...(opened.code === undefined ? {} : { errno: opened.code }),
    });
    return failedAccountRead(db, now(), opened.why);
  }

  // The child is killed whatever happens below, so no attempt leaves one running.
  try {
    return await readAccount(context, opened.session);
  } finally {
    opened.session.close();
  }
}

async function readAccount(context: AdapterContext, session: RpcSession): Promise<AdapterReport> {
  const { db, now, logger } = context;

  const account = await session.call('account/read', { refreshToken: false });
  if (account.kind !== 'result') return failedAccountRead(db, now(), failureOf(account) ?? 'error');
  const kind = parseAccount(account.result);
  if (kind === null) return failedAccountRead(db, now(), 'error');

  if (kind !== 'chatgpt') {
    // Names are the machine's own Codex threads and do not need a ChatGPT sign-in, so they are read here too.
    const observed: Observed = kind === 'signed_out' ? 'signed_out' : 'unsupported';
    recordObserved(db, observed, now());
    await nameThreads(db, session, logger);
    return {
      result: 'skipped',
      message: kind === 'signed_out' ? CHATGPT_MESSAGE.signedOut : CHATGPT_MESSAGE.unsupported,
    };
  }

  const problems: string[] = [];
  let unreadable = 0;
  let responsive = true;
  const failures: Failure[] = [];

  const usage = await session.call('account/usage/read', {});
  const usageReport = usage.kind === 'result' ? parseUsage(usage.result) : null;
  if (usageReport !== null) {
    // `null` buckets clear the stored ones: an old sum must never sit beside a report that has none (the percent-only card).
    saveChatgptTokens(db, usageReport, now());
    unreadable += usageReport.unreadable;
  } else {
    recordFailedChatgptRead(db, now(), 'tokens');
    failures.push(failureOf(usage) ?? 'error');
    problems.push(CHATGPT_MESSAGE.usageMissed);
    if (usage.kind === 'timeout' || usage.kind === 'closed') responsive = false;
  }

  const limits = await session.call('account/rateLimits/read', {});
  const limitsReport = limits.kind === 'result' ? parseRateLimits(limits.result) : null;
  if (limitsReport !== null) {
    saveChatgptRateLimits(db, limitsReport.limits, now(), limitsReport.quota);
    unreadable += limitsReport.unreadable;
  } else {
    recordFailedChatgptRead(db, now(), 'limits');
    failures.push(failureOf(limits) ?? 'error');
    problems.push(CHATGPT_MESSAGE.limitsMissed);
    if (limits.kind === 'timeout' || limits.kind === 'closed') responsive = false;
  }

  // Both account reads missed: this attempt got nothing, and the card says so. One missed: the other half is current.
  if (failures.length === 2) {
    return failedReport(db, now(), failures.includes('auth') ? 'auth' : (failures[0] ?? 'error'));
  }
  recordObserved(db, 'ok', now());

  // A child that stopped answering would only make the names wait out another timeout.
  if (responsive && !(await nameThreads(db, session, logger)))
    problems.push(CHATGPT_MESSAGE.namesMissed);

  const tally = unreadable > 0 ? { unreadable } : {};
  return problems.length === 0
    ? { result: 'succeeded', ...tally }
    : { result: 'partial', message: problems.join(' '), ...tally };
}

/** Reads and applies the thread names. True when every list was read to its end. Counts only are logged, never a name. */
async function nameThreads(
  db: Db,
  session: RpcSession,
  logger: AdapterContext['logger'],
): Promise<boolean> {
  const names = await readThreadNames(session);
  const result = applyThreadNames(db, names);
  logger.debug('codex thread names applied', {
    source: 'chatgpt_account',
    named: result.named,
    unchanged: result.unchanged,
    skipped: result.skipped,
    complete: names.complete,
  });
  return names.complete;
}
