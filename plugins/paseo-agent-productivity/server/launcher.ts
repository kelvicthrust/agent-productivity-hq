import type { DashboardLaunchResult, RuntimeInstallStatus } from '../shared/rpc.ts';
import { dashboardUnavailable, LaunchError, routeConflict, runtimeInstalling } from './errors.ts';
import {
  runtimePaths,
  startDashboard,
  startServe,
  type DashboardProcess,
  type OwnedProcess,
  type RuntimePaths,
} from './processes.ts';
import {
  checkRoutes,
  findTailscale,
  readTailnetHost,
  readTailscaleJson,
  requireFreeTailnetPort,
  type TailnetHost,
} from './tailscale.ts';

interface LaunchInputs {
  directory: string | undefined;
  legacyUrl: string;
}

const host = {
  runtimePaths,
  findTailscale,
  readTailscaleJson,
  requireFreeTailnetPort,
  startDashboard,
  startServe,
  localPort() {
    const value = process.env.AGENT_PRODUCTIVITY_PORT || undefined;
    const port = value === undefined ? 4317 : Number(value);
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      (value !== undefined && !/^\d+$/.test(value))
    ) {
      throw new LaunchError(
        'dashboard-unavailable',
        'Set AGENT_PRODUCTIVITY_PORT to a valid local port on the dashboard host.',
      );
    }
    return port;
  },
};

interface RunningDashboard {
  service: DashboardProcess;
  serve: OwnedProcess;
  tailnet: TailnetHost;
  runtime: RuntimePaths;
  serveSession: string;
}

export function createDashboardLauncher(deps: typeof host = host) {
  const lifetime = new AbortController();
  let active: RunningDashboard | undefined;
  let cleanup: Promise<void> | undefined;
  let pending: Promise<DashboardLaunchResult> | undefined;
  let pendingInstall: Promise<void> | undefined;
  let installStatus: RuntimeInstallStatus = { state: 'idle' };

  function release(): Promise<void> | undefined {
    const owned = active;
    if (!owned) return cleanup;
    active = undefined;
    cleanup = owned.serve.stop().finally(() => owned.service.stop());
    return cleanup;
  }

  async function ensure(
    inputs: LaunchInputs,
    installRuntime: boolean,
  ): Promise<DashboardLaunchResult> {
    const { signal } = lifetime;
    if (signal.aborted) throw dashboardUnavailable();
    const runtime = await deps.runtimePaths(inputs.directory, signal, installRuntime);
    const binary = deps.findTailscale();
    const readConfig = () => deps.readTailscaleJson(binary, ['serve', 'status', '--json'], signal);
    const status = await deps.readTailscaleJson(binary, ['status', '--json'], signal);
    const tailnet = readTailnetHost(status);
    const localPort = deps.localPort();
    const baseCheck = { authority: tailnet.authority, localPort, legacyUrl: inputs.legacyUrl };
    const success = { ok: true, url: `https://${tailnet.authority}` } as const;

    if (
      active &&
      active.service.alive() &&
      active.serve.alive() &&
      active.runtime.directory === runtime.directory &&
      active.runtime.version === runtime.version &&
      active.runtime.node === runtime.node &&
      active.tailnet.authority === tailnet.authority &&
      active.tailnet.ownerLogin === tailnet.ownerLogin &&
      active.service.port === localPort
    ) {
      const running = active;
      checkRoutes(await readConfig(), {
        ...baseCheck,
        remotePort: running.service.remotePort,
        ownSession: running.serveSession,
      });
      if (signal.aborted) throw dashboardUnavailable();
      if (running.service.alive() && running.serve.alive()) return success;
    }

    await release();
    checkRoutes(await readConfig(), baseCheck);
    await deps.requireFreeTailnetPort(tailnet.addresses);
    const service = await deps.startDashboard(runtime, tailnet, localPort, signal);
    let serve: OwnedProcess | undefined;
    try {
      const check = { ...baseCheck, remotePort: service.remotePort };
      checkRoutes(await readConfig(), check);
      if (!service.alive()) throw dashboardUnavailable();
      const serviceLifetime = new AbortController();
      const stopRoute = () => serviceLifetime.abort();
      signal.addEventListener('abort', stopRoute, { once: true });
      if (signal.aborted) stopRoute();
      void service.closed.then(stopRoute);
      try {
        serve = await deps.startServe(
          runtime,
          binary,
          tailnet.authority,
          service.remotePort,
          serviceLifetime.signal,
        );
      } catch (error) {
        // The daemon checks concurrent config updates. Report any newly visible collision.
        checkRoutes(await readConfig(), check);
        throw error;
      } finally {
        signal.removeEventListener('abort', stopRoute);
      }
      const serveSession = checkRoutes(await readConfig(), { ...check, discoverNewSession: true });
      if (!serveSession || !serve.alive()) throw routeConflict();
      if (!service.alive()) throw dashboardUnavailable();
      if (signal.aborted) throw dashboardUnavailable();
      const running = { service, serve, tailnet, runtime, serveSession };
      active = running;
      void Promise.race([service.closed, serve.closed])
        .then(() => {
          if (active === running) return release();
        })
        .catch(() => console.error('[Agent HQ] Could not finish releasing the dashboard.'));
      return success;
    } catch (error) {
      try {
        await serve?.stop();
      } finally {
        await service.stop();
      }
      throw error;
    }
  }

  function attempt(input: () => Promise<LaunchInputs>, installRuntime: boolean) {
    return Promise.resolve()
      .then(input)
      .then((inputs) => ensure(inputs, installRuntime))
      .catch(async (error: unknown) => {
        await release();
        return (error instanceof LaunchError ? error : dashboardUnavailable()).result();
      });
  }

  return {
    launch(input: () => Promise<LaunchInputs>): Promise<DashboardLaunchResult> {
      if (pendingInstall) return Promise.resolve(runtimeInstalling().result());
      return (pending ??= attempt(input, false).finally(() => {
        pending = undefined;
      }));
    },
    startRuntimeInstall(input: () => Promise<LaunchInputs>): RuntimeInstallStatus {
      if (lifetime.signal.aborted) {
        return { state: 'finished', result: dashboardUnavailable().result() };
      }
      if (pendingInstall) return installStatus;
      installStatus = { state: 'installing' };
      const finish = (result: DashboardLaunchResult) => {
        installStatus = { state: 'finished', result };
      };
      pendingInstall = (async () => {
        const previous = await pending;
        return previous?.ok ? previous : attempt(input, true);
      })()
        .then(finish, () => finish(dashboardUnavailable().result()))
        .finally(() => {
          pendingInstall = undefined;
        });
      return installStatus;
    },
    runtimeInstallStatus(): RuntimeInstallStatus {
      return installStatus;
    },
    async stop(): Promise<void> {
      lifetime.abort();
      await release();
      await pending;
      await pendingInstall;
    },
  };
}
