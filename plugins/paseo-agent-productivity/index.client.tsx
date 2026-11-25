import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginWorkspaceRowBadgeItemProps,
} from '@getpaseo/plugin/client';
import { useWorkspace } from '@getpaseo/plugin/client';
import { SettingsAction, SidebarRow, WorkspaceRowBadge } from '@getpaseo/plugin/client/ui';
import { useState } from 'react';
import {
  createLaunchRequests,
  type DashboardDestination,
  type LaunchRequests,
} from './client/launch.ts';
import { LauncherScreen } from './client/launcher-screen.tsx';
import { logbookIcon } from './client/logbook-icon.ts';
import type { DashboardPage, DrillDown } from './client/native-reporting.tsx';
import { NativeScreen } from './client/native-screen.tsx';
import { ConfigureLauncher } from './client/settings.tsx';

const launcherId = 'dashboard';
const title = 'Agent HQ';
const needsAnswer = 'Needs your answer';

function WorkspaceAnswerBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  // The daemon's status gives pending input priority over ongoing work.
  const waiting = useWorkspace(workspaceId, (workspace) => workspace.status === 'needs_input');
  return waiting ? <WorkspaceRowBadge label={needsAnswer} tone="warning" /> : null;
}

function ProductivityScreen({
  requests,
  ...props
}: PluginScreenProps & { requests: LaunchRequests }) {
  const [launch, setLaunch] = useState<{
    id: string;
    destination?: DashboardDestination;
    search?: string;
  }>();
  const [view, setView] = useState<{ page: DashboardPage; drill?: DrillDown }>({ page: 'hq' });

  function openDashboard(destination?: DashboardDestination, search?: string) {
    setLaunch({ id: requests.issue(props.host.id, destination), destination, search });
  }

  return launch === undefined ? (
    <NativeScreen
      {...props}
      {...view}
      navigate={(page, drill) => setView({ page, drill })}
      onOpenDashboard={() => openDashboard()}
      onOpenOwnerSettings={() => openDashboard('sources')}
      onOpenWorkReview={(search) => openDashboard('work-review', search)}
    />
  ) : (
    <>
      <SettingsAction
        label="Agent HQ"
        actionLabel="Back to Agent HQ"
        onPress={() => setLaunch(undefined)}
      />
      <LauncherScreen
        {...props}
        params={{ launch: launch.id }}
        destination={launch.destination}
        search={launch.search}
        requests={requests}
      />
    </>
  );
}

export default function contribute(client: PluginClientContext) {
  const requests = createLaunchRequests();
  let visit = 0;

  function ProductivitySidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
    return (
      <SidebarRow
        icon={logbookIcon}
        active={currentScreen?.screenId === launcherId}
        onPress={() => openScreen({ screenId: launcherId, params: { visit: String(++visit) } })}
      />
    );
  }

  function Screen(props: PluginScreenProps) {
    return (
      <ProductivityScreen
        key={JSON.stringify([props.host.id, props.params.visit])}
        {...props}
        requests={requests}
      />
    );
  }

  const removeSettings = client.addSettingsScreen({
    id: launcherId,
    title: 'Launcher settings',
    icon: 'Settings',
    Component: ConfigureLauncher,
  });
  const removeScreen = client.addScreen({ id: launcherId, title, Component: Screen });
  const removeRow = client.addSidebarHeaderItem({
    id: launcherId,
    title,
    Component: ProductivitySidebarItem,
  });
  const removeBadge = client.addWorkspaceRowBadgeItem?.({
    id: 'needs-your-answer',
    title: needsAnswer,
    icon: 'MessageCircleQuestion',
    Component: WorkspaceAnswerBadge,
  });
  return () => {
    removeBadge?.();
    removeRow();
    removeScreen();
    removeSettings();
  };
}
