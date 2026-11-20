import { cx } from '../lib/cx';
import { BuddyShapes, type BuddyMood } from './Buddy';

// The small crew illustration for rare moments (first run, a quiet day, recovery): the owl and the fox, and for 'search' the
// neutral blob, drawn by `BuddyShapes` at about twice its small size (flat, calm, nothing animated; HQ's hand-drawn scene is the
// only place the critters move). Decorative: aria-hidden, and always beside text that says what the moment is. 'search' adds the
// unknown buddy and a "?" for empty states; 'sleep' adds "z"s for a true zero; 'awake' adds sparks.

export type CrewMood = BuddyMood | 'search';

const Z = {
  className: 'fill-ink-muted font-display',
  fontSize: 11,
  fontWeight: 700,
} as const;

export function CrewArt({ mood = 'awake', className }: { mood?: CrewMood; className?: string }) {
  const buddyMood: BuddyMood = mood === 'sleep' ? 'sleep' : mood === 'dizzy' ? 'dizzy' : 'awake';
  return (
    <svg
      className={cx('block', className)}
      width={132}
      height={64}
      viewBox="0 0 132 64"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse className="fill-sunken" cx="35" cy="59" rx="19" ry="3" />
      <ellipse className="fill-sunken" cx="77" cy="59" rx="17" ry="3" />
      <g transform="translate(14 16) scale(2.1)">
        <BuddyShapes kind="codex" mood={buddyMood} />
      </g>
      <g transform="translate(56 20) scale(2)">
        <BuddyShapes kind="claude" mood={buddyMood === 'dizzy' ? 'awake' : buddyMood} />
      </g>
      {mood === 'sleep' && (
        <>
          <text {...Z} x="100" y="26">
            z
          </text>
          <text {...Z} x="110" y="15">
            z
          </text>
        </>
      )}
      {mood === 'search' && (
        <>
          <ellipse className="fill-sunken" cx="112" cy="59" rx="11" ry="2.5" />
          <g transform="translate(99 32) scale(1.3)">
            <BuddyShapes kind="unknown" />
          </g>
          <text {...Z} x="108" y="26">
            ?
          </text>
        </>
      )}
      {mood === 'awake' && (
        <>
          <path className="fill-sunshine" d="M112 12l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
          <path className="fill-sunshine" d="M101 30l1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2z" />
        </>
      )}
    </svg>
  );
}
