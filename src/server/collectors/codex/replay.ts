import type { ParsedRollout, RolloutEvent, Usage } from './rollout.ts';

// What a fork or a spawned child copied from its parent, and so did not spend ([X5], [X6] in docs/implementation/ccusage-rules.md).
// Pure: two parsed rollouts go in, the child's own events come out.
//
// A rollout whose first line names a parent (`forked_from_id`, else the spawning thread) starts with that parent's history written
// into it, token_count lines included. Those lines are not the child's usage. The oracle finds them by comparison, not by time:
//   [X5] the parent's events up to the fork instant (the child's first line's timestamp) are the replay; the child's leading
//        events are skipped while each equals the parent's event at the same position, figure for figure. The first one that
//        does not ends the replay, and from there on everything is the child's own.
//   [X6] when position 0 does not match (the parent is not among the files, or Codex rewrote the copied history so it no longer
//        lines up), the replay is a burst: a child that opens with two usage lines at most a second apart, the first within a
//        second of its own start, skips events for as long as each comes within a second of the one before.
// A compaction request a child copied is not skipped by position but by identity: it is dropped when the parent recorded it
// at or before the fork instant.

/** Longest pause tolerated inside a burst of copied usage (ccusage: `CODEX_REWRITTEN_BURST_PAUSE_MS`). */
export const BURST_PAUSE_MS = 1000;

const equal = (a: Usage, b: Usage): boolean =>
  a.input === b.input &&
  a.cached === b.cached &&
  a.cacheWrite === b.cacheWrite &&
  a.output === b.output &&
  a.reasoning === b.reasoning &&
  a.total === b.total;

/** The start of the rewritten burst at the head of `child`, or null when it has none. */
function burstStart(child: ParsedRollout): number | null {
  const [first, second] = child.burst;
  if (first === undefined || second === undefined) return null;
  const dense = second - first >= 0 && second - first <= BURST_PAUSE_MS;
  // A late first request can also make a dense pair, so it must have started where the child did.
  const startsAtFork =
    child.metaLineAt === null || Math.abs(first - child.metaLineAt) <= BURST_PAUSE_MS;
  return dense && startsAtFork ? first : null;
}

/**
 * The events a child spent itself. `parent` is the parent's rollout parsed WITHOUT any replay of its own, or null when the parent
 * is not among the files read. A rollout that is not a fork is returned as it is.
 */
export function ownEvents(child: ParsedRollout, parent: ParsedRollout | null): RolloutEvent[] {
  const fork = child.fork;
  if (fork === null) return child.events;

  const lead = parent === null ? [] : parent.events.filter((event) => event.responseId === null);
  const cut =
    fork.at === null ? -1 : lead.findIndex((event) => event.occurredAt > (fork.at as number));
  const prefix = cut < 0 ? lead : lead.slice(0, cut);

  type State =
    { kind: 'matching'; index: number } | { kind: 'burst'; previous: number } | { kind: 'done' };
  let state: State = { kind: 'matching', index: 0 };
  const kept: RolloutEvent[] = [];

  for (const event of child.events) {
    if (event.responseId !== null) {
      // A compaction request the parent recorded no later than the fork is the parent's, copied.
      const recorded = parent?.compactions.get(event.responseId);
      const copied =
        recorded !== undefined && (fork.at === null || recorded === null || recorded <= fork.at);
      if (!copied) kept.push(event);
      continue;
    }
    // Each branch either skips the event or moves toward `done`; the loop runs again only to apply the event to the new state.
    for (;;) {
      if (state.kind === 'matching') {
        const expected = prefix[state.index];
        if (expected !== undefined && equal(expected, event)) {
          state = { kind: 'matching', index: state.index + 1 };
          break;
        }
        // Nothing matched at the head: the parent cannot anchor the replay, so fall back to the burst. Later, the replay is over.
        const burst: number | null = state.index === 0 ? burstStart(child) : null;
        state = burst === null ? { kind: 'done' } : { kind: 'burst', previous: burst };
      } else if (state.kind === 'burst') {
        const gap = event.occurredAt - state.previous;
        if (gap >= 0 && gap <= BURST_PAUSE_MS) {
          state = { kind: 'burst', previous: event.occurredAt };
          break;
        }
        state = { kind: 'done' };
      } else {
        kept.push(event);
        break;
      }
    }
  }
  return kept;
}
