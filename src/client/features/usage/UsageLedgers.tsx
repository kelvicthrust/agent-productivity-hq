import type { ReactNode } from 'react';
import type { Provider, UsageCoverage } from '../../../shared/contracts/common';
import { formatDayLong } from '../../../shared/domain/periods';
import { providersInScope } from '../../../shared/domain/scope';
import { Buddy } from '../../components/Buddy';
import { ScopeLine } from '../../components/ScopeLine';
import { TokenLedger } from '../../components/TokenLedger';
import { COVERAGE_PHRASES, PERIOD_NOT_HAPPENED, PROVIDER_NAMES } from '../../lib/copy';
import type { Filters } from '../../lib/filters';
import { count } from '../../lib/format';
import { USAGE_COPY } from './copy';
import type { UsageCategories } from './queries';

// The provider token ledgers: one card for each provider in scope, each with its own categories and its own total. They
// are never added to each other. A card shows the ledger only when the provider has figures for the period (coverage ok,
// partial or stale). TokenLedger prints 0 for a figure it is not given, and a provider with no records, no history for the
// period, or a period that has not happened yet has no zero to report: it says why in words instead.

/** Coverage with figures behind it. `stale` is a source whose latest refresh failed: what was imported is still real. */
export const hasFigures = (coverage: UsageCoverage | undefined): boolean =>
  coverage === 'ok' || coverage === 'partial' || coverage === 'stale';

type Head = NonNullable<UsageCategories['codex']>;

function LedgerCard({
  provider,
  head,
  loading,
  filters,
  children,
}: {
  provider: Provider;
  head: Head | undefined;
  loading: boolean;
  filters: Filters;
  /** The ledger, given the sentence to append to its rule. */
  children: (note: string | undefined) => ReactNode;
}) {
  const titleId = `us-ledger-${provider}`;
  const coverage = head?.coverage;
  const note =
    coverage === 'partial' && head?.coveredFrom
      ? USAGE_COPY.ledgers.coversOnward(formatDayLong(head.coveredFrom))
      : coverage === 'stale'
        ? USAGE_COPY.ledgers.cached
        : undefined;
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id={titleId}
            className="flex items-center gap-1.5 font-display text-title-section text-ink"
          >
            <Buddy kind={provider} size={15} />
            {PROVIDER_NAMES[provider]}
          </h2>
          <ScopeLine usage={filters} />
        </div>
        {hasFigures(coverage) && head?.sessions !== undefined && (
          <span className="text-caption text-ink-muted">{count(head.sessions, 'session')}</span>
        )}
      </div>
      {loading ? (
        <p role="status" className="text-copy text-ink-muted">
          {USAGE_COPY.loading}
        </p>
      ) : hasFigures(coverage) ? (
        children(note)
      ) : (
        <p className="text-copy text-ink-muted">
          {coverage === 'future'
            ? PERIOD_NOT_HAPPENED
            : coverage === 'unavailable'
              ? COVERAGE_PHRASES.historyUnavailableForPeriod
              : COVERAGE_PHRASES.noLocalRecordsOnMachine}
        </p>
      )}
    </section>
  );
}

export function UsageLedgers({
  categories,
  failed,
  filters,
}: {
  /** Undefined until the first answer. */
  categories: UsageCategories | undefined;
  failed: boolean;
  filters: Filters;
}) {
  if (failed && !categories) {
    return (
      <p role="alert" className="text-copy text-danger">
        {USAGE_COPY.loadFailed}
      </p>
    );
  }
  const providers = providersInScope(filters.provider);
  const loading = categories === undefined;
  return (
    <div className="grid grid-cols-1 gap-4 min-[1024px]:grid-cols-2">
      {providers.includes('codex') && (
        <LedgerCard provider="codex" head={categories?.codex} loading={loading} filters={filters}>
          {(note) => <TokenLedger provider="codex" tokens={categories?.codex ?? {}} note={note} />}
        </LedgerCard>
      )}
      {providers.includes('claude') && (
        <LedgerCard provider="claude" head={categories?.claude} loading={loading} filters={filters}>
          {(note) => (
            <TokenLedger provider="claude" tokens={categories?.claude ?? {}} note={note} />
          )}
        </LedgerCard>
      )}
    </div>
  );
}
