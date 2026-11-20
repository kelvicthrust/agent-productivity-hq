import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

// 16px stroke icons ported from the D7 prototype (docs/design/prototype/ui.js ICONS), paths unchanged. They take their
// colour from the surrounding text (`currentColor`).
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const PATHS = {
  check: <path d="M3.5 8.5l3 3 6-6.5" {...stroke} />,
  alert: (
    <>
      <path d="M8 2.5l6 10.5H2L8 2.5z" {...stroke} />
      <path d="M8 6.5v3" {...stroke} />
      <circle cx="8" cy="11.4" r=".85" fill="currentColor" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="6" {...stroke} />
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" {...stroke} />
    </>
  ),
  none: (
    <>
      <circle cx="8" cy="8" r="6" {...stroke} />
      <path d="M5.3 8h5.4" {...stroke} />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" {...stroke} />
      <path d="M5.5 7V5.2a2.5 2.5 0 015 0V7" {...stroke} />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6" {...stroke} />
      <path d="M8 4.8V8l2.2 1.4" {...stroke} />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 11-1.6-3.7" {...stroke} />
      <path d="M12.3 1.8v2.9H9.4" {...stroke} />
    </>
  ),
  external: (
    <>
      <path d="M9.5 2.5h4v4M13.5 2.5l-6 6" {...stroke} />
      <path d="M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3" {...stroke} />
    </>
  ),
  chevronRight: <path d="M6 3.5L10.5 8 6 12.5" {...stroke} />,
  chevronDown: <path d="M3.5 6L8 10.5 12.5 6" {...stroke} />,
  plus: <path d="M8 3v10M3 8h10" {...stroke} />,
  close: <path d="M4 4l8 8M12 4l-8 8" {...stroke} />,
  info: (
    <>
      <circle cx="8" cy="8" r="6" {...stroke} />
      <path d="M8 7.3v3.9" {...stroke} />
      <circle cx="8" cy="4.9" r=".85" fill="currentColor" />
    </>
  ),
  overview: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" {...stroke} />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" {...stroke} />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" {...stroke} />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" {...stroke} />
    </>
  ),
  trends: <path d="M2.5 12.5l3.5-4 3 2.5 4.5-6" {...stroke} />,
  merge: (
    <>
      <circle cx="4.5" cy="3.5" r="1.6" {...stroke} />
      <circle cx="4.5" cy="12.5" r="1.6" {...stroke} />
      <circle cx="11.5" cy="8.5" r="1.6" {...stroke} />
      <path d="M4.5 5.1v5.8M4.5 5.6c0 2.3 2 2.9 5.4 2.9" {...stroke} />
    </>
  ),
  layers: (
    <>
      <path d="M8 2.5l5.5 3L8 8.5 2.5 5.5 8 2.5z" {...stroke} />
      <path d="M2.5 8.5L8 11.5l5.5-3" {...stroke} />
      <path d="M2.5 11.2L8 14.2l5.5-3" {...stroke} />
    </>
  ),
  plug: (
    <>
      <path d="M5.5 2.5v3M10.5 2.5v3" {...stroke} />
      <path d="M3.5 5.5h9v2a4.5 4.5 0 01-9 0v-2z" {...stroke} />
      <path d="M8 12v2" {...stroke} />
    </>
  ),
  // A small house: the roof, the walls and a door. HQ's mark in the navigation.
  hq: (
    <>
      <path d="M2 7.6L8 2.5l6 5.1" {...stroke} />
      <path d="M3.8 6.6v6.9h8.4V6.6" {...stroke} />
      <path d="M6.7 13.5V10h2.6v3.5" {...stroke} />
    </>
  ),
  filter: <path d="M2.5 3.5h11l-4.3 5v4l-2.4 1v-5l-4.3-5z" {...stroke} />,
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" {...stroke} />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" {...stroke} />
    </>
  ),
  dotSolid: <circle cx="8" cy="8" r="3.5" fill="currentColor" />,
  dotDashed: (
    <circle
      cx="8"
      cy="8"
      r="4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeDasharray="2 1.6"
    />
  ),
  dash: <path d="M4.5 8h7" {...stroke} />,
  // The one moving icon: it says "working" beside the words ("Retrying…"), and stops under reduced motion. Tailwind's
  // animate-spin turns once a second; the prototype's turned in 900ms.
  spinner: (
    <circle
      className="origin-[8px_8px] animate-spin motion-reduce:animate-none"
      cx="8"
      cy="8"
      r="5.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeDasharray="20 15"
      strokeLinecap="round"
    />
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

/** Decorative: always sits beside text that carries the meaning. `size` scales the 16px drawing (badges use 12). */
export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={cx('shrink-0', className)}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
