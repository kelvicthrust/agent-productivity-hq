import { Fragment, type ReactNode } from 'react';
import type { PullRequest } from '../../shared/contracts/prs';
import { PROVIDER_NAMES } from '../lib/copy';
import { cx } from '../lib/cx';
import { count, formatStarted } from '../lib/format';
import { Buddy } from './Buddy';
import { Icon } from './Icon';
import { LinkBadge } from './LinkBadge';

// The Delivery PR table at 640px and wider: a real table of six columns, Pull request | Merged | Author | Merged by | Linked
// sessions | Link basis (ported from app.js `prRow` and `pageDelivery`). Below 640px `DeliveryList` is drawn instead (TECH T5-2,
// the same decision as the Usage tree): this component never changes a table's `display`.
//
// D7 column policy, the same as Usage: the Pull request column takes the spare width, and every other data cell never wraps, so
// a time such as "Nov 2, 10:52 AM" or a login is never split. When the window is too narrow for the columns the table scrolls
// inside its own region instead of breaking a value. The region is focusable, so a keyboard can scroll it (WCAG 2.1.1), and
// shows a soft edge on each side that has more to see.
//
// This file also holds what `DeliveryList` shares with it: the words, the title link and the small cells. The two are
// presentation only. What an opened row shows (`renderEvidence`) and which rows are open belong to the Delivery feature, which
// a component may not import.

export const PR_COPY = {
  columns: {
    pr: 'Pull request',
    merged: 'Merged',
    author: 'Author',
    mergedBy: 'Merged by',
    linked: 'Linked sessions',
    basis: 'Link basis',
  },
  /** The table's name. The phone list carries the same words. */
  caption: 'Merged pull requests with linked sessions and link basis',
  /** The table scrolls sideways by itself when its columns do not fit; the region is how a keyboard reaches it. */
  scrollerLabel: 'Pull request table, scrolls sideways',
  /** Who did it, when it was you. */
  you: 'You',
  /** A login GitHub did not record. */
  nobody: '—',
  opensGithub: '(opens GitHub)',
  none: 'None',
  suggested: (n: number) => `${n} suggested`,
  showEvidence: (title: string) => `Show link evidence for ${title}`,
  hideEvidence: (title: string) => `Hide link evidence for ${title}`,
} as const;

/** The edge cue (ported from app.css `.table-wrap`): a shadow on each side with more to scroll, drawn with background layers. */
const SCROLL_CUE = [
  'linear-gradient(to right, var(--color-surface), transparent) left center / 24px 100% no-repeat local',
  'linear-gradient(to left, var(--color-surface), transparent) right center / 24px 100% no-repeat local',
  'radial-gradient(farthest-side at 0 50%, var(--scroll-edge), transparent) left center / 10px 100% no-repeat scroll',
  'radial-gradient(farthest-side at 100% 50%, var(--scroll-edge), transparent) right center / 10px 100% no-repeat scroll',
].join(', ');

const TH =
  'whitespace-nowrap border-b border-border bg-surface px-2.5 py-2 text-left text-caption font-semibold text-ink-muted';
const TD = 'border-b border-border px-2.5 py-2.5 align-top group-hover/row:bg-row-hover';
/** The Pull request column keeps room for a title however narrow the rest gets. */
const FIRST = 'min-w-64';

export interface DeliveryRowsProps {
  items: readonly PullRequest[];
  /** The report timezone, for the merge time. */
  timeZone: string;
  /** The connected GitHub login, so a merge you did reads "You". Null before anyone connected. */
  login: string | null;
  isOpen: (id: string) => boolean;
  onToggle: (id: string) => void;
  /** What an opened PR shows below its row. */
  renderEvidence: (pr: PullRequest) => ReactNode;
}

// ---- small parts the table and the phone list both draw ---------------------------------------------------------------------

