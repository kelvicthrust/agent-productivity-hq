import type { CSSProperties } from 'react';
import { cx } from '../../lib/cx';
import { DeskBig, Door, Mug, Plant } from './art';
import { AFK_COPY } from './copy';
import { Ground, HAND_FONT, Heading, PAGE_CLASS, Roof, Vent } from './HqScene';
import { BOIL, SWIVEL } from './motion';
import { sketchBox, sketchLine, washBox } from './sketch';
import { SceneFilters, useSceneFilters } from './sceneFilters';

// The quiet state's drawing: one wide room of the building with nobody in it, an "AFK" sign hung in the middle, and the traces of
// everyone having stepped out (a chair pushed back and still turning, a mug still steaming, a trail of paw and talon prints to a door
// left ajar, a "back soon" note). It is decorative, like the rest of HQ's art: hidden from assistive technology, nothing focusable, and
// the sentence under it (HQ_COPY.quiet) is the statement of the state. No character is drawn: a sleeping one would mean an idle
// agent, which is a real state on this page. Same logbook-sketch look as the scene (DESIGN.md › HQ); the props are art.tsx's.

const WIDTH = 480;
const FLOOR = 204;
const HEIGHT = 254;

const SIGN = { x: 120, y: 18, w: 200, h: 88 } as const;
const NOTE = { x: 338, y: 36, w: 76, h: 68, turn: 5 } as const;
const CHAIR_X = 96;
const DESK_X = 212;
const DOOR_X = 438;
const DOOR_SCALE = 1.2;

/** A hand-drawn deterministic jitter for the prints, so the trail looks walked rather than stamped. */
const turn = (i: number, base: number) => base + ((i * 37) % 17) - 8;

/** A fox's paw, pointing up: a pad and four toes. The origin is its centre. */
function FoxPrint() {
  return (
    <g>
      <g className="fill-series-claude stroke-none" fillOpacity="0.5">
        <ellipse cx="0" cy="2.4" rx="4.8" ry="4" />
        <ellipse cx="-5.2" cy="-3" rx="1.9" ry="2.4" />
        <ellipse cx="-2" cy="-6.4" rx="1.9" ry="2.4" />
        <ellipse cx="2" cy="-6.4" rx="1.9" ry="2.4" />
        <ellipse cx="5.2" cy="-3" rx="1.9" ry="2.4" />
      </g>
      <g className="stroke-series-claude" strokeWidth="1.2" strokeOpacity="0.9">
        <path d="M-4.6 2.4 C-4.6 -1 4.6 -1 4.6 2.4 C4.6 5.8 -4.6 5.8 -4.6 2.4 Z" />
        <circle cx="-5.2" cy="-3" r="1.8" />
        <circle cx="-2" cy="-6.4" r="1.8" />
        <circle cx="2" cy="-6.4" r="1.8" />
        <circle cx="5.2" cy="-3" r="1.8" />
      </g>
    </g>
  );
}

/** An owl's talons, pointing up: three toes forward, one back. The origin is its centre. */
function OwlPrint() {
  return (
    <g className="stroke-series-codex" strokeWidth="1.8" strokeOpacity="0.9">
      <path d="M0 2 V-8 M0 2 L-6 -5.5 M0 2 L6 -5.5 M0 2 V7" />
      <g className="fill-series-codex" strokeWidth="0.8">
        <circle cx="0" cy="-8.6" r="1.1" />
        <circle cx="-6.6" cy="-6.2" r="1.1" />
        <circle cx="6.6" cy="-6.2" r="1.1" />
      </g>
    </g>
  );
}

const FOX_STEPS = [150, 205, 260, 315, 370].map((x, i) => ({ x, y: i % 2 ? 225 : 216 }));
const OWL_STEPS = [176, 231, 286, 341, 396].map((x, i) => ({ x, y: i % 2 ? 244 : 235 }));

/** The two trails, on the floor and heading right, to the door. */
function Prints() {
  return (
    <>
      {FOX_STEPS.map(({ x, y }, i) => (
        <g key={`fox-${x}`} transform={`translate(${x} ${y}) rotate(${turn(i, 90)})`}>
          <FoxPrint />
        </g>
      ))}
      {OWL_STEPS.map(({ x, y }, i) => (
        <g key={`owl-${x}`} transform={`translate(${x} ${y}) rotate(${turn(i + 3, 90)})`}>
          <OwlPrint />
        </g>
      ))}
    </>
  );
}

