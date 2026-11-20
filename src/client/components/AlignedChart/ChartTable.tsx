import type { Provider } from '../../../shared/contracts/common';
import type { Bucket } from '../../../shared/contracts/series';
import { PROVIDER_NAMES } from '../../lib/copy';
import { cx } from '../../lib/cx';
import { CHART_COPY } from './copy';
import { tableRowOf } from './words';

// The table equivalent of the chart (ported from app.js `chartTable`): the same buckets with the same words, for anyone who
// would rather read than look, and for a keyboard that wants a button per period. Each period is a button that selects it, the
// way a click on the bucket does, and carries `data-bucket-index` like the bucket does so focus can be handed back to it.
//
// A real `<table>`, never restyled into cards: when the columns do not fit it scrolls inside its own region, which is
// focusable so a keyboard can scroll it (WCAG 2.1.1), as the Delivery and Usage tables do. Every data cell is one line.

/** The edge cue: a shadow on each side with more to scroll, drawn with background layers (as in DeliveryTable). */
const SCROLL_CUE = [
  'linear-gradient(to right, var(--color-surface), transparent) left center / 24px 100% no-repeat local',
  'linear-gradient(to left, var(--color-surface), transparent) right center / 24px 100% no-repeat local',
  'radial-gradient(farthest-side at 0 50%, var(--scroll-edge), transparent) left center / 10px 100% no-repeat scroll',
  'radial-gradient(farthest-side at 100% 50%, var(--scroll-edge), transparent) right center / 10px 100% no-repeat scroll',
].join(', ');

const TH =
  'whitespace-nowrap border-b border-border bg-surface px-2.5 py-2 text-left text-caption font-semibold text-ink-muted';
const TD = 'whitespace-nowrap border-b border-border px-2.5 py-1.5 align-middle';
const NUMBER = 'text-right tabular-nums';

export function ChartTable({
  title,
  buckets,
  providers,
  selectedIndex,
  onSelect,
}: {
  /** The chart's name, so the table's caption says what it is a table of. */
  title: string;
  buckets: readonly Bucket[];
  providers: readonly Provider[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}) {
  const copy = CHART_COPY.table;
  const rows = buckets.map((bucket) => tableRowOf(bucket, providers));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        role="region"
        aria-label={copy.scrollerLabel}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="overflow-x-auto"
        style={{ background: SCROLL_CUE }}
      >
        <table className="w-full border-collapse text-data">
          <caption className="sr-only">
            {title}, {copy.caption}
          </caption>
          <thead>
            <tr>
              <th scope="col" className={cx(TH, 'w-full')}>
                {copy.period}
              </th>
              <th scope="col" className={cx(TH, 'text-right')}>
                {copy.prs}
              </th>
              {providers.map((provider) => (
                <th key={provider} scope="col" className={cx(TH, 'text-right')}>
                  {copy.tokens(PROVIDER_NAMES[provider])}
                </th>
              ))}
              <th scope="col" className={TH}>
                {copy.coverage}
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket, index) => {
              const row = rows[index]!;
              const selected = index === selectedIndex;
              return (
                <tr key={bucket.start} className={cx(selected && 'bg-selection-surface')}>
                  <th scope="row" className={cx(TD, 'text-left font-normal')}>
                    <button
                      type="button"
                      data-bucket-index={index}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelect(index)}
                      className="min-h-6 cursor-pointer rounded-sm border-0 bg-transparent px-1.5 py-0.5 text-left font-semibold text-ink hover:bg-sunken"
                    >
                      {bucket.label}
                    </button>
                  </th>
                  <td className={cx(TD, NUMBER)}>{row.prs}</td>
                  {providers.map((provider) => (
                    <td key={provider} className={cx(TD, NUMBER)}>
                      {row.tokens[provider]}
                    </td>
                  ))}
                  <td className={TD}>{row.coverage}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-ink-muted">{copy.footnote}</p>
    </div>
  );
}
