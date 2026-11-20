import { Outlet } from 'react-router';
import { useRouteFocus } from './useRouteFocus';

/** The one place the page title and route focus are handled: above the review shell and Setup, so neither layout owns it. */
export function RootLayout() {
  useRouteFocus();
  return <Outlet />;
}