/** A desk chair pushed back from the desk, its backrest still turning. The origin is the floor under the pole. */
function Chair() {
  return (
    <g>
      <path
        className="fill-action stroke-action"
        fillOpacity="0.3"
        strokeOpacity="0.3"
        strokeWidth="1.2"
        d="M-22 -35 C-14 -39 14 -39 22 -35 C24 -32 22 -29 20 -29 C12 -26 -12 -26 -20 -29 C-23 -29 -24 -32 -22 -35 Z"
      />
      <path
        strokeWidth="2"
        d="M-22 -35 C-14 -39 14 -39 22 -35 C24 -32 22 -29 19 -28.5 C12 -26 -12 -26 -19 -28.5 C-23 -29 -24 -32 -22 -35 Z"
      />
      <path strokeWidth="2" d="M0 -26 V-10 M0 -10 L-17 -3 M0 -10 L17 -3 M0 -10 L0 -2" />
      <g strokeWidth="1.8">
        <circle cx="-19" cy="-2.4" r="2.4" />
        <circle cx="19" cy="-2.4" r="2.4" />
        <circle cx="0" cy="-1.4" r="1.8" />
      </g>
      <g className={SWIVEL}>
        <path
          className="fill-action stroke-action"
          fillOpacity="0.3"
          strokeOpacity="0.3"
          strokeWidth="1.2"
          d="M-26 -74 C-20 -78 -10 -77 -7 -73 C-6 -63 -7 -53 -9 -46 C-14 -43 -22 -44 -26 -46 C-28 -55 -28 -66 -26 -74 Z"
        />
        <path
          strokeWidth="2"
          d="M-26.5 -73 C-20 -77.5 -10 -77 -6.5 -72.5 C-5.5 -63 -6.5 -53 -8.5 -46 C-14 -43 -21 -43.5 -26 -45.5 C-28 -55 -28 -65 -26.5 -73 Z M-17 -44 V-37"
        />
      </g>
      {/* The turning, drawn at rest so it still reads with reduced motion. */}
      <g className="stroke-ink-muted" strokeWidth="1.5">
        <path d="M-30 -58 C-36 -52 -35 -44 -30 -40 M-31.5 -37 L-29.5 -40.5 L-26 -38.5" />
        <path d="M30 -64 C36 -58 35 -50 30 -46 M31.5 -43 L29.5 -46.5 L26 -44.5" />
      </g>
    </g>
  );
}

/** The hung sign: the room's only loud thing. */
function Sign() {
  const { x, y, w, h } = SIGN;
  return (
    <>
      <path
        className="fill-sunshine stroke-sunshine"
        fillOpacity="0.28"
        strokeOpacity="0.2"
        strokeWidth="1.2"
        d={washBox(x - 16, y - 10, w + 32, h + 28, 41)}
      />
      <path
        className="fill-surface stroke-surface"
        fillOpacity="0.92"
        strokeOpacity="0.2"
        strokeWidth="1.2"
        d={washBox(x + 1, y + 1, w - 2, h - 2, 42)}
      />
      <path strokeWidth="2" d={sketchBox(x, y, w, h, 43)} />
      <path
        className="stroke-ink-muted"
        strokeWidth="1.4"
        d={`${sketchLine(x + 24, 0, x + 24, y + 2, 44)} ${sketchLine(x + w - 24, 0, x + w - 24, y + 2, 45)}`}
      />
      <circle className="fill-ink stroke-none" cx={x + 24} cy={y + 3.5} r="1.8" />
      <circle className="fill-ink stroke-none" cx={x + w - 24} cy={y + 3.5} r="1.8" />
      <path
        className="stroke-action"
        strokeWidth="2.4"
        d="M146 93 C170 88 205 96 232 91 C252 88 270 92 294 90"
      />
    </>
  );
}

/** The sticky note, taped to the wall. */
function Note() {
  const { x, y, w, h, turn: angle } = NOTE;
  return (
    <g transform={`rotate(${angle} ${x + w / 2} ${y + h / 2})`}>
      <path
        className="fill-sunshine stroke-sunshine"
        fillOpacity="0.65"
        strokeOpacity="0.35"
        strokeWidth="1.2"
        d={washBox(x, y, w, h, 51)}
      />
      <path strokeWidth="1.6" d={sketchBox(x, y, w, h, 52)} />
      <path
        className="fill-border-strong stroke-border-strong"
        fillOpacity="0.55"
        strokeOpacity="0.3"
        strokeWidth="1.2"
        d={washBox(x + w / 2 - 13, y - 6, 26, 11, 53)}
      />
    </g>
  );
}

