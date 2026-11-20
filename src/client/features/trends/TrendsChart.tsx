import { Button } from '@astryxdesign/core/Button';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { deliveryScopeLabel, usageScopeLabel } from '../../../shared/domain/scope';
import { AlignedChart } from '../../components/AlignedChart';
import { useSeries } from '../../lib/analytics';
import type { Filters } from '../../lib/filters';
import { bucketRef, useRecordsDrawer } from '../../lib/recordsDrawer';
import { TRENDS_COPY } from './copy';

// The Trends chart: merged PRs and recorded local tokens over the period, larger than the Overview's, with the Chart/Table
// switch. A click on a bucket, or Enter on the keyboard cursor, selects it and opens its records in the drawer (the prototype
// listed them inline below the chart; the design now puts records in the drawer, with the same drill to Delivery and Usage).
//
// The selected bucket is URL state (`sel`, the bucket's start date): it survives a reload and a link, Back undoes it, and a change
// of period or grouping drops it (lib/filters, RANGE_BOUND_KEYS), because it points into the range. The chart marks it, and
// a line under the chart names it and offers Show records (the drawer again) and Clear selection. Opening on a reload would put a
// modal over a page nobody asked it on, so a restored selection is marked and waits.
//
// State ownership: the filters and `sel` are the URL's, the series is TanStack Query's, the drawer is lib/recordsDrawer's. The
// chart's loading and error states are the series' own (a placeholder where the picture goes, a "Try again" panel); the Table
// view still reads the buckets it has.

const COPY = TRENDS_COPY;
const NONE: never[] = [];

/** Puts keyboard focus on a bucket of the chart (or its table row) by position. */
function focusBucketIn(card: HTMLElement | null, index: number): void {
  card?.querySelector<HTMLElement | SVGElement>(`[data-bucket-index="${index}"]`)?.focus();
}

function withSel(params: URLSearchParams, start: string | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (start === null) next.delete('sel');
  else next.set('sel', start);
  return next;
}

export function TrendsChart({ filters }: { filters: Filters }) {
  const series = useSeries(filters);
  const drawer = useRecordsDrawer();
  const [params, setParams] = useSearchParams();
  const card = useRef<HTMLDivElement>(null);
  const buckets = series.data?.buckets ?? NONE;

  // A `sel` that names no bucket of this series (a stale link) simply selects nothing.
  const sel = params.get('sel');
  const found = sel === null ? -1 : buckets.findIndex((bucket) => bucket.start === sel);
  const selectedIndex = found >= 0 ? found : null;
  const selected = selectedIndex === null ? null : buckets[selectedIndex];

  const open = (index: number, returnFocus?: () => void) => {
    const bucket = buckets[index];
    if (!bucket) return;
    drawer.open(bucketRef('trends', bucket, index), returnFocus ? { returnFocus } : undefined);
  };
  const select = (index: number) => {
    const bucket = buckets[index];
    if (!bucket) return;
    // A step Back can undo, like a filter. The chart redraws its buckets, so focus returns to the bucket by position.
    setParams((current) => withSel(current, bucket.start));
    open(index, () => focusBucketIn(card.current, index));
  };

  // Clearing removes the line that held focus; the bucket that was selected takes it, so a keyboard reader is not sent to the top.
  const focusAfterClear = useRef<number | null>(null);
  const clear = () => {
    focusAfterClear.current = selectedIndex;
    setParams((current) => withSel(current, null));
  };
  useEffect(() => {
    if (selectedIndex !== null || focusAfterClear.current === null) return;
    focusBucketIn(card.current, focusAfterClear.current);
    focusAfterClear.current = null;
  }, [selectedIndex]);

  return (
    <div
      ref={card}
      aria-busy={series.isFetching || undefined}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <AlignedChart
        buckets={buckets}
        selectedIndex={selectedIndex}
        onSelect={select}
        title={COPY.chart.title}
        scope={`PRs: ${deliveryScopeLabel(filters)} · Tokens: ${usageScopeLabel(filters)}`}
        unavailableText={series.data?.unavailableText ?? null}
        state={series.isPending ? 'loading' : series.isError && !series.data ? 'error' : 'ready'}
        onRetry={() => void series.refetch()}
      />
      {selected && selectedIndex !== null && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3">
          <p className="min-w-0 text-copy text-ink-muted">
            {COPY.selection.selected} <b className="font-semibold text-ink">{selected.label}</b>
          </p>
          {/* The primary action is on the right, and stays last in the keyboard order too. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              label={COPY.selection.clear}
              variant="ghost"
              size="sm"
              onClick={clear}
              className="max-[719px]:min-h-11"
            />
            <Button
              label={COPY.selection.show}
              variant="primary"
              size="sm"
              onClick={() => open(selectedIndex)}
              className="max-[719px]:min-h-11"
            />
          </div>
        </div>
      )}
    </div>
  );
}
