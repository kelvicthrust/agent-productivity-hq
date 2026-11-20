import { dirname, join } from 'node:path';
import { liveTime } from '../../lib/liveTime.ts';
import { MAX_LIVE_ID_CHARS, MAX_LIVE_PATH_CHARS, fits } from '../../lib/liveText.ts';
import type { Logger } from '../../lib/logger.ts';
import type { Sleep } from '../../lib/sleep.ts';
import { threadIdFromName } from '../codex/files.ts';
import { LineReader, parseJsonLine } from '../ingest/index.ts';
import { projectCodexLine, type CodexMeta } from './codexActivity.ts';
import { createTranscriptFeed, type Tracker, type TranscriptFeed } from './feed.ts';
import { streamOf, type OpenFiles } from './confined.ts';
import { CODEX_HEAD_BYTES } from './heuristics.ts';
import { createSessionMachine } from './machine.ts';
import type { RecentFile } from './recent.ts';

// The Codex transcript feed: the rollouts under `<home>/sessions/**/*.jsonl` that are being written. Compressed copies and
// `archived_sessions/` are not followed: a rollout being written is plain and active. Codex writes the same rollouts for its terminal
// UI, `codex exec`, the SDK and the desktop apps (E9: the originator and source differ, the files do not).

export interface CodexFeedOptions {
  /** The Codex homes (`$CODEX_HOME`, else `~/.codex`); each holds `sessions/`. Asked at every full listing. */
  homes: () => readonly string[];
  now: () => number;
  logger: Logger;
  sleep?: Sleep;
  pollMs?: number;
}

/** The first line of a rollout is `session_meta`: who the thread is and who spawned it. Only that line is read, from at most the start of the file. */
async function readMeta(
  file: RecentFile,
  signal: AbortSignal,
  files: OpenFiles,
): Promise<CodexMeta | null> {
  // Opened as the tail reader opens a file (the containment rule, a regular file, the one that was listed), through the feed's own
  // handles, so a stop closes it.
  const opened = await files.open(file);
  const handle = opened.handle;
  try {
    const { stream, release } = streamOf(handle, { start: 0, end: CODEX_HEAD_BYTES - 1 }, signal);
    try {
      const reader = new LineReader(stream, { maxLineBytes: CODEX_HEAD_BYTES });
      for await (const text of reader.lines()) {
        return boundedMeta(projectCodexLine(parseJsonLine(text))?.meta ?? null);
      }
      return null;
    } finally {
      release();
      stream.destroy();
    }
  } finally {
    await opened.close();
  }
}

/** The identity the first line gave, with an id or a path too long to be one left out (the file name's thread id stands in for the id). */
function boundedMeta(meta: CodexMeta | null): CodexMeta | null {
  const id = meta === null ? null : fits(meta.id, MAX_LIVE_ID_CHARS);
  if (meta === null || id === null) return null;
  return {
    ...meta,
    id,
    cwd: fits(meta.cwd, MAX_LIVE_PATH_CHARS),
    parentId: fits(meta.parentId, MAX_LIVE_ID_CHARS),
  };
}

function createCodexTracker(sessionId: string, meta: CodexMeta | null): Tracker {
  const machine = createSessionMachine();
  return {
    line(text, observedAt) {
      const projected = projectCodexLine(parseJsonLine(text));
      if (projected === null) return;
      // The identity is the one the file's first line gave; a `session_meta` inside the window (a fork replays its parent's) is not read.
      // As in Claude Code's feed: a line with no usable time of its own counts as written when it was seen only if it is part of the
      // conversation; a bookkeeping line with no time is not activity.
      const at = liveTime(projected.at, observedAt);
      if (at === null && projected.events.length === 0) return;
      machine.apply(projected.events, at ?? observedAt);
    },
    overlong: (observedAt) => machine.overlong(observedAt),
    agent(now) {
      const seen = machine.evaluate(now);
      if (seen === null) return null;
      return {
        provider: 'codex',
        sessionId,
        parentSessionId: meta?.parentId ?? null,
        cwd: meta?.cwd ?? null,
        startedAt: liveTime(meta?.startedAt, now),
        ...seen,
      };
    },
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `<root>/YYYY/MM/DD` for today and yesterday, by UTC and by local date: the folder a new rollout is created in. */
function dateDirs(root: string, now: number): string[] {
  const dirs: string[] = [];
  for (const back of [0, 1]) {
    const at = new Date(now - back * 86_400_000);
    dirs.push(
      join(root, String(at.getUTCFullYear()), pad(at.getUTCMonth() + 1), pad(at.getUTCDate())),
      join(root, String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate())),
    );
  }
  return dirs;
}

export function createCodexFeed(options: CodexFeedOptions): TranscriptFeed {
  return createTranscriptFeed({
    now: options.now,
    logger: options.logger,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    source: {
      provider: 'codex',
      roots: () => [...new Set(options.homes())].map((home) => join(home, 'sessions')),
      accept: (rel) => rel.endsWith('.jsonl'),
      hotDirs: (followed: readonly RecentFile[], now, roots) => [
        ...followed.map((file) => dirname(file.path)),
        ...roots.flatMap((root) => dateDirs(root, now)),
      ],
      async start(file, signal, files) {
        const meta = await readMeta(file, signal, files);
        // The thread id is the file name's as a fallback, so a rollout whose first line cannot be read still joins Paseo's agent.
        const sessionId = meta?.id ?? threadIdFromName(file.path);
        return sessionId === null ? null : createCodexTracker(sessionId, meta);
      },
    },
  });
}
