import type { ReactNode } from 'react';
import { Icon } from '../../../components/Icon';

// The pieces both account rows use: the row's grid (the same three columns as "On this machine": name and status, details,
// actions), the button's phone and busy classes, and a refusal said where it happened.

/** One account: name and status, details, actions. The three columns stack on a phone. */
export const ROW =
  'grid grid-cols-[minmax(160px,220px)_minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0 max-[719px]:grid-cols-1';

/** A press target of 44px on a phone, and a busy button that keeps the focus (aria-disabled, not `disabled`). */
export const BUTTON = 'max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70';

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="col-span-full flex items-start gap-1.5 text-caption text-danger">
      <Icon name="error" className="mt-px" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
