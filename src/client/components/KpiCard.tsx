import { useId, type ReactNode } from 'react';
import { cx } from '../lib/cx';

// The Overview's summary tile (ported from app.css .kpi and app.js `kpis`): a label, the scope line that says what the figure
// covers, then the figure and a line of meta. Each tile is its own CSS container, so what is inside it (the provider ledger)
// decides its layout from the tile's width and not from the window's (D4: the tokens tile was fine at 241px and broke at 139px).
//
// `tone="delivery"` is the Merged PRs tile: a berry-tinted surface (the `delivery-surface` token), which replaced the 3px left
// rule the craft floor bans. The tile is a labelled group, not a landmark: five of them would only crowd the region list.
//
// The pieces inside (`KpiValue`, `KpiUnavailable`) are small on purpose: a screen composes them, and a figure that
// cannot be given says why in words (`KpiUnavailable`) rather than printing a 0 nobody measured.

export type KpiTone = 'plain' | 'delivery';

const TONE: Record<KpiTone, string> = {
  plain: 'border-border bg-surface',
  delivery: 'border-heat-1 bg-delivery-surface',
};

export function KpiCard({
  label,
  scope,
  tone = 'plain',
  meta,
  children,
  className,
}: {
  label: string;
  /** What the figure covers: "All repos · Authored by you". */
  scope?: string;
  tone?: KpiTone;
  /** The line under the figure. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cx(
        '@container flex min-w-0 flex-col gap-1 rounded-md border px-4 pt-3 pb-4 shadow-card',
        TONE[tone],
        className,
      )}
    >
      <div id={labelId} className="flex items-center gap-1.5 text-label font-semibold text-ink">
        {label}
      </div>
      {scope && <p className="text-caption text-pretty text-ink-muted">{scope}</p>}
      {children}
      {/* The meta sits at the bottom, so the lines under tiles of one row line up whatever each tile holds above them. */}
      {meta && <div className="mt-auto pt-0.5 text-caption text-ink-muted">{meta}</div>}
    </div>
  );
}

/** The figure, in the display stack. `unit` is the small word after it ("of 7"). */
export function KpiValue({ children, unit }: { children: ReactNode; unit?: ReactNode }) {
  return (
    <p className="font-display text-metric text-ink">
      {children}
      {unit && (
        // The space is text, in the unit's own size, so the figure and its unit read "5 of 8" and are not only set apart by margin.
        <small className="font-sans text-label tracking-normal text-ink-muted"> {unit}</small>
      )}
    </p>
  );
}

/** The words that stand where a figure would be when there is none to give ("No tracked repos", "No local records"). */
export function KpiUnavailable({ children }: { children: ReactNode }) {
  return <p className="py-1.5 text-label text-ink-muted">{children}</p>;
}

/**
 * The tile while the summary loads: three quiet bars where the label, the figure and the meta go. It breathes (opacity) instead
 * of shimmering, and holds still for a reader who asked for less motion. The text that names the state is the page's, once.
 */
export function KpiSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        'flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface px-4 pt-3 pb-4 shadow-card',
        className,
      )}
    >
      <div className="h-3 w-3/5 rounded-sm bg-sunken motion-safe:animate-pulse" />
      <div className="mt-1 h-[30px] w-2/5 rounded-sm bg-sunken motion-safe:animate-pulse" />
      <div className="mt-1 h-3 w-4/5 rounded-sm bg-sunken motion-safe:animate-pulse" />
    </div>
  );
}
