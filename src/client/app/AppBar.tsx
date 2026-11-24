import { BrandMark } from '../components/BrandMark';
import { AboutButton } from './AboutButton';
import { AppBarLinks } from './AppBarLinks';
import { RefreshButton } from './RefreshButton';
import { PRODUCT_NAME } from './routes';

/**
 * The 60px app bar on the canvas, no divider (design-system Layout). The dashboard shows Refresh and About.
 * During Setup the actions slot holds the step caption.
 */
export function AppBar({
  setup = false,
  actionsRef,
}: {
  setup?: boolean;
  /** Gives the actions slot to a screen that draws into it (Setup's step caption). */
  actionsRef?: (element: HTMLElement | null) => void;
}) {
  return (
    <header className="sticky top-0 z-30 col-span-full row-start-1 flex h-[var(--appbar-h)] items-center justify-between gap-4 bg-canvas pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] min-[720px]:pl-[max(1.5rem,env(safe-area-inset-left))] min-[720px]:pr-[max(1.5rem,env(safe-area-inset-right))]">
      <div className="flex min-w-0 items-center gap-2">
        <BrandMark className="flex-none" />
        <span className="min-w-0 truncate font-display text-[15px] font-bold text-ink min-[720px]:text-[17px]">
          {PRODUCT_NAME}
        </span>
        <span className="hidden whitespace-nowrap rounded-full bg-sunken px-2.5 py-0.5 text-caption text-ink-muted min-[1024px]:inline">
          This machine
        </span>
      </div>
      <div id="appbar-actions" className="flex shrink-0 items-center gap-2">
        {setup ? (
          <div ref={actionsRef} />
        ) : (
          <>
            <AppBarLinks />
            <RefreshButton />
          </>
        )}
        <AboutButton />
      </div>
    </header>
  );
}
