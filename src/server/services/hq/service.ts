import { HqRoster, type HqFeed } from '../../../shared/contracts/hq.ts';
import type { TranscriptFeed, TranscriptFeedStatus } from '../../collectors/live/feed.ts';
import type { LiveFeedStatus, PaseoLiveFeed } from '../../collectors/paseo/live.ts';
import { createRepoResolver } from '../../collectors/ingest/repo.ts';
import type { LiveSessionKey, LiveSessionLabel } from '../../db/queries/hq.ts';
import type { Logger } from '../../lib/logger.ts';
import { abortableSleep, type Sleep } from '../../lib/sleep.ts';
import { createDemandGate } from './gate.ts';
import type { HookStore } from './hookStore.ts';
import { buildRoster, createKeyMemo, type KeyMemo } from './roster.ts';

/**
 * The live roster behind GET /api/hq: the coding agents running on this machine now, held in memory and never stored.
 * Feeders fill it while someone is looking (see gate.ts): Paseo's live listing, and the Claude Code and Codex transcript feeds. Claude
 * Code's hook events (hookStore.ts) are a fourth input: they arrive whether or not anyone is looking, are held in memory, and are
 * read here when a roster is built.
 */
export interface HqService {
  /** The roster as of now. Never carries a prompt, response, tool name or argument, permission detail or error text. */
  snapshot(): Promise<HqRoster>;
  /** Stops every feeder and releases what it holds. Safe to call more than once. */
  close(): Promise<void>;
}

/** What a process with no live feeder answers: every feed unavailable and nobody on the roster. */
export function unavailableRoster(nowMs: number): HqRoster {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    feeds: [
      { id: 'paseo', status: 'unavailable' },
      { id: 'claude', status: 'unavailable' },
      { id: 'codex', status: 'unavailable' },
    ],
    agents: [],
    truncated: false,
  };
}

export const HQ_IDLE_MS = 30_000;
export const HQ_COLD_WAIT_MS = 1_000;
/** A repo lookup is remembered this long, so a changed remote is seen within a minute and a poll does not walk folders again. */
const REPO_CACHE_MS = 60_000;

export interface HqServiceOptions {
  /** The feeds this process has. One that is absent is `unavailable`: its source is not on in this process. */
  feeds: {
    paseo?: PaseoLiveFeed | undefined;
    claude?: TranscriptFeed | undefined;
    codex?: TranscriptFeed | undefined;
  };
  now: () => number;
  logger: Logger;
  includePaseoAgentIds?: boolean | undefined;
  /** What Claude Code's hooks have reported (the opt-in switch). Without it the roster is built from the three feeds alone. */
  hooks?: HookStore | undefined;
  /** True until first-launch Setup has been finished: nothing starts and every feed says `setup_incomplete`. */
  waitsForSetup: () => boolean;
  /** The name and repo already stored for imported sessions (a read-only query). Without it no stored label is used. */
  labelsOf?:
    ((keys: readonly LiveSessionKey[]) => ReadonlyMap<string, LiveSessionLabel>) | undefined;
  /** How long without a request before the feeds are stopped. */
  idleMs?: number;
  /** How long a first request waits for the feeds to answer before reporting them as `starting`. */
  coldWaitMs?: number;
  /** Waits `ms`, resolving early on abort. Defaults to a real timer; tests pass their own. */
  sleep?: Sleep;
}

/** A feed's state as the contract names it. A feed that has not started yet is `starting`. */
const feedStatus = (status: LiveFeedStatus | TranscriptFeedStatus): HqFeed['status'] =>
  status === 'stopped' ? 'starting' : status;

type FeedLike = Pick<PaseoLiveFeed | TranscriptFeed, 'start' | 'stop' | 'ready' | 'status'>;

