import type { HqActivity, HqState, HqWaitReason } from '../../../shared/contracts/hq.ts';
import type { Logger } from '../../lib/logger.ts';
import { abortableSleep, type Sleep } from '../../lib/sleep.ts';
import { classifyFsError } from '../ingest/index.ts';
import { createOpenFiles, type OpenFiles } from './confined.ts';
import { FIRST_READ_DEADLINE_MS, TRANSCRIPT_POLL_MS } from './heuristics.ts';
import {
  createRecent,
  type Recent,
  type RecentFile,
  type RecentOptions,
  type RootsState,
} from './recent.ts';
import { tailFile, type TailState } from './tail.ts';

// A transcript feed: the sessions of one provider (Claude Code or Codex) that are being written now, read from their transcript files
// while someone is looking at HQ (data-and-sources › Live roster (HQ) › Transcript feeds). It has the lifecycle of the Paseo live feed:
// `start`, `stop`, `ready`, `status` and a read of what it sees now.
//
// Every `TRANSCRIPT_POLL_MS` it asks `recent` for the files written in the last 15 minutes, reads what is new at the end of each
// (`tail`), gives each line to that session's tracker, and forgets the sessions whose file is no longer followed. What a tracker keeps
// is the state machine and a few ids; no line, title, tool name or path outside the file's own record is kept. `read()` asks each
// tracker for its state at the time of the call. Nothing is written anywhere.
//
// `starting` lasts until the first complete tick has finished: the files found AND each of them read once (`FIRST_READ_DEADLINE_MS`
// ends the wait if that takes too long). The same holds when a feed that had no roots finds them again: it reports `live` only after
// its reads. `ready()` resolves at the same moment the status changes.
//
// One run (`start()` to `stop()`) owns all its state: the controller, the file finder, the followed files, the open handles and the
// status. A late step of a run that has been stopped can only touch that run's own, dead, objects, never a restarted feed's.
// `stop()` aborts the run's signal (before anything is awaited), and then resolves only after (1) every file handle the run opened is
// closed (`OpenFiles.closeAll`, which also waits for an open in flight), and (2) the tick has ended, so no code of the feed runs
// again. Nothing in the feed is raced against the abort: each step of the tick ends by itself (the file system calls are short and the
// signal is checked between them; the read streams are destroyed on abort; the roots lookup and a tracker's start are given the signal
// and end at the step in flight), and `stop()` waits for the step that is in flight and for nothing after it. The one residual is a
// file system call that never answers (a hung network disk): a stop waits for it. Everything the run held (file paths, offsets,
// working directories) is dropped with it.
//
// Failures are reported as a status and a fixed code. A path, a file name or an error's own text is never logged.

export type TranscriptProvider = 'claude' | 'codex';

/** Where a feed is. `stopped` is before `start()` and after `stop()`; the rest say what its roots allowed. */
export type TranscriptFeedStatus =
  'stopped' | 'starting' | 'live' | 'notfound' | 'denied' | 'failed';

/** One session as its transcript shows it. Everything is inferred (data-and-sources › Live roster (HQ) › Transcript feeds). */
export interface TranscriptAgent {
  provider: TranscriptProvider;
  /** The provider's own session id: Claude Code's main file name, Codex's `session_meta.id`; a Claude subagent's is `<parent>:<agent file>`. */
  sessionId: string;
  /** The native parent's session id: a subagent's `<session>/subagents/` folder, a Codex thread's spawner. */
  parentSessionId: string | null;
  cwd: string | null;
  startedAt: number | null;
  state: HqState;
  activity: HqActivity;
  waitReason: HqWaitReason | null;
  since: number;
  lastActivityAt: number;
}

export interface TranscriptSnapshot {
  agents: readonly TranscriptAgent[];
  /** How many files are followed (a file that is not a session to show, or has said nothing yet, is counted too). */
  files: number;
}

/** What a read may ask of the trackers. */
export interface TranscriptReadOptions {
  /**
   * Whether a tool call that has waited long with no result may be read as "may be waiting for you" for this session (its main
   * session id). A session whose Claude Code hooks have spoken says exactly when it waits, so it is asked not to guess.
   */
  guessesPermission?: (sessionId: string) => boolean;
}

