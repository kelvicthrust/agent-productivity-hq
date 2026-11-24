import type { Logger } from '../../lib/logger.ts';
import { abortableSleep, type Sleep } from '../../lib/sleep.ts';
import { connectFailure, listFailure, type ConnectionFailure } from './errors.ts';
import { readLiveAgent, type LiveAgent } from './liveAgent.ts';
import type { PaseoLiveOpen } from './open.ts';

// The live Paseo feed behind HQ (data-and-sources › Live roster (HQ)). One connection to the daemon while someone is looking:
//   1. open a client (no password, SDK reconnect off) and connect;
//   2. every `LIVE_POLL_MS` ask for the listing (`agents.list`, no `subscribe`) and replace the kept roster with what the answer says.
//      Each answer is projected through `readLiveAgent` the moment it arrives and is not referenced afterwards. Nothing is
//      subscribed to, so the SDK keeps nothing about the listing once the call has returned (`connection/owned.js` registers only
//      `observe()` calls);
//   3. every listing has HQ's own deadline (`LIVE_LIST_TIMEOUT_MS`) and a look at the connection state: with reconnect off the SDK
//      neither fails a pending call nor raises an error when the socket drops, it only changes its state, so a silent or dropped
//      daemon is found by the deadline or the state, never by waiting for the SDK;
//   4. on a failed connect or poll, close the client, say why in `status()`, and try again after a growing wait.
// The feed owns reconnecting. Nothing is stored: the roster is this object's memory and goes when the feed stops.
//
// Privacy: every agent is read through `readLiveAgent`, so only the named fields are kept. No title, folder, agent id or session id
// is logged; an SDK error's message is never kept and the only code logged is one from `LOGGABLE_CODES`. Fixed codes and statuses
// only: no count and no flag derived from the roster (the log is on disk).

/** Where a feed is. `stopped` is before `start()` and after `stop()`; the rest are what the daemon said. */
export type LiveFeedStatus =
  'stopped' | 'starting' | 'live' | 'notrunning' | 'needspassword' | 'failed';

/** What the feed holds now: the agents Paseo lists (archived ones never), and whether the daemon had more than one page. */
export interface LiveSnapshot {
  agents: readonly LiveAgent[];
  truncated: boolean;
}

export interface PaseoLiveFeed {
  /** Starts connecting. Does nothing if already started. */
  start(): void;
  /** Aborts a connect in flight, closes the client and clears every timer and the roster. Safe to call more than once. */
  stop(): Promise<void>;
  /** Resolves once the first attempt has ended (live or failed), or the feed was stopped. */
  ready(): Promise<void>;
  status(): LiveFeedStatus;
  /** A copy of what the feed holds now; empty unless live. */
  read(): LiveSnapshot;
}

// ---- the part of the SDK the feed uses -------------------------------------------------------------------------------------
// Written out, not imported, so tests can pass a fake client and so this file says which fields it depends on. The SDK's own
// `DaemonClient` must stay assignable to `PaseoLiveClientLike`: open.ts returns it as one, and the typecheck keeps the two in step.

export interface PaseoLiveListOptions {
  includeBackground: true;
  filter: { includeBackground: true; includeArchived: false; requiresAttention?: true };
  sort: [{ key: 'status_priority'; direction: 'asc' }, { key: 'updated_at'; direction: 'desc' }];
  page: { limit: number };
}

export interface PaseoLiveListResult {
  entries: readonly unknown[];
  pageInfo: { hasMore: boolean };
}

export interface PaseoLiveClientLike {
  connect(): Promise<void>;
  /** Closes the transport (the real one hard-closes its socket) and rejects what is pending. */
  close(): Promise<void>;
  /** `connected` while the socket is up; anything else (`disconnected`, `disposed`, ...) means it is not. */
  getConnectionState(): { status: string };
  agents: { list(options: PaseoLiveListOptions): Promise<PaseoLiveListResult> };
}

// ---- timing ---------------------------------------------------------------------------------------------------------------

/** Regular page size. The protocol allows at most 200. */
export const LIVE_PAGE_LIMIT = 200;
/** On a truncated directory, one extra page protects older unread results from newer idle agents. */
const LIVE_ATTENTION_PAGE_LIMIT = 60;
/** How often the listing is asked for while live (and so how often a dropped connection is looked for). */
export const LIVE_POLL_MS = 2_000;
/** How long a listing may go unanswered. The SDK leaves a call pending for ever when the socket drops, so HQ ends it itself. */
export const LIVE_LIST_TIMEOUT_MS = 5_000;
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
/** A daemon asking for a password is not asked again sooner than this. */
export const PASSWORD_RETRY_MS = 60_000;

