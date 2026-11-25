import type { HqActivity, HqAgent, HqProvider } from '../../../shared/contracts/hq';
import { dotJoin } from '../../lib/format';
import { HQ_COPY, SCENE_COPY, agentDisplayTitle, elapsed, sceneCaption } from './copy';
import { isReadyToReview, type AgentNode, type Session } from './sessions';

// The scene's layout model, pure and React-free: which session sits in which room, who stands in it and what they are doing. The
// drawing (Scene.tsx and the files beside it) only follows this. Rooms keep their slot for as long as their session is present, so
// nothing jumps between the polls; the caller holds the previous `Scene` and passes it back in. Every session has a room: the
// building has as many columns as the screen allows and simply grows taller, one row per `columns` sessions.

export type Pose =
  | 'editing'
  | 'reading'
  | 'command'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'idle'
  | 'error'
  | 'finished'
  | 'starting';

/** `needs`: an agent in the room is waiting for the owner. `idle`: everyone in it is idle. */
export type Mood = 'needs' | 'idle' | 'normal';

export interface SceneCharacter {
  id: string;
  /** Shape carries the provider: a fox for Claude Code, an owl for Codex, a neutral dashed blob for anything else. */
  provider: HqProvider;
  pose: Pose;
  /** The short state under the character. */
  caption: string;
  /** The root of a room with helpers in it; a solo agent is not a captain. */
  captain: boolean;
}

export interface SceneRoom {
  /** The session's id (its root's id). */
  id: string;
  /** The cell the room keeps while its session is present (at this column count), counted along the rows from the top left. */
  slot: number;
  /** The sign's first line: the session's title, else where it runs (so two chats in one repository read differently). */
  name: string;
  /** Where it runs (the repository, else the workspace), for the start of the sign's second line; null when `name` already says it. */
  place: string | null;
  /** The crew and state, for the end of the sign's second line: "captain + 3", "solo", "idle 12 min", "parent away". */
  detail: string;
  mood: Mood;
  /** The root first (the captain, when it has helpers), then up to `MAX_HELPERS` helpers. */
  characters: SceneCharacter[];
  /** Helpers beyond the ones drawn. */
  bench: number;
}

export interface Scene {
  /** In slot order. */
  rooms: SceneRoom[];
  /** The building's columns: the screen's, whatever the number of sessions. */
  cols: number;
  /**
   * How many cells the building has: whole rows, up to the one that holds the highest slot in use, so the slots are 0 to cells - 1.
   * A cell with nobody in it (a vacated slot, or the rest of the last row) is drawn as an empty room.
   */
  cells: number;
}

export interface SceneOptions {
  /** The most columns that fit: 1 on a phone, 2 on a tablet, 3 on a desktop. */
  columns: 1 | 2 | 3;
  /** The clock idle times are measured against. */
  nowMs: number;
}

export const MAX_HELPERS = 5;

const POSE_OF_ACTIVITY: Record<HqActivity, Pose> = {
  thinking: 'thinking',
  planning: 'thinking',
  responding: 'working',
  reading: 'reading',
  editing: 'editing',
  command: 'command',
  delegating: 'working',
  tool: 'working',
  none: 'working',
};

export function poseOf(
  agent: Pick<HqAgent, 'state' | 'activity' | 'reviewPending' | 'backgroundWorkActive'>,
): Pose {
  if ((agent.state === 'idle' || agent.state === 'finished') && agent.backgroundWorkActive) {
    return 'working';
  }
  if (isReadyToReview(agent)) return 'finished';
  switch (agent.state) {
    case 'working':
      return POSE_OF_ACTIVITY[agent.activity];
    case 'waiting':
      return 'waiting';
    case 'idle':
      return 'idle';
    case 'error':
      return 'error';
    case 'finished':
      return 'finished';
    case 'starting':
      return 'starting';
  }
}

