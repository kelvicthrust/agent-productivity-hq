import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { useCallback, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { PullRequest } from '../../../shared/contracts/prs';
import { formatRange } from '../../../shared/domain/periods';
import { deliveryScopeLabel } from '../../../shared/domain/scope';
import { DeliveryList } from '../../components/DeliveryList';
import { DeliveryTable } from '../../components/DeliveryTable';
import { PageHeader } from '../../components/PageHeader';
import { ScopeLine } from '../../components/ScopeLine';
import { useBootstrap } from '../../lib/bootstrap';
import { PERIOD_LABEL, PERIOD_NOT_HAPPENED, linkHealthNotice } from '../../lib/copy';
import { useFilters } from '../../lib/filters';
import { dotJoin } from '../../lib/format';
import { useRepos } from '../../lib/repos';
import { DELIVERY_COPY } from './copy';
import { EvidencePanel } from './evidence';
import { NoRepos } from './NoRepos';
import { Notice } from './Notice';
import { useOpenSet } from './openSet';
import { PrSearch } from './PrSearch';
import { LINK_FILTERS, PAGE_SIZE, linkFilterOf, usePrs } from './queries';
import { useIsPhone } from './useIsPhone';

// Delivery: the merged pull requests of the filters, newest first, with the link basis each one carries. A table from 640px and
// a list of cards below it, chosen by one media query read (`useIsPhone`); an opened PR shows its link evidence and the actions
// on it (./evidence).
//
// State ownership (TECH): the filters, the link-basis tab (`linkClass`) and the search (`q`) are the URL's, the numbers are
// TanStack Query's (queries.ts), and the only state the feature keeps is which PRs are open (openSet.ts), which is transient.

const COPY = DELIVERY_COPY;

/** What an opened PR shows: the evidence behind each of its links and the actions on them (./evidence). */
const renderEvidence = (pr: PullRequest) => <EvidencePanel pr={pr} />;

/** The API leaves the default out of the URL, as the filters do: no `linkClass` means All, no `q` means no search. */
function withParam(params: URLSearchParams, key: string, value: string | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === null || value === '') next.delete(key);
  else next.set(key, value);
  return next;
}

