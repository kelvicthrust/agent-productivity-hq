import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/cx';

// A line of context above the card (ported from app.js `notice`): "warn" for something that limits what is shown, here a
// repo whose PRs are left out because GitHub no longer grants access. The words carry the meaning and the icon repeats it, so
// neither the tint nor the icon is the only signal.
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
