import { createHash } from 'node:crypto';
import { HqAgent } from '../../../shared/contracts/hq.ts';
import { liveTime } from '../../lib/liveTime.ts';
import { MAX_LIVE_TITLE_CHARS, clipped } from '../../lib/liveText.ts';
import { normaliseProvider } from '../../collectors/paseo/agents.ts';
import type { LiveAgent } from '../../collectors/paseo/liveAgent.ts';
import { mapLiveState, type LiveState } from '../../collectors/paseo/liveState.ts';
import type { TranscriptAgent } from '../../collectors/live/feed.ts';
import { FINISHED_VISIBLE_MS } from '../../collectors/live/heuristics.ts';
import type { HookRecord } from './hookStore.ts';
import { liveSessionKey, type LiveSessionKey, type LiveSessionLabel } from '../../db/queries/hq.ts';

// The roster: the agents Paseo lists and the sessions the transcript feeds see, merged into the `HqAgent` list the route answers with.
// Pure: a function of the kept agents, the clock, a repo lookup, a stored-label lookup and the id memo, so it is tested without a daemon
// or a folder. Every field of an `HqAgent` is set here by name from the kept records; nothing is spread, so a stray field can never
// reach the response.
//
// THE OWNERSHIP RULE (ids, sessions and parents; written the same way in data-and-sources › The roster). Ownership and ids are decided
// first, over ALL the agents; the cap only removes entries afterwards.
//   1. A roster id, once shown for an agent, stays with that agent for as long as it is continuously visible. An agent that already
//      holds an id (the memo has one for its own key) keeps it, full stop; an agent never seen before derives its id from the session
//      key when it owns the session, else from its own Paseo key. An id is never given to two entries.
//   2. Ownership of a session key is sticky. A session key is owned by the Paseo agent that owned it before, if that agent is still
//      present and still names the session; otherwise by the best of the current claimants (most recently updated, then lowest id).
//      Only the owner is joined with the transcript and answers to the session key.
//   3. A claimant that does not own the session has its own Paseo key and is NOT joined with the transcript.
//   4. A native parent link resolves to the OWNER of the parent session. If that owner is not on the capped roster the child is
//      `kind: 'child'`, `parentId: null`, `parentAway: true`; another claimant is never substituted. A Paseo parent label resolves to
//      the labelled agent's entry, or is away in the same way. A cycle is refused.

/** The roster shows at most this many agents, with actionable agents before recent idle ones. */
export const ROSTER_CAP = 60;
/** An id (or an owner) remembered for a key that has not been seen for this long is forgotten. */
const MEMO_KEEP_MS = 30 * 60_000;
/** Most keys the memo holds. The keys of the poll being built are never dropped for it (a poll holds at most about 600). */
const MEMO_MAX = 500;

/**
 * How far ahead of the clock a transcript line's time may be and still say "this line came after that hook event". A line further
 * ahead than this (a wrong clock, a bad timestamp) says nothing about order: it is not allowed to hide a hook event, which would
 * otherwise stay hidden until the clock caught up (up to `FUTURE_SKEW_MS` of `liveTime`, a day).
 */
export const HOOK_FUTURE_SKEW_MS = 60_000;

/** A session that has only said it started (no transcript line yet) is shown as `starting` for this long, then not at all. */
export const HOOK_START_VISIBLE_MS = 30_000;

const toIso = (ms: number): string => new Date(ms).toISOString();

