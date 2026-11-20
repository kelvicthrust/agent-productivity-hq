import type { HqActivity, HqState, HqWaitReason } from '../../../shared/contracts/hq.ts';
import {
  DROP_AFTER_MS,
  FINISHED_VISIBLE_MS,
  MAX_PENDING_TOOLS,
  PERMISSION_GUESS_MS,
  QUIET_IDLE_MS,
} from './heuristics.ts';
import type { ToolCategory } from './toolCategory.ts';

// The state machine behind a transcript feed's inferred states (data-and-sources › Live roster (HQ) › Transcript feeds › The mapping).
// Pure: it is given what a line meant (a `MachineEvent`, built by the provider's own projection) and the line's time, and answers
// what the session is doing at any later `now`. It holds no tool name, no text and no path: a waiting tool call is its id, the
// time it started and a category from the fixed table. Both providers use it, so a Claude Code and a Codex session behave the same.

/** What one transcript line meant for the session. Built by `claudeActivity.ts` and `codexActivity.ts`, field by field. */
export type MachineEvent =
  | { kind: 'prompt' }
  | { kind: 'thinking' }
  | { kind: 'responding' }
  | {
      kind: 'tool_start';
      /** Pairs the call with its result. Kept only while the call waits for one. */
      id: string;
      category: ToolCategory;
      longRunning: boolean;
      wait: Extract<HqWaitReason, 'question' | 'plan_approval'> | null;
    }
  | { kind: 'tool_end'; id: string }
  | { kind: 'turn_end' }
  | { kind: 'error' }
  | { kind: 'aborted' }
  /** A line that says the provider is writing but means nothing for the state (a hook result, a bookkeeping record). */
  | { kind: 'other' };

/** What a session is doing, all of it inferred from its transcript. Times are epoch ms. */
export interface Observation {
  state: Extract<HqState, 'working' | 'waiting' | 'idle' | 'error' | 'finished'>;
  activity: HqActivity;
  waitReason: HqWaitReason | null;
  /** When `state` last changed, as far as the transcript says. */
  since: number;
  lastActivityAt: number;
}

export interface SessionMachine {
  /**
   * One line's events, in order, at the line's time. A line with no events is a bookkeeping line: it counts as the provider still writing
   * only while a turn is open and has not expired.
   */
  apply(events: readonly MachineEvent[], at: number): void;
  /** A line too long to read. It counts as activity and clears the waiting tool calls, so it can never read as "waiting". */
  overlong(at: number): void;
  /**
   * The session at `now`, or null when it has been silent for `DROP_AFTER_MS` (or has said nothing yet). `guessPermission: false`
   * leaves out the guess that a tool call with no result after `PERMISSION_GUESS_MS` is waiting for the owner: it is for a session whose
   * hooks say exactly when it waits (data-and-sources › Claude Code hooks).
   */
  evaluate(now: number, options?: { guessPermission?: boolean }): Observation | null;
}

type Phase = 'none' | 'thinking' | 'responding' | 'tool' | 'ended' | 'aborted' | 'error';

interface Pending {
  at: number;
  category: ToolCategory;
  longRunning: boolean;
  wait: Extract<HqWaitReason, 'question' | 'plan_approval'> | null;
}

