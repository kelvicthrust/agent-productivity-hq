import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';
import type { SeriesBucket } from './analytics';
import { applyChange, clampRange, searchFor, type FilterContext, type Filters } from './filters';

// The records drawer's shared state (TECH journey J2): a click or Enter on a chart bucket opens the drawer, which lists the PRs
// and sessions inside that bucket. Overview and Trends OPEN it; the drawer feature (features/records-drawer) SHOWS it. Features
// may not import one another, so the state they share lives here in lib, and the shell (src/client/app) is the one place that
// mounts both: ShellLayout wraps the page in `RecordsDrawerProvider` and renders `<RecordsDrawer />` inside it.
//
// The state is transient (TECH: "transient state"): it is never written to the URL and it is dropped when the page changes.

export type ChartId = 'overview' | 'trends';

/** The bucket a drawer is about: its dates and label from the series, and which chart and position it came from. */
export interface BucketRef {
  chart: ChartId;
  /** Position in the series, so a chart can put focus back on the bucket that opened the drawer. */
  index: number;
  start: string;
  end: string;
  label: string;
}

export function bucketRef(chart: ChartId, bucket: SeriesBucket, index: number): BucketRef {
  return { chart, index, start: bucket.start, end: bucket.end, label: bucket.label };
}

export interface RecordsDrawerApi {
  bucket: BucketRef | null;
  isOpen: boolean;
  /**
   * Opens the drawer on `bucket`. When it closes, focus goes back to the element that was focused now (the chart bucket the
   * keyboard or pointer used), unless the caller gives `returnFocus`, which runs instead (a chart that re-draws its buckets
   * can focus the right one again).
   */
  open: (bucket: BucketRef, options?: { returnFocus?: () => void }) => void;
  /** Closes the drawer and hands focus back, unless `restoreFocus` is false (the page is about to change). */
  close: (options?: { restoreFocus?: boolean }) => void;
}

const RecordsDrawerContext = createContext<RecordsDrawerApi | null>(null);

export function RecordsDrawerProvider({ children }: { children: ReactNode }) {
  const [bucket, setBucket] = useState<BucketRef | null>(null);

  // A different page is a different set of buckets, so the drawer closes (and takes no focus: the page is already moving).
  // Changing only the filters of the same page does not close it: while it is open it is modal, and Trends writes its selected
  // bucket to the URL as it opens. React's own pattern for state that follows a prop: compare during render, no effect.
  const { pathname } = useLocation();
  const [seenPathname, setSeenPathname] = useState(pathname);
  if (seenPathname !== pathname) {
    setSeenPathname(pathname);
    setBucket(null);
  }
  const returnFocus = useRef<(() => void) | null>(null);
  const restoreOnClose = useRef(false);

  const open = useCallback<RecordsDrawerApi['open']>((next, options) => {
    // Opening on another bucket while the drawer is already open keeps the first opener: the active element is now inside the
    // drawer, which is gone by the time focus is handed back.
    if (returnFocus.current === null || options?.returnFocus) {
      const opener = typeof document === 'undefined' ? null : document.activeElement;
      returnFocus.current =
        options?.returnFocus ??
        (() => {
          if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
        });
    }
    restoreOnClose.current = false;
    setBucket(next);
  }, []);

  const close = useCallback<RecordsDrawerApi['close']>((options) => {
    restoreOnClose.current = options?.restoreFocus ?? true;
    setBucket(null);
  }, []);

  // Focus goes back after the drawer has left the page, not while it is still trapping focus.
  useEffect(() => {
    if (bucket !== null) return;
    const restore = restoreOnClose.current ? returnFocus.current : null;
    restoreOnClose.current = false;
    returnFocus.current = null;
    restore?.();
  }, [bucket]);

  const api = useMemo<RecordsDrawerApi>(
    () => ({ bucket, isOpen: bucket !== null, open, close }),
    [bucket, open, close],
  );
  return <RecordsDrawerContext.Provider value={api}>{children}</RecordsDrawerContext.Provider>;
}

export function useRecordsDrawer(): RecordsDrawerApi {
  const api = useContext(RecordsDrawerContext);
  if (api === null) {
    throw new Error(
      'useRecordsDrawer must be used inside RecordsDrawerProvider (ShellLayout mounts it).',
    );
  }
  return api;
}

export type DrillTarget = 'delivery' | 'usage';

/**
 * Where "Open in Delivery" and "Open in Usage" go: the target page with the bucket's own dates as its range and every other
 * filter as it was. A date moves only where the API would refuse it (`clampRange`, the same rule the URL codec applies when the page
 * reads its address): a start before the 12-month lookback goes to the lookback start, and an end later than the end of the current
 * week or month goes to that end. A week that runs to Sunday, a month that runs to its last day, and a day that has not happened
 * yet but is still this week or month keep their dates; the page says in words what has not happened. The new range takes the
 * default grouping for its length, as the prototype's drill does.
 */
export function bucketDrillUrl(
  target: DrillTarget,
  bucket: { start: string; end: string },
  filters: Filters,
  ctx: FilterContext,
): string {
  const next = applyChange(filters, { range: clampRange(bucket, ctx) }, ctx);
  return `/${target}${searchFor('', next, ctx)}`;
}
