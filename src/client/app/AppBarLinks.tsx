import { NavLink } from 'react-router';
import { Icon } from '../components/Icon';
import { cx } from '../lib/cx';
import { APPBAR_BUTTON } from './appBarButton';
import { APPBAR_LINKS } from './routes';

/**
 * The destinations that are not phone tabs (HQ), as icon links on the left of the app bar's actions. Below 720px only: from
 * 720px the side nav lists them. The name is read, not drawn, and the link is a 44px target like the other app-bar controls.
 */
export function AppBarLinks() {
  return APPBAR_LINKS.map((item) => (
    <NavLink
      key={item.id}
      to={item.path}
      end={item.end}
      className={({ isActive }) =>
        cx(APPBAR_BUTTON, 'min-[720px]:hidden', isActive ? 'text-action' : 'text-ink')
      }
    >
      <Icon name={item.icon} />
      <span className="sr-only">{item.label}</span>
    </NavLink>
  ));
}
