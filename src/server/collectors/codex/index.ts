import type { Transform } from 'node:stream';
import * as zlib from 'node:zlib';
import { basename } from 'node:path';
import type { Db } from '../../db/open.ts';
import {
  createEventWriter,
  codexFileOwnsSession,
  retainFileEvents,
  findSessionId,
  listSourceFiles,
  moveCodexFileEvents,
  recordNormalization,
  refreshCodexSessionBounds,
  rememberCodexParent,
  storedAdapterVersion,
  type EventWrite,
  type SourceFileRow,
} from '../../db/queries/ingest.ts';
import { writeSessionRefs } from '../../db/queries/links.ts';
import { upsertSession, type SessionKind } from '../../db/queries/usage.ts';
import type { AdapterContext, AdapterReport, SourceAdapter } from '../types.ts';
import {
  ImportTally,
  classifyFsError,
  commitFile,
  createRepoResolver,
  deniedReport,
  failedReport,
  finishReport,
  headHash,
  markFile,
  notFoundReport,
  planRead,
  sessionStart,
  type RepoResolution,
} from '../ingest/index.ts';
import { findRollouts, threadIdFromName, type RolloutFile } from './files.ts';
import { readRollout, type RolloutRead, type ZstdDecoder } from './read.ts';
import { ownEvents } from './replay.ts';
import { eventKey, type ParsedRollout, type RolloutEvent, type RolloutMeta } from './rollout.ts';

// The Codex adapter (data-and-sources › Codex local rollouts). The shape is in ../ingest/CONTRACT.md; this file is how one
// attempt goes for Codex: find the rollouts, read each that changed from byte 0, commit each in one transaction.
//
// What is specific to Codex and lives in the other files of this folder:
//   files.ts    which copy of a rollout is read (plain over `.zst`, `sessions/` over `archived_sessions/`)
//   rollout.ts  one rollout's lines to events by ccusage's rules (docs/implementation/ccusage-rules.md), the source and parent reference
//   replay.ts   what a fork or spawned child copied from its parent, found by comparing it with the parent's own events
//   read.ts     one file to its parsed contents, decoding zstd as a stream
// Names (`thread/list`) arrive in a later milestone: nothing here runs `codex` or reads the environment.

/**
 * Bumped when the counting rules change. A source last read under another version has every file it still has read again, and
 * each file's events are replaced by what the new rules make of it (events of a log that has since been deleted stay as they were).
 */
export const ADAPTER_VERSION = 'codex-rollout/3';

export interface CodexAdapterOptions {
  /** The Codex homes to look in (each holds `sessions/` and `archived_sessions/`). Called at the start of every attempt. */
  homes: () => readonly string[];
  /** How to decode `.jsonl.zst`. Defaults to `node:zlib`'s decoder; `null` stands for a Node without one (a test seam). */
  zstd?: ZstdDecoder | null;
}

const nodeZstd: ZstdDecoder | null =
  typeof zlib.createZstdDecompress === 'function'
    ? (): Transform => zlib.createZstdDecompress()
    : null;

interface Job {
  file: RolloutFile;
  tracked: SourceFileRow | null;
  state: 'pending' | 'running' | 'done';
}

/** The selected parent can move from an active rollout to an archive. */
function rolloutVersion(file: RolloutFile): string {
  return JSON.stringify([file.path, file.size, file.mtimeMs]);
}

const rolloutName = (path: string): string => basename(path).replace(/\.zst$/, '');

function indexRollouts(files: readonly RolloutFile[]): Map<string, RolloutFile> {
  const indexed = new Map<string, RolloutFile>();
  for (const file of files) {
    const id = threadIdFromName(file.path);
    if (id !== null && !indexed.has(id)) indexed.set(id, file);
  }
  return indexed;
}

export function createCodexAdapter(options: CodexAdapterOptions): SourceAdapter {
  const zstd = options.zstd === undefined ? nodeZstd : options.zstd;
  return { id: 'codex', refresh: (context) => refreshCodex(context, options.homes, zstd) };
}