/** The id of a PR's evidence panel, which its toggle names with `aria-controls` while it is open. */
export const evidenceId = (pr: Pick<PullRequest, 'id'>): string => `pr-evidence-${pr.id}`;

/**
 * Whether `value` is a login of the connected account (GitHub compares logins without case). Merge, unlike authorship, is not
 * answered by the API, so this is the one place the client works it out.
 */
export const isLogin = (value: string | null, login: string | null): boolean =>
  value !== null && login !== null && value.toLowerCase() === login.toLowerCase();

/** "You", the login, or "—". */
export function personLabel(value: string | null, mine: boolean): string {
  return mine ? PR_COPY.you : (value ?? PR_COPY.nobody);
}

/**
 * The address to open, or null when it is not a web address. The API says `url` is a URL, which includes `javascript:`; a
 * link is drawn only for http(s), so a PR's address can never run script when it is clicked.
 */
export function safeHref(url: string): string | null {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Puts focus back on a PR's row toggle, in the table row or the phone card: where focus goes after an evidence action and after its
 * Undo (the panel's own buttons may be gone by then, and a keyboard user must not be dropped at the top of the page).
 */
export function focusRowToggle(prId: string): void {
  document
    .querySelector<HTMLElement>(`[data-pr-id="${CSS.escape(prId)}"] button[aria-expanded]`)
    ?.focus();
}

/**
 * The chevron that opens and closes a PR's evidence. 24px as designed on a desktop; on a phone a pseudo-element grows the hit
 * area to 44px without moving anything (design-to-code "Touch targets"). Named by what it does and which PR it belongs to.
 */
export function RowToggle({
  open,
  label,
  controls,
  onToggle,
}: {
  open: boolean;
  label: string;
  /** The panel this opens; given only while it exists. */
  controls: string | undefined;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      onClick={onToggle}
      className="relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-pill border-0 bg-transparent p-0 text-ink-muted before:absolute before:-inset-2.5 before:content-[''] hover:bg-sunken hover:text-ink min-[720px]:before:hidden"
    >
      <Icon
        name="chevronRight"
        className={cx(
          'transition-transform duration-(--dur-popover) ease-crew-out motion-reduce:transition-none',
          open && 'rotate-90',
        )}
      />
    </button>
  );
}

/**
 * The title (a link to GitHub when the address is a web one, text otherwise) and, under it, `owner/name #number`. The title is
 * only ever a React text child, so whatever it contains is shown as written and never read as markup.
 */
export function PrTitle({ pr }: { pr: PullRequest }) {
  const href = safeHref(pr.url);
  return (
    <div className="min-w-0">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-ink no-underline [overflow-wrap:anywhere] hover:text-action hover:underline"
        >
          {/* A no-break space ties the icon to the title's last word, so it never wraps onto a line of its own. */}
          {pr.title}
          {'\u00A0'}
          <Icon name="external" size={12} className="inline-block align-[-1px] text-ink-muted" />
          <span className="sr-only"> {PR_COPY.opensGithub}</span>
        </a>
      ) : (
        <span className="font-semibold text-ink [overflow-wrap:anywhere]">{pr.title}</span>
      )}
      <div className="text-caption text-ink-muted [overflow-wrap:anywhere]">
        {pr.repo} #{pr.number}
      </div>
    </div>
  );
}

/** "Nov 2, 10:52 AM" in the report timezone, with the exact instant for machines. */
export function MergedAt({ pr, timeZone }: { pr: PullRequest; timeZone: string }) {
  return <time dateTime={pr.mergedAt}>{formatStarted(pr.mergedAt, timeZone)}</time>;
}

/**
 * The providers behind the confirmed links and how many sessions that is, or how many are only suggested, or "None". Until the
 * link engine (M8) every PR says None.
 */
