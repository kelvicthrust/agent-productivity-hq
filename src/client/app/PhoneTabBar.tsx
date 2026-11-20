import { NavLink } from 'react-router';
import { Icon } from '../components/Icon';
import { cx } from '../lib/cx';
import { IssueBadge } from './IssueBadge';
import { PHONE_TABS } from './routes';

// Below 720px: a fixed bottom tab bar with the five destinations of the design (HQ is the app bar's link instead; see NavItem.phone). Rendered AFTER <main> in the DOM so the tab
// order matches what is drawn (the bar is at the bottom). "Sources & repos" shows "Sources" and keeps its full
// accessible name. Each tab is 52px tall; the bar pads for the device's safe-area insets (bottom, left and right).
export function PhoneTabBar() {
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-[28] flex items-stretch gap-0.5 border-t border-border bg-surface pl-[max(6px,env(safe-area-inset-left))] pr-[max(6px,env(safe-area-inset-right))] pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] shadow-nav min-[720px]:hidden"
    >
      {PHONE_TABS.map((item) => (
        <NavLink
          key={item.id}
          to={item.path}
          end={item.end}
          className={({ isActive }) =>
            cx(
              'relative flex h-[52px] min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-[3px] rounded-md px-0.5 text-caption no-underline transition-colors duration-[var(--dur-press)]',
              isActive
                ? 'bg-selection-surface font-semibold text-ink [&_svg]:text-action'
                : 'text-ink-muted',
            )
          }
        >
          <Icon name={item.icon} />
          {item.shortLabel ? (
            <>
              <span aria-hidden="true">{item.shortLabel}</span>
              <span className="sr-only">{item.label}</span>
            </>
          ) : (
            <span>{item.label}</span>
          )}
          {item.id === 'sources' && (
            <IssueBadge className="absolute top-0.5 left-[calc(50%+4px)] !h-[18px] !min-w-[18px] !px-1 text-[11px] leading-none" />
          )}
        </NavLink>
      ))}
    </nav>
  );
}
