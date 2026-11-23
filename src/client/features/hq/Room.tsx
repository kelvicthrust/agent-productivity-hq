import { cx } from '../../lib/cx';
import {
  BlindWindow,
  Books,
  Cushion,
  DeskBig,
  DeskPaper,
  DeskScribbles,
  DeskSmall,
  Door,
  ErrorMarks,
  Mug,
  Plant,
  QBubble,
  ReadArm,
  ReadSheetTilt,
  Star,
  Terminal,
  ThoughtDots,
  Window,
  ZMarks,
  idleWash,
  needsInner,
  needsOuter,
} from './art';
import { CAPTAIN_SCALE, Character, FIGURE_HEIGHT, FIGURE_SCALE } from './Character';
import { SCENE_COPY } from './copy';
import { BOIL } from './motion';
import type { SceneCharacter, SceneRoom } from './scene';
import { seedOf, sketchBox, sketchLine, washBox } from './sketch';
import { captionsCollide, planStage, type Station as StationPlan } from './stage';

// One room of the cutaway building, drawn in its own box so the grid can be any shape. Ink and washes sit in two groups that each
// carry the line boil (never one per part); the handwriting sits outside them so it stays sharp. Decorative: the parent hides it from
// assistive technology, and the roster below is the account of who is where.

/** The floor line and the height of a room in its own units; the height grows when a crowded room's captions need a second row. */
export const FLOOR_Y = 210;
export const ROOM_HEIGHT = 236;
export const ROOM_HEIGHT_TALL = 252;

const SIGN = { x: 16, y: 12, h: 44 } as const;
const SEAT = 28;
const CUSHION = 15;
/** Handwriting sizes, in room units (a room is drawn at about the size it has here, a little less in a crowded row). */
const TITLE_SIZE = 15;
const SMALL_SIZE = 13;

/**
 * The sign is as wide as the room allows, and its two lines are cut to fit with an ellipsis. At two and three columns it is wide
 * enough for "usage-metrics · solo" beside the star (the longest ordinary second line). It stops short of the window, whose left edge
 * is 85 units in from the room's right (so 180 in a one-column room, with a gap), and, at two columns, at 194 so the idle room's
 * bookshelf (`shelfX` in `Room`) keeps its place.
 */
export function signWidth(width: number): number {
  return width <= 300 ? 180 : width <= 380 ? 200 : width <= 460 ? 194 : 230;
}

/**
 * The star on a room that needs the owner sits at the sign's right end: its left tip is 34 units in from the sign's right edge, and it is as tall as both
 * lines of text. Text on that sign stops 34 units sooner than the 12-unit margin it otherwise keeps, which leaves about 12 units
 * between the last letter (the ellipsis, the widest glyph) and the star's tip.
 */
const STAR_CLEARANCE = 34;

/** The width, in room units, the sign's two lines of text may use: the sign less its margins, and less the star's room when it has a star. */
export function signTextWidth(sign: number, needs: boolean): number {
  return sign - 24 - (needs ? STAR_CLEARANCE : 0);
}

/** How many characters of the scene's handwriting at `size` fit in `room` units. */
function capacity(room: number, size: number): number {
  // Estimate 0.54 em a character so sign layout is available while the font loads.
  return Math.max(4, Math.floor(room / (size * 0.54)));
}

