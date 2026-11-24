import { useState } from 'react';
import { useLocation } from 'react-router';
import type { Provider } from '../../../shared/contracts/common';
import { formatDayLong, formatRange } from '../../../shared/domain/periods';
import { providersInScope } from '../../../shared/domain/scope';
import { PageHeader } from '../../components/PageHeader';
import { PaseoQuotaCard } from '../../components/PaseoQuotaCard';
import { RefreshBanner } from '../../components/RefreshBanner';
import { ScopeLine } from '../../components/ScopeLine';
import { useOverview, type Overview } from '../../lib/analytics';
import { useBootstrap } from '../../lib/bootstrap';
import { PROVIDER_NAMES, RANGE_NOTICES, linkHealthNotice } from '../../lib/copy';
import { useFilters } from '../../lib/filters';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { AccountCards } from './AccountCards';
import { OVERVIEW_COPY, PERIOD_LABEL } from './copy';
import { greeting } from './greeting';
import { Kpis, KpiRowSkeleton } from './Kpis';
import { Notice } from './Notice';
import { OverviewChart } from './OverviewChart';
import { CardSkeleton, OverviewFailed, QuietOne } from './Panels';
import { RecentMerged } from './RecentMerged';
import { RepoTable } from './RepoTable';

// Overview: greeting, summary metrics and the activity stack. Notices follow the metrics at every width, so that a collection
// problem never pushes the headline counts down. From 1280px the chart and the account-reported usage share the first row (the
// account card is the chart's neighbour, top to top) and Recently merged and By repository follow at full width, so the two
// columns end near each other instead of one tall column beside a short one. The account card is last in the reading order
// everywhere: below 1280px it follows the stack, and at 1280px it is placed beside the chart by the grid and not by the markup.
//
// State ownership (TECH): the filters are the URL's (`useFilters`), the numbers are TanStack Query's (lib/analytics), and the
// feature keeps no state of its own. The chart's selection is the records drawer's (lib/recordsDrawer), which opens on a bucket.
// A changed filter keeps the last answer on screen until the new one lands (`keepPreviousData`), marked `aria-busy`.
//
// Providers are never summed: every figure is one provider's or says it is not combined. The account cards are account-wide and
// never filtered by repo.

const COPY = OVERVIEW_COPY;
const PROVIDERS: readonly Provider[] = ['codex', 'claude'];

/** The notices above the cards: no local records at all, history that starts after the period does, and the repo filter. */
function rangeNotices(data: Overview) {
  const { scope, coverage } = data;
  const inScope = providersInScope(scope.provider);
  const oldest = (provider: Provider) =>
    coverage.sources?.find((source) => source.id === provider)?.oldestDate ?? null;
  const notices: { tone: 'info' | 'warn'; text: string }[] = [];
  const links = linkHealthNotice(data.linkHealth);
  if (links && (coverage.github?.tracked ?? 0) > 0) notices.push({ tone: 'warn', text: links });
  if (!inScope.some(oldest)) {
    notices.push({ tone: 'warn', text: RANGE_NOTICES.noLocalRecords });
  } else {
    const starts = inScope.flatMap((provider) => {
      const from = oldest(provider);
      return from && scope.start < from
        ? [`${PROVIDER_NAMES[provider]} from ${formatDayLong(from)}`]
        : [];
    });
    if (starts.length > 0) {
      notices.push({ tone: 'info', text: RANGE_NOTICES.historyStarts(starts.join('; ')) });
    }
  }
  if (scope.repos.length > 0) notices.push({ tone: 'info', text: RANGE_NOTICES.repoFilter });
  return notices;
}