function NoteText() {
  const { x, y, w, h, turn: angle } = NOTE;
  return (
    <g transform={`rotate(${angle} ${x + w / 2} ${y + h / 2})`}>
      {AFK_COPY.note.map((word, i) => (
        <text
          key={word}
          x={x + w / 2}
          y={y + 31 + i * 22}
          fontSize="22"
          fontWeight="500"
          textAnchor="middle"
          className="fill-ink"
        >
          {word}
        </text>
      ))}
    </g>
  );
}

/** The doorway with its door swung part way open: a dark gap, and the light from outside across the floor. */
function AjarDoor() {
  return (
    <g transform={`scale(${DOOR_SCALE})`}>
      <path className="fill-ink stroke-none" fillOpacity="0.28" d="M-3 -66 L19 -66 L19 0 L-3 0 Z" />
      <path
        className="fill-sunshine stroke-sunshine"
        fillOpacity="0.4"
        strokeOpacity="0.2"
        strokeWidth="1.2"
        d="M-3 0 L19 0 L28 11 L-12 11 Z"
      />
      <g transform="translate(-19 0) scale(0.45 1) translate(19 0)">
        <Door />
      </g>
    </g>
  );
}

function Frame({ seed }: { seed: number }) {
  return (
    <>
      <path
        className="fill-border-strong stroke-border-strong"
        fillOpacity="0.35"
        strokeOpacity="0.2"
        strokeWidth="1.2"
        d={washBox(2, FLOOR + 1, WIDTH - 4, HEIGHT - FLOOR - 3, seed)}
      />
      <path strokeWidth="1.5" d={sketchLine(3, 0, 3, HEIGHT, seed + 10)} />
      <path strokeWidth="1.5" d={sketchLine(WIDTH - 3, 0, WIDTH - 3, HEIGHT, seed + 11)} />
      <path strokeWidth="1.6" d={sketchLine(0, FLOOR, WIDTH, FLOOR, seed + 12)} />
      <path strokeWidth="1.4" d={sketchLine(0, HEIGHT - 2, WIDTH, HEIGHT - 2, seed + 13)} />
    </>
  );
}

/** Nobody is in. Decorative; the footnote beside it says it in words. */
export function AfkScene() {
  const filters = useSceneFilters();
  return (
    <div
      aria-hidden="true"
      data-testid="hq-afk"
      className={cx(PAGE_CLASS, 'w-full max-w-[720px]')}
      style={{ ...filters.style, fontFamily: HAND_FONT } as CSSProperties}
    >
      <SceneFilters defs={filters.defs} />
      <div className="absolute inset-y-0 left-3 w-px bg-series-delivery/30 min-[720px]:left-10" />
      <Heading />
      <div className="relative">
        <Roof />
        <Vent />
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block h-auto w-full overflow-visible"
          aria-hidden="true"
          focusable="false"
        >
          <g
            className={cx('fill-none stroke-ink', BOIL[0])}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <Frame seed={61} />
            <Sign />
            <Note />
            <g transform={`translate(${DOOR_X} ${FLOOR})`}>
              <AjarDoor />
            </g>
          </g>
          <g
            className={cx('fill-none stroke-ink', BOIL[1])}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <g transform={`translate(${CHAIR_X - 64} ${FLOOR})`}>
              <Plant />
            </g>
            <g transform={`translate(${DESK_X} ${FLOOR})`}>
              <DeskBig />
            </g>
            <g transform={`translate(${DESK_X + 34} ${FLOOR - 33})`}>
              <Mug />
            </g>
            <g transform={`translate(${CHAIR_X} ${FLOOR})`}>
              <Chair />
            </g>
          </g>
          <g
            className={cx('fill-none stroke-ink', BOIL[2])}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <Prints />
          </g>
          <g>
            <text
              x={SIGN.x + SIGN.w / 2}
              y={SIGN.y + 66}
              fontSize="68"
              fontWeight="700"
              textAnchor="middle"
              className="fill-ink"
            >
              {AFK_COPY.sign}
            </text>
            <NoteText />
          </g>
        </svg>
        <Ground />
      </div>
    </div>
  );
}
