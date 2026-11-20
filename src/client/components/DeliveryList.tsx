import type { ReactNode } from 'react';
import { LinkBadge } from './LinkBadge';
import {
  LinkedSessions,
  MergedAt,
  PR_COPY,
  PrTitle,
  RowToggle,
  evidenceId,
  isLogin,
  personLabel,
  type DeliveryRowsProps,
} from './DeliveryTable';

// The Delivery PR table below 640px: a list of cards, drawn instead of the table (TECH T5-2; the same decision as the Usage
// tree). The prototype turned the table's own rows into cards by overriding `display`, which the design itself flags as
// possibly dropping table semantics for assistive technology. A list has no such caveat, and no hidden duplicate cells: a card
// states each value once, under its label.
//
//   card   the toggle and the title with `owner/name #number` under it, across the full width, then a `<dl>` of Merged,
//          Author, Merged by, Linked sessions and Link basis, each label with its value on one line
//
// A value that is long (a login, a linked-sessions summary) wraps inside its own column instead of pushing the card wider, so
// nothing leaves the window at 320px.

export function DeliveryList({
  items,
  timeZone,
  login,
  isOpen,
  onToggle,
  renderEvidence,
}: DeliveryRowsProps) {
  const columns = PR_COPY.columns;
  return (
    <ul aria-label={PR_COPY.caption} className="flex flex-col">
      {items.map((pr) => {
        const open = isOpen(pr.id);
        return (
          <li
            key={pr.id}
            data-pr-id={pr.id}
            className="border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
          >
            <div className="flex items-start gap-1.5">
              <RowToggle
                open={open}
                label={(open ? PR_COPY.hideEvidence : PR_COPY.showEvidence)(pr.title)}
                controls={open ? evidenceId(pr) : undefined}
                onToggle={() => onToggle(pr.id)}
              />
              <PrTitle pr={pr} />
            </div>
            <dl className="m-0 mt-2 flex flex-col gap-1 pl-[30px]">
              <Pair label={columns.merged}>
                <MergedAt pr={pr} timeZone={timeZone} />
              </Pair>
              <Pair label={columns.author}>{personLabel(pr.author, pr.authoredByMe)}</Pair>
              <Pair label={columns.mergedBy}>
                {personLabel(pr.mergedBy, isLogin(pr.mergedBy, login))}
              </Pair>
              <Pair label={columns.linked}>
                <LinkedSessions pr={pr} />
              </Pair>
              <Pair label={columns.basis}>
                <LinkBadge kind={pr.linkClass} />
              </Pair>
            </dl>
            {open && (
              <div id={evidenceId(pr)} className="mt-2 rounded-sm bg-canvas p-3">
                {renderEvidence(pr)}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One label and its value on a line; the label keeps its width, the value takes the rest and wraps inside itself. */
function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-data">
      <dt className="shrink-0 text-caption text-ink-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-right [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
