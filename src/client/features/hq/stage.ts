import type { Pose, SceneCharacter } from './scene';

// Where each character stands along a room's floor, and how big the whole line of them is drawn so that up to six fit. Pure: the
// numbers are in the room's own units, so a room of any width is planned the same way.

/** How far a character's station reaches to either side of the character, drawn at full size: its desk, terminal or cushion. */
type Reach = readonly [left: number, right: number];

const REACH: Record<Pose, { captain: Reach; helper: Reach }> = {
  editing: { captain: [65, 89], helper: [44, 57] },
  working: { captain: [65, 89], helper: [44, 57] },
  reading: { captain: [44, 57], helper: [44, 57] },
  command: { captain: [22, 54], helper: [22, 54] },
  thinking: { captain: [30, 22], helper: [30, 22] },
  waiting: { captain: [46, 28], helper: [46, 28] },
  idle: { captain: [33, 33], helper: [33, 33] },
  error: { captain: [24, 42], helper: [24, 42] },
  finished: { captain: [24, 28], helper: [24, 28] },
  starting: { captain: [34, 24], helper: [34, 24] },
};
/** With no desk: a crowded room lets its readers and writers stand and hold their sheets. */
const STANDING: Reach = [24, 38];
const DESKED = new Set<Pose>(['editing', 'working', 'reading']);

const MARGIN_LEFT = 26;
const MARGIN_RIGHT = 22;
const GAP = 6;
const BENCH = 50;
/** Below this a line of characters is too small to read, so desks are put away before shrinking further. */
const COMFORTABLE = 0.72;
const MAX_SPREAD = 28;
/** From this width a room is the one wide room, which leaves a solo agent space to either side. */
const WIDE = 500;

export interface Station {
  /** The character's x in the room. */
  x: number;
  /** Seated at a desk, as opposed to standing on the floor. */
  desk: boolean;
}

export interface Stage {
  stations: Station[];
  /** The scale the whole line is drawn at, 1 or less. */
  scale: number;
  /** Where the bench count goes, when there is one. */
  benchX: number | null;
  /** Where the line ends: the free floor beyond it holds a door and a plant. */
  end: number;
}

function reachOf(c: SceneCharacter, desk: boolean): Reach {
  const own = REACH[c.pose][c.captain ? 'captain' : 'helper'];
  return DESKED.has(c.pose) && !desk ? STANDING : own;
}

export function planStage(
  characters: readonly SceneCharacter[],
  bench: number,
  width: number,
): Stage {
  const room = width - MARGIN_LEFT - MARGIN_RIGHT;
  const extent = (desk: boolean) =>
    characters.reduce((sum, c) => sum + reachOf(c, desk)[0] + reachOf(c, desk)[1] + GAP, 0) +
    (bench > 0 ? BENCH : 0);
  const desk = extent(true) <= room / COMFORTABLE;
  const total = extent(desk);
  const scale = Math.min(1, room / total);
  const spread =
    scale < 1 ? 0 : Math.min(MAX_SPREAD, (room - total) / Math.max(1, characters.length));

  // One character in a wide room stands in the middle of it, not against the wall.
  const centred =
    characters.length === 1 && bench === 0 && scale === 1 && width >= WIDE ? (room - total) / 2 : 0;
  let cursor = MARGIN_LEFT + centred;
  const stations = characters.map((c) => {
    const [left, right] = reachOf(c, desk);
    const x = cursor + left * scale;
    cursor += (left + right + GAP) * scale + spread;
    return { x, desk: desk && DESKED.has(c.pose) };
  });
  return {
    stations,
    scale,
    benchX: bench > 0 ? cursor + (BENCH * scale) / 2 : null,
    end: cursor + (bench > 0 ? BENCH * scale : 0),
  };
}

/** Whether neighbouring captions would run into each other along one row, so a crowded room puts every other one a line lower. */
export function captionsCollide(
  characters: readonly SceneCharacter[],
  stations: readonly Pick<Station, 'x'>[],
  size: number,
): boolean {
  // 0.56 em a character is the wide end of Shantell Sans at the caption size (its real captions measure 0.44 to 0.56).
  const width = (c: SceneCharacter) => c.caption.length * size * 0.56 + 4;
  return characters.some((c, i) => {
    const next = characters[i + 1];
    const a = stations[i];
    const b = stations[i + 1];
    return next && a && b ? b.x - a.x < (width(c) + width(next)) / 2 : false;
  });
}