/** The root, then everyone it spawned, nested ones after the agent that spawned them. */
function inOrder(node: AgentNode): HqAgent[] {
  return [node.agent, ...node.children.flatMap(inOrder)];
}

const time = (instant: string) => Date.parse(instant);
const idle = (agent: HqAgent) => agent.state === 'idle' && poseOf(agent) === 'idle';

/** Where the session runs: the repository's name (without its owner), else the workspace. */
function placeOf(root: HqAgent): string | null {
  return root.repo?.split('/').pop() || root.workspace || null;
}

/** The sign's two lines of name: the root's title (one line of text) and where it runs, else the place alone and nothing to repeat. */
function signNames(root: HqAgent): Pick<SceneRoom, 'name' | 'place'> {
  const place = placeOf(root);
  const title = agentDisplayTitle(root)?.replace(/\s+/g, ' ');
  if (!title) return { name: place ?? HQ_COPY.noName, place: null };
  return { name: title, place: title === place ? null : place };
}

function roomDetail(session: Session, agents: readonly HqAgent[], nowMs: number): string {
  const root = session.root.agent;
  const helpers = session.size - 1;
  if (helpers > 0) return SCENE_COPY.captain(helpers);
  const napping = agents.every(idle);
  // "idle 12 min" already says there is one agent, so "solo" is left off it: the sign's second line is short.
  return dotJoin([
    root.parentAway ? SCENE_COPY.parentAway : !napping && SCENE_COPY.solo,
    napping && SCENE_COPY.idle(elapsed(time(root.since), nowMs)),
  ]);
}

function roomOf(session: Session, slot: number, nowMs: number): SceneRoom {
  const agents = inOrder(session.root);
  const drawn = agents.slice(0, 1 + MAX_HELPERS);
  return {
    id: session.id,
    slot,
    ...signNames(session.root.agent),
    detail: roomDetail(session, agents, nowMs),
    mood: agents.some((a) => a.state === 'waiting')
      ? 'needs'
      : agents.every(idle)
        ? 'idle'
        : 'normal',
    characters: drawn.map((agent, i) => ({
      id: agent.id,
      provider: agent.provider,
      pose: poseOf(agent),
      caption: sceneCaption(agent),
      captain: i === 0 && agents.length > 1,
    })),
    bench: agents.length - drawn.length,
  };
}

/**
 * Lays the sessions out in rooms, one for every session, `columns` to a row. While a session is present it keeps its slot: one that
 * is gone leaves its slot empty (drawn as an empty room) and a new one takes the lowest free slot. Only the rows after the last
 * occupied slot are dropped, so no room ever moves because of another one leaving. When the column count itself changes (the window
 * was resized) the slots are closed up instead, in the order they had, since the grid is being redrawn anyway.
 */
export function layoutScene(
  prev: Scene | null,
  sessions: readonly Session[],
  { columns, nowMs }: SceneOptions,
): Scene {
  const before = new Map((prev?.rooms ?? []).map((room) => [room.id, room.slot]));
  const kept = sessions
    .filter((session) => before.has(session.id))
    .map((session) => ({ id: session.id, slot: before.get(session.id) ?? 0 }))
    .sort((a, b) => a.slot - b.slot);
  const slots = new Map(
    prev?.cols === columns
      ? kept.map(({ id, slot }) => [id, slot] as const)
      : kept.map(({ id }, index) => [id, index] as const),
  );
  const taken = new Set(slots.values());
  let free = 0;
  for (const session of sessions) {
    if (slots.has(session.id)) continue;
    while (taken.has(free)) free += 1;
    slots.set(session.id, free);
    taken.add(free);
  }

  const rooms = sessions
    .map((session) => roomOf(session, slots.get(session.id) ?? 0, nowMs))
    .sort((a, b) => a.slot - b.slot);
  const last = rooms.at(-1)?.slot;
  return {
    rooms,
    cols: columns,
    cells: last === undefined ? 0 : columns * Math.ceil((last + 1) / columns),
  };
}
