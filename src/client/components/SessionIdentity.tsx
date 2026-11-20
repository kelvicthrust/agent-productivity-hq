import { useId } from 'react';
import type { Session } from '../../shared/contracts/usage';
import { PROVIDER_NAMES, RELATIONSHIP_LABELS, SESSION_COPY } from '../lib/copy';
import { cx } from '../lib/cx';
import { dotJoin, formatStarted } from '../lib/format';

// How a session is named (ported from app.js sessName, sessSub and sessRef; the server now supplies `nameLead`).
// The lead is the recorded name, else the recorded relationship, and when there is no name it says so: a name is never
// made up. Below it, the relationship line (relationship · Paseo · workspace, or "No name recorded"), then the technical
// id, visible but secondary, then the meta line "provider · model · Started <time>".

/** The parts of a `Session` this component reads. */
export type SessionIdentityData = Pick<
  Session,
  'kind' | 'nameLead' | 'named' | 'providerSessionRef' | 'provider' | 'startedAt' | 'startedBasis'
> &
  Partial<Pick<Session, 'relationshipLabel' | 'paseo' | 'model'>>;

/** The relationship in words: the server's label, else derived from `kind`. */
export function relationshipOf(session: SessionIdentityData): string {
  if (session.relationshipLabel) return session.relationshipLabel;
  if (session.kind === 'root') return RELATIONSHIP_LABELS.root;
  if (session.kind === 'child') {
    return session.paseo ? RELATIONSHIP_LABELS.paseoChild : RELATIONSHIP_LABELS.nativeChild;
  }
  return RELATIONSHIP_LABELS.unknown;
}

export function SessionIdentity({
  session,
  details = [],
  showMeta = true,
  timeZone,
  className,
}: {
  session: SessionIdentityData;
  /** More for the relationship line, such as "2 children" or "parent outside current filters". Empty ones are skipped. */
  details?: ReadonlyArray<string | false | null | undefined>;
  /**
   * Show "provider · model · Started <time>". A phone card and the record lists need it; the desktop table has columns
   * for those values, so it turns this off rather than repeat them.
   */
  showMeta?: boolean;
  /** The report timezone for the Started time. Defaults to this machine's. */
  timeZone?: string;
  className?: string;
}) {
  const noteId = useId();
  const relationship = relationshipOf(session);
  const lead = session.named && session.nameLead !== '' ? session.nameLead : relationship;
  // "Paseo" is named once: a Paseo child agent's relationship label already says it.
  const sub = session.named
    ? dotJoin([
        relationship,
        session.paseo && session.kind !== 'child' && SESSION_COPY.paseo,
        session.paseo?.workspace,
        ...details,
      ])
    : dotJoin([SESSION_COPY.noNameRecorded, ...details]);
  const firstEvent = session.startedBasis === 'first_event';

  return (
    <span className={cx('flex min-w-0 flex-col gap-px', className)}>
      <span className="text-label font-semibold text-ink [overflow-wrap:break-word]">{lead}</span>
      <span className="text-caption text-ink-muted">{sub}</span>
      <span className="font-mono text-mono text-ink-muted [overflow-wrap:anywhere]">
        <span className="sr-only">{SESSION_COPY.idPrefix} </span>
        {session.providerSessionRef}
      </span>
      {showMeta && (
        <span className="text-caption text-ink-muted">
          {dotJoin([PROVIDER_NAMES[session.provider], session.model])} ·{' '}
          <time dateTime={session.startedAt} aria-describedby={firstEvent ? noteId : undefined}>
            {SESSION_COPY.started} {formatStarted(session.startedAt, timeZone)}
          </time>
          {firstEvent && (
            <span id={noteId} className="sr-only">
              {SESSION_COPY.firstEventNote}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
