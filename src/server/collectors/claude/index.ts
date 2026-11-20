import { relative, sep } from 'node:path';
import {
  type EventWrite,
  type SourceFileRow,
  createEventWriter,
  finishClaudeReconciliation,
  findSessionId,
  listSourceFiles,
  recordNormalization,
  storedAdapterVersion,
} from '../../db/queries/ingest.ts';
import { writeSessionRefs } from '../../db/queries/links.ts';
import { upsertSession } from '../../db/queries/usage.ts';
import {
  ImportTally,
  LineReader,
  classifyFsError,
  commitFile,
  createRepoResolver,
  deniedReport,
  failedReport,
  fileChunks,
  finishReport,
  headHash,
  listFiles,
  markFile,
  notFoundReport,
  planRead,
  sessionStart,
  type ListedFile,
  type ReadPlan,
} from '../ingest/index.ts';
import type { AdapterContext, AdapterReport, SourceAdapter } from '../types.ts';
import { classifyTranscript, projectRoots, type Transcript } from './files.ts';
import { TranscriptScan } from './transcript.ts';

// The Claude Code adapter (data-and-sources › Claude Code transcripts; the shape of an adapter is in ../ingest/CONTRACT.md).
//
// A refresh looks in `projects/` of every Claude config dir it is given, reads only what changed (from the stored offset, to
// the last complete line), and writes each file in one transaction: its sessions, its events and the offset together.
// A main transcript is a root session; a file under `<session>/subagents/` is a child of that session (native_kind
// `claude_subagent`, parent_basis `native`). One event per message, by ccusage's rules (docs/implementation/ccusage-rules.md): a
// repeated copies prefer the main thread, then the larger total, then speed metadata, then import order. The winning line
// supplies its session ID and all categories. Session start is the earliest line of any type, else the first usage.
//
// What can go wrong never carries text: a line that cannot be read is counted, and an error is reduced to the file system's
// code before it is stored or logged.

/**
 * Bumped when the counting rules change. A source last read under another version has every transcript it still has read again from
 * the start, and each message goes through the current rules against what is stored (a log that was deleted keeps its events).
 */
export const CLAUDE_ADAPTER_VERSION = 'claude-transcripts-3';

const SOURCE = 'claude';
const NATIVE_KIND = 'claude_subagent';

interface Candidate {
  file: ListedFile;
  transcript: Transcript;
}

interface Pending extends Candidate {
  plan: Extract<ReadPlan, { action: 'read' }>;
  tracked: SourceFileRow | null;
}

export function createClaudeAdapter(options: {
  /** The Claude config dirs to look in; each holds `projects/`. Called at the start of every attempt. */
  configDirs: () => readonly string[];
}): SourceAdapter {
  return {
    id: SOURCE,
    async refresh(context) {
      const state: { location: string | null } = { location: null };
      try {
        return await refreshOnce(context, options.configDirs(), state);
      } catch (error) {
        // Only the file system's code is kept: nothing else about an error is known to be free of file content.
        const { code } = classifyFsError(error);
        context.logger.error('claude refresh failed', { code });
        return failedReport(SOURCE, state.location, code);
      }
    },
  };
}

