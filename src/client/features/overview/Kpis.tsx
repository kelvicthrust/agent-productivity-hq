import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Provider } from '../../../shared/contracts/common';
import { formatDayLong } from '../../../shared/domain/periods';
import { PROVIDER_NAMES, deliveryScopeLabel, usageScopeLabel } from '../../../shared/domain/scope';
import { Buddy } from '../../components/Buddy';
import { KpiCard, KpiSkeleton, KpiUnavailable, KpiValue } from '../../components/KpiCard';
import { ProviderLedger, type ProviderLedgerEntry } from '../../components/ProviderLedger';
import { Sparkline, type SparklineKind } from '../../components/Sparkline';
import { useKpiTrend, type Overview, type SeriesBucket } from '../../lib/analytics';
import { COVERAGE_PHRASES, PERIOD_NOT_HAPPENED } from '../../lib/copy';
import type { Filters } from '../../lib/filters';
import { compact, int } from '../../lib/format';
import { OVERVIEW_COPY } from './copy';

// The five summary tiles (ported from app.js `kpis` and `skeletonKpis`): Merged PRs, Linked PRs, Recorded local tokens, Root
// sessions and Child agents. Every figure is the API's: a figure it cannot give is null, and the tile says why in words
// instead of printing a 0 nobody measured (P-05). Providers are never added: the tokens tile is a ledger with one line each.
//
// Merged PRs and each provider's tokens carry a 12-week sparkline (the last twelve Monday-to-Sunday weeks, whatever the period:
// lib/analytics `useKpiTrend`). Each draws its own series on its own scale; the two token lines are never summed. While the
// trend loads a quiet line stands where it will be, and if it cannot be read the tile simply has no sparkline.
//
// One row from 1280px (3-2-3-2-2 of 12 columns), three to a row from 720px. On phones, the tokens tile takes a full row
// between the two delivery tiles and the two session tiles. Every layout follows the document order.

const COPY = OVERVIEW_COPY.kpis;
type Kpis = Overview['kpis'];

/** The weeks of the trend, oldest first, or what stands in for them: still loading (`pending`) or nothing to draw (`none`). */
type Trend =
  { state: 'pending' } | { state: 'none' } | { state: 'ready'; buckets: readonly SeriesBucket[] };

/** A sparkline needs at least one week with a figure. A single week (a provider's first, say) is drawn as its dot alone, so the
 * current-week marker and the accessible summary still say where the record starts. */
function sparkOf(
  trend: Trend,
  pick: (bucket: SeriesBucket) => number | null | undefined,
  kind: SparklineKind,
  format: (value: number) => string,
  label?: string,
): ReactNode {
  if (trend.state === 'pending') return <SparklineSkeleton />;
  if (trend.state === 'none') return null;
  const values = trend.buckets.map((bucket) => pick(bucket) ?? null);
  if (values.every((value) => value === null)) return null;
  return (
    <Sparkline
      values={values}
      currentIndex={values.length - 1}
      kind={kind}
      format={format}
      {...(label ? { label } : {})}
    />
  );
}

/** Holds the sparkline's place while the trend loads, so the tile does not move when it arrives. */
function SparklineSkeleton() {
  return (
    <span
      aria-hidden="true"
      className="block h-5 w-16 rounded-sm bg-sunken motion-safe:animate-pulse"
    />
  );
}

/** Where each tile sits, in document order: merged, linked, tokens, root sessions, child agents. */
const PLACEMENT = {
  merged: 'col-span-6 min-[720px]:col-span-4 min-[1280px]:col-span-3',
  linked: 'col-span-6 min-[720px]:col-span-4 min-[1280px]:col-span-2',
  tokens: 'col-span-12 min-[720px]:col-span-4 min-[1280px]:col-span-3',
  roots: 'col-span-6 min-[720px]:col-span-4 min-[1280px]:col-span-2',
  children: 'col-span-6 min-[720px]:col-span-4 min-[1280px]:col-span-2',
};

function KpiGrid({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <section
      aria-label={COPY.region}
      aria-busy={busy || undefined}
      className="grid grid-cols-12 gap-4"
    >
      {children}
    </section>
  );
}

/** The tiles while the first answer is on its way. The status line names the state once; the bars are decoration. */
export function KpiRowSkeleton() {
  return (
    <KpiGrid busy>
      {Object.entries(PLACEMENT).map(([tile, placement]) => (
        <KpiSkeleton key={tile} className={placement} />
      ))}
      <p role="status" className="sr-only">
        {COPY.loading}
      </p>
    </KpiGrid>
  );
}