export interface TranscriptFeed {
  /** Starts looking. Does nothing if already started. */
  start(): void;
  /**
   * Aborts the look in flight and resolves once every file handle the feed opened is closed and its tick has ended; drops every file,
   * offset, working directory and session. Safe to call more than once (a second call waits for the first).
   */
  stop(): Promise<void>;
  /** Resolves once the first look has ended (live, with every followed file read once, or not live), or the feed was stopped. */
  ready(): Promise<void>;
  status(): TranscriptFeedStatus;
  /** The sessions as they are now; empty unless live. */
  read(options?: TranscriptReadOptions): TranscriptSnapshot;
}

/** What follows one file's session: fed its lines, asked for its state. */
export interface Tracker {
  line(text: string, observedAt: number): void;
  overlong(observedAt: number): void;
  agent(now: number, options?: TranscriptReadOptions): TranscriptAgent | null;
}

/** The part of a provider that differs: where its files are, which to follow, and what a session in one is. */
export interface TranscriptSource {
  provider: TranscriptProvider;
  roots: RecentOptions['roots'];
  accept: RecentOptions['accept'];
  hotDirs: RecentOptions['hotDirs'];
  /**
   * A tracker for a file that has just been followed (or was replaced), or null when it is not a session to show. A file it opens must
   * be opened through `files`, so that a stop closes it, and it must end (settle) once `signal` aborts: the feed waits for it.
   */
  start(file: RecentFile, signal: AbortSignal, files: OpenFiles): Promise<Tracker | null>;
}

export interface TranscriptFeedOptions {
  source: TranscriptSource;
  now: () => number;
  logger: Logger;
  /** Waits `ms`, resolving early on abort. Defaults to a real timer that never keeps the process alive; tests pass their own. */
  sleep?: Sleep;
  pollMs?: number;
}

interface Followed {
  tail: TailState;
  tracker: Tracker | null;
}

const STATUS_OF: Record<RootsState, TranscriptFeedStatus> = {
  ok: 'live',
  notfound: 'notfound',
  denied: 'denied',
  failed: 'failed',
};

/** Everything one run of the feed owns (see the top of this file). */
interface Run {
  readonly controller: AbortController;
  readonly files: OpenFiles;
  readonly recent: Recent;
  readonly followed: Map<string, Followed>;
  readonly startedAt: number;
  status: TranscriptFeedStatus;
  /** Resolves `ready()`. Safe to call more than once. */
  readonly settle: () => void;
  loop: Promise<void>;
}