async function refreshOnce(
  context: AdapterContext,
  configDirs: readonly string[],
  state: { location: string | null },
): Promise<AdapterReport> {
  const { db } = context;

  // Roots: each config dir's projects/ folder says ok, notfound or denied on its own.
  const roots = await projectRoots(configDirs);
  const listings = [];
  for (const root of roots) {
    listings.push({
      root,
      listing: await listFiles(root, (rel) => classifyTranscript(rel) !== null),
    });
  }
  const readable = listings.filter((item) => item.listing.state === 'ok');
  const tracked = new Map(listSourceFiles(db, SOURCE).map((row) => [row.path, row]));

  if (readable.length === 0) {
    // Every root that is there is unreadable: the attempt failed and what was imported earlier is untouched (P-07).
    const existing = listings.filter((item) => item.listing.state !== 'notfound');
    const first = existing[0];
    if (first !== undefined) {
      state.location = first.root;
      const denied = existing.every((item) => item.listing.state === 'denied');
      const code = first.listing.code ?? 'unknown';
      return denied
        ? deniedReport(SOURCE, first.root, { code })
        : failedReport(SOURCE, first.root, code);
    }
  }
  state.location = readable[0]?.root ?? null;
  // A root that exists but cannot be read, beside one that can, makes the result partial.
  let inaccessible = 0;
  for (const { listing } of listings) {
    inaccessible +=
      listing.inaccessible + (listing.state === 'denied' || listing.state === 'failed' ? 1 : 0);
  }

  // The files, main transcripts first so a subagent's parent session exists when the child is written, then what to read of each:
  // a file that has not changed costs a stat and nothing more (C10).
  const candidates: Candidate[] = [];
  const known = new Set<string>();
  for (const { root, listing } of readable) {
    for (const file of listing.files) {
      if (known.has(file.path)) continue;
      const transcript = classifyTranscript(relative(root, file.path).split(sep).join('/'));
      if (transcript === null) continue;
      known.add(file.path);
      candidates.push({ file, transcript });
    }
  }
  // Nothing here and nothing imported before: Claude Code is not on this machine. (With files tracked, their logs were deleted
  // and what was imported stays, P-29: the attempt runs and finds nothing to read.)
  if (candidates.length === 0 && tracked.size === 0 && inaccessible === 0) {
    return notFoundReport(SOURCE);
  }
  const mainsFirst = (a: Candidate, b: Candidate): number =>
    Number(a.transcript.kind === 'subagent') - Number(b.transcript.kind === 'subagent') ||
    (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0);
  candidates.sort(mainsFirst);

  const tally = new ImportTally();
  const pending: Pending[] = [];
  const unchangedChildren: Candidate[] = [];
  // Imported under older counting rules: every transcript still here is read again from the start, changed or not.
  const stored = storedAdapterVersion(db, SOURCE);
  const recount = stored !== null && stored !== CLAUDE_ADAPTER_VERSION;
  for (const candidate of candidates) {
    const row = tracked.get(candidate.file.path) ?? null;
    try {
      let plan: ReadPlan = await planRead(row, candidate.file);
      if (row !== null && (recount || row.normalizationVersion !== CLAUDE_ADAPTER_VERSION)) {
        plan = { action: 'read', from: 0, why: 'replaced' };
      }
      // A transcript read to its end with no usage in it made no session (see importFile), so the lines before the stored offset, where
      // its real start is written, were never put anywhere. Reading only what was appended would take the first appended line's time
      // for the start: read it from the start instead. Nothing earlier was written for it (no usage, so no events), so this is exact.
      if (
        plan.action === 'read' &&
        plan.from > 0 &&
        findSessionId(db, SOURCE, candidate.transcript.sessionId) === null
      ) {
        plan = { action: 'read', from: 0, why: 'replaced' };
      }
      if (plan.action === 'read') pending.push({ ...candidate, plan, tracked: row });
      else {
        tally.filesUnchanged += 1;
        if (candidate.transcript.kind === 'subagent') unchangedChildren.push(candidate);
      }
    } catch (error) {
      noteUnreadable(context, candidate.file, row, error);
    }
  }
  if (pending.length > 0) context.progress({ done: 0, total: pending.length });

  // Read and commit one file at a time.
  const resolveRepo = createRepoResolver();
  const createdRoots = new Set<string>();
  let done = 0;
  for (const item of pending) {
    const created = await importFile(context, item, resolveRepo, tally);
    if (created && item.transcript.kind === 'main') createdRoots.add(item.transcript.sessionId);
    done += 1;
    context.progress({ done, total: pending.length });
  }
  finishClaudeReconciliation(db);

  // A parent that appeared only now (its main transcript was unreadable before) adopts the children already stored: their files
  // are unchanged, so nothing else would link them.
  for (const { file, transcript } of unchangedChildren) {
    if (transcript.kind !== 'subagent' || !createdRoots.has(transcript.parentId)) continue;
    if (findSessionId(db, SOURCE, transcript.sessionId) === null) continue;
    upsertSession(db, {
      provider: SOURCE,
      providerSessionId: transcript.sessionId,
      kind: 'child',
      parentSessionId: findSessionId(db, SOURCE, transcript.parentId),
      parentBasis: 'native',
      nativeKind: NATIVE_KIND,
      // The stored start is kept: it only ever moves earlier, and a file's modified time is never earlier than its start.
      startedAt: file.mtimeMs,
      startedBasis: 'first_event',
    });
  }

  context.logger.debug('claude refresh read', {
    filesRead: tally.filesRead,
    filesUnchanged: tally.filesUnchanged,
    newSessions: tally.newSessions,
    eventsInserted: tally.eventsInserted,
    eventsReplaced: tally.eventsReplaced,
    eventsSkipped: tally.eventsSkipped,
  });
  return finishReport({
    source: SOURCE,
    db,
    tally,
    location: state.location,
    inaccessible,
    adapterVersion: CLAUDE_ADAPTER_VERSION,
  });
}