export interface PaseoLiveFeedOptions {
  url: string;
  open: PaseoLiveOpen;
  now: () => number;
  logger: Logger;
  /** Waits `ms`, resolving early on abort. Defaults to a real timer that never keeps the process alive; tests pass their own. */
  sleep?: Sleep;
  /** 0..1, for the retry jitter. Defaults to `Math.random`. */
  random?: () => number;
}

/**
 * The only failure codes the feed puts in a log. The shared classifier (`errors.ts`) passes on any uppercase token a daemon or the
 * SDK puts in an error's `code`, and a daemon can put any string there (`rpc_error.code`), so an unlisted code is logged as
 * `failed`. These are the codes HQ itself sets, the SDK's own request-timeout code, and the Node network error codes.
 */
const LOGGABLE_CODES: ReadonlySet<string> = new Set([
  'connect_failed',
  'connect_timeout',
  'connection_lost',
  'list_failed',
  'list_timeout',
  'request_timeout',
  'sdk_unavailable',
  'daemon_connection_lost',
  'daemon_request_timeout',
  'econnaborted',
  'econnreset',
  'ehostunreach',
  'enetunreach',
  'enotfound',
  'epipe',
  'etimedout',
]);

const loggableCode = (code: string | undefined): string =>
  code !== undefined && LOGGABLE_CODES.has(code) ? code : 'failed';

const ABORTED = Symbol('aborted');
const TIMED_OUT = Symbol('timed out');

/** `work`'s result, or a rejection with ABORTED as soon as `signal` aborts. A late result of `work` is dropped, a late failure too. */
function untilAborted<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(ABORTED);
    const onAbort = () => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      return reject(error);
    }
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** The wait before attempt number `failures + 1`: 1, 2, 4 ... capped at 30 s, with up to 20 % taken off for jitter. */
export function retryDelay(failures: number, random: number, password: boolean): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
  const jittered = Math.round(base * (1 - 0.2 * random));
  return password ? Math.max(PASSWORD_RETRY_MS, jittered) : jittered;
}

