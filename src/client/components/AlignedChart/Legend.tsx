import type { ReactNode } from 'react';
import type { Provider } from '../../../shared/contracts/common';
import { PROVIDER_NAMES } from '../../lib/copy';
import { CHART_COPY } from './copy';

// The hatch patterns the chart and its key share, and the key itself (ported from ui.js `swatch` and app.js `legend`). The
// prototype kept the patterns in one hidden SVG for the whole page; here each chart carries its own, under ids made unique by
// `useId`, so two charts on a page (Trends draws one beside the Overview's) cannot reach into each other.

export interface PatternIds {
  /** Claude Code's tokens: its colour with light diagonal lines, so the provider is told apart by pattern, not by hue alone. */
  claude: string;
  /** No history: a sunken ground with a dot stipple, so diagonal hatching only ever means Claude Code. Also the partial rail. */
  unavailable: string;
}

/** An id fit for `url(#…)` from React's `useId`, whose punctuation differs between versions. */
export function patternIds(id: string): PatternIds {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return { claude: `ac-${safe}-claude`, unavailable: `ac-${safe}-unavailable` };
}

/**
 * The patterns, in a zero-size SVG that stays in layout: a pattern inside `display: none` is not drawn by every browser, and
 * the table view still shows the key.
 */
export function PatternDefs({ ids }: { ids: PatternIds }) {
  return (
    <svg
      width={0}
      height={0}
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute size-0 overflow-hidden"
    >
      <defs>
        <pattern
          id={ids.claude}
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect className="fill-series-claude" width="5" height="5" />
          <rect className="fill-hatch-light" width="1.4" height="5" />
        </pattern>
        <pattern id={ids.unavailable} width="5" height="5" patternUnits="userSpaceOnUse">
          <rect className="fill-sunken" width="5" height="5" />
          <circle className="fill-coverage-hatch" cx="2.5" cy="2.5" r="1.2" />
        </pattern>
      </defs>
    </svg>
  );
}

type SwatchKind =
  'delivery' | Provider | 'unavailable' | 'zero' | 'rail-complete' | 'rail-partial' | 'rail-none';

/** A 14×10 swatch. Decorative: the words beside it carry the meaning, so colour never does alone. */
function Swatch({ kind, ids }: { kind: SwatchKind; ids: PatternIds }) {
  return (
    <svg viewBox="0 0 14 10" aria-hidden="true" focusable="false" className="h-2.5 w-3.5 shrink-0">
      {kind === 'delivery' && (
        <rect className="fill-series-delivery" width="14" height="10" rx="1" />
      )}
      {kind === 'codex' && <rect className="fill-series-codex" width="14" height="10" rx="1" />}
      {kind === 'claude' && <rect fill={`url(#${ids.claude})`} width="14" height="10" rx="1" />}
      {kind === 'unavailable' && <rect fill={`url(#${ids.unavailable})`} width="14" height="10" />}
      {kind === 'zero' && <rect className="fill-ink-muted" y="8" width="14" height="1.5" />}
      {kind === 'rail-complete' && (
        <rect className="fill-border-strong" y="3" width="14" height="5" />
      )}
      {kind === 'rail-partial' && (
        <rect
          className="stroke-coverage-hatch stroke-[0.75]"
          fill={`url(#${ids.unavailable})`}
          y="3"
          width="14"
          height="5"
        />
      )}
      {kind === 'rail-none' && (
        <rect className="fill-surface stroke-border-strong" x="0.5" y="3" width="13" height="5" />
      )}
    </svg>
  );
}

function Item({ children }: { children: ReactNode }) {
  return <li className="inline-flex items-center gap-1.5">{children}</li>;
}

/** What each mark means. Only the providers in the chart are listed. */
export function Legend({ providers, ids }: { providers: readonly Provider[]; ids: PatternIds }) {
  const key = CHART_COPY.legend;
  return (
    <ul
      aria-label={key.label}
      className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-caption text-ink-muted"
    >
      <Item>
        <Swatch kind="delivery" ids={ids} />
        {key.delivery}
      </Item>
      {providers.map((provider) => (
        <Item key={provider}>
          <Swatch kind={provider} ids={ids} />
          {key.tokens(PROVIDER_NAMES[provider])}
        </Item>
      ))}
      <Item>
        <Swatch kind="unavailable" ids={ids} />
        {key.unavailable}
      </Item>
      <Item>
        <Swatch kind="zero" ids={ids} />
        {key.zero}
      </Item>
      <Item>
        <Swatch kind="rail-complete" ids={ids} />
        <Swatch kind="rail-partial" ids={ids} />
        <Swatch kind="rail-none" ids={ids} />
        {key.rail}
      </Item>
    </ul>
  );
}
