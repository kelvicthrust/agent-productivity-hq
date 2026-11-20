import { usePaseo, useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@getpaseo/plugin/client/ui';
import { useEffect, useState } from 'react';
import { dashboardSettings } from '../shared/dashboard.ts';

type Workspace = Awaited<
  ReturnType<ReturnType<typeof usePaseo>['workspaces']['list']>
>['entries'][number];
type WorkspaceBinding = ReturnType<typeof useSettings<typeof dashboardSettings.schema>>;
type WorkspaceList = { status: 'loading' | 'error' } | { status: 'ready'; entries: Workspace[] };

const loading: WorkspaceList = { status: 'loading' };

export function useLauncherWorkspaces(enabled = true) {
  const { workspaces } = usePaseo();
  const [list, setList] = useState<WorkspaceList>(loading);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    async function load() {
      setList(loading);
      try {
        const entries: Workspace[] = [];
        let cursor: string | undefined;
        do {
          const result = await workspaces.list({ page: { limit: 100, cursor } });
          if (!active) return;
          entries.push(...result.entries);
          cursor = result.pageInfo.nextCursor ?? undefined;
        } while (cursor);
        setList({ status: 'ready', entries });
      } catch {
        if (active) setList({ status: 'error' });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [workspaces, enabled, attempt]);

  return { list, reload: () => setAttempt((value) => value + 1) };
}

export function WorkspacePicker({
  host,
  settings,
  workspaces,
}: {
  host: PluginSurfaceProps['host'];
  settings: WorkspaceBinding;
  workspaces: ReturnType<typeof useLauncherWorkspaces>;
}) {
  const { list, reload } = workspaces;
  return (
    <SettingsSection title="Dashboard workspace">
      <SettingsCard>
        <SettingsRow label="Host" hint={host.label} />
        {settings.status === 'loading' && <SettingsRow label="Loading workspace settings…" />}
        {settings.status === 'error' && (
          <SettingsAction
            label="Workspace settings are unavailable"
            actionLabel="Retry"
            onPress={() => void settings.reload()}
          />
        )}
        {settings.status === 'invalid' && (
          <SettingsAction
            label="The saved workspace needs repair"
            hint="Reset the workspace preference, then choose again."
            actionLabel="Reset settings"
            disabled={settings.saving}
            error={settings.saveError}
            onPress={() => void settings.reset()}
          />
        )}
        {settings.status === 'ready' && (
          <>
            {list.status === 'loading' && <SettingsRow label="Loading workspaces…" />}
            {list.status === 'error' && (
              <SettingsAction
                label="Workspaces are unavailable on this host"
                actionLabel="Retry"
                onPress={reload}
              />
            )}
            {list.status === 'ready' && (
              <>
                {list.entries.length ? (
                  <SettingsRow
                    label="Choose where the dashboard opens"
                    error={settings.saveError}
                  />
                ) : (
                  <SettingsAction
                    label="Open a workspace in Paseo on this host first."
                    actionLabel="Refresh workspaces"
                    onPress={reload}
                  />
                )}
                {list.entries.map((workspace) => {
                  const selected = settings.values.workspaceId === workspace.id;
                  return (
                    <SettingsAction
                      key={workspace.id}
                      label={workspace.title || workspace.name}
                      hint={workspace.workspaceDirectory ?? workspace.projectRootPath}
                      actionLabel={selected ? 'Selected' : 'Choose'}
                      disabled={selected || settings.saving}
                      onPress={() =>
                        void settings.save(
                          { ...settings.values, workspaceId: workspace.id },
                          settings.revision,
                        )
                      }
                    />
                  );
                })}
              </>
            )}
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function DesktopSettings({ host }: Pick<PluginSurfaceProps, 'host'>) {
  const settings = useSettings(dashboardSettings);
  const workspaces = useLauncherWorkspaces();
  return <WorkspacePicker host={host} settings={settings} workspaces={workspaces} />;
}

export function ConfigureLauncher({ host, layout }: PluginSurfaceProps) {
  if (layout.platform === 'web') return <DesktopSettings key={host.id} host={host} />;
  return (
    <SettingsSection title="Dashboard workspace">
      <SettingsCard>
        <SettingsRow label="Host" hint={host.label} />
        <SettingsRow label="Choose a dashboard workspace in Paseo Desktop." />
      </SettingsCard>
    </SettingsSection>
  );
}
