import { useEffect, useState, type ReactElement } from 'react';
import { Image, View } from 'react-native';
import {
  AfkRoom,
  buildSessions,
  captionsCollide,
  EmptyRoom,
  Ground,
  layoutScene,
  planStage,
  ROOM_HEIGHT,
  ROOM_HEIGHT_TALL,
  Roof,
  Room,
  Vent,
  type Scene,
} from './native-hq-art.generated.mjs';
import { inkFrames } from './native-hq-boil.generated.ts';
import { playpenWidth } from './native-hq-letter-metrics.ts';
import { hqColors } from './native-hq-palette.generated.ts';
import { useHqMotion } from './native-hq-motion.tsx';
import { Drawing } from './native-hq-drawing.tsx';
import type { RosterAgent } from './native-types.ts';

const roomWidth = { 1: 290, 2: 420, 3: 360 } as const;
const roofHeight = 48;
const groundHeight = 14;
const quietWidth = 480;
const quietHeight = 254;

function sameSlots(previous: Scene, scene: Scene): boolean {
  return (
    previous.cols === scene.cols &&
    previous.rooms.length === scene.rooms.length &&
    previous.rooms.every(
      (room, i) => room.id === scene.rooms[i]?.id && room.slot === scene.rooms[i]?.slot,
    )
  );
}

function MovingInk({
  kind,
  width,
  height,
  fallback,
}: {
  kind: keyof typeof inkFrames;
  width: number;
  height: number;
  fallback: ReactElement;
}) {
  const images = inkFrames[kind];
  const [loaded, setLoaded] = useState(0);
  const [frame, setFrame] = useState(kind === 'ground' ? 2 : 0);
  const ready = loaded === (1 << images.length) - 1;
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => setFrame((index) => (index + 1) % images.length), 250);
    return () => clearInterval(timer);
  }, [ready, images.length]);
  return (
    <View style={{ width, height }}>
      {ready ? null : fallback}
      {images.map((uri, index) => (
        <Image
          key={index}
          source={{ uri }}
          resizeMode="stretch"
          fadeDuration={0}
          onLoad={() => setLoaded((current) => current | (1 << index))}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width,
            height,
            opacity: ready && frame === index ? 1 : 0,
          }}
        />
      ))}
    </View>
  );
}

function Building({
  agents,
  quiet,
  width,
  columns,
  nowMs,
}: {
  agents: readonly RosterAgent[];
  quiet: boolean;
  width: number;
  columns: 1 | 2 | 3;
  nowMs: number;
}) {
  const animate = useHqMotion();
  const [previous, setPrevious] = useState<Scene | null>(null);
  const scene = layoutScene(previous, buildSessions(agents), { columns, nowMs });
  if (!previous || !sameSlots(previous, scene)) setPrevious(scene);
  const sourceWidth = quiet ? quietWidth : roomWidth[columns];
  const rooms = new Map(
    scene.rooms.map((room) => [
      room.slot,
      {
        room,
        staggeredCaptions: captionsCollide(
          room.characters,
          planStage(room.characters, room.bench, sourceWidth).stations,
          13,
          playpenWidth,
        ),
      },
    ]),
  );
  const crowded = Array.from(rooms.values()).some(({ staggeredCaptions }) => staggeredCaptions);
  const sourceHeight = quiet ? quietHeight : crowded ? ROOM_HEIGHT_TALL : ROOM_HEIGHT;
  const shownColumns = quiet ? 1 : columns;
  const cellWidth = width / shownColumns;
  const cellHeight = (cellWidth / sourceWidth) * sourceHeight;
  const buildingHeight =
    roofHeight + (quiet ? 1 : scene.cells / columns) * cellHeight + groundHeight;
  const roof = (
    <Drawing
      drawing={Roof()}
      width={width}
      height={roofHeight}
      sourceWidth={1000}
      sourceHeight={56}
    />
  );
  const ground = (
    <Drawing
      drawing={Ground()}
      width={width}
      height={groundHeight}
      sourceWidth={1000}
      sourceHeight={14}
    />
  );

  return (
    <View style={{ width, height: buildingHeight }}>
      {animate ? <MovingInk kind="roof" width={width} height={roofHeight} fallback={roof} /> : roof}
      <View style={{ position: 'absolute', left: (width - 24) / 2, top: 14 }}>
        <Drawing drawing={Vent()} width={24} height={24} />
      </View>
      {quiet ? (
        <Drawing
          drawing={AfkRoom()}
          width={width}
          height={cellHeight}
          sourceWidth={sourceWidth}
          sourceHeight={sourceHeight}
          animate={animate}
        />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {Array.from({ length: scene.cells }, (_, slot) => {
            const occupied = rooms.get(slot);
            const geometry = {
              width: sourceWidth,
              height: sourceHeight,
              edgeRight: slot % columns === columns - 1,
            };
            return (
              <Drawing
                key={occupied?.room.id ?? `empty-${slot}`}
                drawing={
                  occupied ? Room({ ...geometry, ...occupied }) : EmptyRoom({ ...geometry, slot })
                }
                width={cellWidth}
                height={cellHeight}
                sourceWidth={sourceWidth}
                sourceHeight={sourceHeight}
                animate={animate}
              />
            );
          })}
        </View>
      )}
      {animate ? (
        <MovingInk kind="ground" width={width} height={groundHeight} fallback={ground} />
      ) : (
        ground
      )}
    </View>
  );
}