// ---- Merged PRs -------------------------------------------------------------------------------------------------------------

function MergedPrs({ data, trend }: { data: Overview; trend: Trend }) {
  const copy = COPY.mergedPrs;
  const merged = data.kpis.mergedPrs;
  const delivery = merged?.delivery;
  const previous = merged?.previous;
  let body: ReactNode;
  let meta: ReactNode;
  if (delivery === 'none') {
    body = <KpiUnavailable>{COVERAGE_PHRASES.noTrackedRepos}</KpiUnavailable>;
    meta = <Link to="/sources">{copy.addRepos}</Link>;
  } else if (delivery === 'future') {
    body = <KpiUnavailable>{PERIOD_NOT_HAPPENED}</KpiUnavailable>;
  } else if (merged?.value == null) {
    body = <KpiUnavailable>—</KpiUnavailable>;
  } else {
    const spark =
      delivery === 'syncing' ? null : sparkOf(trend, (bucket) => bucket.prs, 'delivery', int);
    body = spark ? (
      <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
        <KpiValue>{int(merged.value)}</KpiValue>
        {spark}
      </div>
    ) : (
      <KpiValue>{int(merged.value)}</KpiValue>
    );
    meta =
      delivery === 'syncing'
        ? copy.syncing
        : previous?.label === undefined
          ? undefined
          : previous.outsideLookback || previous.value == null
            ? copy.outsideLookback(previous.label)
            : copy.previous(previous.label, previous.value);
  }
  return (
    <KpiCard
      tone="delivery"
      label={copy.label}
      scope={deliveryScopeLabel(data.scope)}
      meta={meta}
      className={PLACEMENT.merged}
    >
      {body}
    </KpiCard>
  );
}

// ---- Linked PRs -------------------------------------------------------------------------------------------------------------

/** The line under the figure: the PRs that have suggestions only, counted apart from the linked ones (G8_8). */
function linkedMeta(of: number, suggestedOnly: number): string | undefined {
  return of === 0 ? undefined : COPY.linkedPrs.suggestions(suggestedOnly);
}

function LinkedPrs({ data }: { data: Overview }) {
  const copy = COPY.linkedPrs;
  const value = data.kpis.linkedPrs?.value;
  const of = data.kpis.linkedPrs?.of;
  const suggestedOnly = data.kpis.linkedPrs?.suggestedOnly ?? 0;
  const hasFigure = value != null && of != null;
  return (
    <KpiCard
      label={copy.label}
      scope={copy.scope}
      meta={hasFigure ? linkedMeta(of, suggestedOnly) : undefined}
      className={PLACEMENT.linked}
    >
      {hasFigure ? (
        <KpiValue unit={copy.of(of)}>{int(value)}</KpiValue>
      ) : (
        <KpiUnavailable>—</KpiUnavailable>
      )}
    </KpiCard>
  );
}

// ---- Recorded local tokens --------------------------------------------------------------------------------------------------

const PROVIDERS: readonly Provider[] = ['codex', 'claude'];

/** What the ledger says where a provider has no figure: the coverage, in words. */
function noFigure(coverage: string): string {
  switch (coverage) {
    case 'none':
      return COVERAGE_PHRASES.noLocalRecords;
    case 'unavailable':
      return COVERAGE_PHRASES.historyUnavailable;
    case 'future':
      return PERIOD_NOT_HAPPENED;
    default:
      return COVERAGE_PHRASES.unavailable;
  }
}

/**
 * The note under a real figure. The API's `note` is a marker, not display text: "From <date> only" is built here from
 * `coveredFrom` (local-api › M7 delta), and a note without its date says nothing rather than something wrong.
 */
function noteFor(note: string | null | undefined, coveredFrom: string | null | undefined) {
  if (note === 'Cached; recent days missing') return COVERAGE_PHRASES.cachedRecentDaysMissing;
  if (note === 'From <date> only' && coveredFrom) {
    return COVERAGE_PHRASES.fromDateOnly(formatDayLong(coveredFrom));
  }
  return undefined;
}

