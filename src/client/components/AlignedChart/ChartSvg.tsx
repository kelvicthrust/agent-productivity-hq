import type { FocusEventHandler, KeyboardEventHandler, MouseEventHandler, Ref } from 'react';
import { CHART_COPY } from './copy';
import type { BucketShape, ChartLayout } from './layout';
import type { PatternIds } from './Legend';
import { cx } from '../../lib/cx';

// The picture: what `layoutAlignedChart` returned, drawn as SVG (ported from ui.js `alignedChart`, which built the same thing
// as a string). It decides nothing. Where a shape goes, and whether a bucket gets a bar, a tick or hatching, is the layout's
// call, and the words for the same bucket come from the same reading in words.ts.
//
// Nothing here animates: bars, the selection and the keyboard cursor appear and move without transition (design-to-code,
// "Motion mapping"). There are no transition classes on any shape.
//
// The chart is one tab stop (`role="group"`, roledescription "chart"). Each bucket is a `<g>` that can be focused by code
// (`tabIndex={-1}`, found by `data-bucket-index`), so focus can be handed back to the bucket that opened the drawer.

export interface ChartSvgProps {
  layout: ChartLayout;
  ids: PatternIds;
  /** The chart's accessible name, read when it takes focus. */
  label: string;
  /** The selected bucket: tinted and marked `data-selected`. */
  selectedIndex: number | null;
  /** The keyboard cursor: outlined while the chart has focus. */
  cursorIndex: number | null;
  focused: boolean;
  svgRef: Ref<SVGSVGElement>;
  onFocus: FocusEventHandler<SVGSVGElement>;
  onBlur: FocusEventHandler<SVGSVGElement>;
  onKeyDown: KeyboardEventHandler<SVGSVGElement>;
  onClick: MouseEventHandler<SVGSVGElement>;
  onMouseOver: MouseEventHandler<SVGSVGElement>;
  onMouseLeave: MouseEventHandler<SVGSVGElement>;
}

const url = (id: string): string => `url(#${id})`;

function BucketMarks({ shape, ids }: { shape: BucketShape; ids: PatternIds }) {
  const { delivery, usage, rail } = shape;
  return (
    <>
      {delivery.kind === 'bar' && (
        <rect {...delivery.rect} rx={delivery.radius} className="fill-series-delivery" />
      )}
      {delivery.kind === 'zero' && <rect {...delivery.rect} className="fill-ink-muted" />}

      {usage.kind === 'unavailable' && <rect {...usage.rect} fill={url(ids.unavailable)} />}
      {usage.kind === 'stack' &&
        usage.segments.map((segment) =>
          segment.provider === 'codex' ? (
            <rect
              key={segment.provider}
              {...segment.rect}
              data-provider="codex"
              className="fill-series-codex"
            />
          ) : (
            <rect
              key={segment.provider}
              {...segment.rect}
              data-provider="claude"
              fill={url(ids.claude)}
            />
          ),
        )}
      {usage.kind === 'zero' && <rect {...usage.rect} className="fill-ink-muted" />}

      {rail.kind === 'complete' && <rect {...rail.rect} className="fill-border-strong" />}
      {rail.kind === 'partial' && (
        <rect
          {...rail.rect}
          fill={url(ids.unavailable)}
          className="stroke-coverage-hatch stroke-[0.75]"
        />
      )}
      {rail.kind === 'none' && (
        <rect {...rail.rect} className="fill-surface stroke-border-strong" />
      )}
    </>
  );
}

export function ChartSvg({
  layout,
  ids,
  label,
  selectedIndex,
  cursorIndex,
  focused,
  svgRef,
  onFocus,
  onBlur,
  onKeyDown,
  onClick,
  onMouseOver,
  onMouseLeave,
}: ChartSvgProps) {
  const { width, height, padLeft, padRight } = layout;
  const gridX = { x1: padLeft, x2: width - padRight };
  const panels = [
    { panel: layout.delivery, copy: CHART_COPY.panels.delivery },
    { panel: layout.usage, copy: CHART_COPY.panels.usage },
  ] as const;

  return (
    // A keyboard-operated group (design-to-code: `role="group"`, roledescription "chart"; arrows, Home, End and Enter). Its
    // handlers are bubbled from the buckets it holds.
    <svg
      ref={svgRef}
      role="group"
      aria-roledescription="chart"
      aria-label={label}
      tabIndex={0}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block cursor-pointer overflow-visible focus-visible:outline-offset-4"
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onMouseOver={onMouseOver}
      onMouseLeave={onMouseLeave}
    >
      {/* Titles, units and gridlines. Their words are in the readout and the table, so a screen reader skips them. */}
      <g aria-hidden="true">
        {panels.map(({ panel, copy }) => (
          <g key={copy.title}>
            <text x={0} y={panel.titleY}>
              <tspan className="fill-ink font-display text-[12px] font-bold">{copy.title}</tspan>
              <tspan dx={8} className="fill-ink-muted text-[11px] font-normal">
                {copy.unit}
              </tspan>
            </text>
            {panel.ticks.map((tick) => (
              <g key={tick.y}>
                <line
                  {...gridX}
                  y1={tick.y}
                  y2={tick.y}
                  className={
                    tick.baseline
                      ? 'stroke-border-strong stroke-1'
                      : 'stroke-border stroke-1 [stroke-dasharray:2_4]'
                  }
                />
                {tick.label !== null && (
                  <text
                    x={padLeft - 8}
                    y={tick.y + 4}
                    textAnchor="end"
                    className="fill-ink-muted text-[11px]"
                  >
                    {tick.label}
                  </text>
                )}
              </g>
            ))}
          </g>
        ))}
      </g>

      {layout.buckets.map((shape) => {
        const selected = shape.index === selectedIndex;
        const cursor = focused && shape.index === cursorIndex;
        return (
          <g
            key={shape.index}
            data-bucket-index={shape.index}
            data-selected={selected ? 'true' : undefined}
            aria-current={selected ? 'true' : undefined}
            tabIndex={-1}
            className="group/bk outline-none"
          >
            <rect
              {...shape.band}
              className={cx(
                selected ? 'fill-selection-surface' : 'fill-transparent group-hover/bk:fill-canvas',
                cursor && 'stroke-focus stroke-[1.5] [stroke-dasharray:3_2]',
              )}
            />
            <BucketMarks shape={shape} ids={ids} />
          </g>
        );
      })}

      <g aria-hidden="true">
        {layout.notes.map((note) => (
          <g key={note.kind + note.x} data-note={note.kind}>
            <rect {...note.box} rx={4} className="fill-surface stroke-border" />
            <text x={note.x} y={note.y} textAnchor="middle" className="fill-ink-muted text-[11px]">
              {note.text}
            </text>
          </g>
        ))}
        {layout.upcomingNote && (
          <text
            data-note="upcoming"
            x={layout.upcomingNote.x}
            y={layout.upcomingNote.y}
            textAnchor="middle"
            className="fill-ink-muted text-[11px]"
          >
            {layout.upcomingNote.text}
          </text>
        )}
        {layout.xLabels.map((label) => (
          <text
            key={label.index}
            x={label.x}
            y={label.y}
            textAnchor="middle"
            className="fill-ink-muted text-[11px]"
          >
            {label.text}
          </text>
        ))}
      </g>
    </svg>
  );
}
