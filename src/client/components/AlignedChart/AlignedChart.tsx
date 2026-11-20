import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { Provider } from '../../../shared/contracts/common';
import type { Bucket } from '../../../shared/contracts/series';
import { cx } from '../../lib/cx';
import { ScopeLine } from '../ScopeLine';
import { ChartSvg } from './ChartSvg';
import { ChartTable } from './ChartTable';
import { CHART_COPY } from './copy';
import { isMoveKey, isSelectKey, moveCursor, startingCursor } from './keys';
import { layoutAlignedChart } from './layout';
import { Legend, PatternDefs, patternIds } from './Legend';
import { noTrackedRepos, providersIn } from './model';
import { readoutOf, readoutText } from './words';

// The aligned delivery/usage chart (ported from ui.js `alignedChart` and app.js `chartBlock`): merged PRs and recorded local
// tokens on two panels that share an x-axis and have their own y-axes and units, a coverage rail, a readout, and a Table view
// that says the same things in words.
//
// This component draws and reports; it decides nothing about what a selection does. A click on a bucket, or Enter on the
// keyboard cursor, calls `onSelect(index)`. Overview and Trends decide what that means (open the records drawer, or show the
// period's records below), and they hand focus back to the bucket with `[data-bucket-index="n"]` when the drawer closes.
// Selection is the host's state (`selectedIndex`); the keyboard cursor, the pointer hover and the Chart/Table switch are the
// chart's own transient state.
//
// Keyboard (the chart is one tab stop): Left and Right move the cursor by one bucket, Home and End jump to the first and last,
// Enter (or Space) selects the cursor's bucket. The readout follows the cursor and is announced. Nothing animates.

export type ChartView = 'chart' | 'table';

export interface AlignedChartProps {
  /** `GET /api/series` buckets, oldest first. */
  buckets: readonly Bucket[];
  /** The bucket the host has selected (marked, and where the cursor starts), or null. */
  selectedIndex: number | null;
  /** A click on a bucket (or its table row), or Enter on the cursor's bucket. */
  onSelect: (index: number) => void;
  /** The heading: "Merged PRs and recorded local tokens". */
  title: string;
  /** What the figures cover, under the heading ("PRs: All repos · Authored by you · Tokens: This machine · …"). */
  scope?: string;
  /** The heading's level. Overview's cards use 2; a chart nested under a page section can use 3. */
  headingLevel?: 2 | 3;
  /** Providers to draw. Default: the providers the buckets carry. */
  providers?: readonly Provider[];
  /** `SeriesResponse.unavailableText`: said inside a long run of hatched history. */
  unavailableText?: string | null;
  /**
   * `loading` puts a placeholder where the picture goes; `error` puts a "Try again" panel there. In both the Table view still
   * reads the buckets it was given (design-to-code: "Table view still works from cached data").
   */
  state?: 'ready' | 'loading' | 'error';
  onRetry?: () => void;
  className?: string;
}

/** The bucket a DOM event came from, by the `data-bucket-index` its column or table button carries. */
function bucketIndexOf(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const value = target.closest('[data-bucket-index]')?.getAttribute('data-bucket-index');
  return value == null ? null : Number(value);
}

