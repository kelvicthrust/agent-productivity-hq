import { Link, type To } from 'react-router';
import type { Session } from '../../shared/contracts/usage';
import { LINK_STATUS_TEXT } from '../lib/copy';
import { cx } from '../lib/cx';
import { dayOf } from '../lib/format';
import { LinkBadge } from './LinkBadge';

// The Linked PRs cell of a session (D5; ported from app.js `sessRow`'s `pl`, with the decision moved to the server).
//
//   linked             each PR as `#number` and Delivery's badge (Evidence link, Owner-confirmed, Suggested), in that order
//   unlinked           the Unlinked badge: a check could happen and found nothing
//   not checked        plain words, never "Unlinked", because that would claim a check that could not happen:
//                      repo_not_tracked, repo_unknown, prs_not_collected
//
// The client never works the status out from missing data: `Session.linkStatus` says which of these it is. The meaning is
// always in the words, not the colour or shape of the badge.

export type SessionLinksData = Pick<Session, 'linkStatus' | 'linkedPrs'>;
type LinkedPr = Session['linkedPrs'][number];

const CLASS_ORDER: Record<LinkedPr['class'], number> = { evidence: 0, owner: 1, suggested: 2 };

const NOT_CHECKED = {
  repo_not_tracked: LINK_STATUS_TEXT.repoNotTracked,
  repo_unknown: LINK_STATUS_TEXT.repoUnknown,
  prs_not_collected: LINK_STATUS_TEXT.prsNotCollected,
} as const;

/**
 * Where `#number` goes: Delivery, on the day the PR merged (in the report timezone), for every author, searching for the PR, so the
 * PR is listed on the page it lands on (the prototype's `gotoPr` widens the period and the author the same way). Without a merge
 * time the link falls back to the search alone.
 */
export function deliveryLink(
  pr: Pick<LinkedPr, 'repo' | 'number'> & { mergedAt?: string | undefined },
  timeZone?: string,
): To {
  const q = encodeURIComponent(`${pr.repo}#${pr.number}`);
  const day = pr.mergedAt === undefined ? null : dayOf(pr.mergedAt, timeZone);
  return {
    pathname: '/delivery',
    search: day === null ? `?q=${q}` : `?start=${day}&end=${day}&author=all&q=${q}`,
  };
}

export function SessionLinks({
  session,
  className,
  timeZone,
}: {
  session: SessionLinksData;
  className?: string;
  /** The report timezone, to find the day a linked PR merged. */
  timeZone?: string;
}) {
  if (session.linkStatus === 'unlinked') return <LinkBadge kind="unlinked" className={className} />;
  if (session.linkStatus !== 'linked') {
    return (
      <span className={cx('text-caption text-ink-muted', className)}>
        {NOT_CHECKED[session.linkStatus]}
      </span>
    );
  }
  // A "linked" session always has its PRs; if a response ever said otherwise, saying nothing is better than "Unlinked".
  if (session.linkedPrs.length === 0) return null;
  const prs = [...session.linkedPrs].sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class]);
  return (
    <ul className={cx('flex flex-wrap items-center gap-x-3 gap-y-0.5', className)}>
      {prs.map((pr) => (
        <li
          key={pr.prId}
          className="inline-flex max-w-full flex-wrap items-center gap-x-0.5 gap-y-0.5"
        >
          {/* The visible text is the number, as the design has it; the repo is added for assistive technology, because the
              same number can exist in two repos. The item may wrap, number then badge: on a 320px phone the cell is about 155px
              and "#236" with an Owner-confirmed badge is about 186px, so a nowrap item ran out of its session card. */}
          <Link
            to={deliveryLink(pr, timeZone)}
            className="inline-flex min-h-6 items-center rounded-sm px-1.5 text-label font-semibold no-underline hover:bg-selection-surface max-[719px]:min-h-11"
          >
            #{pr.number}
            <span className="sr-only"> in {pr.repo}</span>
          </Link>
          <LinkBadge kind={pr.class} />
        </li>
      ))}
    </ul>
  );
}
