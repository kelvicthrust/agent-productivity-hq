import { NavLink } from 'react-router';
import { Icon } from '../components/Icon';
import { cx } from '../lib/cx';
import { IssueBadge } from './IssueBadge';
import { NAV } from './routes';

// 720px and up. At 1024px and up it is the 220px pill column with Sources & repos following Usage; from 720 to
// 1023px it is a pill row under the app bar. Hidden below 720px, where PhoneTabBar takes over (only one is ever in the accessibility tree).
export function SideNav() {
  return (
    <nav
      aria-label="Sections"
      className="sticky top-[var(--appbar-h)] z-[25] row-start-2 col-start-1 hidden gap-1 overflow-x-auto bg-canvas pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pb-2 pt-1 min-[720px]:flex min-[1024px]:h-[calc(100dvh-var(--appbar-h))] min-[1024px]:flex-col min-[1024px]:overflow-visible min-[1024px]:p-3 min-[1024px]:pb-4"
    >
      {NAV.map((item) => (
        <NavLink
          key={item.id}
          to={item.path}
          end={item.end}
          className={({ isActive }) =>
            cx(
              'flex h-[34px] flex-none items-center gap-2.5 rounded-full px-3 text-label no-underline transition-colors duration-[var(--dur-press)] min-[1024px]:h-[38px]',
              isActive
                ? 'bg-selection-surface font-semibold text-ink [&_svg]:text-action'
                : 'text-ink-muted hover:bg-sunken hover:text-ink',
            )
          }
        >
          <Icon name={item.icon} className="flex-none" />
          <span className="min-w-0 truncate">{item.label}</span>
          {item.id === 'sources' && <IssueBadge className="ml-auto" />}
        </NavLink>
      ))}
    </nav>
  );
}
