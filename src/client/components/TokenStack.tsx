import type { Provider } from '../../shared/contracts/common';
import { PROVIDER_NAMES } from '../lib/copy';
import { cx } from '../lib/cx';
import { compact } from '../lib/format';
import { Buddy } from './Buddy';

/** Codex first, then Claude Code, on every row. */
const PROVIDER_ORDER: readonly Provider[] = ['codex', 'claude'];

export type TokenTotals = Partial<Record<Provider, number | null | undefined>>;

/**
 * Repository token totals (D7): one provider per line, buddy then value, always a column, right-aligned with tabular
 * figures, laid out the same on every row. A provider with no tokens shows `0`; one that was not covered (null) shows
 * "—". The two are never added: `providers` limits the lines to the providers in scope.
 *
 * The buddy is decorative, so each line also carries the provider's name for assistive technology.
 */
export function TokenStack({
  totals,
  providers = PROVIDER_ORDER,
  className,
}: {
  totals: TokenTotals;
  providers?: readonly Provider[];
  className?: string;
}) {
  const shown = PROVIDER_ORDER.filter((provider) => providers.includes(provider));
  return (
    <span className={cx('flex flex-col items-end gap-0.5 tabular-nums', className)}>
      {shown.map((provider) => (
        <span
          key={provider}
          className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap"
        >
          <Buddy kind={provider} size={15} />
          <span className="sr-only">{PROVIDER_NAMES[provider]}: </span>
          {compact(totals[provider])}
        </span>
      ))}
    </span>
  );
}
