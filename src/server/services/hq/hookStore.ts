import { CLAUDE_HOOK_EVENTS, type HqClaudeHookEvent } from '../../../shared/contracts/hq.ts';

// What Claude Code's hooks have told HQ (data-and-sources › Claude Code hooks), in memory only, as two separate facts per session:
//   1. the LATEST EVENT of each session, reduced at once to one of five kinds, a time and the working directory the hook named. No
//      notification text, tool, prompt or transcript path ever reaches it (the schema refuses them). At most `HOOK_MAX_SESSIONS`; one
//      with no event for `HOOK_KEEP_MS` is forgotten. A session that ended is kept as an "ended" record for the same time, because its
//      transcript is still followed for up to 15 minutes after its last line and the record is what keeps it off the roster.
//   2. CAPABLE: that the session has delivered at least one event, which is why its 10-second permission guess is not needed (hooks are
//      exact). It outlives the event: it is kept for `CAPABLE_KEEP_MS` after the later of the session's last event and the last time
//      the transcript feed asked about the session (`delivered`, which the feed does for every session it follows, at every read), so
//      it lasts as long as the session is followed and for a grace period after. At most `CAPABLE_MAX` sessions (the oldest go
//      first). It is dropped at once when the session ends (an ended session is not waiting for anything) and on `clear()`.
// Both tables are Maps kept in the order of their last write, so the oldest entry is always the first: expiry and the bound take from
// the front and cost O(1) for each entry removed, and a record or a read never scans the table. There are no timers and no handles:
// everything is dropped when the server shuts down (`clear()`) or the process ends.

/** What an event meant: the owner has to approve something, the turn is over and it is the owner's move, the turn finished, a session began, a session ended. */
export type HookKind = 'permission' | 'idle' | 'stop' | 'start' | 'end';

export interface HookRecord {
  kind: HookKind;
  /** When HQ received the event (epoch ms). */
  at: number;
  /** The working directory the hook named, the latest one it named. */
  cwd: string | null;
}

/** A session with no event this long is forgotten (the transcript feeds drop a silent file after the same time). */
export const HOOK_KEEP_MS = 15 * 60_000;
export const HOOK_MAX_SESSIONS = 200;
/** A session that delivered an event is "capable" (no permission guess) this long after its last event or last sighting by the transcript feed. */
export const CAPABLE_KEEP_MS = 60 * 60_000;
export const CAPABLE_MAX = 500;

/** The kind an event means, or null for one HQ does not use (an event name or notification type it was not installed for). */
export function kindOf(event: Pick<HqClaudeHookEvent, 'hook_event_name' | 'notification_type'>) {
  switch (event.hook_event_name) {
    case 'PermissionRequest':
      return 'permission';
    case 'Notification':
      if (event.notification_type === 'permission_prompt') return 'permission';
      return event.notification_type === 'idle_prompt' ? 'idle' : null;
    case 'Stop':
      return 'stop';
    case 'SessionStart':
      return 'start';
    case 'SessionEnd':
      return 'end';
    default:
      return null;
  }
}

export interface HookStore {
  /** Keeps the event as its session's latest. False when the event is one HQ does not use (nothing is kept). */
  record(event: HqClaudeHookEvent): boolean;
  /** The latest event of each session, as of now. */
  read(): ReadonlyMap<string, HookRecord>;
  /**
   * Whether this session has delivered an event (so its permission guess is not needed: hooks are exact), for longer than its latest
   * event is kept. Asking counts as a sighting of the session (the feed asks for each session it follows at every read), which keeps
   * a capable session capable for as long as it is followed. A session that was never capable is not made so by being asked about.
   */
  delivered(sessionId: string): boolean;
  /** Forgets everything. */
  clear(): void;
}

/** Removes entries from the front of `table` while `expired` says so, then while it is over `max`. */
function trim<V>(table: Map<string, V>, max: number, expired: (held: V) => boolean): void {
  for (const [id, held] of table) {
    if (!expired(held)) break;
    table.delete(id);
  }
  for (const id of table.keys()) {
    if (table.size <= max) break;
    table.delete(id);
  }
}

export function createHookStore(options: { now: () => number }): HookStore {
  const sessions = new Map<string, HookRecord>();
  /** Session id to the time it last delivered an event or was last asked about. */
  const capable = new Map<string, number>();

  const eventAlive = (held: HookRecord, now: number): boolean => now - held.at < HOOK_KEEP_MS;
  const capableAlive = (seen: number, now: number): boolean => now - seen < CAPABLE_KEEP_MS;
  /** Moved to the end of its table, so the table stays in the order of the last write. */
  const put = <V>(table: Map<string, V>, id: string, value: V): void => {
    table.delete(id);
    table.set(id, value);
  };

  return {
    record(event) {
      const now = options.now();
      const kind = kindOf(event);
      // An event HQ installed a hook for proves the session delivers, even when it says nothing HQ uses (a notification of another
      // type); an event it did not install for is not from the script it wrote.
      const installed = (CLAUDE_HOOK_EVENTS as readonly string[]).includes(event.hook_event_name);
      if (installed) {
        if (event.hook_event_name === 'SessionEnd') capable.delete(event.session_id);
        else put(capable, event.session_id, now);
        trim(capable, CAPABLE_MAX, (seen) => !capableAlive(seen, now));
      }
      if (kind === null) return false;
      const previous = sessions.get(event.session_id);
      put(sessions, event.session_id, { kind, at: now, cwd: event.cwd ?? previous?.cwd ?? null });
      trim(sessions, HOOK_MAX_SESSIONS, (held) => !eventAlive(held, now));
      return true;
    },
    read() {
      const now = options.now();
      trim(sessions, HOOK_MAX_SESSIONS, (held) => !eventAlive(held, now));
      // Copied without what has expired (the table is in the order of arrival, but the clock is not trusted to be monotonic).
      return new Map([...sessions].filter(([, held]) => eventAlive(held, now)));
    },
    delivered(sessionId) {
      const now = options.now();
      const seen = capable.get(sessionId);
      if (seen === undefined) return false;
      if (!capableAlive(seen, now)) {
        capable.delete(sessionId);
        return false;
      }
      put(capable, sessionId, now);
      return true;
    },
    clear() {
      sessions.clear();
      capable.clear();
    },
  };
}
