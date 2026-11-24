import type { IconName } from '../components/Icon';
import type { FilterGroupId } from '../lib/filterSlot';

export interface NavItem {
  id: string;
  path: string;
  /** Full name: the accessible name everywhere, and the visible text above phone width. */
  label: string;
  /** Visible text on the phone tab bar when the full label would not fit. */
  shortLabel?: string;
  icon: IconName;
  /** Match the path exactly (the index route). */
  end?: boolean;
  /**
   * The filter groups this screen's data answers to (what its queries pass: lib/analytics, usage/queries, delivery/queries). The
   * bar under its title shows exactly these; a screen with none has no bar.
   */
  filterGroups?: readonly FilterGroupId[];
  /**
   * Where the item goes below 720px. Unset: a tab on the phone tab bar, which the design fixes at five. `appbar`: not a tab, an
   * icon link in the app bar instead (HQ), so the bar keeps five tabs that fit at 320px.
   */
  phone?: 'appbar';
}

const ALL_GROUPS: readonly FilterGroupId[] = ['period', 'gran', 'repos', 'provider', 'author'];

// The destinations in nav order: the five of the D7 design, then HQ. Setup is a separate route without navigation.
export const NAV: readonly NavItem[] = [
  {
    id: 'overview',
    path: '/',
    label: 'Overview',
    icon: 'overview',
    end: true,
    filterGroups: ALL_GROUPS,
  },
  { id: 'trends', path: '/trends', label: 'Trends', icon: 'trends', filterGroups: ALL_GROUPS },
  {
    id: 'delivery',
    path: '/delivery',
    label: 'Delivery',
    icon: 'merge',
    filterGroups: ['period', 'repos', 'author'],
  },
  {
    id: 'usage',
    path: '/usage',
    label: 'Usage',
    icon: 'layers',
    filterGroups: ['period', 'repos', 'provider'],
  },
  // HQ sits after Usage in the side nav and has no filter bar. It is the one destination that is not a phone tab.
  { id: 'hq', path: '/hq', label: 'HQ', icon: 'hq', phone: 'appbar' },
  {
    id: 'sources',
    path: '/sources',
    label: 'Sources & repos',
    shortLabel: 'Sources',
    icon: 'plug',
  },
];

/** The destinations on the phone tab bar: all but those drawn in the app bar. */
export const PHONE_TABS: readonly NavItem[] = NAV.filter((item) => item.phone !== 'appbar');
/** The destinations the app bar links to on a phone. */
export const APPBAR_LINKS: readonly NavItem[] = NAV.filter((item) => item.phone === 'appbar');

export const SETUP_PATH = '/setup';
export const PRODUCT_NAME = 'Agent Productivity HQ';

/** The page name for a path, used for the document title. */
export function pageNameFor(pathname: string): string {
  if (pathname === SETUP_PATH) return 'Setup';
  if (pathname === '/work-review') return 'Work Review';
  const hit = NAV.find((item) =>
    item.end ? pathname === item.path : pathname.startsWith(item.path),
  );
  return hit?.label ?? 'Page not found';
}

/** The filter groups of the screen at `pathname`: none for Sources & repos, Setup and a path that is not a screen. */
export function filterGroupsFor(pathname: string): readonly FilterGroupId[] {
  if (pathname === '/work-review') return ['period', 'repos', 'provider', 'author'];
  return (
    NAV.find((item) => (item.end ? pathname === item.path : pathname.startsWith(item.path)))
      ?.filterGroups ?? []
  );
}

/** Whether the screen at `pathname` carries the filter bar. */
export function showsFilters(pathname: string): boolean {
  return filterGroupsFor(pathname).length > 0;
}
