import * as paseoClient from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@getpaseo/plugin/client/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { dashboardSettings, isTailnetHttpsOrigin } from '../shared/dashboard.ts';
import { launchDashboard, runtimeInstall } from '../shared/rpc.ts';
import type { LaunchRequests } from './launch.ts';
import { useLauncherWorkspaces, WorkspacePicker } from './settings.tsx';

interface LauncherScreenProps extends paseoClient.PluginScreenProps {
  requests: LaunchRequests;
  configure(): void;
}

type OpenWorkspaceBrowser = NonNullable<
  NonNullable<LauncherScreenProps['navigation']>['openBrowser']
>;

interface DashboardLaunchCardProps extends LauncherScreenProps {
  ready: boolean;
  loadingWorkspace?: boolean;
  openWorkspace?(url: string): void;
}

function DashboardLaunchCard({
  host,
  layout,
  params,
  requests,
  theme,
  configure,
  ready,
  loadingWorkspace,
  openWorkspace,
}: DashboardLaunchCardProps) {
  const launch = paseoClient.useRpc(launchDashboard);
  const install = paseoClient.useRpc(runtimeInstall);
  const externalOpen =
    !openWorkspace && typeof paseoClient.openExternalUrl === 'function'
      ? paseoClient.openExternalUrl
      : undefined;
  const [status, setStatus] = useState<string>();
  const [privateUrl, setPrivateUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [installNeeded, setInstallNeeded] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(false);
  const waiting = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const openInBrowser = useCallback(
    async (url: string) => {
      try {
        if (externalOpen) {
          await externalOpen(url);
          if (active.current && layout.platform !== 'web') {
            setPrivateUrl(undefined);
            setStatus('The dashboard is open in your browser.');
          }
          return;
        }
      } catch {
        // Keep the validated address available for copying if the client cannot open it.
      }
      if (active.current && (layout.platform !== 'web' || !externalOpen)) {
        setPrivateUrl(url);
        setStatus('Copy the private address and open it in your browser.');
      }
    },
    [externalOpen, layout.platform],
  );

  const waitForRuntime = useCallback(
    async (action: 'start' | 'status') => {
      setStatus('Installing the private Node.js runtime on the Paseo host…');
      let progress = await install({ action });
      while (active.current && progress.state === 'installing') {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        if (!active.current) return null;
        progress = await install({ action: 'status' });
      }
      if (progress.state === 'finished') return progress.result;
      return {
        ok: false,
        reason: 'runtime-required',
        message: 'The host no longer has an active install. Try installing the runtime again.',
      } as const;
    },
    [install],
  );

  const open = useCallback(
    async (installRuntime = false) => {
      if (inFlight.current || !ready) return;
      inFlight.current = true;
      setBusy(true);
      setPrivateUrl(undefined);
      setStatus(
        installRuntime
          ? 'Installing the private Node.js runtime on the Paseo host…'
          : 'Starting the dashboard and checking private access…',
      );
      try {
        let result = installRuntime ? await waitForRuntime('start') : await launch({});
        if (active.current && result?.ok === false && result.reason === 'runtime-installing') {
          result = await waitForRuntime('status');
        }
        if (!active.current || !result) return;
        if (!result.ok) {
          setInstallNeeded(
            result.reason === 'runtime-required' || result.reason === 'runtime-install-failed',
          );
          setStatus(result.message);
          return;
        }
        setInstallNeeded(false);
        if (!isTailnetHttpsOrigin(result.url)) {
          setStatus(
            'The host returned an invalid private address. Check Tailscale on the host and retry.',
          );
          return;
        }
        if (openWorkspace) {
          try {
            openWorkspace(result.url);
            setStatus('The dashboard is open in its workspace.');
          } catch {
            setStatus(
              'This workspace is unavailable. Choose another dashboard workspace, then retry.',
            );
          }
        } else if (layout.platform === 'web' && externalOpen) {
          // The RPC can outlive a browser's user activation. Offer a fresh click to open it.
          setPrivateUrl(result.url);
          setStatus('Open the dashboard in your browser or copy the private address.');
        } else {
          await openInBrowser(result.url);
        }
      } catch {
        if (active.current)
          setStatus('The launcher could not reach the Paseo host. Reconnect to it and retry.');
      } finally {
        inFlight.current = false;
        if (active.current) setBusy(false);
      }
    },
    [ready, launch, openWorkspace, layout.platform, externalOpen, openInBrowser, waitForRuntime],
  );

  // A restored route can contain an old launch ID. Only a fresh sidebar click starts the service.
  useEffect(() => {
    if (requests.take(params.launch, host.id)) waiting.current = params.launch;
    if (!waiting.current || waiting.current !== params.launch || !ready) return;
    waiting.current = undefined;
    void open();
  }, [params.launch, host.id, requests, ready, open]);

  const textStyle = { color: theme.colors.foreground, paddingHorizontal: 16, paddingVertical: 12 };
  return (
    <SettingsSection title="Agent HQ">
      <SettingsCard>
        <SettingsRow label="Host" hint={host.label} />
        {loadingWorkspace && <SettingsRow label="Loading workspace settings…" />}
        {ready && (
          <>
            <Text accessibilityLiveRegion="polite" style={textStyle}>
              {status ??
                (openWorkspace
                  ? 'Open the dashboard in its workspace.'
                  : 'Open the dashboard in your browser.')}
            </Text>
            {privateUrl && (
              <>
                <Text selectable style={textStyle}>
                  {privateUrl}
                </Text>
                {layout.platform === 'web' && externalOpen && (
                  <SettingsAction
                    label="Private dashboard address"
                    actionLabel="Open in browser"
                    disabled={busy}
                    onPress={() => void openInBrowser(privateUrl)}
                  />
                )}
              </>
            )}
            <SettingsAction
              label="Dashboard"
              actionLabel={
                installNeeded
                  ? busy
                    ? 'Installing…'
                    : 'Install runtime'
                  : busy
                    ? 'Opening…'
                    : status
                      ? 'Retry'
                      : 'Open dashboard'
              }
              disabled={busy}
              onPress={() => void open(installNeeded)}
            />
            {openWorkspace && (
              <SettingsAction
                label="Dashboard workspace"
                actionLabel="Change workspace"
                disabled={busy}
                onPress={configure}
              />
            )}
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function WorkspaceLauncher({
  openBrowser,
  ...props
}: LauncherScreenProps & { openBrowser: OpenWorkspaceBrowser }) {
  const { host } = props;
  const settings = paseoClient.useSettings(dashboardSettings);
  const savedId = settings.status === 'ready' ? settings.values.workspaceId : '';
  const workspaces = useLauncherWorkspaces(!savedId);
  const { list } = workspaces;
  const workspaceId =
    settings.status === 'ready'
      ? savedId || (list.status === 'ready' && list.entries.length === 1 && list.entries[0]?.id)
      : undefined;
  const loadingWorkspace =
    settings.status === 'loading' ||
    (settings.status === 'ready' && !workspaceId && list.status === 'loading');
  const openWorkspace = useCallback(
    (url: string) => {
      if (workspaceId) openBrowser({ serverId: host.id, workspaceId, url });
    },
    [host.id, openBrowser, workspaceId],
  );

  return (
    <>
      <DashboardLaunchCard
        {...props}
        ready={Boolean(workspaceId)}
        loadingWorkspace={loadingWorkspace}
        openWorkspace={workspaceId ? openWorkspace : undefined}
      />
      {!loadingWorkspace && !workspaceId && (
        <WorkspacePicker host={host} settings={settings} workspaces={workspaces} />
      )}
    </>
  );
}

export function LauncherScreen(props: LauncherScreenProps) {
  const { layout, navigation } = props;
  const openBrowser = layout.platform === 'web' ? navigation?.openBrowser : undefined;
  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 12 }}>
      {openBrowser ? (
        <WorkspaceLauncher {...props} openBrowser={openBrowser} />
      ) : (
        <DashboardLaunchCard {...props} ready />
      )}
    </ScrollView>
  );
}
