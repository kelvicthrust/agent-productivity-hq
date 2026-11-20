import type { HqProvider } from '../../../shared/contracts/hq';
import {
  FoxAsleep,
  FoxBody,
  FoxFace,
  OwlEyeCrosses,
  OwlEyeRings,
  OwlEyeRingsX,
  OwlEyeWash,
  OwlEyeWashX,
  OwlTrunk,
  OwlTuft,
  OwlTuftDroop,
  OwlWingL,
  OwlWingR,
  OwlWingUp,
  Pennant,
} from './art';
import type { Pose } from './scene';

// The critters: a round orange fox curled into a bun for Claude Code, a boxy teal owl with a yellow-tipped tuft for Codex, and a
// neutral dashed-outline blob for any other agent. Drawn with the feet at (0, 0), a little under 50 units tall. The shape carries the
// provider, so colour never does alone. The small owl is the mockup's owl with the busy parts left off (no belly chevrons, no beak,
// thin eye rings), because at the size of a room they crowd a 40-unit body.

type Eyes = 'open' | 'closed' | 'crossed';

function eyesOf(pose: Pose): Eyes {
  return pose === 'idle' || pose === 'finished' ? 'closed' : pose === 'error' ? 'crossed' : 'open';
}

/** Where the eyes are, in the figure's own units, for the marks drawn over a body that has none of its own. */
const FOX_EYES = [
  [-7.5, -26.5],
  [7, -26.5],
] as const;
const OWL_EYES = [
  [-7, -25],
  [7, -25],
] as const;
const BLOB_EYES = [
  [-6.5, -26],
  [6.5, -26],
] as const;

/** Two closed eyes: small downward arcs. */
function Lids({ at }: { at: readonly (readonly [number, number])[] }) {
  return (
    <path
      strokeWidth="1.9"
      d={at.map(([x, y]) => `M${x - 3.6} ${y} Q${x} ${y + 3.8} ${x + 3.6} ${y}`).join(' ')}
    />
  );
}

/** Two crossed-out eyes. */
function Crosses({ at }: { at: readonly (readonly [number, number])[] }) {
  return (
    <path
      strokeWidth="1.9"
      d={at
        .map(
          ([x, y]) => `M${x - 3} ${y - 3} L${x + 3} ${y + 3} M${x + 3} ${y - 3} L${x - 3} ${y + 3}`,
        )
        .join(' ')}
    />
  );
}

function Fox({ pose }: { pose: Pose }) {
  const eyes = eyesOf(pose);
  if (eyes === 'closed') return <FoxAsleep />;
  return (
    <>
      <FoxBody />
      {eyes === 'open' ? <FoxFace /> : <Crosses at={FOX_EYES} />}
    </>
  );
}

function Owl({ pose }: { pose: Pose }) {
  const eyes = eyesOf(pose);
  return (
    <>
      {pose === 'error' ? <OwlTuftDroop /> : <OwlTuft />}
      <OwlTrunk />
      {pose === 'waiting' ? <OwlWingUp /> : <OwlWingL />}
      <OwlWingR />
      {eyes === 'open' && (
        <>
          <OwlEyeWash />
          <OwlEyeRings />
        </>
      )}
      {eyes === 'closed' && <Lids at={OWL_EYES} />}
      {eyes === 'crossed' && (
        <>
          <OwlEyeWashX />
          <OwlEyeRingsX />
          <OwlEyeCrosses />
        </>
      )}
    </>
  );
}

/** Any other agent: a neutral blob with a dashed outline, like the unknown buddy. */
function Blob({ pose }: { pose: Pose }) {
  const eyes = eyesOf(pose);
  return (
    <>
      <path
        className="fill-series-neutral stroke-series-neutral"
        fillOpacity="0.3"
        strokeOpacity="0.35"
        strokeWidth="1.2"
        d="M-16 -22 C-16 -36 -8 -43 1 -43 C10 -43 17 -36 16.5 -22 C16 -10 15 -2 11 -1 L-11 -1 C-15 -2 -16 -10 -16 -22Z"
      />
      <path
        className="stroke-ink-muted"
        strokeWidth="1.9"
        strokeDasharray="4 3"
        d="M-17 -22 C-17 -37 -8 -44 0 -44 C9 -44 18 -37 17.5 -22 C17 -10 16 -2 12 0 L-12 0 C-16 -2 -17 -10 -17 -22Z"
      />
      {eyes === 'open' &&
        BLOB_EYES.map(([x, y]) => (
          <circle key={x} className="fill-ink stroke-none" cx={x} cy={y} r="2.8" />
        ))}
      {eyes === 'closed' && <Lids at={BLOB_EYES} />}
      {eyes === 'crossed' && <Crosses at={BLOB_EYES} />}
    </>
  );
}

/** How tall each figure is at scale 1, for placing what hangs above it (the arrows and the bubble). */
export const FIGURE_HEIGHT: Record<HqProvider, number> = { claude: 50, codex: 53, other: 44 };
/** The scale each is drawn at, so a fox and an owl read as the same size of creature. */
export const FIGURE_SCALE: Record<HqProvider, number> = { claude: 0.95, codex: 1.1, other: 1.05 };
export const CAPTAIN_SCALE = 1.15;

export function Character({
  provider,
  pose,
  captain,
}: {
  provider: HqProvider;
  pose: Pose;
  captain: boolean;
}) {
  return (
    <>
      {provider === 'claude' ? (
        <Fox pose={pose} />
      ) : provider === 'codex' ? (
        <Owl pose={pose} />
      ) : (
        <Blob pose={pose} />
      )}
      {captain && <Pennant />}
    </>
  );
}