export function createTranscriptFeed(options: TranscriptFeedOptions): TranscriptFeed {
  const { source, now, logger } = options;
  const sleep = options.sleep ?? abortableSleep;
  const pollMs = options.pollMs ?? TRANSCRIPT_POLL_MS;
  const name = `${source.provider}_live`;

  /** The run that is going; null before `start()` and from the moment `stop()` is called. */
  let current: Run | null = null;
  let stopping: Promise<void> | null = null;
  let ready: Promise<void> = Promise.resolve();
  let lastLogged: string | null = null;

  const setStatus = (run: Run, next: TranscriptFeedStatus, code?: string): void => {
    run.status = next;
    if (next !== 'live' && next !== 'starting') run.followed.clear();
    const key = `${next}:${code ?? ''}`;
    if (key === lastLogged) return;
    lastLogged = key;
    if (next === 'live' || next === 'starting') return;
    // The status and a fixed code only: never a path, a file name or an error's text.
    if (next === 'failed')
      logger.warn('transcript live feed failed', { source: name, code: code ?? 'failed' });
    else logger.info('transcript live feed not usable', { source: name, status: next });
  };

  /** Live, and `ready()` answered: the first complete tick is over (or its deadline has passed). */
  const finishFirst = (run: Run): void => {
    if (run.controller.signal.aborted) return;
    setStatus(run, 'live');
    run.settle();
  };

  async function follow(run: Run, file: RecentFile): Promise<void> {
    const { signal } = run.controller;
    const held = run.followed.get(file.path) ?? null;
    let entry: Followed | null = held;
    const outcome = await tailFile(
      file,
      held?.tail ?? null,
      {
        // A new or replaced file starts its session over before its first line. One that was jumped ahead in saw lines it did not
        // read, which counts as activity and clears the calls it was waiting on.
        async begin({ reset, skipped }) {
          if (entry === null || reset) {
            entry = {
              tail: held?.tail ?? { offset: 0, size: 0, mtimeMs: 0, head: '' },
              tracker: null,
            };
            // Awaited to its end: it is given the signal, and a stop waits for it (it holds no handle but those of `run.files`).
            entry.tracker = await source.start(file, signal, run.files);
          } else if (skipped) {
            entry.tracker?.overlong(now());
          }
        },
        // One line that cannot be understood never stops the file: it counts as a line that could not be read.
        line: (text) => {
          try {
            entry?.tracker?.line(text, now());
          } catch {
            entry?.tracker?.overlong(now());
          }
        },
        overlong: () => entry?.tracker?.overlong(now()),
      },
      signal,
      run.files,
    );
    if (signal.aborted) return;
    if (outcome === null) return; // unchanged: the tracker stays as it was
    if (entry === null) entry = { tail: outcome.state, tracker: null };
    entry.tail = outcome.state;
    run.followed.set(file.path, entry);
  }

  async function tick(run: Run): Promise<void> {
    const { signal } = run.controller;
    const seen = await run.recent.refresh(signal);
    if (signal.aborted) return;
    const next = STATUS_OF[seen.roots];
    if (next !== 'live') {
      setStatus(run, next, seen.roots === 'failed' ? 'list_failed' : undefined);
      run.settle();
      return;
    }
    const wanted = new Set(seen.files.map((file) => file.path));
    for (const path of [...run.followed.keys()]) if (!wanted.has(path)) run.followed.delete(path);
    for (const file of seen.files) {
      if (signal.aborted) return;
      try {
        await follow(run, file);
      } catch (error) {
        if (signal.aborted) return;
        // A file that went away mid-read is simply no longer followed; any other failure is tried again next tick.
        if (classifyFsError(error).kind === 'notfound') run.followed.delete(file.path);
      }
      // Slow reads do not keep the feed `starting` for ever: what has been read so far is shown after the deadline.
      if (run.status === 'starting' && now() - run.startedAt >= FIRST_READ_DEADLINE_MS)
        finishFirst(run);
    }
    // Only now, with every followed file read once, is the feed live (a feed coming back from `notfound` is no exception).
    finishFirst(run);
  }

  async function loop(run: Run): Promise<void> {
    const { signal } = run.controller;
    while (!signal.aborted) {
      try {
        await tick(run);
      } catch {
        if (signal.aborted) return;
        setStatus(run, 'failed', 'tick_failed');
        run.settle();
      }
      if (signal.aborted) return;
      await sleep(pollMs, signal);
    }
  }

  return {
    start() {
      if (current) return;
      let settle: () => void = () => undefined;
      ready = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const files = createOpenFiles();
      const run: Run = {
        controller: new AbortController(),
        files,
        recent: createRecent({
          files,
          roots: source.roots,
          accept: source.accept,
          hotDirs: source.hotDirs,
          now,
        }),
        followed: new Map(),
        startedAt: now(),
        status: 'starting',
        settle,
        loop: Promise.resolve(),
      };
      current = run;
      lastLogged = null;
      run.loop = loop(run).catch(() => undefined);
    },
    stop() {
      const run = current;
      if (!run) return stopping ?? Promise.resolve();
      current = null;
      run.controller.abort();
      run.settle();
      const ending = (async () => {
        try {
          await run.files.closeAll();
          await run.loop;
        } finally {
          run.followed.clear();
          run.recent.clear();
        }
      })();
      const own = ending.then(() => {
        if (stopping === own) stopping = null;
      });
      stopping = own;
      return own;
    },
    ready: () => ready,
    status: () => current?.status ?? 'stopped',
    read(readOptions) {
      const run = current;
      if (run === null || run.status !== 'live') return { agents: [], files: 0 };
      const at = now();
      const agents: TranscriptAgent[] = [];
      for (const entry of run.followed.values()) {
        try {
          const agent = entry.tracker?.agent(at, readOptions) ?? null;
          if (agent !== null) agents.push(agent);
        } catch {
          // A session that cannot be read now is left out of this answer; it never takes the others with it.
        }
      }
      return { agents, files: run.followed.size };
    },
  };
}
