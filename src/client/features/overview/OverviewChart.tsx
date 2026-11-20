import { useRef } from 'react';
import { deliveryScopeLabel, usageScopeLabel } from '../../../shared/domain/scope';
import { AlignedChart } from '../../components/AlignedChart';
import { useSeries } from '../../lib/analytics';
import type { Filters } from '../../lib/filters';
import { bucketRef, useRecordsDrawer } from '../../lib/recordsDrawer';
import { OVERVIEW_COPY } from './copy';

// The Overview's chart card: merged PRs and recorded local tokens over the period, on the aligned chart. It reads the series
// (TanStack Query) and draws it; what a selection means is decided here: a click on a bucket, or Enter on the keyboard cursor,
// opens the records drawer on that bucket (the Overview keeps no selection of its own: the drawer's open bucket is the selection).
//
// The chart's own loading and error states are the series' (design-to-code › "Chart loading / error"): a placeholder where the
// picture goes while the first answer is on its way, and a "Try again" panel when it could not be built. In both the Table view
// still reads the buckets it has. A changed filter keeps the last answer on screen until the new one lands, so the chart never
// flashes empty.

const NONE: never[] = [];

export function OverviewChart({ filters }: { filters: Filters }) {
  const series = useSeries(filters);
  const drawer = useRecordsDrawer();
  const card = useRef<HTMLDivElement>(null);
  const buckets = series.data?.buckets ?? NONE;

  // The bucket whose records the drawer shows, if it is one of this chart's (matched by its start, not only its position).
  const open = drawer.bucket?.chart === 'overview' ? drawer.bucket : null;
  const selectedIndex =
    open !== null && buckets[open.index]?.start === open.start ? open.index : null;

  const select = (index: number) => {
    const bucket = buckets[index];
    if (!bucket) return;
    drawer.open(bucketRef('overview', bucket, index), {
      // The chart redraws its buckets, so the element that had focus may be gone by the time the drawer closes: focus the
      // bucket again by its position, in the chart or in its table, whichever is showing.
      returnFocus: () =>
        card.current
          ?.querySelector<HTMLElement | SVGElement>(`[data-bucket-index="${index}"]`)
          ?.focus(),
    });
  };

  return (
    <div
      ref={card}
      aria-busy={series.isFetching || undefined}
      className="flex h-full min-w-0 flex-col rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <AlignedChart
        buckets={buckets}
        selectedIndex={selectedIndex}
        onSelect={select}
        title={OVERVIEW_COPY.chart.title}
        scope={`PRs: ${deliveryScopeLabel(filters)} · Tokens: ${usageScopeLabel(filters)}`}
        unavailableText={series.data?.unavailableText ?? null}
        state={series.isPending ? 'loading' : series.isError && !series.data ? 'error' : 'ready'}
        onRetry={() => void series.refetch()}
      />
    </div>
  );
}
