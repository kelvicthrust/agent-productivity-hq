import { Drawer } from '@astryxdesign/core/Drawer';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useBootstrap } from '../../lib/bootstrap';
import { useFilters } from '../../lib/filters';
import { useRecordsDrawer, type BucketRef } from '../../lib/recordsDrawer';
import { RecordsPanel } from './RecordsPanel';

// The records drawer (TECH journey J2, design-to-code › Component map "Records drawer"): the Astryx Drawer, opened by a chart
// bucket (Overview, Trends) or a day of the year grid, listing the PRs and sessions inside that bucket. The shell mounts it
// once, inside RecordsDrawerProvider; the state it reads (`useRecordsDrawer`) is the one the charts write.
//
// Focus. Astryx moves focus to `[data-autofocus]` when the drawer opens (the heading, in RecordsPanel). Closing is two steps,
// because a modal <dialog> makes the page behind it inert until the dialog is closed, and the dialog closes only after its
// slide-out has finished: focus handed back while the drawer is still sliding away would land on an inert element and do
// nothing. So a close request (Escape, the scrim, Close, or a link inside) first lets the drawer slide out, and the shared state
// closes when the browser says the dialog has closed. That is when the opener's own `returnFocus` (the chart's "focus
// bucket i") runs, on a page that can take it. The same wait lets "Open in Delivery" change the page after the drawer has gone,
// so the route's own focus move (to the new page's heading) is not lost to the inert page either.
//
// Motion is the design's (design-system/DESIGN.md › Motion, animate snapshot c8a79627): 320ms on `--ease-drawer` for the panel
// and the scrim. Astryx draws its own durations and curve; the utilities below, one layer above Astryx's, replace them with
// the product tokens. Reduced motion collapses to an instant change (Astryx and the global rule).

/**
 * The panel as designed: inset 8px from the viewport with large corners and the overlay shadow (Astryx's own is flush and
 * square, with a hairline on the inner edge), the product's motion tokens on the slide and the scrim, and below 640px nearly the
 * whole width (8px each side) where Astryx would keep a 56px reveal.
 */
const PANEL =
  'top-2 right-2 bottom-2 left-auto h-auto rounded-lg border-0 shadow-overlay duration-(--dur-drawer) ease-crew-drawer backdrop:bg-(--scrim) backdrop:duration-(--dur-drawer) backdrop:ease-crew-out max-[639px]:w-[calc(100dvw-1rem)]';

export function RecordsDrawer() {
  const drawer = useRecordsDrawer();
  const { filters, ctx } = useFilters();
  const bootstrap = useBootstrap();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);

  // What the panel draws. It follows the open bucket, and keeps the last one until the dialog has closed, so a drawer that
  // is sliding out because the page changed does not slide out empty.
  const [shown, setShown] = useState<BucketRef | null>(null);
  if (drawer.bucket !== null && drawer.bucket !== shown) setShown(drawer.bucket);

  // A close requested but not yet finished: the drawer is sliding out and `after` waits for it (a page change, or nothing).
  const [leaving, setLeaving] = useState(false);
  const after = useRef<(() => void) | null>(null);
  // A different bucket, or none, starts fresh.
  const [seen, setSeen] = useState(drawer.bucket);
  if (seen !== drawer.bucket) {
    setSeen(drawer.bucket);
    setLeaving(false);
  }

  const requestClose = useCallback((then?: () => void) => {
    after.current = then ?? null;
    setLeaving(true);
  }, []);

  // The browser's own `close` event fires after the dialog has left the top layer, whatever closed it.
  const onHostClosed = useEffectEvent(() => {
    const then = after.current;
    after.current = null;
    if (leaving) {
      // `restoreFocus: false` when a page change follows: the page itself decides where focus goes then.
      drawer.close({ restoreFocus: then === null });
      then?.();
      setShown(null);
    } else if (drawer.bucket === null) {
      // Closed because the page changed: the shared state had already let go.
      setShown(null);
    }
  });
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onClosed = () => onHostClosed();
    element.addEventListener('close', onClosed);
    return () => element.removeEventListener('close', onClosed);
  }, []);

  const open = drawer.isOpen && !leaving;

  return (
    <Drawer
      ref={dialog}
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      label={shown?.label ?? ''}
      width={520}
      padding={0}
      className={PANEL}
    >
      {shown && filters && ctx && (
        <RecordsPanel
          bucket={shown}
          filters={filters}
          ctx={ctx}
          timeZone={bootstrap.data?.timezone ?? 'UTC'}
          onClose={() => requestClose()}
          onNavigate={(href) => requestClose(() => void navigate(href))}
        />
      )}
    </Drawer>
  );
}