/** A file that could not be opened or read: tried again next refresh. One that vanished since it was listed is just gone. */
function noteUnreadable(
  context: AdapterContext,
  file: ListedFile,
  row: SourceFileRow | null,
  error: unknown,
): void {
  const { kind, code } = classifyFsError(error);
  if (kind === 'notfound') return;
  context.logger.warn('claude file unreadable', { code });
  markFile(context.db, {
    sourceId: SOURCE,
    file,
    state: 'unreadable',
    now: context.now(),
    tracked: row,
  });
}

/** Reads one file and commits it. Returns whether it created its session. */
async function importFile(
  context: AdapterContext,
  item: Pending,
  resolveRepo: ReturnType<typeof createRepoResolver>,
  tally: ImportTally,
): Promise<boolean> {
  const { db } = context;
  const { file, transcript, plan, tracked } = item;
  const scan = new TranscriptScan(
    transcript.kind === 'main' ? transcript.sessionId : transcript.parentId,
    transcript.kind === 'subagent',
  );
  let hash: string;
  let reader: LineReader;
  try {
    hash = await headHash(file.path, file.size);
    reader = new LineReader(fileChunks(file.path, plan.from), { from: plan.from });
    for await (const text of reader.lines()) scan.add(text);
  } catch (error) {
    noteUnreadable(context, file, tracked, error);
    return false;
  }
  tally.filesRead += 1;

  const span = scan.eventSpan();
  const start = sessionStart(scan.earliestLine, span?.first ?? null);
  const repo = resolveRepo(scan.cwd);
  const writes: EventWrite[] = [];
  let created = false;

  commitFile(
    db,
    {
      sourceId: SOURCE,
      file,
      headHash: hash,
      from: plan.from,
      endOffset: reader.endOffset,
      tracked,
      unreadableLines: scan.unreadable + reader.overlong,
      now: context.now(),
    },
    (fileId) => {
      recordNormalization(db, fileId, CLAUDE_ADAPTER_VERSION);
      const existing = findSessionId(db, SOURCE, transcript.sessionId);
      // A file with no usage yet is not a session worth a row: the next read that has some creates it. One that is already
      // stored still takes what this read learned (a title written later, a new branch).
      if (span === null && existing === null) return;
      created = existing === null;
      const sessionId = upsertSession(db, {
        provider: SOURCE,
        providerSessionId: transcript.sessionId,
        kind: transcript.kind === 'main' ? 'root' : 'child',
        parentSessionId:
          transcript.kind === 'subagent' ? findSessionId(db, SOURCE, transcript.parentId) : null,
        parentBasis: transcript.kind === 'subagent' ? 'native' : null,
        nativeKind: transcript.kind === 'subagent' ? NATIVE_KIND : null,
        recordedName: scan.title,
        nameSource: scan.title === null ? null : 'provider_title',
        repoId: repo.repoId,
        repoBasis: repo.basis,
        cwd: scan.cwd,
        gitBranch: scan.gitBranch,
        // When this read has no timestamp at all, the stored start stays: a file's modified time is never before its start.
        startedAt: start?.startedAt ?? file.mtimeMs,
        startedBasis: start?.startedBasis ?? 'first_event',
        firstEventAt: span?.first ?? null,
        lastEventAt: span?.last ?? null,
        lastModel: span?.lastModel ?? null,
      });
      // The identifiers the file named (PR references, commit ids, branches), in the same transaction as the session they belong to.
      writeSessionRefs(db, sessionId, scan.refs.refs());
      // [A2] an event is counted for the session of the file that holds the copy that survives: the oracle's session report groups by
      // file, not by the `sessionId` a line carries (a resumed transcript's copied lines keep the old one). [A4] one copy of a message
      // survives whichever file is read first, so a file read later can take an event from one read earlier, and never the other way.
      const writer = createEventWriter(db);
      for (const event of scan.events.values()) {
        writes.push(
          writer.write(
            {
              provider: SOURCE,
              dedupeKey: event.dedupeKey,
              sessionId,
              occurredAt: event.occurredAt,
              model: event.model,
              inputTokens: event.input,
              cacheWriteTokens: event.cacheWrite,
              cacheReadTokens: event.cacheRead,
              outputTokens: event.output,
              providerTotal: event.total,
              sourceFileId: fileId,
              copy: {
                sidechain: event.sidechain,
                hasSpeed: event.hasSpeed,
                path: file.path,
              },
            },
            'survivor',
          ),
        );
      }
    },
  );

  // Counted only once the transaction is through: a file that rolled back is read again.
  if (created) tally.newSessions += 1;
  for (const write of writes) tally.addEvent(write);
  tally.eventsSkipped += scan.repeated;
  return created;
}
