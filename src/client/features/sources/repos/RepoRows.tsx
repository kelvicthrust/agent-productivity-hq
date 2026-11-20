import { Button } from '@astryxdesign/core/Button';
import { useEffect, useEffectEvent, useRef } from 'react';
import type { Repo } from '../../../../shared/contracts/repos';
import { Icon } from '../../../components/Icon';
import { StatusTag, type StatusKind } from '../../../components/StatusTag';
import { SOURCES_COPY, STATUS_TEXT } from '../../../lib/copy';
import { formatWhen } from '../../../lib/format';
import { REPO_COPY } from './copy';
import type { Problem } from '../../../lib/repos';
import { ProblemLine } from './ProblemLine';

// The rows of Tracked repositories: a tracked repo (its state, what was collected, Check again, Stop tracking and the inline
// confirm) and a Previously tracked one (what is retained and Track again). The grid is the one the "On this machine" rows use,
// so the two sections line up.

const ROW =
  'grid grid-cols-[minmax(160px,220px)_minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0 max-[719px]:grid-cols-1';
const ACTIONS = 'flex flex-wrap justify-end gap-2 max-[719px]:justify-start';
const BUTTON = 'max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70';

function Name({ id, kind, children }: { id: string; kind: StatusKind; children: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* A repo name has no spaces to break at: on a narrow window it wraps anywhere instead of widening the page. */}
      <b className="text-copy font-bold text-ink [overflow-wrap:anywhere]">{id}</b>
      {/* Polite: "Checking…" turning into the answer is announced where it happens. */}
      <span aria-live="polite">
        <StatusTag kind={kind}>{children}</StatusTag>
      </span>
    </div>
  );
}

// ---- a tracked repo ----

function tagFor(repo: Repo, checking: boolean): { kind: StatusKind; text: string } {
  if (checking) return { kind: 'checking', text: REPO_COPY.rechecking };
  switch (repo.accessState) {
    case 'ok':
      return { kind: 'ok', text: STATUS_TEXT.collecting };
    case 'inaccessible':
      return { kind: 'inaccessible', text: STATUS_TEXT.inaccessible };
    case 'unknown':
      return { kind: 'none', text: REPO_COPY.accessUnknown };
  }
}

