import { Outlet } from 'react-router';
import { useBootstrap } from '../lib/bootstrap';
import { isPaseoBrowser } from '../lib/paseoBrowser';
import { PaseoBrowserStatus } from './PaseoBrowserStatus';
import { useRouteFocus } from './useRouteFocus';

function PaseoDashboard() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <PaseoBrowserStatus state="loading" />;
  if (!bootstrap.data) return <PaseoBrowserStatus state="error" />;
  if (!bootstrap.data.setupComplete) return <PaseoBrowserStatus state="setup" />;
  return <Outlet />;
}

/** The one place the page title and route focus are handled: above the review shell and Setup, so neither layout owns it. */
export function RootLayout() {
  useRouteFocus();
  return isPaseoBrowser() ? <PaseoDashboard /> : <Outlet />;
}
