import type { Db } from '../db/open.ts';
import { readLinkHealth, recordLinkRebuildResult } from '../db/queries/link-health.ts';
import {
  createRun,
  finishRun,
  getRun,
  getRunningRun,
  recordAttempt,
  updateRunSources,
  type AttemptResult,
  type RunRow,
  type RunSourceEntry,
  type RunSources,
  type RunState,
} from '../db/queries/sources.ts';
import { DISK_FULL_IMPORT_MESSAGE, isDiskFull } from '../lib/diskFull.ts';
import type { Logger } from '../lib/logger.ts';
import {
  REFRESH_STAGES,
  type AdapterReport,
  type ImportProgress,
  type RefreshSourceId,
  type RefreshTrigger,
  type SourceAdapter,
} from './types.ts';

// The refresh runner (TECH › Refresh run state machine).
//
//   start()  guard: no run in state 'running', else the caller gets the running id (HTTP 409 refresh_running)
//            run.state = running, every requested source queued, then the work goes on in the background
//   before   discovery: a fresh look at the local folders, so a row says what the machine says now (injected as `beforeSources`)
//   stage 1  codex, claude   in parallel   queued -> running -> succeeded | partial | failed | skipped
//   stage 2  paseo           after stage 1  (enrichment needs the sessions stage 1 imported)
//   stage 3  github          after stage 2
//   stage 4  chatgpt_account after stage 3
//   after    retention and link recompute on the retained data (injected as `afterSources`)
//   finish   run.state = succeeded | partial | failed, from the sources and link rebuild (see `runStateOf`)
//
// Every progress write goes to the `refresh_run` row, so the client's 1-second poll of GET /api/refresh/{id} is the only
// thing that tells it what is happening: there is no timer, delay or in-memory flag in the answer. Within a run each
// source is attempted once, so the single-run guard is also the per-source lock.
//
// A finished attempt is written by `recordAttempt` (db/queries/sources.ts): last_attempt_* and consecutive_failures in one
// transaction, reset by succeeded or partial and one more after a failed one. A skipped source records nothing, so it can
// never change consecutive_failures. A failed or skipped source never deletes data; earlier rows are untouched (P-07).

/** Work the run does around the sources. A step that throws is logged and the run goes on: it never decides a source's result. */
export interface RunnerStep {
  name: string;
  run: () => void | Promise<void>;
}

interface LinkRebuildStep {
  name: 'links';
  /** Commits the replacement links and successful result together for this run. */
  rebuild: (runId: number) => void;
}

export interface RunnerDeps {
  db: Db;
  now: () => number;
  logger: Logger;
  /** The adapters this process has. A requested source with no adapter is skipped, and nothing about it is recorded. */
  adapters: readonly SourceAdapter[];
  /**
   * Before any source is attempted: discovery (collectors/discovery.ts). It looks at the local folders and records what it
   * found; it imports nothing and never counts as an attempt, so a failed look cannot change `consecutive_failures`.
   */
  beforeSources?: readonly RunnerStep[];
  /** Retention and link rebuild run after the sources, whatever the sources did. */
  afterSources?: readonly (RunnerStep | LinkRebuildStep)[];
}

export type StartResult =
  | { started: true; run: RunRow }
  /** A run is already going: attach to this one. */
  | { started: false; runId: number };

export interface Runner {
  /** Starts a run in the background; returns at once with the run as created (every source `queued`). */
  start(request: { trigger: RefreshTrigger; sources?: readonly RefreshSourceId[] }): StartResult;
  /** Resolves when this process has no run in progress. For shutdown and tests; nothing in a request path waits on it. */
  idle(): Promise<void>;
}

const NO_ADAPTER = 'This source can’t be refreshed yet.';
/** How often a source's progress reaches the run row (the client polls once a second, so more would only be written, never seen). */
export const PROGRESS_INTERVAL_MS = 250;

/** The sentence a running source shows while it imports: the run's own `message` field, so the API shape is unchanged. */
export function progressMessage({ done, total }: ImportProgress): string {
  return `Importing ${done} of ${total} ${total === 1 ? 'file' : 'files'}`;
}
/** Shown when an adapter or the save of its result broke: no file content, path or token ever reaches this text (P-31). */
const UNEXPECTED = 'The refresh stopped unexpectedly. Already-imported history is unaffected.';

