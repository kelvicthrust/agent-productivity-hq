import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { Button } from '@astryxdesign/core/Button';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useBootstrap } from '../../lib/bootstrap';
import { canonicalSearch, useFilters } from '../../lib/filters';
import type { FilterGroupId } from '../../lib/filterSlot';
import { useRepos } from '../../lib/repos';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { AUTHOR_SUMMARY, COPY, PERIOD_LABEL, PROVIDER_SUMMARY } from './copy';
import { FilterControls } from './FilterControls';
import { activeFilterCount } from './groups';
import { FilterIcon } from './icons';
import type { RepoList } from './RepoPanel';

// The filter bar on Overview, Trends, Delivery and Usage (the shell mounts it for the route it shows, and the screen's PageHeader
// draws it under the title). `groups` are the ones that screen uses. Filters live in the URL (lib/filters.ts), so this
// component keeps no copy of them. From 720px it is one compact row (period, range, a Filters popover, time zone); below
// that it is a one-line summary and a Filters button that opens an Astryx Bottom Sheet with the same groups.

export function FilterBar({ groups }: { groups: readonly FilterGroupId[] }) {
  const { filters, ctx, period, apply } = useFilters();
  const bootstrap = useBootstrap();
  const repos = useRepos();
  const { search } = useLocation();
  const navigate = useNavigate();
  const wide = useMediaQuery('(min-width: 720px)');
  const [sheetOpen, setSheetOpen] = useState(false);
  // The sheet keeps its content mounted while closed; a new key at each opening starts the controls collapsed again.
  const [sheetKey, setSheetKey] = useState(0);
  // The sheet only exists on a phone: widening the window closes it, so narrowing again does not bring it back.
  if (wide && sheetOpen) setSheetOpen(false);
  const filtersButton = useRef<HTMLButtonElement>(null);

  // A URL that spells out defaults, repeats a key or reaches outside the lookback is rewritten to what it means, in place
  // (no history entry), so the address bar never says more or less than the page shows.
  useEffect(() => {
    if (!ctx) return;
    const canonical = canonicalSearch(search, ctx);
    if (canonical !== null) void navigate({ search: canonical }, { replace: true });
  }, [ctx, search, navigate]);

  if (!filters || !ctx || period === null) {
    // While the app is still asking what today is, keep the bar's height so the page below does not jump.
    return bootstrap.isPending ? <div aria-hidden="true" className="h-14" /> : null;
  }

  const repoList: RepoList =
    repos.status === 'success'
      ? { status: 'success', repos: repos.data }
      : repos.status === 'error'
        ? { status: 'error', retry: () => void repos.refetch() }
        : { status: 'pending' };
  const names = new Map(
    (repos.status === 'success' ? repos.data : []).map((repo) => [repo.id, repo.displayName]),
  );
  const repoLabel =
    filters.repos.length === 0
      ? COPY.allRepos
      : filters.repos.length === 1
        ? (names.get(filters.repos[0]!) ?? filters.repos[0]!)
        : `${filters.repos.length} repos`;

  const has = (group: FilterGroupId) => groups.includes(group);
  // The phone summary names only what this screen filters by.
  const summary = [
    ...(has('repos') ? [repoLabel] : []),
    ...(has('provider') ? [PROVIDER_SUMMARY[filters.provider]] : []),
    ...(has('author') ? [AUTHOR_SUMMARY[filters.author]] : []),
  ];

  const controls = (inline: boolean) => (
    <FilterControls
      inline={inline}
      groups={groups}
      activeCount={activeFilterCount(groups, filters)}
      ctx={ctx}
      filters={filters}
      period={period}
      timezone={bootstrap.data?.timezone}
      repoList={repoList}
      repoLabel={repoLabel}
      apply={apply}
    />
  );

  // The sticky band's cream background reaches into the page margin (24px) to cover what scrolls under it. It is a box-shadow
  // clipped to the sides, not a negative margin: a shadow adds no scrollable overflow, so the screen's column stays inside its box.
  return (
    <section
      aria-label={COPY.filters}
      className="sticky top-[var(--appbar-h)] z-20 bg-canvas pb-3 pt-1 shadow-[0_0_0_24px_var(--color-canvas)] [clip-path:inset(-2px_-24px)] min-[720px]:top-[calc(var(--appbar-h)+46px)] min-[1024px]:top-[var(--appbar-h)]"
    >
      {wide ? (
        <div className="flex max-w-[var(--content-max)] flex-wrap items-center gap-x-4 gap-y-2">
          {controls(false)}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 rounded-full border border-border bg-surface py-1.5 pl-3.5 pr-1.5">
            <p className="min-w-0 text-caption text-ink-muted">
              <b className="text-label font-bold text-ink">{PERIOD_LABEL[period]}</b>
              {summary.map((part) => ` · ${part}`).join('')}
            </p>
            <Button
              ref={filtersButton}
              label={COPY.filters}
              size="sm"
              variant="secondary"
              icon={<FilterIcon name="filter" />}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              className="min-h-11 flex-none rounded-full"
              onClick={() => {
                setSheetKey((key) => key + 1);
                setSheetOpen(true);
              }}
            />
          </div>
          <BottomSheet
            isOpen={sheetOpen}
            onOpenChange={setSheetOpen}
            finalFocusRef={filtersButton}
            label={COPY.filters}
            height="hug"
          >
            <div key={sheetKey} className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2>{COPY.filters}</h2>
                <Button
                  label={COPY.closeFilters}
                  isIconOnly
                  icon={<FilterIcon name="close" />}
                  variant="ghost"
                  className="min-h-11 min-w-11"
                  onClick={() => setSheetOpen(false)}
                />
              </div>
              {controls(true)}
              <div className="flex items-center justify-between gap-2">
                <Button
                  label={COPY.reset}
                  variant="secondary"
                  className="min-h-11"
                  onClick={() => apply({ reset: true })}
                />
                <Button
                  label={COPY.showResults}
                  variant="primary"
                  className="min-h-11"
                  onClick={() => setSheetOpen(false)}
                />
              </div>
            </div>
          </BottomSheet>
        </>
      )}
    </section>
  );
}
