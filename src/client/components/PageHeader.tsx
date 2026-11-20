import type { ReactNode } from 'react';
import { useFilterSlot } from '../lib/filterSlot';

export interface PageHeaderProps {
  /** Drawn in the screen's h1. */
  title: ReactNode;
  /** One line under the title. */
  subtitle?: ReactNode;
  /** Right-aligned on the title row. */
  actions?: ReactNode;
}

/**
 * The top of a screen: title, subtitle, then the screen's filter bar if the shell provided one. The bar is a sibling of the
 * `<header>`, not inside it, so its sticky position lasts for the whole page and not only for the header's own height.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  const filterBar = useFilterSlot();
  return (
    <>
      <header className="min-w-0 pt-2">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          {/* Route focus lands on this h1 (useRouteFocus). */}
          <h1
            id="page-title"
            tabIndex={-1}
            className="min-w-0 font-display text-title-page text-ink"
          >
            {title}
          </h1>
          {actions}
        </div>
        {subtitle !== undefined && subtitle !== null && subtitle !== false && (
          <p className="mt-1 text-copy text-ink-muted">{subtitle}</p>
        )}
      </header>
      {filterBar}
    </>
  );
}
