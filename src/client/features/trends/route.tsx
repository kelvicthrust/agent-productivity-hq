import type { Provider } from '../../../shared/contracts/common';
import type { SourceStatus } from '../../../shared/contracts/sources';
import { formatDayLong, formatRange } from '../../../shared/domain/periods';
import { providersInScope } from '../../../shared/domain/scope';
import { PageHeader } from '../../components/PageHeader';
import { useSources } from '../../components/RefreshBanner';
import { useBootstrap } from '../../lib/bootstrap';
import { PROVIDER_NAMES, RANGE_NOTICES } from '../../lib/copy';
import { useFilters, type Filters } from '../../lib/filters';
import { ModelShares } from './ModelShares';
import { Notice } from './Notice';
import { PERIOD_LABEL, TRENDS_COPY } from './copy';
import { TrendsChart } from './TrendsChart';
import { YearCard } from './YearCard';

// Trends: how delivery and usage moved. A year of merges (the whole lookback at a glance, the period outlined), the larger
// aligned chart with its Chart/Table switch, and the recorded tokens by model. A selection in the chart, or a day in the grid, opens
// that period's records in the records drawer; nothing is listed inline (docs/design: Trends keeps the chart and the year; the
// records live in the drawer).
//
// State ownership (TECH): the filters and the selected bucket (`sel`) are the URL's, the numbers are TanStack Query's
// (lib/analytics), and the feature keeps no state of its own. Each card reads its own answer and states its own loading and
// error, so one that fails does not take the others with it.
//
// Providers are never summed: the model shares are within each provider, and the chart keeps each provider's tokens apart.

const COPY = TRENDS_COPY;

/** The notices above the cards: no local records at all, history that starts after the period does, and the repo filter. */
function rangeNotices(sources: readonly SourceStatus[], filters: Filters) {
  const inScope = providersInScope(filters.provider);
  const oldest = (provider: Provider) =>
    sources.find((source) => source.id === provider)?.oldestDate ?? null;
  const notices: { tone: 'info' | 'warn'; text: string }[] = [];
  if (!inScope.some(oldest)) {
    notices.push({ tone: 'warn', text: RANGE_NOTICES.noLocalRecords });
  } else {
    const starts = inScope.flatMap((provider) => {
      const from = oldest(provider);
      return from && filters.start < from
        ? [`${PROVIDER_NAMES[provider]} from ${formatDayLong(from)}`]
        : [];
    });
    if (starts.length > 0) {
      notices.push({ tone: 'info', text: RANGE_NOTICES.historyStarts(starts.join('; ')) });
    }
  }
  if (filters.repos.length > 0) notices.push({ tone: 'info', text: RANGE_NOTICES.repoFilter });
  return notices;
}

export function TrendsRoute() {
  const { filters, period } = useFilters();
  const bootstrap = useBootstrap().data;
  const sources = useSources().data?.sources;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={COPY.title}
        subtitle={
          filters && period
            ? COPY.subtitle(
                PERIOD_LABEL[period],
                formatRange(filters.start, filters.end),
                filters.gran,
              )
            : undefined
        }
      />
      {!filters || !bootstrap ? (
        <p role="status" className="text-copy text-ink-muted">
          {COPY.loading}
        </p>
      ) : (
        <>
          {sources &&
            rangeNotices(sources, filters).map((notice) => (
              <Notice key={notice.text} tone={notice.tone}>
                {notice.text}
              </Notice>
            ))}
          <YearCard filters={filters} />
          <TrendsChart filters={filters} />
          <ModelShares filters={filters} />
        </>
      )}
    </div>
  );
}