async function refreshCodex(
  context: AdapterContext,
  homes: () => readonly string[],
  zstd: ZstdDecoder | null,
): Promise<AdapterReport> {
  try {
    const found = await findRollouts(homes());
    if (found.outcome === 'denied')
      return deniedReport('codex', found.location, { code: found.code });
    if (found.outcome === 'failed') return failedReport('codex', found.location, found.code);

    const tracked = listSourceFiles(context.db, 'codex');
    const files = found.outcome === 'files' ? found.files : [];
    const location = found.outcome === 'files' ? found.location : null;
    const inaccessible = found.outcome === 'files' ? found.inaccessible : 0;
    // Nothing here and nothing imported before: Codex has not run on this machine. Files imported before stay (P-29).
    if (files.length === 0 && tracked.length === 0 && inaccessible === 0)
      return notFoundReport('codex');

    const tally = new ImportTally();
    const known = new Map(tracked.map((row) => [row.path, row]));
    // Imported under older counting rules: every file still here is read again, whether or not it changed.
    const stored = storedAdapterVersion(context.db, 'codex');
    const recount = stored !== null && stored !== ADAPTER_VERSION;
    const fileByThread = indexRollouts(files);
    const jobs: Job[] = [];
    for (const file of files) {
      const row = known.get(file.path) ?? null;
      try {
        // The plan's offset is not used: a changed rollout is always read again from byte 0 (see read.ts).
        const parent = row?.codexParentId ? fileByThread.get(row.codexParentId) : undefined;
        const parentChanged =
          parent !== undefined && rolloutVersion(parent) !== row?.codexParentVersion;
        const needsNormalization =
          row !== null &&
          row.state !== 'unsupported' &&
          row.normalizationVersion !== ADAPTER_VERSION &&
          (row.codexParentId === null || parent !== undefined);
        if (
          recount ||
          needsNormalization ||
          parentChanged ||
          (await planRead(row, file)).action === 'read'
        )
          jobs.push({ file, tracked: row, state: 'pending' });
        else tally.filesUnchanged += 1;
      } catch (error) {
        if (classifyFsError(error).kind !== 'notfound')
          markFile(context.db, {
            sourceId: 'codex',
            file,
            state: 'unreadable',
            now: context.now(),
            tracked: row,
          });
      }
    }

    if (jobs.length > 0) {
      const selected = new Set(files.map((file) => file.path));
      const alternatives = new Map<string, SourceFileRow[]>();
      for (const file of tracked) {
        if (selected.has(file.path)) continue;
        const name = rolloutName(file.path);
        const others = alternatives.get(name);
        if (others) others.push(file);
        else alternatives.set(name, [file]);
      }
      await importJobs(context, jobs, fileByThread, alternatives, zstd, tally);
    }
    return finishReport({
      source: 'codex',
      db: context.db,
      tally,
      location,
      inaccessible,
      adapterVersion: ADAPTER_VERSION,
    });
  } catch (error) {
    return failedReport('codex', null, classifyFsError(error).code);
  }
}

/** The relationship a session is stored with. A spawned subagent is a child only when its parent is a session we hold. */
function relationship(
  db: Db,
  meta: RolloutMeta,
): { kind: SessionKind; parentSessionId: number | null } {
  if (meta.source.kind === 'root') return { kind: 'root', parentSessionId: null };
  if (meta.source.kind === 'spawned' && meta.source.parentId !== null) {
    const parentSessionId = findSessionId(db, 'codex', meta.source.parentId);
    // No edge is ever guessed: a parent that is not named, or not imported, leaves the relationship unknown.
    if (parentSessionId !== null) return { kind: 'child', parentSessionId };
  }
  return { kind: 'unknown', parentSessionId: null };
}

