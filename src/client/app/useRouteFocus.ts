import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { PRODUCT_NAME, SETUP_PATH, pageNameFor } from './routes';

/**
 * On a route change, name the page in the document title and move focus to its h1, so keyboard and screen-reader users land where
 * the new content starts (TECH › Accessibility: focus on the h1 at every route change). The first render does not move focus.
 *
 * It is used once, above both layouts (RootLayout), so a change that swaps one layout for the other (Finish on Setup lands on
 * Overview) is a route change like any other: the hook outlives the swap and the new page's heading gets the focus. It finds the
 * heading in the `#main` landmark both layouts draw, instead of holding a reference a layout would take with it.
 */
export function useRouteFocus(): void {
  const { pathname } = useLocation();
  const seen = useRef<string | null>(null);

  useEffect(() => {
    document.title = `${pageNameFor(pathname)} · ${PRODUCT_NAME}`;
    // Compare with the last path handled, so React StrictMode's repeated effect cannot steal focus.
    // Setup is reached only by the app's own first-launch redirect (nothing the owner did) or by typing its address, so arriving there
    // does not take focus: a visible focus ring around a heading nobody asked about is not what a first launch should open on.
    if (seen.current !== null && seen.current !== pathname && pathname !== SETUP_PATH) {
      document.getElementById('main')?.querySelector<HTMLElement>('h1')?.focus();
    }
    seen.current = pathname;
  }, [pathname]);
}
