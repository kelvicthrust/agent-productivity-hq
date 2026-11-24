import type { PluginHandlerContext, PluginServerContext } from '@getpaseo/plugin/server';
import { createDashboardLauncher } from './server/launcher.ts';
import { paseoSource } from './server/paseo-source.ts';
import { dashboardSettings } from './shared/dashboard.ts';
import { nativeDashboard, nativeRuntimeInstall } from './shared/native.ts';
import { browserHandoff, launchDashboard, runtimeInstall } from './shared/rpc.ts';

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(dashboardSettings);
  const launcher = createDashboardLauncher();
  async function readNativeInputs(paseo: PluginHandlerContext['paseo']) {
    const { config } = await paseo.config.get();
    return { directory: config.plugins?.['agent-productivity']?.path };
  }
  async function readLaunchInputs(paseo: PluginHandlerContext['paseo']) {
    const [inputs, state] = await Promise.all([readNativeInputs(paseo), settings.read()]);
    if (state.status !== 'ready') throw new Error('Invalid dashboard host settings');
    return {
      ...inputs,
      legacyUrl: state.values.privateUrl,
    };
  }
  server.handle(nativeDashboard, (request, { paseo }) =>
    launcher.native(() => readNativeInputs(paseo), request, paseoSource(paseo)),
  );
  server.handle(nativeRuntimeInstall, ({ action }, { paseo }) =>
    action === 'start'
      ? launcher.startNativeRuntimeInstall(() => readNativeInputs(paseo), paseoSource(paseo))
      : launcher.nativeRuntimeInstallStatus(),
  );
  server.handle(launchDashboard, (_, { paseo }) =>
    launcher.launch(() => readLaunchInputs(paseo), paseoSource(paseo)),
  );
  server.handle(browserHandoff, (_, { paseo }) =>
    launcher.browserHandoff(() => readLaunchInputs(paseo), paseoSource(paseo)),
  );
  server.handle(runtimeInstall, ({ action }, { paseo }) =>
    action === 'start'
      ? launcher.startRuntimeInstall(() => readLaunchInputs(paseo), paseoSource(paseo))
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
