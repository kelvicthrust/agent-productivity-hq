import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Which Claude Code files are transcripts, and which session each one belongs to (data-and-sources › Claude Code transcripts).
//
//   projects/<project>/<session>.jsonl                      a main transcript: a root session named by the file
//   projects/<project>/<session>/subagents/<agent>.jsonl    a subagent's transcript: a child of <session>, by location (R3)
//
// Set-aside copies are skipped: `*.orphaned-*.jsonl` and `*.jsonl.superseded-*`. Reading them would count a message twice
// (the dedupe key would catch it, but a copy is not a session). Everything else under projects/ is not a transcript.

export type Transcript =
  | { kind: 'main'; sessionId: string }
  | {
      kind: 'subagent';
      /** The child's own id: unique because the agent file's name is only unique inside its parent. */
      sessionId: string;
      /** The session that spawned it: the folder the `subagents/` folder sits in. */
      parentId: string;
    };

const SET_ASIDE = /\.orphaned-[^/]*\.jsonl$|\.jsonl\.superseded-/;
const SUFFIX = '.jsonl';

/** `name` without `.jsonl`, or null when it is not a transcript name (or is a set-aside copy). */
function transcriptStem(name: string): string | null {
  if (!name.endsWith(SUFFIX) || SET_ASIDE.test(name)) return null;
  const stem = name.slice(0, -SUFFIX.length);
  return stem === '' ? null : stem;
}

/** What a file is, from its path below `projects/` (with `/` separators), or null when it is not read. */
export function classifyTranscript(relativePath: string): Transcript | null {
  const parts = relativePath.split('/');
  if (parts.length === 2) {
    const stem = transcriptStem(parts[1] ?? '');
    return stem === null ? null : { kind: 'main', sessionId: stem };
  }
  if (parts.length === 4 && parts[2] === 'subagents') {
    const parentId = parts[1] ?? '';
    const stem = transcriptStem(parts[3] ?? '');
    if (parentId === '' || stem === null) return null;
    return { kind: 'subagent', sessionId: `${parentId}:${stem}`, parentId };
  }
  return null;
}

/**
 * The `projects/` folder of each Claude config dir, once each: two entries that are the same folder (a symbolic link from
 * `~/.config/claude` to `~/.claude`, or a repeated override) would otherwise read every file twice. The real path only decides which
 * entries are the same folder; it never authorises an access (the roots are the owner's approved locations).
 */
export async function projectRoots(
  configDirs: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const dir of configDirs) {
    // With a signal (HQ's live feed): once it aborts no further folder is looked at, and what has been found so far is returned (the
    // caller ignores it). The call in flight is the last one, and the caller waits for it: nothing is raced against the signal.
    if (signal?.aborted) break;
    if (dir === '') continue;
    const root = join(dir, 'projects');
    const identity = await realpath(root).catch(() => resolve(root));
    if (signal?.aborted) break;
    if (seen.has(identity)) continue;
    seen.add(identity);
    roots.push(root);
  }
  return roots;
}
