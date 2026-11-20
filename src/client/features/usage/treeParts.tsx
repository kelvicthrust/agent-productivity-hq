import { Button } from '@astryxdesign/core/Button';
import type { RefObject } from 'react';
import { Buddy } from '../../components/Buddy';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/cx';
import { USAGE_COPY } from './copy';
import type { GroupSessions } from './queries';
import type { GroupView, SessionNode } from './treeModel';

// The small parts the table and the phone list both draw, so a row reads the same in either.

const TREE = USAGE_COPY.tree;

/**
 * The chevron that opens and closes a row. 24px as designed on a desktop; on a phone a pseudo-element grows the hit area to
 * 44px without moving anything (design-to-code "Touch targets"). Its name says what it does and which row it belongs to.
 * The chevron turns a quarter turn as it opens (200ms, ease-out): it shows the row changing state and stops under
 * reduced motion.
 */
export function RowToggle({
  open,
  label,
  onToggle,
  buttonRef,
}: {
  open: boolean;
  label: string;
  onToggle: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={open}
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

/** Keeps a row without a toggle in line with the rows that have one. */
export function ToggleSpacer() {
  return <span aria-hidden="true" className="inline-block size-6 shrink-0" />;
}

/** The provider's buddy for a session; a session whose relationship is unknown gets the dashed one. Decorative. */
export function SessionBuddy({ node }: { node: SessionNode }) {
  const { session, level } = node;
  return (
    <Buddy
      kind={session.kind === 'unknown' ? 'unknown' : session.provider}
      size={level === 2 ? 18 : 13}
      className="mt-0.5"
    />
  );
}

/** A group's name and what is in it. The name is bold, as the design has it. */
export function GroupLabel({ view }: { view: GroupView }) {
  return (
    <span className="flex min-w-0 flex-col gap-px">
      <span className="text-label font-bold text-ink [overflow-wrap:anywhere]">{view.label}</span>
      <span className="text-caption text-ink-muted">{view.summary}</span>
    </span>
  );
}

/** What the group's name stands for, repeated by its toggle: "Expand kelvin/atlas-api". */
export function groupToggleLabel(view: GroupView): string {
  return view.open ? TREE.collapse(view.label) : TREE.expand(view.label);
}

/** "Show 15 more roots" and how many are left. Pressing it reads the next page; focus is kept on the group when the last one lands. */
export function ShowMore({
  remaining,
  sessions,
  groupToggle,
  className,
}: {
  remaining: number;
  sessions: GroupSessions;
  /** Where focus goes if this button goes away because the last page arrived. */
  groupToggle: RefObject<HTMLButtonElement | null>;
  className?: string;
}) {
  const next = Math.min(remaining, 15);
  return (
    <span className={cx('flex flex-wrap items-center gap-x-2', className)}>
      <Button
        label={TREE.showMore(next)}
        size="sm"
        variant="ghost"
        aria-disabled={sessions.isFetchingMore || undefined}
        className="max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70"
        onClick={() => {
          if (sessions.isFetchingMore) return;
          void sessions.loadMore().then((more) => {
            if (!more) groupToggle.current?.focus();
          });
        }}
      />
      <span className="text-caption text-ink-muted">{TREE.notShown(remaining)}</span>
    </span>
  );
}

/** What a group says while its sessions are on their way, or when they could not be read. */
export function GroupStatus({ sessions }: { sessions: GroupSessions }) {
  if (sessions.status === 'error') {
    return (
      <span role="alert" className="flex flex-wrap items-center gap-x-2 text-caption text-danger">
        {TREE.sessionsFailed}
        <Button
          label={USAGE_COPY.retry}
          size="sm"
          variant="ghost"
          className="max-[719px]:min-h-11"
          onClick={sessions.retry}
        />
      </span>
    );
  }
  return (
    <span role="status" className="text-caption text-ink-muted">
      {TREE.loadingSessions}
    </span>
  );
}
