import type { ReactNode, Ref } from 'react';
import type { PullRequest } from '../../../shared/contracts/prs';
import type { Session } from '../../../shared/contracts/usage';
import { Buddy } from '../../components/Buddy';
import { MergedAt, PrTitle } from '../../components/DeliveryTable';
import { Icon } from '../../components/Icon';
import { LinkBadge } from '../../components/LinkBadge';
import { SessionIdentity } from '../../components/SessionIdentity';
import { cx } from '../../lib/cx';
import { compact } from '../../lib/format';
import { DRAWER_COPY } from './copy';

// The two record lists of the drawer and the small parts around them. Presentational: the panel (RecordsPanel) decides which
// list, which note or which empty sentence goes where, from what the API says about coverage.

const ROW = 'border-b border-border py-2.5 first:pt-0 last:border-b-0';

/** A line of context above a list (ported from app.js `notice`): "info" for what the data does not cover, "warn" for a gap that limits it. */
export function Note({ tone, children }: { tone: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={cx(
        'flex items-start gap-2 rounded-sm px-3 py-2 text-caption text-ink',
        tone === 'warn' ? 'bg-warning-surface' : 'bg-sunken',
      )}
    >
      <Icon
        name={tone === 'warn' ? 'alert' : 'info'}
        className={cx('mt-px shrink-0', tone === 'warn' ? 'text-warning' : 'text-ink-muted')}
      />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** A sentence that names a state in the list's place: why there is nothing to list. */
export function Said({ children }: { children: ReactNode }) {
  return <p className="text-copy text-ink-muted">{children}</p>;
}

/**
 * The list element carries the focus the panel hands back after "Show more" (the button that had it has gone), so it is a
 * programmatic focus target and nothing a Tab reaches.
 */
export function PrList({
  prs,
  timeZone,
  listRef,
}: {
  prs: readonly PullRequest[];
  timeZone: string;
  listRef: Ref<HTMLUListElement>;
}) {
  return (
    <ul
      ref={listRef}
      tabIndex={-1}
      aria-label={DRAWER_COPY.prs.listLabel}
      className="m-0 flex list-none flex-col p-0 outline-none"
    >
      {prs.map((pr) => (
        <li key={pr.id} className={cx('flex items-start justify-between gap-3', ROW)}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <PrTitle pr={pr} />
            <div className="text-caption text-ink-muted">
              <MergedAt pr={pr} timeZone={timeZone} />
              {!pr.authoredByMe && pr.author ? ` · ${DRAWER_COPY.prs.by(pr.author)}` : ''}
            </div>
          </div>
          <LinkBadge kind={pr.linkClass} className="shrink-0" />
        </li>
      ))}
    </ul>
  );
}

/** Sessions, largest first as the API sends them. A count is one session's own tokens in its own provider's units: nothing is added up. */
export function SessionList({
  sessions,
  timeZone,
  listRef,
}: {
  sessions: readonly Session[];
  timeZone: string;
  listRef: Ref<HTMLUListElement>;
}) {
  return (
    <ul
      ref={listRef}
      tabIndex={-1}
      aria-label={DRAWER_COPY.sessions.listLabel}
      className="m-0 flex list-none flex-col p-0 outline-none"
    >
      {sessions.map((session) => (
        <li key={session.id} className={cx('flex items-start gap-2', ROW)}>
          <Buddy kind={session.provider} size={15} className="mt-0.5" />
          <SessionIdentity session={session} timeZone={timeZone} className="flex-1" />
          <span className="shrink-0 text-data font-semibold text-ink">
            {compact(session.tokens)}
            <span className="sr-only"> {DRAWER_COPY.sessions.tokens}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
