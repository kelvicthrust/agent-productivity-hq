import { basename, dirname, join, posix } from 'node:path';
import { liveTime } from '../../lib/liveTime.ts';
import { MAX_LIVE_PATH_CHARS, fits, liveTitle } from '../../lib/liveText.ts';
import type { Logger } from '../../lib/logger.ts';
import type { Sleep } from '../../lib/sleep.ts';
import { classifyTranscript, projectRoots, type Transcript } from '../claude/files.ts';
import { asRecord, parseJsonLine } from '../ingest/index.ts';
import { projectClaudeLine } from './claudeActivity.ts';
import { statWithin, type OpenFiles } from './confined.ts';
import {
  createTranscriptFeed,
  type Tracker,
  type TranscriptFeed,
  type TranscriptParent,
} from './feed.ts';
import { createSessionMachine } from './machine.ts';
import type { RecentFile } from './recent.ts';
import { tailFile } from './tail.ts';

// The Claude Code transcript feed: `projects/<project>/<session>.jsonl` are main sessions and `projects/<project>/<session>/subagents/*.jsonl`
// their subagents (native children), exactly the files the batch importer reads (`classifyTranscript`); set-aside copies are skipped.
// Claude Code writes its transcripts there for the terminal, the desktop app's Code tab and the Agent SDK alike (E9).

export interface ClaudeFeedOptions {
  /** The Claude config dirs (`$CLAUDE_CONFIG_DIR`, else `~/.config/claude` and `~/.claude`); each holds `projects/`. Asked at every full listing. */
  configDirs: () => readonly string[];
  now: () => number;
  logger: Logger;
  sleep?: Sleep;
  pollMs?: number;
}

const MAX_SUBAGENT_METADATA_BYTES = 16 * 1024;

/** Read only the metadata next to this child, through the same guarded handles as its transcript. */
async function readSubagentTitle(
  file: RecentFile,
  signal: AbortSignal,
  files: OpenFiles,
): Promise<string | null> {
  const path = `${file.path.slice(0, -'.jsonl'.length)}.meta.json`;
  try {
    const metadata = await statWithin(file.guard, path);
    if (signal.aborted || !metadata || metadata.size > MAX_SUBAGENT_METADATA_BYTES) return null;
    const opened = await files.open({ path, guard: metadata.guard });
    try {
      if (signal.aborted) return null;
      const buffer = Buffer.allocUnsafe(metadata.size + 1);
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0);
      if (signal.aborted || bytesRead !== metadata.size) return null;
      const record = asRecord(parseJsonLine(buffer.toString('utf8', 0, bytesRead)));
      return liveTitle(record?.['agentType']);
    } finally {
      await opened.close();
    }
  } catch {
    // Missing, unreadable or replaced metadata never interrupts the child's transcript.
    return null;
  }
}

function createClaudeTracker(
  transcript: Transcript,
  readTitle?: () => Promise<string | null>,
): Tracker {
  const machine = createSessionMachine();
  const sidechainFile = transcript.kind === 'subagent';
  const parentSessionId = transcript.kind === 'subagent' ? transcript.parentId : null;
  let cwd: string | null = null;
  let subagentTitle: string | null = null;
  return {
    ...(readTitle && {
      async refreshMetadata() {
        subagentTitle ??= await readTitle();
      },
    }),
    line(text, observedAt) {
      const projected = projectClaudeLine(parseJsonLine(text), sidechainFile);
      if (projected === null) return;
      cwd = fits(projected.cwd, MAX_LIVE_PATH_CHARS) ?? cwd;
      // A line whose time is not one HQ keeps (`liveTime`) counts as written when it was seen, if it is part of the conversation. A
      // bookkeeping line with no time of its own (Claude Code's `cost-state`, appended to an old transcript) says nothing about when the
      // conversation happened, so it is not read as activity.
      const at = liveTime(projected.at, observedAt);
      if (at === null && projected.events.length === 0) return;
      machine.apply(projected.events, at ?? observedAt);
    },
    overlong: (observedAt) => machine.overlong(observedAt),
    agent(now, options) {
      // A subagent's calls wait on the same owner as its parent's: the hooks speak for the main session.
      const hooked = transcript.kind === 'subagent' ? transcript.parentId : transcript.sessionId;
      const seen = machine.evaluate(now, {
        guessPermission: options?.guessesPermission?.(hooked) ?? true,
      });
      if (seen === null) return null;
      return {
        provider: 'claude',
        sessionId: transcript.sessionId,
        parentSessionId,
        cwd,
        startedAt: null,
        ...(subagentTitle !== null && { subagentTitle }),
        ...seen,
      };
    },
  };
}