export function AlignedChart({
  buckets,
  selectedIndex,
  onSelect,
  title,
  scope,
  headingLevel = 2,
  providers: providerProp,
  unavailableText,
  state = 'ready',
  onRetry,
  className,
}: AlignedChartProps) {
  const headingId = useId();
  const ids = patternIds(useId());
  const count = buckets.length;
  const providers = useMemo(() => providerProp ?? providersIn(buckets), [providerProp, buckets]);

  // Transient state. An index that no longer exists (the period changed under it) is simply not there.
  const [view, setView] = useState<ChartView>('chart');
  const [cursor, setCursor] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const inRange = (index: number | null): number | null =>
    index !== null && index >= 0 && index < count ? index : null;
  const selected = inRange(selectedIndex);
  const cursorAt = inRange(cursor);
  const hoverAt = inRange(hover);

  // The picture redraws at its container's pixel width, so text never scales below 11px. Unmeasured (a first render, or no
  // layout engine), the layout falls back to the prototype's 720.
  const showChart = view === 'chart' && state === 'ready';
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showChart]);

  const layout = useMemo(
    () =>
      layoutAlignedChart(buckets, width, {
        providers,
        unavailableText: unavailableText ?? CHART_COPY.defaultUnavailable,
        upcomingText: CHART_COPY.upcomingCaption,
        ...(noTrackedRepos(buckets) ? { noDeliveryText: CHART_COPY.noTrackedRepositories } : {}),
      }),
    [buckets, width, providers, unavailableText],
  );

  const svg = useRef<SVGSVGElement>(null);
  const focusBucket = useCallback((index: number) => {
    svg.current?.querySelector<SVGElement>(`[data-bucket-index="${index}"]`)?.focus();
  }, []);
  const announce = (index: number) =>
    setAnnouncement(readoutText(readoutOf(buckets[index]!, providers)));

  const onFocus = (event: FocusEvent<SVGSVGElement>) => {
    setFocused(true);
    if (count === 0) return;
    // The chart itself takes the cursor to the selected (else the newest) bucket; a bucket that was focused by code, or by a
    // click, takes it there.
    const at =
      inRange(bucketIndexOf(event.target)) ?? cursorAt ?? startingCursor(buckets, selected);
    setCursor(at);
    announce(at);
  };

  const onBlur = (event: FocusEvent<SVGSVGElement>) => {
    // Focus moving from one bucket to another stays inside the chart.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setFocused(false);
    setCursor(null);
    setAnnouncement('');
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    // Not ours: Alt+Left is the browser's Back, and Ctrl/Cmd/Shift keys have their own jobs.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || count === 0) return;
    const from = cursorAt ?? startingCursor(buckets, selected);
    if (isMoveKey(event.key)) {
      event.preventDefault();
      const next = moveCursor(event.key, from, count);
      setCursor(next);
      announce(next);
      // When a bucket itself holds focus (it was handed focus), focus follows the cursor to the next one.
      if (event.target !== event.currentTarget) focusBucket(next);
    } else if (isSelectKey(event.key)) {
      event.preventDefault();
      setCursor(from);
      onSelect(from);
    }
  };

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const index = inRange(bucketIndexOf(event.target));
    if (index === null) return;
    setCursor(index);
    onSelect(index);
  };

  const onMouseOver = (event: MouseEvent<SVGSVGElement>) => {
    const index = bucketIndexOf(event.target);
    if (index !== null) setHover(index);
  };

  // What the readout reads: the bucket under the pointer, else the keyboard cursor, else the selected bucket.
  const reading = hoverAt ?? cursorAt ?? selected;
  const readout = reading === null ? null : readoutOf(buckets[reading]!, providers);

  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const label = [title, scope, CHART_COPY.keyboardHelp].filter(Boolean).join('. ');

  return (
    <div className={cx('flex min-w-0 flex-col gap-3', className)}>
      <PatternDefs ids={ids} />
      <div>
        <Heading id={headingId} className="font-display text-title-section text-ink">
          {title}
        </Heading>
        {scope && <ScopeLine>{scope}</ScopeLine>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Legend providers={providers} ids={ids} />
        <SegmentedControl
          label={CHART_COPY.switchLabel}
          value={view}
          onChange={(next) => {
            if (next === 'chart' || next === 'table') {
              setView(next);
              setHover(null);
            }
          }}
        >
          <SegmentedControlItem value="chart" label={CHART_COPY.views.chart} />
          <SegmentedControlItem value="table" label={CHART_COPY.views.table} />
        </SegmentedControl>
      </div>

      {view === 'table' ? (
        <ChartTable
          title={title}
          buckets={buckets}
          providers={providers}
          selectedIndex={selected}
          onSelect={onSelect}
        />
      ) : state === 'loading' ? (
        <>
          <div aria-hidden="true" className="h-[220px] w-full animate-pulse rounded-sm bg-sunken" />
          <p role="status" className="sr-only">
            {CHART_COPY.loading}
          </p>
        </>
      ) : state === 'error' ? (
        <div
          role="status"
          className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-strong p-6 text-center"
        >
          <p className="font-semibold text-ink">{CHART_COPY.error.title}</p>
          <p className="max-w-[44ch] text-ink-muted">{CHART_COPY.error.body}</p>
          {onRetry && (
            <Button label={CHART_COPY.error.retry} variant="secondary" onClick={onRetry} />
          )}
        </div>
      ) : (
        <>
          <div className="flex min-h-[22px] flex-wrap items-baseline gap-x-4 gap-y-0.5 text-data text-ink">
            {readout === null ? (
              <span className="text-ink-muted">{CHART_COPY.idleReadout}</span>
            ) : (
              <>
                <span className="font-bold">{readout.title}</span>
                {readout.upcoming ? (
                  <span className="text-ink-muted">{CHART_COPY.readout.upcoming}</span>
                ) : (
                  readout.facts.map((fact) => (
                    <span key={fact.label}>
                      {fact.label}: <b className="font-bold">{fact.value}</b>
                    </span>
                  ))
                )}
              </>
            )}
          </div>
          <div ref={host} className="w-full min-w-0">
            <ChartSvg
              layout={layout}
              ids={ids}
              label={label}
              selectedIndex={selected}
              cursorIndex={cursorAt}
              focused={focused}
              svgRef={svg}
              onFocus={onFocus}
              onBlur={onBlur}
              onKeyDown={onKeyDown}
              onClick={onClick}
              onMouseOver={onMouseOver}
              onMouseLeave={() => setHover(null)}
            />
          </div>
          <p className="text-caption text-ink-muted">{CHART_COPY.hint}</p>
          {/* The readout is announced when the keyboard moves the cursor, not when the pointer passes over a bucket. */}
          <p role="status" className="sr-only">
            {announcement}
          </p>
        </>
      )}
    </div>
  );
}