/** Upserts the session a rollout belongs to (start, repo, relationship) and says whether it is new to the database. */
function storeSession(
  db: Db,
  meta: RolloutMeta,
  events: readonly RolloutEvent[],
  repo: RepoResolution,
): { id: number; created: boolean } {
  let first = Infinity;
  let last = -Infinity;
  let lastModel: string | null = null;
  for (const event of events) {
    first = Math.min(first, event.occurredAt);
    last = Math.max(last, event.occurredAt);
    if (event.model !== 'unknown') lastModel = event.model;
  }
  const created = findSessionId(db, 'codex', meta.id) === null;
  const start = sessionStart(meta.startedAt, first);
  const link = relationship(db, meta);
  const id = upsertSession(db, {
    provider: 'codex',
    providerSessionId: meta.id,
    kind: link.kind,
    parentSessionId: link.parentSessionId,
    parentBasis: link.parentSessionId === null ? null : 'native',
    nativeKind: meta.source.kind === 'spawned' ? 'codex_subagent' : null,
    repoId: repo.repoId,
    repoBasis: repo.basis,
    cwd: meta.cwd,
    gitBranch: meta.branch,
    startedAt: start?.startedAt ?? first,
    startedBasis: start?.startedBasis ?? 'first_event',
    firstEventAt: first,
    lastEventAt: last,
    lastModel,
  });
  return { id, created };
}

