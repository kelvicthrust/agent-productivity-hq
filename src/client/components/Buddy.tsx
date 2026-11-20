import type { Provider } from '../../shared/contracts/common';
import { cx } from '../lib/cx';

// Agent buddies, drawn as the critters: Claude Code is a round orange fox curled into a bun (two small pointed ears, a pale muzzle and
// a nose dot), Codex is a boxy teal owl with a yellow-tipped tuft and two ringed eyes, and an unknown agent is a neutral blob with a
// dashed outline. These are the small, flat versions of HQ's hand-drawn critters (features/hq/art.tsx): clean shapes in the product's
// own colours, no outline filter and no motion, so they stay crisp at 16 to 20px. Shape still says which provider (round with ears,
// square with a tuft, dashed), so colour never carries the meaning alone. Decorative: aria-hidden, and always beside text that names
// the provider.

export type BuddyKind = Provider | 'unknown';
export type BuddyMood = 'awake' | 'sleep' | 'dizzy';

/** Where a critter's two eyes are in the 20x20 box: the fox's sit above its muzzle, the owl's fill its face. */
const EYES = {
  claude: { y: 10.6, left: 6.9, right: 13.1 },
  codex: { y: 10.9, left: 6.7, right: 13.3 },
  unknown: { y: 11.4, left: 7.3, right: 12.7 },
} as const satisfies Record<BuddyKind, { y: number; left: number; right: number }>;

/** The ink a critter's closed or crossed eyes are drawn in: the neutral blob's own grey, the others' dark ink. */
const MARK: Record<BuddyKind, string> = {
  claude: 'stroke-ink',
  codex: 'stroke-ink',
  unknown: 'stroke-series-neutral',
};

function Body({ kind }: { kind: BuddyKind }) {
  if (kind === 'claude') {
    return (
      <>
        <path
          className="fill-series-claude stroke-series-claude"
          d="M3.5 8.8 L4.6 1.9 L8.3 4.7Z M16.5 8.8 L15.4 1.9 L11.7 4.7Z"
          strokeWidth={1}
          strokeLinejoin="round"
        />
        <circle className="fill-series-claude" cx="10" cy="11.2" r="7.4" />
        <ellipse className="fill-white" cx="10" cy="14.3" rx="4" ry="2.8" />
      </>
    );
  }
  if (kind === 'codex') {
    return (
      <>
        <path
          className="stroke-series-codex"
          d="M10 6.2V3.8"
          fill="none"
          strokeWidth={2.6}
          strokeLinecap="round"
        />
        <path
          className="stroke-sunshine"
          d="M10 3.6V2"
          fill="none"
          strokeWidth={2.6}
          strokeLinecap="round"
        />
        <rect className="fill-series-codex" x="2.6" y="5" width="14.8" height="13.2" rx="3.4" />
      </>
    );
  }
  return (
    <path
      className="fill-sunken stroke-series-neutral"
      d="M3.4 12.2 C3.4 6.6 6.4 3.6 10 3.6 C13.6 3.6 16.6 6.6 16.6 12.2 C16.6 15.6 15.9 17.6 14.6 17.6 H5.4 C4.1 17.6 3.4 15.6 3.4 12.2Z"
      strokeWidth={1.4}
      strokeDasharray="2.4 1.8"
    />
  );
}

function Eyes({ kind, mood }: { kind: BuddyKind; mood: BuddyMood }) {
  const { y, left, right } = EYES[kind];
  const stroke = {
    className: MARK[kind],
    fill: 'none',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
  } as const;
  const at = (v: number) => Math.round(v * 100) / 100;
  if (mood === 'sleep') {
    const lid = (x: number) => `M${at(x - 1.9)} ${y}Q${x} ${at(y + 1.9)} ${at(x + 1.9)} ${y}`;
    return <path {...stroke} d={`${lid(left)}${lid(right)}`} />;
  }
  if (mood === 'dizzy') {
    const cross = (x: number) =>
      `M${at(x - 1.5)} ${at(y - 1.5)}l3 3M${at(x + 1.5)} ${at(y - 1.5)}l-3 3`;
    return <path {...stroke} d={`${cross(left)}${cross(right)}`} />;
  }
  if (kind === 'codex') {
    return (
      <>
        {[left, right].map((x) => (
          <g key={x}>
            <circle className="fill-white stroke-ink" cx={x} cy={y} r="2.5" strokeWidth={0.7} />
            <circle className="fill-ink" cx={x} cy={y + 0.4} r="1.1" />
          </g>
        ))}
      </>
    );
  }
  const className = kind === 'unknown' ? 'fill-series-neutral' : 'fill-ink';
  return (
    <>
      <circle className={className} cx={left} cy={y} r="1.3" />
      <circle className={className} cx={right} cy={y} r="1.3" />
      {kind === 'claude' && <circle className="fill-ink" cx="10" cy="12.9" r="1" />}
    </>
  );
}

/** The buddy's shapes in a 20x20 box, for `Buddy` and for the larger crew illustration to place and scale. */
export function BuddyShapes({ kind, mood = 'awake' }: { kind: BuddyKind; mood?: BuddyMood }) {
  return (
    <>
      <Body kind={kind} />
      <Eyes kind={kind} mood={mood} />
    </>
  );
}

export function Buddy({
  kind,
  mood = 'awake',
  size = 14,
  className,
}: {
  kind: BuddyKind;
  mood?: BuddyMood;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={cx('inline-block shrink-0 overflow-visible align-[-3px]', className)}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <BuddyShapes kind={kind} mood={mood} />
    </svg>
  );
}