/**
 * A successful rebuild is recorded separately. A failed rebuild contributes a failure to the run,
 * so successful imports with a failed rebuild finish as partial. Skipped sources are not attempts.
 */
export function runStateOf(
  sources: RunSources,
  linkRebuildFailed = false,
): Exclude<RunState, 'running' | 'interrupted'> {
  const attempted = Object.values(sources)
    .map((entry) => entry.state)
    .filter((state): state is AttemptResult => state !== 'skipped');
  if (linkRebuildFailed) attempted.push('failed');
  if (attempted.length === 0 || attempted.every((state) => state === 'succeeded'))
    return 'succeeded';
  if (attempted.every((state) => state === 'failed')) return 'failed';
  return 'partial';
}

const DEFAULT_STATUS: Record<AttemptResult, string> = {
  succeeded: 'ok',
  partial: 'partial',
  failed: 'failed',
};

/** The run's entry for a finished source: only the facts that were reported, so the JSON stays small. */
function entryFor(report: AdapterReport): RunSourceEntry {
  if (report.result === 'skipped') {
    return { state: 'skipped', ...(report.message ? { message: report.message } : {}) };
  }
  const message =
    report.message ?? (report.result === 'failed' ? report.errorDetail : null) ?? null;
  return {
    state: report.result,
    ...(report.imported !== undefined ? { imported: report.imported } : {}),
    ...(report.duplicatesSkipped !== undefined
      ? { duplicatesSkipped: report.duplicatesSkipped }
      : {}),
    ...(report.unreadable !== undefined ? { unreadable: report.unreadable } : {}),
    ...(message ? { message } : {}),
  };
}

