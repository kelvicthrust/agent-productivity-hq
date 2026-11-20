import { Button } from '@astryxdesign/core/Button';
import { Buddy } from '../../../components/Buddy';
import { LinkBadge } from '../../../components/LinkBadge';
import { SessionIdentity } from '../../../components/SessionIdentity';
import { cx } from '../../../lib/cx';
import { compact } from '../../../lib/format';
import type { EvidenceItem, LinkAction } from '../../../lib/links';
import { WRAPPING_LABEL } from '../../../lib/wrapLabel';
import { EVIDENCE_COPY } from './copy';

// One link of an opened PR (ported from app.js `evItem`): the badge that names its class, the session, what it was based on, and
// the actions the SERVER allows on it. The client never works out an action from the class: `item.actions` is the list, so the
// transition table (TECH › Owner link decision transitions) lives in one place.
//
//   evidence   Mark incorrect                (ghost)
//   suggested  Dismiss, Confirm link         (secondary, then primary on the right)
//   owner      Remove link                   (secondary)
//   marked incorrect: the badge is struck through and the claim the source made stays in the Basis line; Restore (secondary)

type ItemAction = Exclude<LinkAction, 'add'>;

/** Left to right: the primary action is last, on the right (design-system › Primary actions). */
const ORDER: readonly ItemAction[] = ['reject', 'restore', 'remove', 'dismiss', 'confirm'];

const VARIANT: Record<ItemAction, 'primary' | 'secondary' | 'ghost'> = {
  confirm: 'primary',
  dismiss: 'secondary',
  reject: 'ghost',
  restore: 'secondary',
  remove: 'secondary',
};

export function EvidenceItemRow({
  item,
  timeZone,
  pending,
  onAct,
}: {
  item: EvidenceItem;
  timeZone: string | undefined;
  /** The action on its way for this item, or null. */
  pending: LinkAction | null;
  onAct: (action: ItemAction) => void;
}) {
  const { session } = item;
  const actions = ORDER.filter((action) => item.actions.includes(action));
  return (
    <li
      data-evidence-session={session.id}
      className={cx(
        'grid min-w-0 gap-x-3 gap-y-2 rounded-md border bg-surface p-3 min-[720px]:grid-cols-[auto_minmax(0,1fr)_auto]',
        item.effectiveClass === 'suggested'
          ? 'border-dashed border-control-border'
          : 'border-border',
      )}
    >
      <div className="flex min-w-0 items-start gap-2 min-[720px]:col-start-2 min-[720px]:row-start-1">
        <Buddy kind={session.provider} size={18} className="mt-px align-baseline" />
        <SessionIdentity
          session={session}
          timeZone={timeZone}
          className="[overflow-wrap:anywhere]"
        />
      </div>
      <p className="text-caption text-ink-muted min-[720px]:col-span-2 min-[720px]:row-start-2">
        {EVIDENCE_COPY.tokens(compact(session.tokens))}
      </p>
      <LinkBadge
        kind={item.effectiveClass}
        className="h-auto min-h-[22px] max-w-full self-start justify-self-start whitespace-normal [overflow-wrap:anywhere] min-[720px]:col-start-1 min-[720px]:row-start-1"
      />
      <p className="text-caption text-ink-muted [overflow-wrap:anywhere] min-[720px]:col-span-2 min-[720px]:row-start-3 min-[720px]:-mt-1">
        <span className="font-semibold">{EVIDENCE_COPY.basis}</span> {item.basisText}
      </p>
      {actions.length > 0 && (
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap justify-end gap-2 min-[720px]:col-start-3 min-[720px]:row-span-3 min-[720px]:row-start-1 min-[720px]:self-center">
          {actions.map((action) => (
            <Button
              key={action}
              // The name starts with the visible words and adds which session, so the same button on two items differs.
              label={`${EVIDENCE_COPY.actions[action]}: ${session.nameLead} (${session.providerSessionRef})`}
              variant={VARIANT[action]}
              size="sm"
              isLoading={pending === action}
              className={WRAPPING_LABEL}
              onClick={() => onAct(action)}
            >
              {EVIDENCE_COPY.actions[action]}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}