/** `'a'` plus the first 12 hex characters of `sha256(key)`: opaque, and says nothing about the key it came from. */
export function keyId(key: string): string {
  return `a${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

/**
 * The opaque id a Paseo agent has on the roster before it names a provider session (the id then comes from `<provider>:<session id>`,
 * the key a transcript has too, so the agent has one id whichever feed sees it). Stable for as long as the agent exists. The Paseo key is
 * `paseo:<agent id>`; the transcript feeds' keys are `claude:<sessionId>` / `codex:<sessionId>`.
 */
export function rosterId(paseoAgentId: string): string {
  return keyId(`paseo:${paseoAgentId}`);
}

/**
 * What the service remembers between polls so that an id already shown does not change when a feed starts or stops seeing the same agent,
 * and so that the owner of a provider session does not change while it is there. Every key known for an agent (`paseo:<id>` and, when it
 * owns a provider session, `claude:<sid>` / `codex:<sid>`) is remembered at once and resolves to one id, so whichever feed sees the agent
 * next, it has the id it had. Kept only while the feeds run (the service drops it when it stops); a fresh id comes from the session key
 * when there is one, so a restart gives the same id again.
 */
export interface KeyMemo {
  /** Key to the id it was given, the time it was last built, and the poll that was. */
  ids: Map<string, { id: string; seenAt: number; poll: number }>;
  /** Provider session key to the Paseo agent that owns it. */
  owners: Map<string, { agent: string; seenAt: number; poll: number }>;
  /** How many rosters have been built with this memo. */
  polls: number;
}
export const createKeyMemo = (): KeyMemo => ({ ids: new Map(), owners: new Map(), polls: 0 });

/** The last folder name of a path, `/` or `\` separated; null when there is none. */
function lastSegment(path: string | null): string | null {
  if (path === null) return null;
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  return clipped(parts.at(-1) ?? null, MAX_LIVE_TITLE_CHARS);
}

const RECENT_RANK = 5;

function rankOf(shown: Shown): number {
  if (shown.state === 'waiting') return 0;
  if (shown.state === 'error' && shown.reviewPending !== false) return 1;
  if (shown.state === 'working' || shown.state === 'starting' || shown.backgroundWorkActive)
    return 2;
  if (shown.reviewPending) return 3;
  return RECENT_RANK;
}

/** What an entity (one agent, seen by Paseo, a transcript or both) is doing, and how sure that is. */
interface Shown {
  state: HqAgent['state'];
  activity: HqAgent['activity'];
  waitReason: HqAgent['waitReason'];
  confidence: HqAgent['confidence'];
  since: number;
  lastActivityAt: number;
  reviewPending?: boolean | undefined;
  backgroundWorkActive?: boolean;
  confirmedEmpty?: boolean;
}

/** What Claude Code's hooks said about a session, with the session's id (the key the hook store holds it under). */
interface HookView extends HookRecord {
  sessionId: string;
}

interface Entity {
  paseo: LiveAgent | null;
  transcript: TranscriptAgent | null;
  /** The latest hook event of the session this entity shows, when the hooks sent one (its working directory fills a gap; its kind may speak for the state). */
  hook: HookView | null;
  /** The key the entity is known by itself: `paseo:<id>` for a Paseo agent, the provider session key for a transcript-only session. */
  identity: string;
  /** The provider session key this entity is the owner of (a Paseo agent that owns it, with or without a transcript), or its own key (a transcript-only session). */
  session: string | null;
  /** Every key to remember the entity's id under: its identity, then the session it owns. */
  keys: string[];
  /** What orders the entity among equals: the Paseo id when there is one, else the transcript key. */
  sortKey: string;
  shown: Shown;
  /** An expired Paseo row that can still link a crew with actionable work. */
  ancestorOnly?: true;
}

export interface RosterInput {
  /** Paseo's agents. */
  agents: readonly LiveAgent[];
  /** Whether the selected daemon can navigate to matched Paseo agents. */
  includePaseoAgentIds?: boolean | undefined;
  /** The sessions the Claude Code and Codex feeds see. */
  transcripts?: readonly TranscriptAgent[] | undefined;
  now: number;
  /** `owner/name` for a working directory, or null. Read-only; defaults to "no repo". */
  repoOf?: ((cwd: string | null) => string | null) | undefined;
  /** The name and repo already stored for sessions that have been imported; absent for the rest. */
  labelsOf?:
    ((keys: readonly LiveSessionKey[]) => ReadonlyMap<string, LiveSessionLabel>) | undefined;
  /** The daemon had more agents than the one page the feed reads. */
  pageTruncated?: boolean | undefined;
  /** Ids shown so far; given, an id already shown is kept when a second feed starts seeing the agent. */
  memo?: KeyMemo | undefined;
  /** The latest Claude Code hook event of each session, by the Claude session id (the hook store's `read()`). */
  hooks?: ReadonlyMap<string, HookRecord> | undefined;
}

export interface Roster {
  agents: HqAgent[];
  /** The list was cut: by the 60-agent cap, or because the daemon had more than one page. */
  truncated: boolean;
  /** How many times something had to be repaired to keep the answer valid: a time outside the window, an agent left out. For a log code, never shown. */
  repaired: number;
}

const byRecency = (a: TranscriptAgent, b: TranscriptAgent): number =>
  b.lastActivityAt - a.lastActivityAt;

/** How a Paseo-reported state and a transcript's inferred one combine for the same agent. */
function mergeShown(paseo: LiveAgent, live: LiveState, transcript: TranscriptAgent | null): Shown {
  // Paseo said it, so the state is reported. While Paseo says the agent is running, the transcript says what it is busy with; in every
  // other state of Paseo's the transcript adds nothing (it could only disagree by being late).
  const activity =
    live.state === 'working' && transcript !== null && transcript.state === 'working'
      ? transcript.activity
      : live.activity;
  const unreadResult =
    live.state === 'finished' &&
    paseo.attentionReason === 'finished' &&
    paseo.requiresAttention === true;
  return {
    state: live.state,
    activity,
    waitReason: live.waitReason,
    confidence: 'reported',
    since: live.since,
    lastActivityAt: Math.max(paseo.updatedAt, transcript?.lastActivityAt ?? 0),
    reviewPending: live.state === 'error' ? paseo.requiresAttention : unreadResult || undefined,
    backgroundWorkActive: paseo.backgroundWorkActive,
    confirmedEmpty: paseo.reportsEmptyThread && transcript === null,
  };
}

/**
 * What a session's latest hook event says it is doing, when it speaks: `'ended'` (the session is over: it leaves the roster), a state
 * (always `reported`), or null (the hooks have nothing to say, and the transcript's own reading stands). The rule (data-and-sources ›
 * Claude Code hooks › Precedence): a hook event speaks only while it is not older than the session's latest conversation line, so
 * any LATER evidence (a tool result, a new prompt, assistant output) clears a waiting state. A line dated more than
 * `HOOK_FUTURE_SKEW_MS` ahead of `now` has no usable time and does not count as later than anything.
 *   permission  -> waiting / permission (a transcript wait for a question or a plan keeps its own, more specific, reason)
 *   idle        -> idle (the prompt waited for the next message: the turn is over and it is the owner's move)
 *   stop        -> finished for the finished window, then idle
 *   start       -> starting, only while there is no transcript at all, and only for a short time
 *   end         -> ended
 * A session only the hooks know (no transcript yet, not on Paseo) is shown from the same mapping: one that reported `idle` or `Stop`
 * exists, and is idle (or finished, then idle) until its `SessionEnd` or until the hook store forgets its event (no event for
 * `HOOK_KEEP_MS`), when the row goes. A session that only said it started is shown for `HOOK_START_VISIBLE_MS`, then not at all: it has
 * said nothing since that says what it is doing.
 */
function fromHook(
  record: HookRecord,
  transcript: TranscriptAgent | null,
  now: number,
): Shown | 'ended' | null {
  const lineAt =
    transcript !== null && transcript.lastActivityAt <= now + HOOK_FUTURE_SKEW_MS
      ? transcript.lastActivityAt
      : null;
  if (lineAt !== null && record.at < lineAt) return null;
  const base = {
    activity: 'none' as const,
    confidence: 'reported' as const,
    lastActivityAt: Math.max(record.at, lineAt ?? 0),
  };
  switch (record.kind) {
    case 'end':
      return 'ended';
    case 'permission':
      return {
        ...base,
        state: 'waiting',
        waitReason:
          transcript?.state === 'waiting' &&
          transcript.waitReason !== null &&
          transcript.waitReason !== 'permission'
            ? transcript.waitReason
            : 'permission',
        since: record.at,
      };
    case 'idle':
      return { ...base, state: 'idle', waitReason: null, since: record.at };
    case 'stop':
      if (now - record.at < FINISHED_VISIBLE_MS)
        return { ...base, state: 'finished', waitReason: null, since: record.at };
      return { ...base, state: 'idle', waitReason: null, since: record.at + FINISHED_VISIBLE_MS };
    case 'start':
      return transcript === null && now - record.at < HOOK_START_VISIBLE_MS
        ? { ...base, state: 'starting', waitReason: null, since: record.at }
        : null;
  }
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Leaves out any agent that is not a valid `HqAgent` and, for an agent whose parent was left out (or never was on the list), drops the
 * edge and says the parent is away, so the answer always satisfies the contract. Returns how many agents were left out.
 */
export function conformAgents(agents: readonly HqAgent[]): { agents: HqAgent[]; dropped: number } {
  const valid = agents.filter((agent) => HqAgent.safeParse(agent).success);
  const ids = new Set(valid.map((agent) => agent.id));
  return {
    agents: valid.map((agent) =>
      agent.parentId !== null && !ids.has(agent.parentId)
        ? { ...agent, parentId: null, parentAway: true }
        : agent,
    ),
    dropped: agents.length - valid.length,
  };
}

export function buildRoster(input: RosterInput): Roster {
  const repoOf = input.repoOf ?? (() => null);
  const memo = input.memo ?? createKeyMemo();
  // The answer must always be serialisable: a clock that is not a time falls back to the real one, and every time below is checked.
  const now = liveTime(input.now, input.now) === null ? Date.now() : input.now;
  let repaired = 0;
  /** A time that is kept as it is when it is one HQ accepts (`liveTime`), else `now`: one bad agent never fails the answer. */
  const timeOf = (ms: number): number => {
    const valid = liveTime(ms, now);
    if (valid === null) repaired += 1;
    return valid ?? now;
  };
  const timeOrNull = (ms: number | null): number | null => {
    if (ms === null) return null;
    const valid = liveTime(ms, now);
    if (valid === null) repaired += 1;
    return valid;
  };

  const paseoAgents = input.agents.map((agent) => ({
    ...agent,
    updatedAt: timeOf(agent.updatedAt),
    createdAt: timeOrNull(agent.createdAt),
    attentionAt: timeOrNull(agent.attentionAt),
    turnStartedAt: timeOrNull(agent.turnStartedAt),
  }));
  const sessions = (input.transcripts ?? []).map((agent) => ({
    ...agent,
    since: timeOf(agent.since),
    lastActivityAt: timeOf(agent.lastActivityAt),
    startedAt: timeOrNull(agent.startedAt),
  }));

  // One transcript per provider session (a session in two config dirs shows once: the most recently active).
  const transcriptByKey = new Map<string, TranscriptAgent>();
  for (const agent of sessions.sort(byRecency)) {
    const key = liveSessionKey(agent.provider, agent.sessionId);
    if (!transcriptByKey.has(key)) transcriptByKey.set(key, agent);
  }

  // What the memo holds: a key not seen for 30 min is forgotten.
  const previousPoll = memo.polls;
  memo.polls += 1;
  const poll = memo.polls;
  for (const [key, held] of memo.ids) if (now - held.seenAt > MEMO_KEEP_MS) memo.ids.delete(key);
  for (const [key, held] of memo.owners)
    if (now - held.seenAt > MEMO_KEEP_MS) memo.owners.delete(key);

  // The Paseo agents the roster can show (one Paseo's own rules do not show takes no part), and which of them owns each provider
  // session. The join: Paseo's `runtimeInfo.sessionId` is the provider's own session id. Ownership is sticky (rule 2 above): the agent
  // that owned a session keeps it while it is present and names it, else the most recently updated claimant, then the lowest id. Only
  // the owner takes the transcript and the session key.
  interface Visible {
    agent: LiveAgent;
    live: LiveState;
    sessionKey: string | null;
  }
  const visible: Visible[] = [];
  const expired: Array<{ agent: LiveAgent; sessionKey: string | null }> = [];
  const groups = new Map<string, Visible[]>();
  for (const agent of paseoAgents) {
    const provider = normaliseProvider(agent.provider);
    const sessionKey =
      agent.sessionId !== null && provider !== 'other'
        ? liveSessionKey(provider, agent.sessionId)
        : null;
    const live = mapLiveState(agent, now);
    if (live === null) {
      if (!agent.archived) expired.push({ agent, sessionKey });
      continue;
    }
    const claimant: Visible = { agent, live, sessionKey };
    visible.push(claimant);
    if (sessionKey !== null) groups.set(sessionKey, [...(groups.get(sessionKey) ?? []), claimant]);
  }
  const owners = new Map<string, Visible>();
  for (const [key, group] of groups) {
    const remembered = memo.owners.get(key)?.agent;
    const sticky = group.find((claimant) => claimant.agent.id === remembered);
    const [best] = [...group].sort(
      (a, b) => b.agent.updatedAt - a.agent.updatedAt || byText(a.agent.id, b.agent.id),
    );
    const owner = sticky ?? best;
    if (owner === undefined) continue;
    owners.set(key, owner);
    memo.owners.set(key, { agent: owner.agent.id, seenAt: now, poll });
  }

  const entities: Entity[] = [];
  const claimed = new Set<string>();
  for (const { agent, live, sessionKey } of visible) {
    const owns = sessionKey !== null && owners.get(sessionKey)?.agent === agent;
    const transcript = owns ? (transcriptByKey.get(sessionKey) ?? null) : null;
    if (owns && transcript !== null) claimed.add(sessionKey);
    entities.push({
      paseo: agent,
      transcript,
      hook: null,
      identity: `paseo:${agent.id}`,
      session: owns ? sessionKey : null,
      keys: [`paseo:${agent.id}`, ...(owns ? [sessionKey] : [])],
      sortKey: agent.id,
      shown: mergeShown(agent, live, transcript),
    });
  }
  // Transcript-only sessions, and what Claude Code's hooks add: a hook event is read for a session no Paseo agent owns (Paseo's own
  // reported states keep their precedence), and a session whose hooks say it ended is left out at once.
  const hookViews = new Map<string, HookView>();
  for (const [sessionId, record] of input.hooks ?? []) {
    const at = liveTime(record.at, now);
    if (at === null) {
      repaired += 1;
      continue;
    }
    hookViews.set(liveSessionKey('claude', sessionId), { ...record, at, sessionId });
  }
  for (const [key, transcript] of transcriptByKey) {
    if (claimed.has(key)) continue;
    // A subagent's transcript is never read for hooks: the main session is the one that waits (a session id in the hook that happens
    // to name a subagent's key is not the subagent's).
    const view = transcript.parentSessionId === null ? (hookViews.get(key) ?? null) : null;
    const spoken = view === null ? null : fromHook(view, transcript, now);
    if (spoken === 'ended') continue;
    entities.push({
      paseo: null,
      transcript,
      hook: view,
      identity: key,
      session: key,
      keys: [key],
      sortKey: key,
      shown: spoken ?? {
        state: transcript.state,
        activity: transcript.state === 'working' ? transcript.activity : 'none',
        waitReason: transcript.waitReason,
        confidence: 'inferred',
        since: transcript.since,
        lastActivityAt: transcript.lastActivityAt,
      },
    });
  }
  // A session the hooks know and no transcript or Paseo agent shows yet: one that has only started, one waiting before its transcript
  // has been read, and one that reported an idle prompt or a stop (idle or finished, until its end or its event is forgotten).
  for (const [key, view] of hookViews) {
    if (transcriptByKey.has(key) || owners.has(key)) continue;
    const spoken = fromHook(view, null, now);
    if (spoken === null || spoken === 'ended') continue;
    entities.push({
      paseo: null,
      transcript: null,
      hook: view,
      identity: key,
      session: key,
      keys: [key],
      sortKey: key,
      shown: spoken,
    });
  }

  // An expired Paseo parent can link a crew, but cannot take a provider session away from another source.
  const activeSessions = new Set(entities.map((entity) => entity.session));
  const contextualSessions = new Set<string>();
  expired.sort((a, b) => b.agent.updatedAt - a.agent.updatedAt || byText(a.agent.id, b.agent.id));
  for (const { agent, sessionKey } of expired) {
    const session =
      sessionKey !== null && !activeSessions.has(sessionKey) && !contextualSessions.has(sessionKey)
        ? sessionKey
        : null;
    if (session !== null) contextualSessions.add(session);
    const identity = `paseo:${agent.id}`;
    entities.push({
      paseo: agent,
      transcript: null,
      hook: null,
      identity,
      session,
      keys: [identity, ...(session === null ? [] : [session])],
      sortKey: agent.id,
      shown: {
        state: 'idle',
        activity: 'none',
        waitReason: null,
        confidence: 'reported',
        since: agent.updatedAt,
        lastActivityAt: agent.updatedAt,
      },
      ancestorOnly: true,
    });
  }

  // Resolve parent claims before filtering out empty threads and capping the roster.
  const bySession = new Map<string, Entity>();
  const byPaseo = new Map<string, Entity>();
  for (const entity of entities) {
    if (entity.session !== null) bySession.set(entity.session, entity);
    if (entity.paseo !== null) byPaseo.set(entity.paseo.id, entity);
  }
  interface Claim {
    /** The entity the provider or Paseo names as the parent, when it is eligible for the roster. */
    target: Entity | undefined;
    basis: 'native' | 'paseo';
  }
  /**
   * A parent claim: the provider's own record wins (a Claude subagent's folder, a Codex thread's spawner), Paseo's label fills a gap.
   * No edge is ever invented from anything else. A claim whose parent is not on the roster is still a claim ("away").
   */
  const claimOf = (entity: Entity): Claim | null => {
    const native = entity.transcript?.parentSessionId ?? null;
    if (native !== null && entity.transcript !== null) {
      return {
        target: bySession.get(liveSessionKey(entity.transcript.provider, native)),
        basis: 'native',
      };
    }
    const label = entity.paseo?.parentAgentId ?? null;
    if (label !== null) {
      return {
        target: byPaseo.get(label),
        basis: 'paseo',
      };
    }
    return null;
  };
  const claims = new Map<Entity, Claim>();
  for (const entity of entities) {
    const claim = claimOf(entity);
    if (claim !== null) claims.set(entity, claim);
  }

  // Empty threads only stay when they connect a visible descendant. Prefer the ancestors of actionable agents over independent
  // idle sessions when there is space. Every step improves the parent's rank, so even a cycle stops the walk.
  const nonempty = entities.filter(
    (entity) => !entity.shown.confirmedEmpty && !entity.ancestorOnly,
  );
  const displayRanks = new Map(nonempty.map((entity) => [entity, rankOf(entity.shown)] as const));
  for (const entity of nonempty) {
    const ancestorRank = rankOf(entity.shown) === RECENT_RANK ? RECENT_RANK : RECENT_RANK - 1;
    for (let parent = claims.get(entity)?.target; parent; parent = claims.get(parent)?.target) {
      if (parent.ancestorOnly && ancestorRank === RECENT_RANK) break;
      if ((displayRanks.get(parent) ?? Infinity) <= ancestorRank) break;
      displayRanks.set(parent, ancestorRank);
    }
  }
  // Ids (rule 1), for ALL the entities, before the cap. An entity looks its keys up in the memo, its own first; an id that is taken
  // (by an entity decided earlier in this poll) is not given twice. Who is decided first: an entity that held its own key's id in the
  // previous poll (continuously visible) before one that held it longer ago, before one that only has the session's id, before a new
  // one; a Paseo agent before a transcript-only session; then by key. So a returning claimant can never take the id of an agent that
  // has been visible all along, and the outcome does not depend on display order or on the order Paseo lists agents in.
  const claimRank = (entity: Entity): number => {
    const own = memo.ids.get(entity.identity);
    if (own !== undefined) return own.poll === previousPoll ? 0 : 1;
    return entity.keys.slice(1).some((key) => memo.ids.has(key)) ? 2 : 3;
  };
  const idOf = new Map<Entity, string>();
  const taken = new Set<string>();
  const knownEntities = entities.filter(
    (entity) => !entity.ancestorOnly || displayRanks.has(entity),
  );
  const ranks = new Map(knownEntities.map((entity) => [entity, claimRank(entity)] as const));
  const decided = [...knownEntities].sort(
    (a, b) =>
      Number(Boolean(a.ancestorOnly && a.session === null)) -
        Number(Boolean(b.ancestorOnly && b.session === null)) ||
      (ranks.get(a) ?? 3) - (ranks.get(b) ?? 3) ||
      (a.paseo === null ? 1 : 0) - (b.paseo === null ? 1 : 0) ||
      byText(a.identity, b.identity),
  );
  // First every entity that has an id of its own to keep takes it; only then do new agents derive theirs, so a new agent can never take
  // (by deriving it) an id that an agent still on the roster holds.
  for (const entity of decided) {
    for (const key of entity.keys) {
      const held = memo.ids.get(key)?.id;
      if (held === undefined || taken.has(held)) continue;
      taken.add(held);
      idOf.set(entity, held);
      break;
    }
  }
  for (const entity of decided) {
    if (idOf.has(entity)) continue;
    // A new agent: its id comes from the session when it owns one (so the same agent has the same id whichever feed sees it, and after
    // a restart), else from its own Paseo key.
    let chosen = keyId(entity.keys.at(-1) ?? entity.identity);
    for (let again = 0; taken.has(chosen); again += 1)
      chosen = keyId(`${entity.keys.join('|')}#${again}`);
    taken.add(chosen);
    idOf.set(entity, chosen);
  }
  for (const entity of knownEntities) {
    const id = idOf.get(entity);
    if (id !== undefined)
      for (const key of entity.keys) memo.ids.set(key, { id, seenAt: now, poll });
  }
  for (const table of [memo.ids, memo.owners]) {
    if (table.size <= MEMO_MAX) continue;
    // The oldest go first; what this poll wrote is never dropped for the bound.
    const old = [...table.entries()]
      .filter(([, held]) => held.poll < poll)
      .sort((a, b) => a[1].seenAt - b[1].seenAt || byText(a[0], b[0]));
    for (const [key] of old.slice(0, table.size - MEMO_MAX)) table.delete(key);
  }

  const eligible = entities.filter((entity) => displayRanks.has(entity));
  const kept = eligible
    .sort(
      (a, b) =>
        (displayRanks.get(a) ?? RECENT_RANK) - (displayRanks.get(b) ?? RECENT_RANK) ||
        b.shown.lastActivityAt - a.shown.lastActivityAt ||
        byText(a.sortKey, b.sortKey),
    )
    .slice(0, ROSTER_CAP);
  const onRoster = new Set(kept);
  const parentOf = new Map<Entity, Entity>();
  for (const entity of kept) {
    const parent = claims.get(entity)?.target;
    if (parent !== undefined && onRoster.has(parent)) parentOf.set(entity, parent);
  }
  /** An agent whose ancestor chain enters any cycle, its own or another one (a -> b -> c -> b): its edge is refused, not drawn in a circle. */
  const inCycle = (start: Entity): boolean => {
    const seen = new Set<Entity>([start]);
    for (let at = parentOf.get(start); at !== undefined; at = parentOf.get(at)) {
      if (seen.has(at)) return true;
      seen.add(at);
    }
    return false;
  };

  // Labels stored for sessions that have been imported: one read for the whole roster, and none when nothing is known by a session id.
  const sessionKeys: LiveSessionKey[] = [];
  for (const entity of kept) {
    if (entity.transcript !== null)
      sessionKeys.push({
        provider: entity.transcript.provider,
        sessionId: entity.transcript.sessionId,
      });
    else if (entity.paseo !== null && entity.paseo.sessionId !== null) {
      const provider = normaliseProvider(entity.paseo.provider);
      if (provider !== 'other') sessionKeys.push({ provider, sessionId: entity.paseo.sessionId });
    } else if (entity.hook !== null)
      sessionKeys.push({ provider: 'claude', sessionId: entity.hook.sessionId });
  }
  let labels: ReadonlyMap<string, LiveSessionLabel> = new Map();
  try {
    if (input.labelsOf && sessionKeys.length > 0) labels = input.labelsOf(sessionKeys);
  } catch {
    repaired += 1; // a label is a nicety: a lookup that fails takes no agent with it
  }
  /** `owner/name` for a working directory; a lookup that fails is "no repo". */
  const repoFor = (cwd: string | null): string | null => {
    try {
      return repoOf(cwd);
    } catch {
      repaired += 1;
      return null;
    }
  };

  const built = kept.map((entity): HqAgent | null => {
    try {
      return buildAgent(entity);
    } catch {
      repaired += 1; // one agent that cannot be built is left out, never the whole answer
      return null;
    }
  });
  const conformed = conformAgents(built.filter((agent): agent is HqAgent => agent !== null));
  repaired += conformed.dropped;

  return {
    agents: conformed.agents,
    truncated: input.pageTruncated === true || eligible.length > ROSTER_CAP,
    repaired,
  };

  function buildAgent(entity: Entity): HqAgent {
    const claim = claims.get(entity);
    const parent = parentOf.get(entity);
    const linked = parent !== undefined && !inCycle(entity);
    // A claim that points into a cycle gives no edge and no claim of a parent: a root. One that points off the roster is a child whose
    // parent is away.
    const refused = parent !== undefined && !linked;
    const hasClaim = claim !== undefined && !refused;
    const { paseo, transcript, hook } = entity;
    const provider =
      paseo !== null
        ? normaliseProvider(paseo.provider)
        : (transcript?.provider ?? (hook === null ? 'other' : 'claude'));
    const sessionId = transcript?.sessionId ?? paseo?.sessionId ?? hook?.sessionId ?? null;
    const label: LiveSessionLabel | undefined =
      sessionId !== null && provider !== 'other'
        ? labels.get(liveSessionKey(provider, sessionId))
        : undefined;
    const cwd = paseo?.cwd ?? transcript?.cwd ?? hook?.cwd ?? null;
    const startedAt =
      paseo?.createdAt ??
      transcript?.startedAt ??
      (paseo === null && transcript === null && hook?.kind === 'start' ? hook.at : null);
    return {
      id: idOf.get(entity) ?? keyId(entity.sortKey),
      ...(input.includePaseoAgentIds && paseo ? { paseoAgentId: paseo.id } : {}),
      ...(entity.shown.reviewPending !== undefined && {
        reviewPending: entity.shown.reviewPending,
      }),
      ...(entity.shown.backgroundWorkActive && { backgroundWorkActive: true }),
      ...(entity.shown.confirmedEmpty && { confirmedEmpty: true }),
      provider,
      kind: hasClaim ? 'child' : 'root',
      parentId: linked ? (idOf.get(parent) ?? null) : null,
      parentBasis: hasClaim ? claim.basis : null,
      parentAway: claim !== undefined && parent === undefined,
      title: paseo?.title ?? label?.title ?? null,
      repo: label?.repo ?? repoFor(cwd),
      workspace: paseo?.workspaceName ?? lastSegment(cwd) ?? label?.workspace ?? null,
      state: entity.shown.state,
      activity: entity.shown.activity,
      waitReason: entity.shown.waitReason,
      confidence: entity.shown.confidence,
      since: toIso(entity.shown.since),
      lastActivityAt: toIso(entity.shown.lastActivityAt),
      startedAt: startedAt === null ? null : toIso(startedAt),
      seenBy: { paseo: paseo !== null, transcript: transcript !== null },
    };
  }
}
