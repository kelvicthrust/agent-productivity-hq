import type { PluginHandlerContext, PluginServerContext } from '@getpaseo/plugin/server';
import { createDashboardLauncher } from './server/launcher.ts';
import { dashboardSettings } from './shared/dashboard.ts';
import { launchDashboard, runtimeInstall } from './shared/rpc.ts';

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(dashboardSettings);
  const launcher = createDashboardLauncher();
  async function readLaunchInputs(paseo: PluginHandlerContext['paseo']) {
    const [{ config }, state] = await Promise.all([paseo.config.get(), settings.read()]);
    if (state.status !== 'ready') throw new Error('Invalid dashboard host settings');
    return {
      directory: config.plugins?.['agent-productivity']?.path,
      legacyUrl: state.values.privateUrl,
    };
  }
  server.handle(launchDashboard, (_, { paseo }) => launcher.launch(() => readLaunchInputs(paseo)));
  server.handle(runtimeInstall, ({ action }, { paseo }) =>
    action === 'start'
      ? launcher.startRuntimeInstall(() => readLaunchInputs(paseo))
      : launcher.runtimeInstallStatus(),
  );

  const disconnect = () => {
    void launcher.stop();
  };
  process.once('disconnect', disconnect);
  return async () => {
    process.off('disconnect', disconnect);
    await launcher.stop();
  };
}
