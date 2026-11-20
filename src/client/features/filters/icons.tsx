import type { ReactNode } from 'react';

// The few 16px stroke icons the filter bar needs, ported from the D7 prototype (docs/design/prototype/ui.js ICONS).
// Decorative: each sits beside text that carries the meaning.
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const PATHS = {
  filter: <path d="M2.5 3.5h11l-4.3 5v4l-2.4 1v-5l-4.3-5z" {...stroke} />,
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" {...stroke} />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" {...stroke} />
    </>
  ),
  chevronDown: <path d="M3.5 6L8 10.5 12.5 6" {...stroke} />,
  close: <path d="M4 4l8 8M12 4l-8 8" {...stroke} />,
  error: (
    <>
      <circle cx="8" cy="8" r="6" {...stroke} />
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" {...stroke} />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type FilterIconName = keyof typeof PATHS;

export function FilterIcon({ name, className }: { name: FilterIconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={16}
      height={16}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
