import { useMediaQuery } from '../../lib/useMediaQuery';

/** Below this width the PRs are a list of cards; from it, a table. TECH T5-2, design-to-code "Delivery PR table". */
export const PHONE_QUERY = '(max-width: 639px)';

/**
 * Whether the window is phone-sized right now: the one media query read that chooses between `DeliveryTable` and
 * `DeliveryList`. CSS never picks the renderer and never changes a table's `display`. Where `matchMedia` does not exist
 * (jsdom) it reads false, so the table renders. (The Usage screen has the same hook; a feature may not import another.)
 */
export const useIsPhone = (): boolean => useMediaQuery(PHONE_QUERY);
