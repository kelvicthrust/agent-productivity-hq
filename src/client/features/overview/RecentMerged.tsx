import { Button } from '@astryxdesign/core/Button';
import type { ComponentProps } from 'react';
import { Link } from 'react-router';
import { CrewArt } from '../../components/CrewArt';
import { MergedAt, PrTitle } from '../../components/DeliveryTable';
import { LinkBadge } from '../../components/LinkBadge';
import { EMPTY_REPOS, PERIOD_NOT_HAPPENED } from '../../lib/copy';
import type { Overview } from '../../lib/analytics';
import { OVERVIEW_COPY } from './copy';

// Recently merged (ported from app.js `recentList` and `emptyRepos`): the newest merged PRs of the period, at most six (the API
// sends no more), each with its link basis, then how many merged in all and a way to the full list. What it says when there is
// nothing to list depends on why: no tracked repo, a period that has not started, a first sync still running, or a true none.

const COPY = OVERVIEW_COPY.recent;

/** React Router's Link under the `href` name Astryx's Button passes to a custom link component. */
function RouterLink({ href, ...rest }: Omit<ComponentProps<typeof Link>, 'to'> & { href: string }) {
  return <Link to={href} {...rest} />;
}

/** The state when no repository is tracked: the way forward is to add one. The primary action is on the right of its group. */
function EmptyRepos() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong bg-surface p-6">
      <CrewArt mood="search" />
      <h3 className="font-display text-title-section text-ink">{EMPTY_REPOS.heading}</h3>
      <p className="max-w-[60ch] text-copy text-ink-muted">{EMPTY_REPOS.body}</p>
      <Button
        label={EMPTY_REPOS.action}
        href="/sources"
        as={RouterLink}
        size="sm"
        variant="primary"
        className="max-[719px]:min-h-11"
      />
    </div>
  );
}

export function RecentMerged({
  data,
  timeZone,
  deliverySearch,
}: {
  data: Overview;
  timeZone: string;
  /** The current filters as a query string, so "View all in Delivery" opens on the same period and scope. */
  deliverySearch: string;
}) {
  const delivery = data.kpis.mergedPrs?.delivery;
  const prs = data.recentPrs;
  if (delivery === 'none') return <EmptyRepos />;
  if (prs.length === 0) {
    return (
      <p className="text-copy text-ink-muted">
        {delivery === 'future'
          ? PERIOD_NOT_HAPPENED
          : delivery === 'syncing'
            ? COPY.syncing
            : COPY.none(data.scope.author === 'mine')}
      </p>
    );
  }
  return (
    <>
      <ul className="m-0 flex list-none flex-col p-0">
        {prs.map((pr) => (
          <li
            key={pr.id}
            className="flex items-start justify-between gap-3 border-b border-border py-2.5 first:pt-0 last:border-b-0"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <PrTitle pr={pr} />
              <div className="text-caption text-ink-muted">
                <MergedAt pr={pr} timeZone={timeZone} />
                {!pr.authoredByMe && pr.author ? ` · ${COPY.by(pr.author)}` : ''}
              </div>
            </div>
            <LinkBadge kind={pr.linkClass} className="shrink-0" />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-caption text-ink-muted">
          {COPY.merged(data.periodMergedCount ?? prs.length)}
        </span>
        <Link
          to={{ pathname: '/delivery', search: deliverySearch }}
          // A 20px line on a phone: a pseudo-element grows the hit area to 44px without moving anything (design-to-code › Touch targets).
          className="relative before:absolute before:inset-x-0 before:-inset-y-3 before:content-[''] min-[720px]:before:hidden"
        >
          {COPY.viewAll}
        </Link>
      </div>
    </>
  );
}
