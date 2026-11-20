import { useCallback, useSyncExternalStore } from 'react';

// Whether a CSS media query matches right now, read synchronously so the first paint already has the right layout
// (there is no server render to mismatch). Where `matchMedia` does not exist (jsdom) nothing matches.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    [query],
  );
  const snapshot = useCallback(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, snapshot);
}