export function createPaseoLiveFeed(options: PaseoLiveFeedOptions): PaseoLiveFeed {
  const { url, open, now, logger } = options;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;

  let status: LiveFeedStatus = 'stopped';
  let agents = new Map<string, LiveAgent>();
  let truncated = false;
  let controller: AbortController | null = null;
  let loop: Promise<void> = Promise.resolve();
  let ready: Promise<void> = Promise.resolve();
  let settle: () => void = () => undefined;
  let lastLogged: string | null = null;

  const setStatus = (next: LiveFeedStatus, code?: string): void => {
    status = next;
    if (next !== 'starting' && next !== 'live') {
      agents = new Map();
      truncated = false;
    }
    settle();
    const logged = loggableCode(code);
    const key = `${next}:${logged}`;
    if (key === lastLogged) return;
    lastLogged = key;
    if (next === 'live') return; // the connected line says so
    if (next === 'failed')
      logger.warn('paseo live feed failed', { source: 'paseo_live', code: logged });
    else logger.info('paseo live feed not usable', { source: 'paseo_live', status: next });
  };

  /** Keeps what an answer says about the agents, field by field, and nothing else: the answer is not referenced afterwards. */
  const replace = (listed: PaseoLiveListResult): void => {
    const next = new Map<string, LiveAgent>();
    for (const entry of listed.entries) {
      const agent = readLiveAgent(entry, now());
      if (agent && !agent.archived) next.set(agent.id, agent);
    }
    agents = next;
    truncated = listed.pageInfo.hasMore;
  };

  /**
   * One listing, ended by HQ if the daemon does not end it: it rejects with ABORTED when `signal` aborts and with TIMED_OUT after
   * `LIVE_LIST_TIMEOUT_MS`. The SDK leaves a call pending for ever when the socket drops, so this deadline is what ends it. The
   * deadline's timer is released whichever way the call ends.
   */
  async function listWithDeadline(
    client: PaseoLiveClientLike,
    signal: AbortSignal,
    attentionOnly = false,
  ): Promise<PaseoLiveListResult> {
    const deadline = new AbortController();
    try {
      const outcome = await untilAborted(
        () =>
          Promise.race([
            client.agents.list({
              includeBackground: true,
              filter: {
                includeBackground: true,
                includeArchived: false,
                ...(attentionOnly && { requiresAttention: true }),
              },
              sort: [
                { key: 'status_priority', direction: 'asc' },
                { key: 'updated_at', direction: 'desc' },
              ],
              page: { limit: attentionOnly ? LIVE_ATTENTION_PAGE_LIMIT : LIVE_PAGE_LIMIT },
            }),
            sleep(LIVE_LIST_TIMEOUT_MS, deadline.signal).then((): typeof TIMED_OUT => TIMED_OUT),
          ]),
        signal,
      );
      if (outcome === TIMED_OUT) throw TIMED_OUT;
      return outcome;
    } finally {
      deadline.abort();
    }
  }

  /** What a listing that did not come back means. A connection found not to be up is a lost connection, whatever the SDK said. */
  function listingFailure(error: unknown, client: PaseoLiveClientLike): ConnectionFailure {
    const failure: ConnectionFailure =
      error === TIMED_OUT ? { kind: 'failed', code: 'list_timeout' } : listFailure(error);
    if (failure.kind === 'failed' && client.getConnectionState().status !== 'connected')
      return { kind: 'failed', code: 'connection_lost' };
    return failure;
  }

  /** One connection, from open to drop. Returns how it ended; never throws. */
  async function session(
    signal: AbortSignal,
  ): Promise<{ live: boolean; failure: ConnectionFailure | null }> {
    let client: PaseoLiveClientLike | undefined;
    let live = false;
    const ended = (failure: ConnectionFailure | null) => ({ live, failure });
    const fail = (failure: ConnectionFailure) => {
      // A failure that arrives after the stop (the call settled in the same turn) changes nothing.
      if (!signal.aborted)
        setStatus(failure.kind, failure.kind === 'failed' ? failure.code : undefined);
      return ended(failure);
    };
    try {
      try {
        client = await untilAborted(async () => await open(url), signal);
        const connecting = client;
        await untilAborted(() => connecting.connect(), signal);
      } catch (error) {
        return error === ABORTED ? ended(null) : fail(connectFailure(error));
      }

      const connected = client;
      let canListAttention = true;
      for (;;) {
        // The check before the call finds a drop between two polls; the call's own deadline and the check after a failure find one
        // that happens while it is pending.
        if (connected.getConnectionState().status !== 'connected')
          return fail({ kind: 'failed', code: 'connection_lost' });
        try {
          let listed = await listWithDeadline(connected, signal);
          if (listed.pageInfo.hasMore && canListAttention) {
            try {
              const attention = await listWithDeadline(connected, signal, true);
              listed = { ...listed, entries: [...listed.entries, ...attention.entries] };
            } catch (error) {
              if (error === ABORTED) throw error;
              // A silent daemon can still answer the primary listing. Retain it and avoid accumulating timed-out requests.
              if (error === TIMED_OUT) canListAttention = false;
            }
          }
          // The answer arrived in the turn the feed was stopped in: it is not kept (stop empties the roster, and a restart has its own).
          if (signal.aborted) return ended(null);
          replace(listed);
        } catch (error) {
          return error === ABORTED ? ended(null) : fail(listingFailure(error, connected));
        }
        if (!live) {
          live = true;
          setStatus('live');
          // Nothing about the roster: not how many agents the daemon listed, not whether it had more (the log is on disk).
          logger.info('paseo live feed connected', { source: 'paseo_live' });
        }
        await sleep(LIVE_POLL_MS, signal);
        if (signal.aborted) return ended(null);
      }
    } finally {
      try {
        await client?.close();
      } catch {
        // Closing a socket that is already gone says nothing worth keeping.
      }
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const ended = await session(signal);
      if (signal.aborted) return;
      failures = ended.live ? 1 : failures + 1;
      await sleep(retryDelay(failures, random(), ended.failure?.kind === 'needspassword'), signal);
    }
  }

  return {
    start() {
      if (controller) return;
      const own = new AbortController();
      controller = own;
      status = 'starting';
      agents = new Map();
      truncated = false;
      lastLogged = null;
      ready = new Promise<void>((resolve) => {
        settle = resolve;
      });
      loop = run(own.signal).catch(() => undefined);
    },
    async stop() {
      const own = controller;
      if (!own) return;
      controller = null;
      own.abort();
      settle();
      await loop;
      if (controller === null) {
        status = 'stopped';
        agents = new Map();
        truncated = false;
      }
    },
    ready: () => ready,
    status: () => status,
    read: () => ({ agents: [...agents.values()], truncated }),
  };
}