export function LinkedSessions({ pr }: { pr: PullRequest }) {
  const { linkedSessionCount: linked, suggestedCount: suggested, providers } = pr;
  if (linked > 0) {
    return (
      <>
        <span className="flex flex-wrap gap-x-2 gap-y-0.5">
          {providers.map((provider) => (
            <span key={provider} className="inline-flex items-center gap-1 whitespace-nowrap">
              <Buddy kind={provider} size={13} />
              {PROVIDER_NAMES[provider]}
            </span>
          ))}
        </span>
        <span className="block text-caption text-ink-muted">
          {count(linked, 'session')}
          {suggested > 0 && ` · +${suggested} suggested`}
        </span>
      </>
    );
  }
  return (
    <span className="text-caption text-ink-muted">
      {suggested > 0 ? PR_COPY.suggested(suggested) : PR_COPY.none}
    </span>
  );
}

// ---- the table --------------------------------------------------------------------------------------------------------------

export function DeliveryTable({
  items,
  timeZone,
  login,
  isOpen,
  onToggle,
  renderEvidence,
}: DeliveryRowsProps) {
  const columns = PR_COPY.columns;
  return (
    // The card has 16px of padding; the scroller bleeds into it so the table can use the full width and its edge cue sits on
    // the card's border. When the columns do not fit this is a scrollable area, and a keyboard can only scroll an area it can
    // focus (WCAG 2.1.1; axe `scrollable-region-focusable`), so it is a labelled region with tabIndex 0. The lint rule below
    // allows tabIndex on a non-interactive element only for tabpanel, which this is deliberately not.
    <div
      role="region"
      aria-label={PR_COPY.scrollerLabel}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="-mx-4 overflow-x-auto px-4"
      style={{ background: SCROLL_CUE }}
    >
      <table className="w-full border-collapse text-data">
        <caption className="sr-only">{PR_COPY.caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={cx(TH, FIRST, 'w-full')}>
              {columns.pr}
            </th>
            <th scope="col" className={TH}>
              {columns.merged}
            </th>
            <th scope="col" className={TH}>
              {columns.author}
            </th>
            <th scope="col" className={TH}>
              {columns.mergedBy}
            </th>
            <th scope="col" className={TH}>
              {columns.linked}
            </th>
            <th scope="col" className={TH}>
              {columns.basis}
            </th>
          </tr>
        </thead>
        <tbody className="last:[&>tr:last-child>td]:border-b-0">
          {items.map((pr) => {
            const open = isOpen(pr.id);
            return (
              <Fragment key={pr.id}>
                <tr className="group/row" data-pr-id={pr.id}>
                  <td className={cx(TD, FIRST)}>
                    <div className="flex items-start gap-1.5">
                      <RowToggle
                        open={open}
                        label={(open ? PR_COPY.hideEvidence : PR_COPY.showEvidence)(pr.title)}
                        controls={open ? evidenceId(pr) : undefined}
                        onToggle={() => onToggle(pr.id)}
                      />
                      <PrTitle pr={pr} />
                    </div>
                  </td>
                  <td className={cx(TD, 'whitespace-nowrap')}>
                    <MergedAt pr={pr} timeZone={timeZone} />
                  </td>
                  <td className={cx(TD, 'whitespace-nowrap')}>
                    {personLabel(pr.author, pr.authoredByMe)}
                  </td>
                  <td className={cx(TD, 'whitespace-nowrap')}>
                    {personLabel(pr.mergedBy, isLogin(pr.mergedBy, login))}
                  </td>
                  <td className={cx(TD, 'whitespace-nowrap')}>
                    <LinkedSessions pr={pr} />
                  </td>
                  <td className={cx(TD, 'whitespace-nowrap')}>
                    <LinkBadge kind={pr.linkClass} />
                  </td>
                </tr>
                {open && (
                  // The one row with a colspan: an opened PR's panel is a single block across the table, as in the prototype.
                  <tr id={evidenceId(pr)}>
                    <td colSpan={6} className="border-b border-border bg-canvas py-3 pr-3 pl-11">
                      {renderEvidence(pr)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
