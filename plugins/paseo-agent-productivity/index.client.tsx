import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { createLaunchRequests } from './client/launch.ts';
import { LauncherScreen } from './client/launcher-screen.tsx';
import { logbookIcon } from './client/logbook-icon.ts';
import { ConfigureLauncher } from './client/settings.tsx';

const launcherId = 'dashboard';
const title = 'Agent HQ';

export default function contribute(client: PluginClientContext) {
  const requests = createLaunchRequests();

  function ProductivitySidebarItem({ currentScreen, host, openScreen }: PluginSidebarItemProps) {
    return (
      <SidebarRow
        icon={logbookIcon}
        active={currentScreen?.screenId === launcherId}
        onPress={() =>
          openScreen({ screenId: launcherId, params: { launch: requests.issue(host.id) } })
        }
      />
    );
  }

  function ProductivityScreen(props: PluginScreenProps) {
    return (
      <LauncherScreen
        key={props.host.id}
        {...props}
        requests={requests}
        configure={() => client.openSettings(launcherId)}
      />
    );
  }

  const removeSettings = client.addSettingsScreen({
    id: launcherId,
    title: 'Dashboard workspace',
    icon: 'Settings',
    Component: ConfigureLauncher,
  });
  const removeScreen = client.addScreen({ id: launcherId, title, Component: ProductivityScreen });
  const removeRow = client.addSidebarHeaderItem({
    id: launcherId,
    title,
    Component: ProductivitySidebarItem,
  });
  return () => {
    removeRow();
    removeScreen();
    removeSettings();
  };
}
