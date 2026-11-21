import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@getpaseo/plugin/client/ui';
import { dashboardSettings } from '../shared/dashboard.ts';

function DesktopSettings({ host }: Pick<PluginSurfaceProps, 'host'>) {
  const settings = useSettings(dashboardSettings);
  return (
    <SettingsSection title="Launcher settings">
      <SettingsCard>
        <SettingsRow label="Host" hint={host.label} />
        {settings.status === 'loading' && <SettingsRow label="Loading launcher settings…" />}
        {settings.status === 'error' && (
          <SettingsAction
            label="Launcher settings are unavailable"
            actionLabel="Retry"
            onPress={() => void settings.reload()}
          />
        )}
        {settings.status === 'invalid' && (
          <SettingsAction
            label="Saved launcher settings need repair"
            actionLabel="Reset settings"
            disabled={settings.saving}
            error={settings.saveError}
            onPress={() => void settings.reset()}
          />
        )}
        {settings.status === 'ready' && <SettingsRow label="Launcher settings are ready." />}
      </SettingsCard>
    </SettingsSection>
  );
}

export function ConfigureLauncher({ host, layout }: PluginSurfaceProps) {
  if (layout.platform === 'web') return <DesktopSettings key={host.id} host={host} />;
  return (
    <SettingsSection title="Launcher settings">
      <SettingsCard>
        <SettingsRow label="Host" hint={host.label} />
        <SettingsRow label="Use Paseo Desktop to repair saved launcher settings." />
      </SettingsCard>
    </SettingsSection>
  );
}
