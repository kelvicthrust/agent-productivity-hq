import { useRef } from 'react';
import { formatDayLong, formatWeekday } from '../../../shared/domain/periods';
import { ScopeLine } from '../../components/ScopeLine';
import { YearGrid, YearLegend } from '../../components/YearGrid';
import { useYear } from '../../lib/analytics';
import type { Filters } from '../../lib/filters';
import { useRecordsDrawer, type BucketRef } from '../../lib/recordsDrawer';
import { TRENDS_COPY } from './copy';
import { CardSkeleton, LoadFailed } from './Panels';

// A year of merges (ported from app.js `yearCard`): one cell per day of the last 12 months, shaded by merged PRs. Delivery history
// covers the whole lookback for a tracked repo, so every drawn cell is a real count and an empty one is a covered zero. The
// period filter only outlines its days; the repo and author filters apply (the API takes only those two).
//
// A day is a pointer target (keyboard users reach any day through Custom range and the chart's table view: an accepted,
// recorded limitation of the design). Pressing one opens that day's records in the drawer, as a chart bucket does. The day
// is not one of the chart's buckets, so it carries no position in the series (`index: -1`), and when the drawer closes focus goes
// to the grid's own scroll region, the nearest thing a keyboard can reach.
//
// With no tracked repo there is nothing to count, so the card is not drawn at all (design-to-code › Designed state → behaviour).

const COPY = TRENDS_COPY.year;

/** What the drawer is told about a day pressed in the grid: that day, as its own bucket of one. */
function dayRef(date: string): BucketRef {
  return {
    chart: 'trends',
    index: -1,
    start: date,
    end: date,
    label: `${formatWeekday(date)}, ${formatDayLong(date)}`,
  };
}

export function YearCard({ filters }: { filters: Filters }) {
  const year = useYear(filters);
  const drawer = useRecordsDrawer();
  const card = useRef<HTMLElement>(null);
  const data = year.data;

  if (data?.delivery === 'none') return null;
  if (!data) {
    return year.isError ? (
      <section className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card">
        <h2 className="font-display text-title-section text-ink">{COPY.title}</h2>
        <LoadFailed onRetry={() => void year.refetch()} />
      </section>
    ) : (
      <CardSkeleton title={COPY.title} loading={COPY.loading} />
    );
  }

  return (
    <section
      ref={card}
      aria-labelledby="tr-year-title"
      aria-busy={year.isFetching || undefined}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="tr-year-title" className="font-display text-title-section text-ink">
            {COPY.title}
          </h2>
          <ScopeLine delivery={filters}>{COPY.scope}</ScopeLine>
        </div>
        <YearLegend />
      </div>
      <YearGrid
        data={data}
        range={{ start: filters.start, end: filters.end }}
        dayHint={COPY.dayHint}
        onSelectDay={(date) =>
          drawer.open(dayRef(date), {
            returnFocus: () => card.current?.querySelector<HTMLElement>('[role="region"]')?.focus(),
          })
        }
      />
      {data.delivery === 'syncing' && <p className="text-caption text-ink-muted">{COPY.syncing}</p>}
    </section>
  );
}
