import type { ReactNode } from 'react';
import type { Scope } from '../../shared/contracts/common';
import { deliveryScopeLabel, usageScopeLabel } from '../../shared/domain/scope';
import { cx } from '../lib/cx';

/**
 * The line under a figure or card heading that says what the figure covers (ported from app.js scopeDelivery,
 * scopeUsage and the `.scope` rules). Give it the applied scope and which figures it describes:
 *
 *   <ScopeLine delivery={scope} />             "All repos · Authored by you"
 *   <ScopeLine usage={scope} />                "This machine · All repos · All providers"
 *   <ScopeLine delivery={scope} usage={scope} />   "PRs: … · Tokens: …"
 *
 * `children` adds more words after the scope, and `tag` adds a chip ("Not filtered by repo").
 */
export function ScopeLine({
  delivery,
  usage,
  tag,
  children,
  className,
}: {
  delivery?: Pick<Scope, 'repos' | 'author'>;
  usage?: Pick<Scope, 'repos' | 'provider'>;
  tag?: string;
  children?: ReactNode;
  className?: string;
}) {
  const deliveryText = delivery ? deliveryScopeLabel(delivery) : null;
  const usageText = usage ? usageScopeLabel(usage) : null;
  const text =
    deliveryText && usageText
      ? `PRs: ${deliveryText} · Tokens: ${usageText}`
      : (deliveryText ?? usageText);
  return (
    <p className={cx('mt-0.5 text-caption text-ink-muted', className)}>
      {text}
      {text && children ? ' · ' : null}
      {children}
      {tag && <span className="ml-1 inline-block rounded-full bg-sunken px-2">{tag}</span>}
    </p>
  );
}
