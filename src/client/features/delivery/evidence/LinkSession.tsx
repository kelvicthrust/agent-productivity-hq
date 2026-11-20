import { Button } from '@astryxdesign/core/Button';
import { useEffect, useId, useRef, useState } from 'react';
import type { Session as Candidate } from '../../../../shared/contracts/usage';
import { Icon } from '../../../components/Icon';
import { relationshipOf } from '../../../components/SessionIdentity';
import { PROVIDER_NAMES } from '../../../lib/copy';
import { dotJoin, formatStarted } from '../../../lib/format';
import { EVIDENCE_COPY } from './copy';

// "Link a session" (ported from app.js `addLinkForm`): the sessions the server offers (same repo, active in the 3 days up to the
// merge, not already listed, at most 30) in one select, then Add link. Cancel is on the left and the primary action on the right.
//
// Focus (J4): opening goes to the select; Cancel goes back to "Link a session"; a link that saved goes to the PR's row toggle,
// which `useLinkActions` does for every change. A link that did not save leaves the form open with the choice kept.

const SELECT =
  'h-[34px] w-full min-w-0 max-w-full rounded-sm border border-control-border bg-surface px-2 text-data text-ink max-[719px]:h-11 max-[719px]:text-[16px]';

/** "Planner · Codex · Started Nov 3, 2:10 PM · thread 7f3a…2c91": the option, with the same "Started" every session time has. */
function optionText(session: Candidate, timeZone: string | undefined): string {
  const lead =
    session.named && session.nameLead !== '' ? session.nameLead : relationshipOf(session);
  return dotJoin([
    lead,
    PROVIDER_NAMES[session.provider],
    `Started ${formatStarted(session.startedAt, timeZone)}`,
    session.providerSessionRef,
  ]);
}

export function LinkSession({
  repo,
  candidates,
  timeZone,
  adding,
  onAdd,
}: {
  repo: string;
  candidates: readonly Candidate[];
  timeZone: string | undefined;
  /** An Add link is on its way. */
  adding: boolean;
  /** Links the session; true when it saved, and the form closes. */
  onAdd: (sessionId: number) => Promise<boolean>;
}) {
  const copy = EVIDENCE_COPY.linkSession;
  const ids = useId();
  const selectId = `${ids}-select`;
  const openerId = `${ids}-open`;
  const select = useRef<HTMLSelectElement>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  /** Set by Cancel and Close: the opener is drawn again after the form goes, and that is where focus belongs. */
  const returnToOpener = useRef(false);

  // What was chosen if it is still offered, else the first: the list changes under the form when a refresh finishes.
  const picked = candidates.find((candidate) => String(candidate.id) === choice) ?? candidates[0];

  useEffect(() => {
    if (open) select.current?.focus();
    else if (returnToOpener.current) {
      returnToOpener.current = false;
      document.getElementById(openerId)?.focus();
    }
  }, [open, openerId]);

  const close = () => {
    returnToOpener.current = true;
    setOpen(false);
  };

  if (!open) {
    // Nothing to offer, so nothing to open.
    if (candidates.length === 0) return null;
    return (
      <div>
        <Button
          id={openerId}
          label={copy.open}
          variant="secondary"
          size="sm"
          icon={<Icon name="plus" />}
          className="max-[719px]:min-h-11"
          onClick={() => setOpen(true)}
        />
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-copy text-ink-muted">{copy.noCandidates(repo)}</p>
        <div>
          <Button
            label={copy.close}
            variant="secondary"
            size="sm"
            className="max-[719px]:min-h-11"
            onClick={close}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex min-w-0 max-w-full flex-1 basis-72 flex-col gap-1">
          <label htmlFor={selectId} className="text-label font-semibold text-ink">
            {copy.label(repo)}
          </label>
          <select
            ref={select}
            id={selectId}
            className={SELECT}
            value={picked === undefined ? '' : String(picked.id)}
            onChange={(event) => setChoice(event.target.value)}
          >
            {candidates.map((candidate) => (
              <option key={candidate.id} value={String(candidate.id)}>
                {optionText(candidate, timeZone)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            label={copy.cancel}
            variant="secondary"
            size="sm"
            className="max-[719px]:min-h-11"
            onClick={close}
          />
          <Button
            label={EVIDENCE_COPY.actions.add}
            variant="primary"
            size="sm"
            isLoading={adding}
            className="max-[719px]:min-h-11"
            onClick={() => {
              if (picked === undefined) return;
              void onAdd(picked.id).then((saved) => {
                if (saved) setOpen(false);
              });
            }}
          />
        </div>
      </div>
      <p className="text-caption text-ink-muted">{copy.hint}</p>
    </div>
  );
}