/** The inline confirm: a group, not a modal. Cancel is on the left and Stop tracking, the danger action, on the right. */
function ConfirmStop({
  id,
  busy,
  onCancel,
  onStop,
}: {
  id: string;
  busy: boolean;
  onCancel: () => void;
  onStop: () => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // Reads the latest onCancel without re-attaching the key listener on every render.
  const cancelFromKey = useEffectEvent(onCancel);

  // Focus starts on Cancel, the safe answer, so Enter never confirms by accident. Esc inside the panel cancels it.
  useEffect(() => {
    cancel.current?.focus();
    const element = group.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      cancelFromKey();
    };
    element?.addEventListener('keydown', onKey);
    return () => element?.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      ref={group}
      role="group"
      aria-label={SOURCES_COPY.repos.confirmGroup(id)}
      className="col-span-full flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md bg-danger-surface p-4"
    >
      <p className="min-w-0 flex-[1_1_280px] text-caption text-ink">
        <b className="font-bold">{SOURCES_COPY.repos.confirmHeading(id)}</b>{' '}
        {SOURCES_COPY.repos.confirmBody}
      </p>
      <div className="ml-auto flex flex-wrap justify-end gap-2">
        <Button
          ref={cancel}
          label={SOURCES_COPY.repos.cancel}
          size="sm"
          variant="secondary"
          className={BUTTON}
          onClick={() => {
            if (!busy) onCancel();
          }}
        />
        <Button
          label={busy ? REPO_COPY.stopping : SOURCES_COPY.repos.stopTracking}
          size="sm"
          variant="destructive"
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
          // The design's danger button is solid (design-system/DESIGN.md "danger (confirmations)"); Astryx's destructive variant is
          // a pale tint, which would nearly vanish on this panel's own pale-red surface.
          className={`${BUTTON} bg-danger text-on-action shadow-press hover:bg-danger-hover`}
          onClick={() => {
            if (!busy) onStop();
          }}
        />
      </div>
    </div>
  );
}

export function RepoRow({
  repo,
  confirming,
  checking,
  stopping,
  onCheck,
  onAskStop,
  onCancelStop,
  onStop,
}: {
  repo: Repo;
  confirming: boolean;
  checking: boolean;
  stopping: boolean;
  onCheck: () => void;
  onAskStop: () => void;
  onCancelStop: () => void;
  onStop: () => void;
}) {
  const stopButton = useRef<HTMLButtonElement>(null);
  const tag = tagFor(repo, checking);
  const copy = SOURCES_COPY.repos;
  const merged = repo.mergedPrsLast12Months ?? 0;

  return (
    <li className={ROW}>
      <Name id={repo.displayName} kind={tag.kind}>
        {tag.text}
      </Name>
      <div className="flex min-w-0 flex-col gap-1 text-caption text-ink-muted">
        {repo.accessState === 'inaccessible' ? (
          <span className="text-danger">
            {repo.accessError ?? copy.error.noAccess(repo.displayName)}
          </span>
        ) : repo.accessState === 'ok' ? (
          <span>
            {repo.backfillComplete === false
              ? REPO_COPY.importing(merged)
              : copy.collectedPrs(merged)}
          </span>
        ) : null}
      </div>
      <div className={ACTIONS}>
        {repo.accessState !== 'ok' && (
          <Button
            label={copy.recheck}
            aria-label={`${copy.recheck}: ${repo.displayName}`}
            icon={<Icon name="refresh" />}
            size="sm"
            variant="secondary"
            aria-busy={checking || undefined}
            aria-disabled={checking || undefined}
            className={BUTTON}
            onClick={() => {
              if (!checking) onCheck();
            }}
          />
        )}
        <Button
          ref={stopButton}
          label={copy.stopTracking}
          aria-label={`${copy.stopTracking} ${repo.displayName}`}
          aria-expanded={confirming}
          size="sm"
          variant="ghost"
          className={`${BUTTON} text-action`}
          onClick={onAskStop}
        />
      </div>
      {confirming && (
        <ConfirmStop
          id={repo.displayName}
          busy={stopping}
          onCancel={() => {
            onCancelStop();
            stopButton.current?.focus();
          }}
          onStop={onStop}
        />
      )}
    </li>
  );
}

// ---- a repo that was tracked ----

export function StoppedRow({
  repo,
  today,
  timeZone,
  tracking,
  problem,
  onTrackAgain,
}: {
  repo: Repo;
  today: string;
  timeZone: string;
  tracking: boolean;
  problem: Problem | null;
  onTrackAgain: () => void;
}) {
  const copy = SOURCES_COPY.repos;
  const stopped = repo.stoppedAt ? formatWhen(repo.stoppedAt, { timeZone, today }) : null;
  const retained = repo.mergedPrsLast12Months ?? 0;
  return (
    <li className={ROW}>
      <Name id={repo.displayName} kind="none">
        {STATUS_TEXT.notTracked}
      </Name>
      <div className="flex min-w-0 flex-col gap-1.5 text-caption text-ink-muted">
        <span>{stopped ? copy.retained(retained, stopped) : copy.collectedPrs(retained)}</span>
        {problem && <ProblemLine id={`stopped-${repo.id}-problem`} problem={problem} />}
      </div>
      <div className={ACTIONS}>
        <Button
          label={tracking ? REPO_COPY.tracking : copy.trackAgain}
          aria-label={`${copy.trackAgain} ${repo.displayName}`}
          size="sm"
          variant="secondary"
          aria-busy={tracking || undefined}
          aria-disabled={tracking || undefined}
          className={BUTTON}
          onClick={() => {
            if (!tracking) onTrackAgain();
          }}
        />
      </div>
    </li>
  );
}
