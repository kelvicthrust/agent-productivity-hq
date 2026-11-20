import type { RefKind, SessionRefInput } from '../../db/queries/links.ts';
import { scanLine } from './scan.ts';

// The per-session memory of the scan: the identifiers one session showed, each with the earliest time it showed them. An adapter
// makes one collector per session it reads (or per file), feeds it every line and the branch metadata, and hands `refs()` to
// `writeSessionRefs` inside the file's own transaction. The collector holds identifiers only: the line text it is given is scanned
// and dropped on the spot, so there is nothing to leak through a log or an error (P-31).

/** A branch name longer than this is not kept (the store refuses it too); it stops a pathological line from being held. */
const MAX_BRANCH_LENGTH = 200;
/** A transcript that names more distinct identifiers of one kind than this (a pasted `git log` of a whole repo) keeps the first ones. */
export const MAX_REFS_PER_KIND = 2000;

export interface RefCollector {
  /**
   * Scans one line as it was read and remembers its PR references and commit ids. `observedAt` is when the session showed them (the
   * line's own timestamp, epoch ms); an unusable time drops the line's identifiers rather than guessing one.
   */
  addLine(text: unknown, observedAt: number): void;
  /** A branch the session worked on, from the adapter's metadata (Claude `gitBranch`, Codex `git.branch`), never from text. */
  addBranch(name: unknown, observedAt: number): void;
  /** Everything collected so far, earliest sighting kept, in a stable order. */
  refs(): SessionRefInput[];
}

export function createRefCollector(): RefCollector {
  const seen: Record<RefKind, Map<string, number>> = {
    pr_url: new Map(),
    commit: new Map(),
    branch: new Map(),
  };
  const remember = (kind: RefKind, value: string, observedAt: number): void => {
    const known = seen[kind];
    const earlier = known.get(value);
    if (earlier !== undefined) {
      if (observedAt < earlier) known.set(value, observedAt);
    } else if (known.size < MAX_REFS_PER_KIND) {
      known.set(value, observedAt);
    }
  };

  return {
    addLine(text, observedAt) {
      if (!Number.isFinite(observedAt)) return;
      const found = scanLine(text);
      for (const pr of found.prs) remember('pr_url', pr, observedAt);
      for (const commit of found.commits) remember('commit', commit, observedAt);
    },
    addBranch(name, observedAt) {
      if (!Number.isFinite(observedAt)) return;
      if (typeof name !== 'string' || name === '' || name.length > MAX_BRANCH_LENGTH) return;
      remember('branch', name, observedAt);
    },
    refs() {
      return (['pr_url', 'commit', 'branch'] as const).flatMap((kind) =>
        [...seen[kind]]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([value, observedAt]) => ({ kind, value, observedAt })),
      );
    },
  };
}