/** Cuts `text` to `chars` characters, ending in an ellipsis when it was cut. */
function cut(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1).trimEnd()}…`;
}

/** Cuts `text` to what fits in `room` units of the scene's handwriting at `size`, ending in an ellipsis when it was cut. */
export function fit(text: string, room: number, size: number): string {
  return cut(text, capacity(room, size));
}

const PLACE_SEPARATOR = ' · ';
/** The least of a place worth drawing: three letters and the ellipsis. */
const PLACE_MIN = 4;

/**
 * The sign's second line, "place · state" ("usage-metrics · captain + 3"). The state (the crew, or how long it has been idle) is
 * what the owner reads this line for, so it is never cut for the place: the place takes what is left of the line and is cut with an
 * ellipsis, and when less than `PLACE_MIN` characters are left the place is left off and the line is the state alone. Only a state
 * that is wider than the whole line is cut itself. With no place the line is the state.
 */
export function fitSecondLine(
  place: string | null,
  state: string,
  room: number,
  size: number,
): string {
  const left = capacity(room, size) - state.length - PLACE_SEPARATOR.length;
  if (place === null || left < PLACE_MIN) return fit(state, room, size);
  return `${cut(place, left)}${PLACE_SEPARATOR}${state}`;
}

function Frame({
  width,
  height,
  edgeRight,
  seed,
}: {
  width: number;
  height: number;
  edgeRight: boolean;
  seed: number;
}) {
  return (
    <>
      <path
        className="fill-border-strong stroke-border-strong"
        fillOpacity="0.35"
        strokeOpacity="0.2"
        strokeWidth="1.2"
        d={washBox(2, FLOOR_Y + 1, width - 4, height - FLOOR_Y - 3, seed)}
      />
      <path strokeWidth="1.5" d={sketchLine(3, 0, 3, height, seed + 10)} />
      {edgeRight && (
        <path strokeWidth="1.5" d={sketchLine(width - 3, 0, width - 3, height, seed + 11)} />
      )}
      <path strokeWidth="1.6" d={sketchLine(0, FLOOR_Y, width, FLOOR_Y, seed + 12)} />
      <path strokeWidth="1.4" d={sketchLine(0, height - 2, width, height - 2, seed + 13)} />
    </>
  );
}

/** A wash from the mockup stretched over the room's own box. */
function Blob({
  blob,
  frame,
  className,
  fillOpacity,
  strokeOpacity,
}: {
  blob: { d: string; box: readonly [number, number, number, number] };
  frame: {
    x: number;
    y: number;
    w: number;
    h: number;
    of: readonly [number, number, number, number];
  };
  className: string;
  fillOpacity: string;
  strokeOpacity: string;
}) {
  const [x0, x1, y0, y1] = frame.of;
  const sx = frame.w / (x1 - x0);
  const sy = frame.h / (y1 - y0);
  return (
    <path
      className={className}
      fillOpacity={fillOpacity}
      strokeOpacity={strokeOpacity}
      strokeWidth="1.2"
      vectorEffect="non-scaling-stroke"
      transform={`translate(${frame.x} ${frame.y}) scale(${sx} ${sy}) translate(${-x0} ${-y0})`}
      d={blob.d}
    />
  );
}

function Sign({ width, room, seed }: { width: number; room: SceneRoom; seed: number }) {
  const { x, y, h } = SIGN;
  return (
    <>
      <path
        className="fill-surface stroke-surface"
        fillOpacity="0.9"
        strokeOpacity="0.2"
        strokeWidth="1.2"
        d={washBox(x + 1, y + 1, width - 2, h - 2, seed + 20)}
      />
      <path strokeWidth="1.5" d={sketchBox(x, y, width, h, seed + 21)} />
      <path
        className="stroke-ink-muted"
        strokeWidth="1.2"
        d={`${sketchLine(x + 14, 0, x + 14, y + 2, seed + 25)} ${sketchLine(x + width - 14, 0, x + width - 14, y + 2, seed + 26)}`}
      />
      <circle className="fill-ink stroke-none" cx={x + 14} cy={y + 3.5} r="1.5" />
      <circle className="fill-ink stroke-none" cx={x + width - 14} cy={y + 3.5} r="1.5" />
      {room.mood === 'needs' && (
        <g transform={`translate(${x + width - 24} ${y + 21})`}>
          <Star />
        </g>
      )}
    </>
  );
}

/** Seated characters sit behind a desk; the rest stand on the floor. */
function Figure({ c, seat }: { c: SceneCharacter; seat: number }) {
  const scale = FIGURE_SCALE[c.provider] * (c.captain ? CAPTAIN_SCALE : 1);
  return (
    <g transform={`translate(0 ${-seat}) scale(${scale})`}>
      <Character provider={c.provider} pose={c.pose} captain={c.captain} />
    </g>
  );
}

/** One character with what it works at. The origin is the floor under the character. */
function Station({ c, desk }: { c: SceneCharacter; desk: boolean }) {
  const at = c.captain ? 12 : 4;
  switch (c.pose) {
    case 'editing':
    case 'working':
      return (
        <>
          <Figure c={c} seat={desk ? SEAT : 0} />
          {desk && (
            <g transform={`translate(${c.captain ? 12 : 6.5} 0)`}>
              {c.captain ? <DeskBig /> : <DeskSmall />}
            </g>
          )}
          <g transform={`translate(${at} 0)`}>
            <DeskPaper />
            {c.pose === 'editing' && <DeskScribbles />}
          </g>
        </>
      );
    case 'reading':
      return (
        <>
          <Figure c={c} seat={desk ? SEAT : 0} />
          <g transform="translate(6.5 0)">
            {desk && <DeskSmall />}
            <ReadSheetTilt />
            <ReadArm />
          </g>
        </>
      );
    case 'command':
      return (
        <>
          <Figure c={c} seat={0} />
          <Terminal />
        </>
      );
    case 'thinking':
      return (
        <>
          <Figure c={c} seat={0} />
          <ThoughtDots />
        </>
      );
    case 'waiting':
      return (
        <>
          <Figure c={c} seat={0} />
          <g transform="translate(4 -4) scale(0.9)">
            <QBubble />
          </g>
        </>
      );
    case 'idle':
      return (
        <>
          <Cushion />
          <Figure c={c} seat={CUSHION} />
          <ZMarks />
        </>
      );
    case 'error':
      return (
        <>
          <Figure c={c} seat={0} />
          <ErrorMarks />
        </>
      );
    case 'finished':
      return (
        <>
          <Figure c={c} seat={0} />
          <path className="stroke-success" strokeWidth="2.4" d="M17 -50 L21.5 -44.5 L30 -56" />
        </>
      );
    case 'starting':
      return (
        <>
          <Figure c={c} seat={0} />
          <g transform="translate(-34 0)">
            <Mug />
          </g>
        </>
      );
  }
}

/** Where an agent's head is, for the arrows: the floor, the seat, and the figure's height, all at the stage's scale. */
function headTop(c: SceneCharacter, station: StationPlan, scale: number): number {
  const seat = station.desk ? SEAT : c.pose === 'idle' ? CUSHION : 0;
  const figure =
    FIGURE_HEIGHT[c.provider] * FIGURE_SCALE[c.provider] * (c.captain ? CAPTAIN_SCALE : 1);
  return FLOOR_Y - scale * (seat + figure);
}

/** A grape arrow from the captain over to a helper, with the loop the mockup draws on the way. */
function Arrow({
  from,
  to,
  rank,
  step,
}: {
  from: readonly [number, number];
  to: readonly [number, number];
  rank: number;
  step: number;
}) {
  const [x0, top0] = from;
  const [x1, top1] = to;
  const y0 = top0 - 4;
  const y1 = top1 - 8;
  const peak = Math.max(66, Math.min(y0, y1) - 26 - rank * step);
  const control = (8 * peak - y0 - y1) / 6;
  const mid = (x0 + x1) / 2;
  const top = (y0 + y1 + 6 * control) / 8;
  return (
    <>
      <path d={`M${x0} ${y0} C${x0} ${control} ${x1} ${control} ${x1} ${y1}`} />
      <path d={`M${x1 - 5.5} ${y1 - 8.5} L${x1} ${y1} L${x1 + 5.3} ${y1 - 7.5}`} />
      <circle cx={mid} cy={top - 4} r="4.2" />
    </>
  );
}

export interface RoomProps {
  room: SceneRoom;
  width: number;
  height: number;
  /** The room at the right end of its row draws the building's right wall. */
  edgeRight: boolean;
  /** Native outlined lettering can measure the exact glyph advances. */
  staggeredCaptions?: boolean;
}

export function Room({ room, width, height, edgeRight, staggeredCaptions }: RoomProps) {
  const seed = seedOf(room.id);
  const stage = planStage(room.characters, room.bench, width);
  const sign = signWidth(width);
  const signText = signTextWidth(sign, room.mood === 'needs');
  const solo = room.characters.length === 1;
  const needs = room.mood === 'needs';
  const idle = room.mood === 'idle';
  const free = width - 22 - stage.end;
  const captain = room.characters[0];
  const captainStation = stage.stations[0];
  const staggered =
    staggeredCaptions ?? captionsCollide(room.characters, stage.stations, SMALL_SIZE);
  const shelfX = SIGN.x + sign + 80;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto w-full overflow-visible"
      aria-hidden="true"
      focusable="false"
      data-testid="hq-room"
      data-session={room.id}
      data-mood={room.mood}
    >
      <g
        className={cx('fill-none stroke-ink', BOIL[room.slot % 3])}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {needs && (
          <>
            <Blob
              blob={needsOuter}
              frame={{ x: 8, y: 6, w: width - 16, h: FLOOR_Y - 10, of: needsOuter.box }}
              className="fill-sunshine stroke-sunshine"
              fillOpacity="0.16"
              strokeOpacity="0.3"
            />
            <Blob
              blob={needsInner}
              frame={{ x: 8, y: 6, w: width - 16, h: FLOOR_Y - 10, of: needsOuter.box }}
              className="fill-sunshine stroke-sunshine"
              fillOpacity="0.08"
              strokeOpacity="0.12"
            />
          </>
        )}
        {idle && (
          <Blob
            blob={idleWash}
            frame={{ x: 8, y: 6, w: width - 16, h: height - 10, of: idleWash.box }}
            className="fill-series-neutral stroke-series-neutral"
            fillOpacity="0.12"
            strokeOpacity="0.22"
          />
        )}
        <Frame width={width} height={height} edgeRight={edgeRight} seed={seed} />
        <Sign width={sign} room={room} seed={seed} />
        <g transform={`translate(${width - 58} 60)`}>{idle ? <BlindWindow /> : <Window />}</g>
        {idle && shelfX + 59 < width - 70 && (
          <g transform={`translate(${shelfX} 112)`}>
            <Books />
          </g>
        )}
        {solo && width >= 500 ? (
          <>
            <g transform={`translate(${width - 46} ${FLOOR_Y})`}>
              <Door />
            </g>
            <g transform={`translate(${width * 0.2} ${FLOOR_Y})`}>
              <Plant />
            </g>
          </>
        ) : (
          solo &&
          free >= 70 && (
            <g transform={`translate(${width - 46} ${FLOOR_Y})`}>
              {seed % 2 === 0 ? <Door /> : <Plant />}
            </g>
          )
        )}
      </g>
      <g
        className={cx('fill-none stroke-ink', BOIL[(room.slot + 1) % 3])}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {captain && captainStation && room.characters.length > 1 && (
          <g className="stroke-action" strokeWidth="2">
            {room.characters.slice(1).map((c, i) => {
              const station = stage.stations[i + 1];
              return station ? (
                <Arrow
                  key={c.id}
                  from={[
                    captainStation.x + 3 + i * 4,
                    headTop(captain, captainStation, stage.scale),
                  ]}
                  to={[station.x, headTop(c, station, stage.scale)]}
                  rank={i}
                  step={room.characters.length > 4 ? 10 : 13}
                />
              ) : null;
            })}
          </g>
        )}
        {room.characters.map((c, i) => {
          const station = stage.stations[i];
          return station ? (
            <g key={c.id} transform={`translate(${station.x} ${FLOOR_Y}) scale(${stage.scale})`}>
              <Station c={c} desk={station.desk} />
            </g>
          ) : null;
        })}
        {stage.benchX !== null && (
          <path
            className="stroke-ink-muted"
            strokeWidth="1.8"
            d={`M${stage.benchX - 18} ${FLOOR_Y - 12} H${stage.benchX + 18} M${stage.benchX - 14} ${FLOOR_Y - 12} V${FLOOR_Y - 1} M${stage.benchX + 14} ${FLOOR_Y - 12} V${FLOOR_Y - 1}`}
          />
        )}
      </g>
      <g>
        <text
          x={SIGN.x + 12}
          y={SIGN.y + 20}
          fontSize={TITLE_SIZE}
          fontWeight="600"
          className="fill-ink"
          data-hq-max-width={signText}
        >
          {fit(room.name, signText, TITLE_SIZE)}
        </text>
        <text
          x={SIGN.x + 12}
          y={SIGN.y + 36}
          fontSize={SMALL_SIZE}
          className="fill-ink-muted"
          data-hq-max-width={signText}
          data-hq-priority={room.detail}
        >
          {fitSecondLine(room.place, room.detail, signText, SMALL_SIZE)}
        </text>
        {room.characters.map((c, i) => {
          const station = stage.stations[i];
          return station ? (
            <text
              key={c.id}
              x={station.x}
              y={FLOOR_Y + 17 + (staggered && i % 2 === 1 ? 14 : 0)}
              fontSize={SMALL_SIZE}
              textAnchor="middle"
              className="fill-ink-muted"
            >
              {c.caption}
            </text>
          ) : null;
        })}
        {stage.benchX !== null && (
          <text
            x={stage.benchX}
            y={FLOOR_Y - 18}
            fontSize={SMALL_SIZE}
            textAnchor="middle"
            className="fill-ink-muted"
          >
            {SCENE_COPY.bench(room.bench)}
          </text>
        )}
      </g>
    </svg>
  );
}

/** A cell of the building with nobody in it: walls and a floor. */
export function EmptyRoom({
  width,
  height,
  edgeRight,
  slot,
}: {
  width: number;
  height: number;
  edgeRight: boolean;
  slot: number;
}) {
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto w-full overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      <g
        className={cx('fill-none stroke-ink', BOIL[slot % 3])}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Frame width={width} height={height} edgeRight={edgeRight} seed={seedOf(`empty-${slot}`)} />
      </g>
    </svg>
  );
}
