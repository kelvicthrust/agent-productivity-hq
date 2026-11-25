import type { Provider } from '../../../shared/contracts/common';
import { formatDayLong, formatRange } from '../../../shared/domain/periods';
import { usageScopeLabel } from '../../../shared/domain/scope';
import { PageHeader } from '../../components/PageHeader';
import { useBootstrap } from '../../lib/bootstrap';
import { PERIOD_LABEL, PROVIDER_NAMES, RANGE_NOTICES } from '../../lib/copy';
import { useFilters, type Filters } from '../../lib/filters';
import { dotJoin } from '../../lib/format';
import { NoRecords } from './NoRecords';
import { Notice } from './Notice';
import { USAGE_COPY } from './copy';
import { useUsageCategories, type UsageCategories } from './queries';
import { UsageCoverage } from './UsageCoverage';
import { UsageLedgers, hasFigures } from './UsageLedgers';
import { UsageTree } from './UsageTree';

// Usage: where the tokens went on this machine. Provider ledgers on top (each provider's categories and total, never
// added together), then the tree of sessions by repository, root session and child agent, with each session's linked PRs.
//
// State ownership (TECH): the filters are the URL's (`useFilters`), the numbers are TanStack Query's (queries.ts), and the
// only state the feature keeps is which tree rows are open (expandedSet.ts), which is transient.

const PROVIDERS: readonly Provider[] = ['codex', 'claude'];

/** The providers whose coverage says there are no figures for the period; their totals must not read as a covered 0. */
function uncoveredProviders(categories: UsageCategories | undefined): ReadonlySet<Provider> {
  const out = new Set<Provider>();
  if (!categories) return out;
  for (const provider of PROVIDERS) {
    const coverage = categories[provider]?.coverage;
    if (coverage !== undefined && !hasFigures(coverage)) out.add(provider);
  }
  return out;
}

/** "Codex from Feb 2, 2026; Claude Code from Mar 14, 2026": the providers whose history starts after the period does. */
function historyStarts(categories: UsageCategories, filters: Filters): string[] {
  return PROVIDERS.flatMap((provider) => {
    const from = categories[provider]?.coveredFrom;
    return from && filters.start < from
      ? [`${PROVIDER_NAMES[provider]} from ${formatDayLong(from)}`]
      : [];
  });
}

export function UsageRoute() {
  const { filters, period } = useFilters();
  const timeZone = useBootstrap().data?.timezone;
  const categories = useUsageCategories(filters);
  const data = categories.data;

  // This machine has no records at all: nothing to break down, so no ledgers and no tree.
  const noRecords =
    filters?.provider === 'all' &&
    data?.codex?.coverage === 'none' &&
    data.claude?.coverage === 'none';
  const starts = data && filters ? historyStarts(data, filters) : [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={USAGE_COPY.title}
        subtitle={
          filters && period
            ? dotJoin([
                PERIOD_LABEL[period],
                formatRange(filters.start, filters.end),
                usageScopeLabel(filters),
              ])
            : undefined
        }
      />
      <UsageCoverage />
      {!filters || !timeZone ? (
        <p role="status" className="text-copy text-ink-muted">
          {USAGE_COPY.loading}
        </p>
      ) : noRecords ? (
        <NoRecords />
      ) : (
        <>
          {starts.length > 0 && (
            <Notice tone="info">{RANGE_NOTICES.historyStarts(starts.join('; '))}</Notice>
          )}
          {filters.repos.length > 0 && <Notice tone="info">{RANGE_NOTICES.repoFilter}</Notice>}
          {data?.paseoNote && <Notice tone="warn">{data.paseoNote}</Notice>}
          <UsageLedgers categories={data} failed={categories.isError} filters={filters} />
          <UsageTree filters={filters} uncovered={uncoveredProviders(data)} timeZone={timeZone} />
        </>
      )}
    </div>
  );
}