export function createHqService(options: HqServiceOptions): HqService & { stop(): Promise<void> } {
  const { feeds, now, waitsForSetup } = options;
  const coldWaitMs = options.coldWaitMs ?? HQ_COLD_WAIT_MS;
  const sleep = options.sleep ?? abortableSleep;
  const present: FeedLike[] = [feeds.paseo, feeds.claude, feeds.codex].filter(
    (feed): feed is NonNullable<typeof feed> => feed !== undefined,
  );

  // The repo lookup remembers each roster folder (full working directory and `.git` paths) and the id memo each agent's keys, so both
  // are dropped when the feeds stop: nothing about the folders or the sessions is kept while nobody is looking. While running the
  // lookup is also replaced every `REPO_CACHE_MS`.
  let repoOf: ReturnType<typeof createRepoResolver> | null = null;
  let repoOfSince = 0;
  let memo: KeyMemo = createKeyMemo();
  /** Counts the stops, so a look that began before one is not built into an answer after it (it would put folders and ids back). */
  let generation = 0;
  let closed = false;
  /** The repair codes already logged since the feeds started: once each, whatever the number of agents or polls. */
  const noted = new Set<string>();
  /** A fixed code and nothing else: no count, no id, no title, no path. */
  const note = (code: 'roster_repaired' | 'roster_failed'): void => {
    if (noted.has(code)) return;
    noted.add(code);
    options.logger.warn('hq roster repaired', { source: 'hq', code });
  };
  const repoFor = (cwd: string | null): string | null => {
    if (repoOf === null || now() - repoOfSince >= REPO_CACHE_MS) {
      repoOf = createRepoResolver();
      repoOfSince = now();
    }
    return repoOf(cwd).repoId;
  };

  // A stored label is a nicety: a database that cannot be read right now (busy, closing) must not take the roster down with it.
  const { labelsOf } = options;
  const storedLabels = labelsOf
    ? (keys: readonly LiveSessionKey[]): ReadonlyMap<string, LiveSessionLabel> => {
        try {
          return labelsOf(keys);
        } catch {
          return new Map();
        }
      }
    : undefined;

  const gate = createDemandGate({
    start: () => {
      options.logger.debug('hq feeds started', { source: 'hq' });
      for (const feed of present) feed.start();
    },
    stop: async () => {
      options.logger.debug('hq feeds stopped', { source: 'hq' });
      try {
        await Promise.allSettled(present.map((feed) => feed.stop()));
      } finally {
        generation += 1;
        repoOf = null;
        memo = createKeyMemo();
        noted.clear();
      }
    },
    idleMs: options.idleMs ?? HQ_IDLE_MS,
  });

  /** Waits up to `coldWaitMs` for feeds that have only just started, so the first poll can already show a roster. */
  async function coldWait(): Promise<void> {
    const starting = present.filter((feed) => feed.status() === 'starting');
    if (starting.length === 0) return;
    const timeout = new AbortController();
    try {
      await Promise.race([
        Promise.all(starting.map((feed) => feed.ready())),
        sleep(coldWaitMs, timeout.signal),
      ]);
    } finally {
      timeout.abort();
    }
  }

  const feedsOf = (status: (id: HqFeed['id']) => HqFeed['status']): HqFeed[] => [
    { id: 'paseo', status: status('paseo') },
    { id: 'claude', status: status('claude') },
    { id: 'codex', status: status('codex') },
  ];

  /** The clock as an instant; a clock that is not a time must not fail the answer. */
  const generatedAt = (): string => {
    try {
      return new Date(now()).toISOString();
    } catch {
      return new Date().toISOString();
    }
  };

  const response = (
    feedsNow: HqFeed[],
    agents: HqRoster['agents'],
    truncated: boolean,
  ): HqRoster => ({
    generatedAt: generatedAt(),
    feeds: feedsNow,
    agents,
    truncated,
  });

  return {
    async snapshot() {
      // Closed (shutdown): nothing is started, built or asked of the database, which may be closed by now (`waitsForSetup` reads it).
      if (closed)
        return response(
          feedsOf((id) => {
            const feed = feeds[id];
            return feed === undefined ? 'unavailable' : feedStatus(feed.status());
          }),
          [],
          false,
        );
      if (waitsForSetup())
        return response(
          feedsOf((id) => (feeds[id] === undefined ? 'unavailable' : 'setup_incomplete')),
          [],
          false,
        );
      gate.touch();
      const began = generation;
      await coldWait();
      const statuses = feedsOf((id) => {
        const feed = feeds[id];
        return feed === undefined ? 'unavailable' : feedStatus(feed.status());
      });
      // The feeds were stopped (or the service closed) while this waited: there is nothing to build, and building would put the repo
      // lookup and the id memory back after they were dropped.
      if (closed || began !== generation) return response(statuses, [], false);
      // A feed's data never fails the answer: whatever it holds is read and built inside this guard, a bad agent or time is repaired
      // or left out in the roster, and what is left out of the answer is only ever the agents, never the feed statuses.
      try {
        const paseo = feeds.paseo?.status() === 'live' ? feeds.paseo.read() : null;
        // A session whose hooks have spoken says exactly when it waits: its transcript is not asked to guess.
        const readOptions = {
          guessesPermission: (sessionId: string) => !(options.hooks?.delivered(sessionId) ?? false),
        };
        const claude = feeds.claude?.status() === 'live' ? feeds.claude.read(readOptions) : null;
        const codex = feeds.codex?.status() === 'live' ? feeds.codex.read(readOptions) : null;
        const transcripts = [...(claude?.agents ?? []), ...(codex?.agents ?? [])];
        const hooks = options.hooks?.read();
        if (paseo === null && transcripts.length === 0 && (hooks?.size ?? 0) === 0)
          return response(statuses, [], false);
        const roster = buildRoster({
          agents: paseo?.agents ?? [],
          includePaseoAgentIds: options.includePaseoAgentIds,
          transcripts,
          claudeParents: claude?.parents,
          now: now(),
          repoOf: repoFor,
          labelsOf: storedLabels,
          pageTruncated: paseo?.truncated ?? false,
          memo,
          hooks,
        });
        if (roster.repaired > 0) note('roster_repaired');
        const body = response(statuses, roster.agents, roster.truncated);
        if (HqRoster.safeParse(body).success) return body;
        note('roster_failed');
        return response(statuses, [], false);
      } catch {
        note('roster_failed');
        return response(statuses, [], false);
      }
    },
    stop: () => gate.stop(),
    close: () => {
      closed = true;
      return gate.close();
    },
  };
}
