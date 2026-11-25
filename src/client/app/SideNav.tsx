import { Fragment } from 'react';
import { Link, NavLink, matchPath, useLocation } from 'react-router';
import { FILTER_KEYS } from '../../shared/domain/dashboard-filters';
import { Icon } from '../components/Icon';
import { cx } from '../lib/cx';
import { useMediaQuery } from '../lib/useMediaQuery';
import { IssueBadge } from './IssueBadge';
import { NAV } from './routes';

const NAV_LINK =
  'flex flex-none items-center gap-2.5 rounded-full px-3 text-label no-underline transition-colors duration-[var(--dur-press)]';
const SELECTED = 'bg-selection-surface font-semibold text-ink [&_svg]:text-action';
const UNSELECTED = 'text-ink-muted hover:bg-sunken hover:text-ink';

function workReviewSearch(current: URLSearchParams): string {
  const next = new URLSearchParams({ section: 'work-review' });
  for (const key of FILTER_KEYS) {
    const value = current.get(key);
    if (value !== null) next.set(key, value);
  }
  return `?${next}`;
}

// 720px and up. At 1024px and up it is the 220px pill column with Sources & repos following Usage; from 720 to
// 1023px it is a pill row under the app bar. Hidden below 720px, where PhoneTabBar takes over (only one is ever in the accessibility tree).
export function SideNav() {
  const { pathname, search } = useLocation();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const params = new URLSearchParams(search);
  const reviewCurrent =
    desktop && matchPath('/delivery', pathname) !== null && params.get('section') === 'work-review';

  return (
    <nav
      aria-label="Sections"
      className="sticky top-[var(--appbar-h)] z-[25] row-start-2 col-start-1 hidden gap-1 overflow-x-auto bg-canvas pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pb-2 pt-1 min-[720px]:flex min-[1024px]:h-[calc(100dvh-var(--appbar-h))] min-[1024px]:flex-col min-[1024px]:overflow-visible min-[1024px]:p-3 min-[1024px]:pb-4"
    >
      {NAV.map((item) => {
        const containsReview = item.id === 'delivery' && reviewCurrent;
        return (
          <Fragment key={item.id}>
            <NavLink
              to={item.path}
              end={item.end}
              aria-current={containsReview ? 'false' : undefined}
              className={({ isActive }) =>
                cx(
                  NAV_LINK,
                  'h-[34px] min-[1024px]:h-[38px]',
                  containsReview
                    ? 'font-semibold text-ink hover:bg-sunken [&_svg]:text-action'
                    : isActive
                      ? SELECTED
                      : UNSELECTED,
                )
              }
            >
              <Icon name={item.icon} className="flex-none" />
              <span className="min-w-0 truncate">{item.label}</span>
              {item.id === 'sources' && <IssueBadge className="ml-auto" />}
            </NavLink>
            {desktop && item.id === 'delivery' && (
              <Link
                to={{ pathname: item.path, search: workReviewSearch(params) }}
                aria-current={reviewCurrent ? 'page' : undefined}
                className={cx(NAV_LINK, 'ms-8 h-[34px]', reviewCurrent ? SELECTED : UNSELECTED)}
              >
                Work Review
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