/** The folders a new session or subagent file would appear in: beside each followed file, and a main session's own `subagents/` folder. */
function hotDirs(followed: readonly RecentFile[]): string[] {
  const dirs: string[] = [];
  for (const file of followed) {
    const folder = dirname(file.path);
    dirs.push(folder);
    if (classifyTranscript(file.rel)?.kind === 'main')
      dirs.push(join(folder, basename(file.path, '.jsonl'), 'subagents'));
  }
  return dirs;
}

type ParentFile = NonNullable<Awaited<ReturnType<typeof statWithin>>>;

function createParentLookup() {
  type CachedParent = { file: ParentFile; parent: TranscriptParent | null };
  let cache = new Map<string, CachedParent>();

  return async (
    children: readonly RecentFile[],
    now: number,
    signal: AbortSignal,
    files: OpenFiles,
    checkDeadline: () => void,
  ): Promise<TranscriptParent[]> => {
    const candidates = new Map<string, { scope: RecentFile['guard']; sessionId: string }>();
    for (const child of children) {
      const parent = classifyTranscript(`${posix.dirname(posix.dirname(child.rel))}.jsonl`);
      if (parent?.kind !== 'main') continue;
      const path = `${dirname(dirname(child.path))}.jsonl`;
      candidates.set(path, { scope: child.guard, sessionId: parent.sessionId });
    }

    const next = new Map<string, CachedParent>();
    const parents: TranscriptParent[] = [];
    for (const [path, { scope, sessionId }] of candidates) {
      if (signal.aborted) return [];
      try {
        const file = await statWithin(scope, path);
        if (signal.aborted) return [];
        checkDeadline();
        if (file === null) continue;
        const held = cache.get(path);
        const unchanged =
          held !== undefined &&
          held.file.guard.realRoot === file.guard.realRoot &&
          held.file.guard.dev === file.guard.dev &&
          held.file.guard.ino === file.guard.ino &&
          held.file.size === file.size &&
          held.file.mtimeMs === file.mtimeMs;
        const parent = unchanged
          ? held.parent
          : await readParent(path, file, sessionId, now, signal, files);
        next.set(path, { file, parent });
        if (parent !== null) parents.push(parent);
      } catch {
        // The parent can disappear or be refused between stat and read. The child is still valid.
      } finally {
        checkDeadline();
      }
    }
    if (signal.aborted) return [];
    cache = next;
    return parents;
  };
}

async function readParent(
  path: string,
  file: ParentFile,
  sessionId: string,
  now: number,
  signal: AbortSignal,
  files: OpenFiles,
): Promise<TranscriptParent | null> {
  let lastActivityAt: number | null = null;
  let cwd: string | null = null;
  await tailFile(
    { path, ...file },
    null,
    {
      begin() {},
      overlong() {},
      line(text) {
        const projected = projectClaudeLine(parseJsonLine(text), false);
        if (!projected?.events.length) return;
        const at = liveTime(projected.at, now);
        if (at === null || (lastActivityAt !== null && at < lastActivityAt)) return;
        lastActivityAt = at;
        cwd = fits(projected.cwd, MAX_LIVE_PATH_CHARS) ?? cwd;
      },
    },
    signal,
    files,
  );
  return lastActivityAt === null ? null : { sessionId, cwd, lastActivityAt };
}

export function createClaudeFeed(options: ClaudeFeedOptions): TranscriptFeed {
  return createTranscriptFeed({
    now: options.now,
    logger: options.logger,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    source: {
      provider: 'claude',
      roots: (signal) => projectRoots(options.configDirs(), signal),
      accept: (rel) => classifyTranscript(rel) !== null,
      hotDirs,
      parentLookup: createParentLookup,
      start: (file, signal, files) => {
        const transcript = classifyTranscript(file.rel);
        if (transcript === null) return Promise.resolve(null);
        const readTitle =
          transcript.kind === 'subagent' ? () => readSubagentTitle(file, signal, files) : undefined;
        return Promise.resolve(createClaudeTracker(transcript, readTitle));
      },
    },
  });
}