export function createRunner(deps: RunnerDeps): Runner {
  const { db, now, logger } = deps;
  const adapters = new Map(deps.adapters.map((adapter) => [adapter.id, adapter]));
  const rebuildLinks = deps.afterSources?.some((step) => 'rebuild' in step) ?? false;
  let current: Promise<void> | null = null;

  /** Writes the attempt, or says the result couldn't be saved. A failed save changes nothing in `source_state`. */
  function record(sourceId: RefreshSourceId, report: AdapterReport): RunSourceEntry {
    if (report.result === 'skipped') return entryFor(report);
    try {
      recordAttempt(db, {
        sourceId,
        result: report.result,
        at: now(),
        status: report.status ?? DEFAULT_STATUS[report.result],
        location: report.location ?? null,
        oldestEventAt: report.oldestEventAt ?? null,
        unreadable: report.unreadable ?? 0,
        unsupported: report.unsupported ?? 0,
        errorCode: report.errorCode ?? null,
        errorDetail: report.errorDetail ?? null,
        adapterVersion: report.adapterVersion ?? null,
      });
    } catch (error) {
      logger.error('could not record a source attempt', {
        source: sourceId,
        code: 'record',
        error,
      });
      // A full disk is the one failure with its own sentence: the attempt could not be saved either, and the owner needs to know why.
      return {
        state: 'failed',
        message: isDiskFull(error) ? DISK_FULL_IMPORT_MESSAGE : UNEXPECTED,
      };
    }
    return entryFor(report);
  }

  async function attempt(runId: number, sourceId: RefreshSourceId, sources: RunSources) {
    const adapter = adapters.get(sourceId);
    if (!adapter) return;
    sources[sourceId] = { state: 'running' };
    updateRunSources(db, runId, sources);
    // Progress goes to the run row as the source's message while it runs: the first figure at once, then at most one write per
    // interval, and never after the attempt has ended (the finished entry below replaces it, so a late call cannot bring it back).
    let attempting = true;
    let lastWrite = Number.NEGATIVE_INFINITY;
    const progress = (value: ImportProgress) => {
      const at = performance.now();
      if (!attempting || at - lastWrite < PROGRESS_INTERVAL_MS) return;
      lastWrite = at;
      try {
        sources[sourceId] = { state: 'running', message: progressMessage(value) };
        updateRunSources(db, runId, sources);
      } catch (error) {
        logger.warn('could not save import progress', {
          source: sourceId,
          code: 'progress',
          error,
        });
      }
    };
    let report: AdapterReport;
    try {
      report = await adapter.refresh({ db, now, logger, progress });
    } catch (error) {
      const full = isDiskFull(error);
      logger.error(full ? 'the disk is full during a refresh' : 'a source adapter threw', {
        source: sourceId,
        code: full ? 'disk_full' : 'adapter',
        error,
      });
      // A full disk fails the run with its own sentence and the usual Retry; what was already committed stays as it was.
      const sentence = full ? DISK_FULL_IMPORT_MESSAGE : UNEXPECTED;
      report = {
        result: 'failed',
        errorCode: full ? 'disk_full' : 'unexpected_error',
        errorDetail: sentence,
        message: sentence,
      };
    }
    attempting = false;
    sources[sourceId] = record(sourceId, report);
    updateRunSources(db, runId, sources);
  }

  async function runSteps(
    steps: RunnerDeps['afterSources'],
    when: 'before' | 'after',
    runId: number,
  ): Promise<boolean> {
    let linkRebuildFailed = false;
    for (const step of steps ?? []) {
      try {
        if ('rebuild' in step) {
          if (readLinkHealth(db).state === 'fresh') recordLinkRebuildResult(db, runId, null);
          else step.rebuild(runId);
        } else await step.run();
      } catch (error) {
        logger.error(`a step ${when} the sources failed`, {
          source: 'refresh',
          step: step.name,
          error,
        });
        if ('rebuild' in step) {
          recordLinkRebuildResult(db, runId, 'failed');
          linkRebuildFailed = true;
        }
      }
    }
    return linkRebuildFailed;
  }

  async function execute(runId: number, stages: RefreshSourceId[][], sources: RunSources) {
    await runSteps(deps.beforeSources, 'before', runId);
    for (const stage of stages) {
      const attempts = await Promise.allSettled(
        stage.map((sourceId) => attempt(runId, sourceId, sources)),
      );
      const rejected = attempts.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    const linkRebuildFailed = await runSteps(deps.afterSources, 'after', runId);
    finishRun(db, runId, {
      state: runStateOf(sources, linkRebuildFailed),
      finishedAt: now(),
      sources,
    });
  }

  return {
    start({ trigger, sources: requested }) {
      const running = getRunningRun(db);
      if (running) return { started: false, runId: running.id };

      const wanted = new Set<RefreshSourceId>(requested ?? REFRESH_STAGES.flat());
      const stages = REFRESH_STAGES.map((stage) => stage.filter((id) => wanted.has(id)))
        .filter((stage) => stage.length > 0)
        .map((stage) => [...stage]);
      const sources: RunSources = {};
      for (const id of stages.flat()) {
        sources[id] = adapters.has(id)
          ? { state: 'queued' }
          : { state: 'skipped', message: NO_ADAPTER };
      }

      const runId = createRun(db, { trigger, startedAt: now(), sources, rebuildLinks });
      const run = getRun(db, runId) as RunRow;
      const task: Promise<void> = execute(runId, stages, sources)
        .catch((error: unknown) => {
          // Something outside an adapter broke (the database, say). Close the run so nothing looks active forever.
          const full = isDiskFull(error);
          logger.error('a refresh run broke', {
            source: 'refresh',
            code: full ? 'disk_full' : 'run',
            error,
          });
          try {
            for (const id of Object.keys(sources)) {
              const entry = sources[id];
              if (entry?.state === 'queued' || entry?.state === 'running') {
                sources[id] = {
                  state: 'failed',
                  message: full ? DISK_FULL_IMPORT_MESSAGE : UNEXPECTED,
                };
              }
            }
            if (rebuildLinks) recordLinkRebuildResult(db, runId, 'interrupted');
            finishRun(db, runId, { state: 'failed', finishedAt: now(), sources });
          } catch {
            // The database is the thing that broke; boot marks a run left `running` as interrupted.
          }
        })
        .finally(() => {
          if (current === task) current = null;
        });
      current = task;
      return { started: true, run };
    },
    idle: async () => {
      while (current) await current;
    },
  };
}
