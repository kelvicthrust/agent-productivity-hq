import { LayerProvider } from '@astryxdesign/core/Layer';
import { useMemo } from 'react';
import { Navigate, Outlet, useLocation, useNavigation } from 'react-router';
import { RefreshBanner } from '../components/RefreshBanner';
import { FilterBar } from '../features/filters/FilterBar';
import { RecordsDrawer } from '../features/records-drawer/RecordsDrawer';
import { useBootstrap } from '../lib/bootstrap';
import { FilterSlotProvider } from '../lib/filterSlot';
import { RecordsDrawerProvider } from '../lib/recordsDrawer';
import { useMediaQuery } from '../lib/useMediaQuery';
import { AppBar } from './AppBar';
import { PhoneTabBar } from './PhoneTabBar';
import { RouteLoading } from './RouteState';
import { SETUP_PATH, filterGroupsFor } from './routes';
import { SideNav } from './SideNav';

// The phone tab bar (PhoneTabBar) floats over the bottom edge below 720px: its height plus the device's own bottom inset. Astryx
// keeps its toasts, and any popover anchored near that edge, this far from it, so a toast is never drawn under the bar.
const TAB_BAR_CLEARANCE = 'calc(var(--bottomnav-h) + env(safe-area-inset-bottom, 0px))';

/**
 * The review shell: skip link, app bar, navigation, main, then the phone tab bar. DOM order is visual
 * order at every width: the tab bar is last because it is drawn at the bottom.
 *
 * Phone rules that belong to the shell rather than to any one screen (design-to-code › Responsive and accessibility decisions):
 * the page leaves room for the tab bar and the device's insets, toasts sit above the tab bar, and a text field is 16px so iOS
 * does not zoom the page when it takes focus (a field a screen draws smaller is raised here, the one place that sees them all).
 */
export function ShellLayout() {
  const { pathname, search } = useLocation();
  const { state } = useNavigation();
  const phone = useMediaQuery('(max-width: 719px)');
  // The shell mounts the bar for the route it is showing; the screen draws it under its title (PageHeader), through this slot.
  const filterBar = useMemo(() => {
    const groups = filterGroupsFor(pathname, search);
    return groups.length > 0 ? <FilterBar groups={groups} /> : null;
  }, [pathname, search]);
  const layerInset = useMemo(() => (phone ? { blockEnd: TAB_BAR_CLEARANCE } : undefined), [phone]);
  // A first launch goes to Setup (TECH J1: "router redirects to /setup"). Only the server's own word moves the owner: while the
  // bootstrap is loading, or the app cannot be reached, nothing is decided and the page stays where it is. A finished setup never
  // sends anyone back; /setup itself stays reachable, so the owner can look at it again.
  const { data: bootstrap } = useBootstrap();
  if (bootstrap && !bootstrap.setupComplete) return <Navigate to={SETUP_PATH} replace />;
  return (
    <LayerProvider inset={layerInset}>
      <RecordsDrawerProvider>
        <FilterSlotProvider value={filterBar}>
          <div className="grid min-h-dvh max-[719px]:[&_input]:text-[16px] max-[719px]:[&_select]:text-[16px] max-[719px]:[&_textarea]:text-[16px] grid-cols-[minmax(0,1fr)] grid-rows-[var(--appbar-h)_auto_1fr] min-[1024px]:grid-cols-[var(--sidenav-w)_minmax(0,1fr)] min-[1024px]:grid-rows-[var(--appbar-h)_1fr]">
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[100] focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2 focus:shadow-overlay"
            >
              Skip to content
            </a>
            <AppBar />
            <SideNav />
            <main
              id="main"
              tabIndex={-1}
              className="row-start-3 min-w-0 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-3 pb-[calc(var(--space-3xl)+var(--bottomnav-h)+env(safe-area-inset-bottom))] min-[720px]:pl-[max(1.5rem,env(safe-area-inset-left))] min-[720px]:pr-[max(1.5rem,env(safe-area-inset-right))] min-[720px]:pt-4 min-[720px]:pb-12 min-[1024px]:col-start-2 min-[1024px]:row-start-2"
            >
              <div className="max-w-[var(--content-max)]">
                {(!phone || pathname !== '/') && <RefreshBanner />}
                {state !== 'idle' && <RouteLoading />}
                <Outlet />
              </div>
            </main>
            <PhoneTabBar />
          </div>
        </FilterSlotProvider>
        <RecordsDrawer />
      </RecordsDrawerProvider>
    </LayerProvider>
  );
}