function entriesOf(tokens: NonNullable<Kpis['localTokens']>, trend: Trend): ProviderLedgerEntry[] {
  return PROVIDERS.flatMap<ProviderLedgerEntry>((provider) => {
    const kpi = tokens[provider];
    if (!kpi) return [];
    if (kpi.value == null) {
      return [{ provider, value: null, unavailable: noFigure(kpi.coverage) }];
    }
    const note = noteFor(kpi.note, kpi.coveredFrom);
    const spark = sparkOf(
      trend,
      (bucket) => bucket.tokens[provider],
      provider,
      compact,
      PROVIDER_NAMES[provider],
    );
    return [
      { provider, value: kpi.value, ...(note ? { note } : {}), ...(spark ? { trend: spark } : {}) },
    ];
  });
}

function LocalTokens({ data, trend }: { data: Overview; trend: Trend }) {
  const copy = COPY.tokens;
  return (
    <KpiCard
      label={copy.label}
      scope={usageScopeLabel(data.scope)}
      meta={copy.meta}
      className={PLACEMENT.tokens}
    >
      <ProviderLedger entries={entriesOf(data.kpis.localTokens ?? {}, trend)} />
    </KpiCard>
  );
}

// ---- Root sessions and child agents -----------------------------------------------------------------------------------------

/** One buddy per session (the API sends up to ten), the first few as a small cluster, then "+N" for the rest. Decorative: the count is the figure. */
function CrewRow({ providers, total }: { providers: readonly Provider[]; total: number }) {
  const shown = providers.slice(0, COPY.crewMax);
  const more = total - shown.length;
  if (shown.length === 0) return null;
  return (
    <span aria-hidden="true" className="flex min-h-4 flex-wrap items-center gap-1">
      {shown.map((provider, index) => (
        <Buddy key={index} kind={provider} size={16} />
      ))}
      {more > 0 && <span className="text-caption text-ink-muted">+{more}</span>}
    </span>
  );
}

function RootSessions({ data }: { data: Overview }) {
  const copy = COPY.rootSessions;
  const roots = data.kpis.rootSessions;
  const upcoming = data.kpis.mergedPrs?.delivery === 'future';
  return (
    <KpiCard
      label={copy.label}
      scope={copy.scope}
      meta={roots?.value == null ? undefined : copy.unknown(roots.unknownRelationship ?? 0)}
      className={PLACEMENT.roots}
    >
      {roots?.value == null ? (
        <KpiUnavailable>
          {upcoming ? PERIOD_NOT_HAPPENED : COVERAGE_PHRASES.noLocalRecords}
        </KpiUnavailable>
      ) : (
        <>
          <KpiValue>{int(roots.value)}</KpiValue>
          <CrewRow providers={roots.crew ?? []} total={roots.value} />
        </>
      )}
    </KpiCard>
  );
}

function ChildAgents({ data }: { data: Overview }) {
  const copy = COPY.childAgents;
  const agents = data.kpis.childAgents;
  const upcoming = data.kpis.mergedPrs?.delivery === 'future';
  return (
    <KpiCard
      label={copy.label}
      scope={copy.scope}
      meta={agents?.value == null ? undefined : copy.split(agents.paseo ?? 0, agents.native ?? 0)}
      className={PLACEMENT.children}
    >
      {agents?.value == null ? (
        <KpiUnavailable>
          {upcoming ? PERIOD_NOT_HAPPENED : COVERAGE_PHRASES.noLocalRecords}
        </KpiUnavailable>
      ) : (
        <>
          <KpiValue>{int(agents.value)}</KpiValue>
          <CrewRow providers={agents.crew ?? []} total={agents.value} />
        </>
      )}
    </KpiCard>
  );
}

export function Kpis({
  data,
  busy,
  stale = false,
  filters,
}: {
  data: Overview;
  busy: boolean;
  /** The figures on screen are a previous filter's, kept while the new ones load. */
  stale?: boolean;
  filters: Filters;
}) {
  const series = useKpiTrend(filters);
  // A trend and its KPI must share one filter scope. While either answer is a previous filter's (kept while the new one loads),
  // hold the placeholder: never old weeks under new figures, nor new weeks under old figures.
  const trend: Trend =
    series.data && !series.isPlaceholderData && !stale
      ? { state: 'ready', buckets: series.data.buckets }
      : series.isPending || series.isPlaceholderData || stale
        ? { state: 'pending' }
        : { state: 'none' };
  return (
    <KpiGrid busy={busy}>
      <MergedPrs data={data} trend={trend} />
      <LinkedPrs data={data} />
      <LocalTokens data={data} trend={trend} />
      <RootSessions data={data} />
      <ChildAgents data={data} />
    </KpiGrid>
  );
}
