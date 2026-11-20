import type { Provider } from '../../../shared/contracts/common';
import { providersInScope } from '../../../shared/domain/scope';
import { Buddy } from '../../components/Buddy';
import { ScopeLine } from '../../components/ScopeLine';
import { useModels, type Models } from '../../lib/analytics';
import { COVERAGE_PHRASES, PERIOD_NOT_HAPPENED, PROVIDER_NAMES } from '../../lib/copy';
import { cx } from '../../lib/cx';
import type { Filters } from '../../lib/filters';
import { compact } from '../../lib/format';
import { TRENDS_COPY } from './copy';
import { CardSkeleton, LoadFailed } from './Panels';

// Recorded tokens by model (ported from app.js `modelBreakdown`): for each provider in scope, how its own tokens split across the
// models it used. A share is a share OF THAT PROVIDER's tokens: the two providers are never compared on one scale, so each has its
// own list and its own 100%. Codex's bars are solid and Claude Code's are hatched, as in the chart, so the provider is never
// carried by colour alone.
//
// The bar is decoration: the model, its tokens and its share are written beside it, so the figures do not depend on seeing it.
// A provider with no figures for the period says why in words (no records, history unavailable, not yet) rather than an empty list.

const COPY = TRENDS_COPY.models;

/** The fill of a model's bar. The hatch is the chart's: the series colour with light stripes. */
const FILL: Record<Provider, { className?: string; style?: { background: string } }> = {
  codex: { className: 'bg-series-codex' },
  claude: {
    style: {
      background:
        'repeating-linear-gradient(45deg, var(--color-series-claude) 0 3.5px, var(--color-hatch-light) 3.5px 5px)',
    },
  },
};

type Share = NonNullable<Models[Provider]>;

function ProviderShare({ provider, share }: { provider: Provider; share: Share | undefined }) {
  const rows = share?.rows ?? [];
  const coverage = share?.coverage;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-label font-semibold text-ink">
        <Buddy kind={provider} size={15} />
        {PROVIDER_NAMES[provider]}
      </h3>
      {coverage === 'none' ? (
        <p className="text-copy text-ink-muted">{COVERAGE_PHRASES.noLocalRecordsOnMachine}</p>
      ) : coverage === 'unavailable' ? (
        <p className="text-copy text-ink-muted">{COVERAGE_PHRASES.historyUnavailableForPeriod}</p>
      ) : coverage === 'future' ? (
        <p className="text-copy text-ink-muted">{PERIOD_NOT_HAPPENED}</p>
      ) : rows.length === 0 ? (
        <p className="text-copy text-ink-muted">{COPY.none}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((row, index) => (
            <li
              key={row.model ?? index}
              className="grid grid-cols-[110px_minmax(0,1fr)_72px] items-center gap-3 text-data min-[720px]:grid-cols-[160px_minmax(0,1fr)_84px]"
            >
              <span className="truncate font-mono text-mono" title={row.model}>
                {row.model}
              </span>
              <span aria-hidden="true" className="h-2.5 overflow-hidden rounded-pill bg-sunken">
                <span
                  className={cx('block h-full rounded-pill', FILL[provider].className)}
                  style={{ width: `${row.sharePercent ?? 0}%`, ...FILL[provider].style }}
                />
              </span>
              <span className="text-right tabular-nums">
                {compact(row.tokens)}{' '}
                <span className="text-caption text-ink-muted">{row.sharePercent ?? 0}%</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ModelShares({ filters }: { filters: Filters }) {
  const models = useModels(filters);
  const data = models.data;
  if (!data) {
    return models.isError ? (
      <section className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card">
        <h2 className="font-display text-title-section text-ink">{COPY.title}</h2>
        <LoadFailed onRetry={() => void models.refetch()} />
      </section>
    ) : (
      <CardSkeleton title={COPY.title} loading={COPY.loading} />
    );
  }
  return (
    <section
      aria-labelledby="tr-models-title"
      aria-busy={models.isFetching || undefined}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="min-w-0">
        <h2 id="tr-models-title" className="font-display text-title-section text-ink">
          {COPY.title}
        </h2>
        <ScopeLine usage={filters}>{COPY.scope}</ScopeLine>
      </div>
      <div className="grid grid-cols-1 gap-4 min-[1024px]:grid-cols-2">
        {providersInScope(filters.provider).map((provider) => (
          <ProviderShare key={provider} provider={provider} share={data[provider]} />
        ))}
      </div>
    </section>
  );
}