export function DeliveryRoute() {
  const { filters, ctx, period } = useFilters();
  const bootstrap = useBootstrap();
  const timeZone = bootstrap.data?.timezone;
  const login = bootstrap.data?.githubLogin ?? null;
  const repos = useRepos();
  const [params, setParams] = useSearchParams();
  const link = linkFilterOf(params.get('linkClass'));
  const search = params.get('q') ?? '';

  const phone = useIsPhone();
  const open = useOpenSet();
  const prs = usePrs(filters, link, search);

  // A tab is a step Back can undo, like a filter; typing is not, so the search replaces its own entry.
  const chooseLink = (next: string) =>
    setParams((current) => withParam(current, 'linkClass', next === 'all' ? null : next));
  const commitSearch = useCallback(
    (text: string) =>
      setParams((current) => withParam(current, 'q', text.trim()), { replace: true }),
    [setParams],
  );

  const pages = prs.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items ?? []);
  const counts = pages[0]?.counts;
  const links = linkHealthNotice(pages[0]?.linkHealth);
  const inaccessible = pages[0]?.inaccessibleRepos ?? [];
  const noRepos = repos.data !== undefined && repos.data.length === 0;

  // "N not shown" is known only when nothing narrows the tab's own count: a search has no count of its own.
  const total = search.trim() === '' ? counts?.[link] : undefined;
  const remaining = total === undefined ? null : Math.max(0, total - items.length);

  // After "Show more", focus moves to the first row it added: the button may be gone once the last page lands, and a focus lost
  // to the page would send a keyboard reader back to the top.
  const card = useRef<HTMLElement>(null);
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = focusFrom.current;
    const added = from === null ? undefined : items[from];
    if (added === undefined) return;
    focusFrom.current = null;
    card.current
      ?.querySelector<HTMLElement>(`[data-pr-id="${CSS.escape(added.id)}"] button`)
      ?.focus();
  }, [items]);
  const showMore = () => {
    if (prs.isFetchingNextPage) return;
    focusFrom.current = items.length;
    void prs.fetchNextPage();
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={COPY.title}
        subtitle={
          filters && period
            ? dotJoin([
                PERIOD_LABEL[period],
                formatRange(filters.start, filters.end),
                deliveryScopeLabel(filters),
              ])
            : undefined
        }
      />
      {!filters || !timeZone || repos.data === undefined ? (
        <p role="status" className="text-copy text-ink-muted">
          {COPY.loading}
        </p>
      ) : noRepos ? (
        <NoRepos />
      ) : (
        <>
          {links && <Notice tone="warn">{links}</Notice>}
          {inaccessible.length > 0 && (
            <Notice tone="warn">
              {COPY.inaccessible.text(inaccessible)}{' '}
              <Link to="/sources" className="font-semibold">
                {COPY.inaccessible.fix}
              </Link>
            </Notice>
          )}
          <section
            ref={card}
            aria-labelledby="dl-title"
            aria-busy={prs.isFetching || undefined}
            className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
          >
            <div className="min-w-0">
              <h2 id="dl-title" className="font-display text-title-section text-ink">
                {COPY.list.title}
              </h2>
              <ScopeLine delivery={filters}>{COPY.list.scope}</ScopeLine>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SegmentedControl
                label={COPY.linkFilter.label}
                value={link}
                onChange={chooseLink}
                className="max-w-full max-[719px]:flex-wrap"
              >
                {LINK_FILTERS.map((tab) => (
                  <SegmentedControlItem
                    key={tab}
                    value={tab}
                    label={`${COPY.linkFilter[tab]}${counts?.[tab] === undefined ? '' : ` ${counts[tab]}`}`}
                  />
                ))}
              </SegmentedControl>
              <PrSearch value={search} onCommit={commitSearch} />
            </div>
            {prs.isError && !prs.data ? (
              <p role="alert" className="flex flex-wrap items-center gap-x-2 text-copy text-danger">
                {COPY.loadFailed}
                <Button
                  label={COPY.retry}
                  size="sm"
                  variant="ghost"
                  className="max-[719px]:min-h-11"
                  onClick={() => void prs.refetch()}
                />
              </p>
            ) : !prs.data ? (
              <p role="status" className="text-copy text-ink-muted">
                {COPY.loading}
              </p>
            ) : items.length === 0 ? (
              <p className="text-copy text-ink-muted">
                {counts?.all === 0
                  ? // a range that starts after today has nothing to count yet: that is not a zero
                    ctx !== null && filters.start > ctx.today
                    ? PERIOD_NOT_HAPPENED
                    : COPY.none(filters.author === 'mine')
                  : COPY.noMatch}
              </p>
            ) : (
              <>
                {phone ? (
                  <DeliveryList
                    items={items}
                    timeZone={timeZone}
                    login={login}
                    isOpen={open.has}
                    onToggle={open.toggle}
                    renderEvidence={renderEvidence}
                  />
                ) : (
                  <DeliveryTable
                    items={items}
                    timeZone={timeZone}
                    login={login}
                    isOpen={open.has}
                    onToggle={open.toggle}
                    renderEvidence={renderEvidence}
                  />
                )}
                {prs.hasNextPage && (
                  <div className="flex flex-wrap items-center gap-x-2">
                    <Button
                      label={COPY.showMore(
                        remaining === null ? null : Math.min(PAGE_SIZE, remaining),
                      )}
                      size="sm"
                      variant="secondary"
                      aria-disabled={prs.isFetchingNextPage || undefined}
                      className="max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70"
                      onClick={showMore}
                    />
                    {remaining !== null && remaining > 0 && (
                      <span className="text-caption text-ink-muted">
                        {COPY.notShown(remaining)}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
