import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/cx';

// The pieces every Setup step draws: the card, a row's grid (the same three columns as the Sources rows, so the two screens line up),
// the press target of a button on a phone, a notice and a refusal said where it happened.

/** A step's card. Its heading takes the focus when the owner moves between steps, so the new content is what is read next. */
export function StepCard({
  id,
  title,
  scope,
  children,
}: {
  id: string;
  title: string;
  scope: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="min-w-0">
        <h2 id={id} tabIndex={-1} className="font-display text-title-section text-ink">
          {title}
        </h2>
        <p className="mt-0.5 text-caption text-ink-muted">{scope}</p>
      </div>
      {children}
    </section>
  );
}

/** One source, account or repo: name and status, details, actions. The three columns stack on a phone. */
export const ROW =
  'grid grid-cols-[minmax(160px,220px)_minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0 max-[719px]:grid-cols-1';

/** A press target of 44px on a phone, and a busy button that keeps the focus (aria-disabled, not `disabled`). */
export const BUTTON = 'max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70';

export const ACTIONS = 'flex flex-wrap justify-end gap-2 max-[719px]:justify-start';

export function Notice({ tone, children }: { tone: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={cx(
        'flex items-start gap-2 rounded-sm px-3 py-2 text-caption text-ink',
        tone === 'warn' ? 'bg-warning-surface' : 'bg-sunken',
      )}
    >
      <Icon
        name={tone === 'warn' ? 'alert' : 'info'}
        className={cx('mt-px', tone === 'warn' ? 'text-warning' : 'text-ink-muted')}
      />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function Alert({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cx('flex items-start gap-1.5 text-caption text-danger', className)}>
      <Icon name="error" className="mt-px" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