export function createSessionMachine(): SessionMachine {
  let phase: Phase = 'none';
  let phaseAt = 0;
  /** When the turn that is under way began: the `since` of "working". */
  let turnStartedAt = 0;
  /** The time of the last conversation event (not a bookkeeping line). */
  let conversationAt: number | null = null;
  let lastLineAt: number | null = null;
  const pending = new Map<string, Pending>();

  const seen = (at: number): void => {
    lastLineAt = lastLineAt === null ? at : Math.max(lastLineAt, at);
  };
  const active = (): boolean => phase === 'thinking' || phase === 'responding' || phase === 'tool';

  /** Called before an event that is the session doing something: a new turn starts when it was not under way, or had gone quiet. */
  const beginTurnIfNeeded = (at: number): void => {
    const quiet =
      conversationAt !== null && pending.size === 0 && at - conversationAt >= QUIET_IDLE_MS;
    if (!active() || quiet) turnStartedAt = at;
  };

  const apply = (events: readonly MachineEvent[], at: number): void => {
    // Bookkeeping can extend an open turn's roster window while it is still live.
    const continuing = active() && lastLineAt !== null && at - lastLineAt < DROP_AFTER_MS;
    if (continuing || events.some((event) => event.kind !== 'other')) seen(at);
    for (const event of events) {
      switch (event.kind) {
        case 'prompt':
          turnStartedAt = at;
          pending.clear();
          phase = 'thinking';
          phaseAt = at;
          conversationAt = at;
          break;
        case 'thinking':
        case 'responding':
          beginTurnIfNeeded(at);
          conversationAt = at;
          if (pending.size === 0 || !active()) {
            phase = event.kind;
            phaseAt = at;
          }
          break;
        case 'tool_start':
          beginTurnIfNeeded(at);
          conversationAt = at;
          if (!active()) pending.clear();
          pending.set(event.id, {
            at,
            category: event.category,
            longRunning: event.longRunning,
            wait: event.wait,
          });
          // The oldest call is forgotten beyond the bound (a Map keeps insertion order).
          if (pending.size > MAX_PENDING_TOOLS) {
            const oldest = pending.keys().next();
            if (!oldest.done) pending.delete(oldest.value);
          }
          phase = 'tool';
          phaseAt = at;
          break;
        case 'tool_end':
          beginTurnIfNeeded(at);
          conversationAt = at;
          pending.delete(event.id);
          if (pending.size === 0) {
            phase = 'thinking';
            phaseAt = at;
          }
          break;
        case 'turn_end':
          pending.clear();
          // The end is written twice by Claude Code (the last message, then `turn_duration`): the first one is when the turn ended.
          if (phase !== 'ended') phaseAt = at;
          phase = 'ended';
          conversationAt = at;
          break;
        case 'error':
          pending.clear();
          phase = 'error';
          phaseAt = at;
          conversationAt = at;
          break;
        case 'aborted':
          pending.clear();
          phase = 'aborted';
          phaseAt = at;
          conversationAt = at;
          break;
        case 'other':
          break;
      }
    }
  };

  return {
    apply,
    overlong(at) {
      seen(at);
      conversationAt = at;
      pending.clear();
      if (phase === 'tool') {
        phase = 'thinking';
        phaseAt = at;
      }
    },
    evaluate(now, options) {
      const guessPermission = options?.guessPermission ?? true;
      if (lastLineAt === null || now - lastLineAt >= DROP_AFTER_MS) return null;
      const lastActivityAt = conversationAt ?? lastLineAt;
      const make = (
        state: Observation['state'],
        since: number,
        activity: HqActivity = 'none',
        waitReason: HqWaitReason | null = null,
      ): Observation => ({ state, activity, waitReason, since, lastActivityAt });

      switch (phase) {
        case 'error':
          return make('error', phaseAt);
        case 'aborted':
          return make('idle', phaseAt);
        case 'ended':
          return now - phaseAt < FINISHED_VISIBLE_MS
            ? make('finished', phaseAt)
            : make('idle', phaseAt + FINISHED_VISIBLE_MS);
        case 'none':
          return make('idle', lastLineAt);
        default:
          break;
      }

      // A turn is under way. A call that asks the person something is a wait for sure.
      let asking: Pending | null = null;
      let guess: Pending | null = null;
      let newest: Pending | null = null;
      for (const call of pending.values()) {
        newest = call;
        if (call.wait !== null && asking === null) asking = call;
        if (
          guessPermission &&
          !call.longRunning &&
          call.wait === null &&
          now - call.at >= PERMISSION_GUESS_MS
        )
          guess ??= call;
      }
      if (asking !== null) return make('waiting', asking.at, 'none', asking.wait);
      if (guess !== null)
        return make('waiting', guess.at + PERMISSION_GUESS_MS, 'none', 'permission');
      if (pending.size === 0 && conversationAt !== null && now - conversationAt >= QUIET_IDLE_MS)
        return make('idle', conversationAt + QUIET_IDLE_MS);
      const activity: HqActivity =
        newest !== null ? newest.category : phase === 'responding' ? 'responding' : 'thinking';
      return make('working', turnStartedAt, activity);
    },
  };
}
