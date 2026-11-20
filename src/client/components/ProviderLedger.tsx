import type { ReactNode } from 'react';
import type { Provider } from '../../shared/contracts/common';
import { PROVIDER_NAMES } from '../lib/copy';
import { compact } from '../lib/format';
import { Buddy } from './Buddy';

// The provider ledger inside the "Recorded local tokens" tile (D4, ported from app.css .kpi-split). One line per provider with
// its own figure, which is never added to the other's (PRODUCT: providers are not combined).
//
// The safe layout is the default: one provider per row, name on the left and the figure on the right. When the tile is at
// least 200px wide (its inner width, measured by the container query on the tile: KpiCard is `@container`) the two providers sit
// side by side. Two `nowrap` provider labels need about 190px, so a narrower tile must stack them. Used outside a container
// the ledger simply stays stacked.
//
// A provider with no figure says why in words (`unavailable`), and a note may qualify a figure that is real ("From Mar 14,
// 2026 only"). A real figure may carry its own provider's 12-week trend under it (`trend`), on that provider's own scale. The caller
// builds the words and the trend; this component only lays them out.

export interface ProviderLedgerEntry {
  provider: Provider;
  /** The figure, or null when there is none to give. 0 means covered with no activity. */
  value: number | null;
  /** Stands where the figure would be when `value` is null: "No local records", "History unavailable". */
  unavailable?: string;
  /** Under a real figure: "From Mar 14, 2026 only", "Cached; recent days missing". */
  note?: string;
  /** The provider's own 12-week trend, drawn under its figure. Never a sum with the other provider's. */
  trend?: ReactNode;
}

export function ProviderLedger({ entries }: { entries: readonly ProviderLedgerEntry[] }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-2 @[200px]:grid-cols-2 @[200px]:gap-3">
      {entries.map(({ provider, value, unavailable, note, trend }) => (
        <div
          key={provider}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 @[200px]:block"
        >
          <dt className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
            <Buddy kind={provider} size={15} />
            {PROVIDER_NAMES[provider]}
          </dt>
          <dd className="m-0 text-right @[200px]:text-left">
            {value === null ? (
              <span className="text-label text-ink-muted @[200px]:block @[200px]:py-1.5">
                {unavailable}
              </span>
            ) : (
              <span className="block font-display text-[24px] leading-[30px] font-bold tracking-[-0.015em] text-ink">
                {compact(value)}
              </span>
            )}
            {trend && value !== null && (
              <span className="mt-1 flex justify-end @[200px]:justify-start">{trend}</span>
            )}
          </dd>
          {note && value !== null && (
            <dd className="m-0 col-span-full text-caption text-ink-muted">{note}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}
