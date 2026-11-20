import { useState, type CSSProperties } from 'react';
import type { HqAgent } from '../../../shared/contracts/hq';
import { cx } from '../../lib/cx';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { SCENE_COPY } from './copy';
import { BOIL } from './motion';
import { EmptyRoom, ROOM_HEIGHT, ROOM_HEIGHT_TALL, Room } from './Room';
import { layoutScene, type Scene } from './scene';
import { sketchLine } from './sketch';
import { buildSessions } from './sessions';
import { captionsCollide, planStage } from './stage';
import { SceneFilters, useSceneFilters } from './sceneFilters';

// HQ's illustrated scene: a hand-drawn cutaway building on a notebook page, one room per session, drawn from `layoutScene`. It is
// decorative: hidden from assistive technology, no focusable part, and the roster below it is the accessible account of the page.
// Original art in the logbook-sketch style (DESIGN.md › HQ); the buddies stay the characters on every other screen.

/** The in-scene handwriting, defined once: the self-hosted Shantell Sans (the @font-face in theme/globals.css), then system handwriting faces. */
export const HAND_FONT =
  "'Shantell Sans', 'Bradley Hand', 'Segoe Print', 'Chalkboard SE', 'Comic Sans MS', cursive";

/** A room's drawing box, in its own units, by how many columns the building has. */
const WIDTH = { 1: 290, 2: 420, 3: 360 } as const;

/** Whether two scenes put the same sessions in the same cells. */
function sameSlots(a: Scene, b: Scene): boolean {
  const key = (scene: Scene) =>
    `${scene.cols}/${scene.cells}/${scene.rooms.map((room) => `${room.id}:${room.slot}`).join(',')}`;
  return key(a) === key(b);
}

/** The notebook page every HQ drawing sits on: cream paper, ruled lines, room for the margin line (the caller adds it and a max width). */
export const PAGE_CLASS = cx(
  'pointer-events-none relative isolate select-none overflow-hidden rounded-md border border-border bg-canvas',
  'bg-[linear-gradient(to_bottom,transparent_25px,var(--color-border)_25px,var(--color-border)_26px)] bg-[length:100%_26px]',
  'pb-3 pl-6 pr-3 pt-4 min-[720px]:pl-[52px] min-[720px]:pr-5',
);

const ROOF = {
  wash: 'M18 54 L500 6 L982 54 Z',
  ink: `${sketchLine(14, 54, 500, 6, 7)} ${sketchLine(500, 6, 986, 54, 8)}`,
  eave: sketchLine(14, 54, 986, 54, 9),
};

/** The roof stretches to the building's width; its strokes keep their weight. */
export function Roof() {
  return (
    <svg
      viewBox="0 0 1000 56"
      preserveAspectRatio="none"
      className="block h-12 w-full overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      <g
        className={cx('fill-none stroke-ink', BOIL[0])}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          className="fill-border-strong stroke-border-strong"
          fillOpacity="0.25"
          strokeOpacity="0.15"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
          d={ROOF.wash}
        />
        <path strokeWidth="1.5" vectorEffect="non-scaling-stroke" d={ROOF.ink} />
        <path strokeWidth="1.5" vectorEffect="non-scaling-stroke" d={ROOF.eave} />
      </g>
    </svg>
  );
}

export function Vent() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="absolute left-1/2 top-[14px] h-6 w-6 -translate-x-1/2"
      aria-hidden="true"
      focusable="false"
    >
      <g className={cx('fill-none stroke-ink', BOIL[0])} strokeLinecap="round">
        <circle
          className="fill-selection-surface stroke-selection-surface"
          cx="12"
          cy="12"
          r="7.5"
          strokeWidth="1.2"
        />
        <circle cx="12" cy="12" r="8" strokeWidth="1.5" />
        <path strokeWidth="1.4" d="M12 4.5 V19.5" />
      </g>
    </svg>
  );
}

export function Ground() {
  return (
    <svg
      viewBox="0 0 1000 14"
      preserveAspectRatio="none"
      className="block h-3.5 w-full overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      <g className={cx('fill-none stroke-ink', BOIL[2])} strokeLinecap="round">
        <path
          className="stroke-border-strong"
          strokeOpacity="0.5"
          strokeWidth="7"
          vectorEffect="non-scaling-stroke"
          d={sketchLine(0, 9, 1000, 9, 21)}
        />
        <path
          strokeWidth="1.7"
          vectorEffect="non-scaling-stroke"
          d={sketchLine(2, 4, 998, 4, 22)}
        />
      </g>
    </svg>
  );
}

/** "HQ, today", with a grape underline. In the page's handwriting, not a heading: the page's own title is the h1. */
export function Heading() {
  return (
    <div className="mb-1 w-fit">
      <p className="text-[22px] font-semibold leading-7 text-ink" style={{ fontFamily: HAND_FONT }}>
        {SCENE_COPY.heading}
      </p>
      <svg
        viewBox="0 0 120 8"
        className="-mt-0.5 block h-2 w-[120px] overflow-visible"
        aria-hidden="true"
        focusable="false"
      >
        <path
          className="fill-none stroke-action"
          strokeWidth="1.8"
          strokeLinecap="round"
          d="M2 5 C30 2 70 6 104 4 C112 3.6 116 4.4 118 5"
        />
      </svg>
    </div>
  );
}

export function HqScene({ agents, nowMs }: { agents: readonly HqAgent[]; nowMs: number }) {
  const wide = useMediaQuery('(min-width: 1280px)');
  const medium = useMediaQuery('(min-width: 720px)');
  const columns = wide ? 3 : medium ? 2 : 1;
  const filters = useSceneFilters();
  // The previous scene is what keeps every room in its slot from poll to poll. It is state that is only replaced when a slot
  // changes (React's "adjust state during render" pattern), so laying out is a pure function of the roster and the last scene.
  const [previous, setPrevious] = useState<Scene | null>(null);
  const scene = layoutScene(previous, buildSessions(agents), { columns, nowMs });
  if (previous === null || !sameSlots(previous, scene)) setPrevious(scene);

  const width = WIDTH[columns];
  const tall = scene.rooms.some((room) =>
    captionsCollide(room.characters, planStage(room.characters, room.bench, width).stations, 13),
  );
  const height = tall ? ROOM_HEIGHT_TALL : ROOM_HEIGHT;
  const byslot = new Map(scene.rooms.map((room) => [room.slot, room]));
  const cells = Array.from({ length: scene.cells }, (_, slot) => ({
    slot,
    room: byslot.get(slot),
  }));

  return (
    <div
      aria-hidden="true"
      data-testid="hq-scene"
      className={cx(PAGE_CLASS, 'max-w-[1000px]')}
      style={{ ...filters.style, fontFamily: HAND_FONT } as CSSProperties}
    >
      <SceneFilters defs={filters.defs} />
      <div className="absolute inset-y-0 left-3 w-px bg-series-delivery/30 min-[720px]:left-10" />
      <Heading />
      <div className="relative">
        <Roof />
        <Vent />
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${scene.cols}, minmax(0, 1fr))` }}
        >
          {cells.map(({ slot, room }) =>
            room ? (
              <Room
                key={room.id}
                room={room}
                width={width}
                height={height}
                edgeRight={slot % scene.cols === scene.cols - 1}
              />
            ) : (
              <EmptyRoom
                key={`empty-${slot}`}
                slot={slot}
                width={width}
                height={height}
                edgeRight={slot % scene.cols === scene.cols - 1}
              />
            ),
          )}
        </div>
        <Ground />
      </div>
    </div>
  );
}