export function OverviewRoute() {
  const { filters, period } = useFilters();
  const bootstrap = useBootstrap().data;
  const overview = useOverview(filters);
  const phone = useMediaQuery('(max-width: 719px)');
  const { search } = useLocation();
  // The part of the day is read once, when the page opens: a greeting that changed while someone read it would be noise.
  const [openedAt] = useState(() => Date.now());
  const data = overview.data;

  const title = bootstrap ? greeting(openedAt, bootstrap.timezone, bootstrap.greetingName) : null;
  const timeZone = bootstrap?.timezone;
  const failed = data === undefined && overview.isError;

  const coverage = data
    ? Object.fromEntries(
        PROVIDERS.flatMap((provider) => {
          const kpi = data.kpis.localTokens?.[provider];
          return kpi ? [[provider, kpi.coverage] as const] : [];
        }),
      )
    : {};

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          title === null ? (
            COPY.title
          ) : (
            <>
              <span className="sr-only">{COPY.title}: </span>
              {title}
            </>
          )
        }
        subtitle={
          filters && period
            ? COPY.subtitle(PERIOD_LABEL[period], formatRange(filters.start, filters.end))
            : undefined
        }
      />

      {!filters || !bootstrap || !timeZone ? (
        <p role="status" className="text-copy text-ink-muted">
          {COPY.loading}
        </p>
      ) : (
        <>
          <div>
            {failed ? (
              <OverviewFailed onRetry={() => void overview.refetch()} />
            ) : data ? (
              <Kpis
                data={data}
                busy={overview.isFetching}
                stale={overview.isPlaceholderData}
                filters={filters}
              />
            ) : (
              <KpiRowSkeleton />
            )}
          </div>

          {phone && <RefreshBanner />}
          {data &&
            rangeNotices(data).map((notice) => (
              <Notice key={notice.text} tone={notice.tone}>
                {notice.text}
              </Notice>
            ))}
          {data?.trueZero && <QuietOne />}

          <div className="grid grid-cols-12 items-start gap-4">
            <div className="col-span-12 min-w-0 min-[1280px]:col-span-8 min-[1280px]:row-start-1">
              <OverviewChart filters={filters} />
            </div>
            {data ? (
              <>
                <section
                  aria-labelledby="ov-recent-title"
                  className="col-span-12 flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
                >
                  <div className="min-w-0">
                    <h2 id="ov-recent-title" className="font-display text-title-section text-ink">
                      {COPY.recent.title}
                    </h2>
                    <ScopeLine delivery={data.scope} />
                  </div>
                  <RecentMerged data={data} timeZone={timeZone} deliverySearch={search} />
                </section>
                <section
                  aria-labelledby="ov-repo-title"
                  className="col-span-12 flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
                >
                  <div className="min-w-0">
                    <h2 id="ov-repo-title" className="font-display text-title-section text-ink">
                      {COPY.repos.title}
                    </h2>
                    <ScopeLine delivery={data.scope} usage={data.scope} />
                  </div>
                  <RepoTable
                    rows={data.repoRows}
                    providers={providersInScope(data.scope.provider)}
                    coverage={coverage}
                    noRepos={data.kpis.mergedPrs?.delivery === 'none'}
                  />
                </section>
              </>
            ) : (
              !failed && (
                <>
                  <div className="col-span-12 min-w-0">
                    <CardSkeleton title={COPY.recent.title} loading={COPY.loading} />
                  </div>
                  <div className="col-span-12 min-w-0">
                    <CardSkeleton title={COPY.repos.title} loading={COPY.loading} />
                  </div>
                </>
              )
            )}
            <div className="col-span-12 min-w-0 min-[1280px]:col-span-4 min-[1280px]:col-start-9 min-[1280px]:row-start-1">
              {bootstrap.paseoManaged ? (
                <PaseoQuotaCard
                  provider={filters.provider}
                  timeZone={timeZone}
                  today={bootstrap.today}
                />
              ) : data ? (
                <AccountCards
                  accounts={data.coverage.accounts ?? []}
                  reports={data.accounts}
                  scope={data.scope}
                  timeZone={timeZone}
                  today={bootstrap.today}
                />
              ) : (
                !failed && <CardSkeleton title={COPY.accounts.title} loading={COPY.loading} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