export function IllustratedHq({
  agents,
  quiet,
  nowMs,
}: {
  agents: readonly RosterAgent[];
  quiet: boolean;
  nowMs?: number;
}) {
  const [mountedAt] = useState(Date.now);
  const [paper, setPaper] = useState({ width: 0, height: 0 });
  if (!quiet && agents.length === 0) return null;
  const columns = paper.width >= 940 ? 3 : paper.width >= 620 ? 2 : 1;
  const wide = paper.width >= 620;
  const left = wide ? 52 : 24;
  const right = wide ? 20 : 12;
  const width = paper.width - left - right - 2;
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      pointerEvents="none"
      testID={quiet ? 'hq-afk' : 'hq-scene'}
      onLayout={({ nativeEvent: { layout } }) => {
        if (layout.width !== paper.width || layout.height !== paper.height) {
          setPaper({ width: layout.width, height: layout.height });
        }
      }}
      style={{
        width: '100%',
        maxWidth: quiet ? 720 : 1000,
        minHeight: 80,
        paddingTop: 16,
        paddingBottom: 12,
        paddingLeft: left,
        paddingRight: right,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: hqColors.border,
        backgroundColor: hqColors.canvas,
        overflow: 'hidden',
      }}
    >
      {Array.from({ length: Math.floor(paper.height / 26) }, (_, index) => (
        <View
          key={index}
          style={{
            position: 'absolute',
            top: 25 + index * 26,
            left: 0,
            right: 0,
            height: 1,
            backgroundColor: hqColors.border,
          }}
        />
      ))}
      <View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: wide ? 40 : 12,
          width: 1,
          backgroundColor: `${hqColors['series-delivery']}4D`,
        }}
      />
      <Drawing
        drawing={
          <svg>
            <text x="0" y="23" fontSize="22" fontWeight="600" className="fill-ink">
              HQ, today
            </text>
            <path
              className="fill-none stroke-action"
              strokeWidth="1.8"
              strokeLinecap="round"
              d="M2 31 C30 28 70 32 104 30 C112 29.6 116 30.4 118 31"
            />
          </svg>
        }
        width={120}
        height={38}
      />
      {width > 0 ? (
        <Building
          agents={agents}
          quiet={quiet}
          width={width}
          columns={columns}
          nowMs={nowMs ?? mountedAt}
        />
      ) : null}
    </View>
  );
}