async function importJobs(
  context: AdapterContext,
  jobs: Job[],
  fileByThread: ReadonlyMap<string, RolloutFile>,
  alternativesByName: ReadonlyMap<string, readonly SourceFileRow[]>,
  zstd: ZstdDecoder | null,
  tally: ImportTally,
): Promise<void> {
  const { db } = context;
  const writer = createEventWriter(db);
  const resolveRepo = createRepoResolver();
  const byThread = new Map<string, Job>();
  for (const job of jobs) {
    const id = threadIdFromName(job.file.path);
    if (id !== null && !byThread.has(id)) byThread.set(id, job);
  }
  const parsedByPath = new Map<string, Promise<ParsedRollout | null>>();
  let done = 0;
  context.progress({ done, total: jobs.length });

  const mark = (job: Job, state: 'unreadable' | 'unsupported'): void =>
    markFile(db, {
      sourceId: 'codex',
      file: job.file,
      state,
      now: context.now(),
      tracked: job.tracked,
    });

  /** The parent's rollout, parsed on its own (its copied history included), once per attempt; null when it is not here or cannot be read. */
  async function parentOf(
    child: RolloutFile,
    parentId: string,
  ): Promise<{ parsed: ParsedRollout; version: string } | null> {
    const file = fileByThread.get(parentId.toLowerCase());
    if (!file || file.path === child.path) return null;
    let parsed = parsedByPath.get(file.path);
    if (!parsed) {
      parsed =
        file.compressed && !zstd
          ? Promise.resolve(null)
          : readRollout(file.path, file.compressed ? zstd : null).then(
              (read) => read.parsed,
              () => null,
            );
      parsedByPath.set(file.path, parsed);
    }
    const result = await parsed;
    return result?.meta?.id.toLowerCase() === parentId.toLowerCase()
      ? { parsed: result, version: rolloutVersion(file) }
      : null;
  }

  async function load(job: Job): Promise<{ read: RolloutRead; hash: string } | null> {
    if (job.file.compressed && !zstd) {
      mark(job, 'unsupported'); // no decoder: counted, and skipped until the file changes
      return null;
    }
    try {
      const hash = await headHash(job.file.path, job.file.size);
      return { read: await readRollout(job.file.path, job.file.compressed ? zstd : null), hash };
    } catch (error) {
      // Gone since it was listed: nothing to record. Anything else (permission, I/O, a damaged archive) is retried next time.
      if (classifyFsError(error).kind !== 'notfound') mark(job, 'unreadable');
      return null;
    }
  }

  function commit(
    job: Job,
    { read, hash }: { read: RolloutRead; hash: string },
    events: RolloutEvent[],
    alternatives: readonly SourceFileRow[],
    parent?: { id: string; version: string | null },
  ): void {
    const { meta, sawUsage } = read.parsed;
    if (meta === null && sawUsage) {
      mark(job, 'unsupported'); // usage with no session_meta to say whose it is: a format this adapter does not read
      return;
    }
    const repo =
      meta !== null && events.length > 0 ? resolveRepo(meta.cwd, meta.repositoryUrl) : null;
    const writes: EventWrite[] = [];
    let created = false;
    commitFile(
      db,
      {
        sourceId: 'codex',
        file: job.file,
        headHash: hash,
        from: 0,
        endOffset: read.endOffset,
        tracked: job.tracked,
        unreadableLines: read.unreadableLines,
        now: context.now(),
      },
      (fileId) => {
        recordNormalization(db, fileId, ADAPTER_VERSION, parent);
        if (meta !== null) {
          for (const prior of alternatives) moveCodexFileEvents(db, prior.id, fileId, meta.id);
        }
        // The file is read whole every time, so what it holds now is the complete set: events it brought in before that it no longer
        // holds (an older counting rule's among them) go, and the others are written, a skip when this or another file holds them.
        // A new rollout with no previously imported copy has no stored events to reconcile.
        if (job.tracked !== null || alternatives.length > 0) {
          retainFileEvents(
            db,
            fileId,
            new Set(events.map((event) => eventKey(meta?.id ?? '', event))),
          );
        }
        // A rollout with no usage in it is not imported: Usage is driven by events, and a session with none shows nowhere.
        if (meta === null) return;
        if (repo === null || events.length === 0) {
          const sessionId = findSessionId(db, 'codex', meta.id);
          if (sessionId !== null) refreshCodexSessionBounds(db, sessionId);
          return;
        }
        const session = storeSession(db, meta, events, repo);
        created = session.created;
        // The identifiers the rollout named, in the same transaction as the session they belong to.
        writeSessionRefs(db, session.id, read.parsed.refs);
        for (const event of events)
          writes.push(
            writer.write(
              {
                provider: 'codex',
                dedupeKey: eventKey(meta.id, event),
                sessionId: session.id,
                occurredAt: event.occurredAt,
                model: event.model,
                inputTokens: event.input,
                cachedInputTokens: event.cached,
                // Codex's cache-write tokens are inside `input` like the cached ones: stored in the same column Claude Code uses
                // for its separate category, never added to the provider total (input + output is the whole of it).
                cacheWriteTokens: event.cacheWrite,
                outputTokens: event.output,
                reasoningTokens: event.reasoning,
                providerTotal: event.providerTotal,
                sourceFileId: fileId,
              },
              'replace-owned',
            ),
          );
        if (job.tracked !== null || alternatives.length > 0)
          refreshCodexSessionBounds(db, session.id);
      },
    );
    tally.filesRead += 1;
    if (created) tally.newSessions += 1;
    for (const write of writes) tally.addEvent(write);
  }

  async function run(job: Job): Promise<void> {
    if (job.state !== 'pending') return;
    job.state = 'running';
    const loaded = await load(job);
    if (loaded) {
      parsedByPath.set(job.file.path, Promise.resolve(loaded.read.parsed));
      const source = loaded.read.parsed.meta?.source;
      const { fork } = loaded.read.parsed;
      const parentId = (
        fork?.parentId ?? (source?.kind === 'spawned' ? source.parentId : null)
      )?.toLowerCase();
      const parent = parentId === undefined ? undefined : byThread.get(parentId);
      if (parent) await run(parent);
      const evidence = parentId === undefined ? null : await parentOf(job.file, parentId);
      const meta = loaded.read.parsed.meta;
      const alternatives =
        meta === null
          ? []
          : (alternativesByName.get(rolloutName(job.file.path)) ?? []).filter((file) =>
              codexFileOwnsSession(db, file.id, meta.id),
            );
      const previous = job.tracked ?? alternatives[0];
      if (
        parentId !== undefined &&
        evidence === null &&
        previous &&
        (previous.codexParentVersion !== null ||
          (previous.normalizationVersion === null &&
            loaded.read.parsed.meta !== null &&
            findSessionId(db, 'codex', loaded.read.parsed.meta.id) !== null))
      ) {
        rememberCodexParent(db, previous.id, parentId);
      } else {
        const own = fork
          ? ownEvents(loaded.read.parsed, evidence?.parsed ?? null)
          : loaded.read.parsed.events;
        commit(
          job,
          loaded,
          own,
          alternatives,
          parentId === undefined ? undefined : { id: parentId, version: evidence?.version ?? null },
        );
      }
    }
    job.state = 'done';
    done += 1;
    context.progress({ done, total: jobs.length });
  }

  for (const job of jobs) await run(job);
}
