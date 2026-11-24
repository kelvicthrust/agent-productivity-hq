import type {
  NativeRequest,
  NativeResult,
  NativeRuntimeInstallStatus,
  PaseoRead,
} from '../shared/native.ts';
import type {
  BrowserHandoffResult,
  DashboardLaunchResult,
  RuntimeInstallStatus,
} from '../shared/rpc.ts';
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

interface NativeInputs {
  directory: string | undefined;
}

interface LaunchInputs extends NativeInputs {
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

interface BrowserRoute {
  serve: OwnedProcess;
  tailnet: TailnetHost;
  remotePort: number;
  session: string;
}

interface RunningDashboard {
  service: DashboardProcess;
  runtime: RuntimePaths;
  lifetime: AbortController;
  route?: BrowserRoute;
  routeCleanup?: Promise<void>;
}

type BrowserStart =
  | Extract<DashboardLaunchResult, { ok: false }>
  | { ok: true; url: string; running: RunningDashboard; route: BrowserRoute };

function launchResult(result: BrowserStart): DashboardLaunchResult {
  return result.ok ? { ok: true, url: result.url } : result;
}

const failure = (error: unknown) =>
  (error instanceof LaunchError ? error : dashboardUnavailable()).result();

function sameService(running: RunningDashboard, runtime: RuntimePaths, port: number): boolean {
  return (
    running.service.alive() &&
    running.service.port === port &&
    running.runtime.directory === runtime.directory &&
    running.runtime.version === runtime.version &&
    running.runtime.node === runtime.node
  );
}

export function createDashboardLauncher(deps: typeof host = host) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let active: RunningDashboard | undefined;
  let serviceCleanup: Promise<void> | undefined;
  let pendingService: Promise<RunningDashboard> | undefined;
  let pendingBrowser:
    { ready: Promise<BrowserStart>; response: Promise<DashboardLaunchResult> } | undefined;
  let pendingInstall: Promise<void> | undefined;
  let installStatus: RuntimeInstallStatus = { state: 'idle' };
  let nativeInstallStatus: NativeRuntimeInstallStatus = { state: 'idle' };

  async function releaseRoute(running: RunningDashboard | undefined): Promise<void> {
    if (!running) return;
    const route = running.route;
    if (!route) return running.routeCleanup;
    running.route = undefined;
    return (running.routeCleanup = route.serve
      .stop()
      .finally(async () => {
        if (running.service.alive()) await running.service.detachRemote();
      })
      .catch(() => console.error('[Agent HQ] Could not finish releasing the browser route.')));
  }

  function releaseService(): Promise<void> | undefined {
    const running = active;
    if (!running) return serviceCleanup;
    active = undefined;
    running.lifetime.abort();
    return (serviceCleanup = releaseRoute(running).finally(() => running.service.stop()));
  }

  async function ensureService(runtime: RuntimePaths, port: number, readPaseo?: PaseoRead) {
    while (pendingService) await pendingService;
    if (signal.aborted) throw dashboardUnavailable();
    if (active && sameService(active, runtime, port)) return active;
    return (pendingService = (async () => {
      await releaseService();
      const service = await deps.startDashboard(runtime, port, signal, readPaseo);
      if (signal.aborted || !service.alive()) {
        await service.stop();
        throw dashboardUnavailable();
      }
      const running = { service, runtime, lifetime: new AbortController() };
      active = running;
      void service.closed
        .then(() => {
          if (active === running) return releaseService();
        })
        .catch(() => console.error('[Agent HQ] Could not finish releasing the dashboard.'));
      return running;
    })().finally(() => {
      pendingService = undefined;
    }));
  }

  async function startRoute(
    running: RunningDashboard,
    binary: string,
    tailnet: TailnetHost,
    baseCheck: Parameters<typeof checkRoutes>[1],
    readConfig: () => Promise<unknown>,
  ) {
    const { service, runtime } = running;
    let serve: OwnedProcess | undefined;
    try {
      const remotePort = await service.attachRemote(tailnet);
      const check = { ...baseCheck, remotePort };
      checkRoutes(await readConfig(), check);
      if (signal.aborted || !service.alive()) throw dashboardUnavailable();
      try {
        serve = await deps.startServe(
          runtime,
          binary,
          tailnet.authority,
          remotePort,
          running.lifetime.signal,
        );
      } catch (error) {
        // The daemon checks concurrent config updates. Report any newly visible collision.
        checkRoutes(await readConfig(), check);
        throw error;
      }
      const session = checkRoutes(await readConfig(), { ...check, discoverNewSession: true });
      if (!session || !serve.alive()) throw routeConflict();
      if (signal.aborted || !service.alive()) throw dashboardUnavailable();
      const route = { serve, tailnet, remotePort, session };
      running.route = route;
      void serve.closed.then(() => {
        if (running.route === route) return releaseRoute(running);
      });
      return route;
    } catch (error) {
      try {
        await serve?.stop();
      } finally {
        if (service.alive()) await service.detachRemote().catch(() => undefined);
      }
      throw error;
    }
  }

  async function attemptBrowser(
    input: () => Promise<LaunchInputs>,
    install: boolean,
    readPaseo?: PaseoRead,
  ): Promise<BrowserStart> {
    try {
      if (signal.aborted) throw dashboardUnavailable();
      const inputs = await input();
      const runtime = await deps.runtimePaths(inputs.directory, signal, install);
      const binary = deps.findTailscale();
      const readConfig = () =>
        deps.readTailscaleJson(binary, ['serve', 'status', '--json'], signal);
      const status = await deps.readTailscaleJson(binary, ['status', '--json'], signal);
      const tailnet = readTailnetHost(status);
      const port = deps.localPort();
      const check = { authority: tailnet.authority, localPort: port, legacyUrl: inputs.legacyUrl };
      const url = `https://${tailnet.authority}`;
      const route = active?.route;
      if (
        active &&
        route &&
        sameService(active, runtime, port) &&
        route.serve.alive() &&
        route.tailnet.authority === tailnet.authority &&
        route.tailnet.ownerLogin === tailnet.ownerLogin
      ) {
        const running = active;
        const session = checkRoutes(await readConfig(), {
          ...check,
          remotePort: route.remotePort,
          ownSession: route.session,
        });
        if (signal.aborted) throw dashboardUnavailable();
        if (session && running.service.alive() && route.serve.alive()) {
          return { ok: true, url, running, route };
        }
      }

      await releaseRoute(active);
      checkRoutes(await readConfig(), check);
      await deps.requireFreeTailnetPort(tailnet.addresses);
      const running = await ensureService(runtime, port, readPaseo);
      const startedRoute = await startRoute(running, binary, tailnet, check, readConfig);
      return { ok: true, url, running, route: startedRoute };
    } catch (error) {
      await releaseRoute(active);
      return failure(error);
    }
  }

  function prepareBrowser(input: () => Promise<LaunchInputs>, readPaseo?: PaseoRead) {
    if (pendingBrowser) return pendingBrowser;
    const ready = attemptBrowser(input, false, readPaseo).finally(() => {
      pendingBrowser = undefined;
    });
    return (pendingBrowser = { ready, response: ready.then(launchResult) });
  }

  async function nativeService(
    input: () => Promise<NativeInputs>,
    install: boolean,
    readPaseo: PaseoRead,
  ) {
    if (signal.aborted) throw dashboardUnavailable();
    const inputs = await input();
    const port = deps.localPort();
    const running = active;
    if (
      running?.service.alive() &&
      running.runtime.directory === inputs.directory &&
      running.service.port === port
    ) {
      return running;
    }
    const runtime = await deps.runtimePaths(inputs.directory, signal, install);
    return ensureService(runtime, port, readPaseo);
  }

  function install<T>(
    attempt: () => Promise<T>,
    finish: (result: T) => void,
    failed: (error: unknown) => void,
  ) {
    const previous = pendingInstall;
    const job = (async () => {
      await previous;
      return attempt();
    })()
      .then(finish, failed)
      .finally(() => {
        if (pendingInstall === job) pendingInstall = undefined;
      });
    pendingInstall = job;
  }

  return {
    async native(
      input: () => Promise<NativeInputs>,
      request: NativeRequest,
      readPaseo: PaseoRead,
    ): Promise<NativeResult> {
      if (pendingInstall && !active?.service.alive()) return runtimeInstalling().result();
      try {
        const running = await nativeService(input, false, readPaseo);
        return await running.service.native(request);
      } catch (error) {
        return failure(error);
      }
    },
    launch(
      input: () => Promise<LaunchInputs>,
      readPaseo?: PaseoRead,
    ): Promise<DashboardLaunchResult> {
      if (pendingInstall) return Promise.resolve(runtimeInstalling().result());
      return prepareBrowser(input, readPaseo).response;
    },
    async browserHandoff(
      input: () => Promise<LaunchInputs>,
      readPaseo?: PaseoRead,
    ): Promise<BrowserHandoffResult> {
      if (pendingInstall) return runtimeInstalling().result();
      try {
        const result = await prepareBrowser(input, readPaseo).ready;
        if (!result.ok) return result;
        const { running, route, url } = result;
        const stillReady = () =>
          active === running &&
          running.route === route &&
          running.service.alive() &&
          route.serve.alive();
        if (!stillReady()) throw dashboardUnavailable();
        const { ticket, expiresAt } = await running.service.issueBrowserTicket();
        const validForMs = Math.min(120_000, expiresAt - Date.now());
        if (!stillReady() || validForMs <= 0) throw dashboardUnavailable();
        return { ok: true, url, ticket, validForMs };
      } catch (error) {
        return failure(error);
      }
    },
    startRuntimeInstall(
      input: () => Promise<LaunchInputs>,
      readPaseo?: PaseoRead,
    ): RuntimeInstallStatus {
      if (signal.aborted) return { state: 'finished', result: dashboardUnavailable().result() };
      if (installStatus.state === 'installing') return installStatus;
      installStatus = { state: 'installing' };
      const previous = pendingBrowser?.response;
      const finish = (result: DashboardLaunchResult) => {
        installStatus = { state: 'finished', result };
      };
      install(
        async () => {
          const result = await previous;
          return result?.ok ? result : launchResult(await attemptBrowser(input, true, readPaseo));
        },
        finish,
        (error) => finish(failure(error)),
      );
      return installStatus;
    },
    runtimeInstallStatus(): RuntimeInstallStatus {
      return installStatus;
    },
    startNativeRuntimeInstall(
      input: () => Promise<NativeInputs>,
      readPaseo: PaseoRead,
    ): NativeRuntimeInstallStatus {
      if (signal.aborted) return { state: 'finished', result: dashboardUnavailable().result() };
      if (nativeInstallStatus.state === 'installing') return nativeInstallStatus;
      nativeInstallStatus = { state: 'installing' };
      install(
        async () => {
          await nativeService(input, true, readPaseo);
          return { ok: true } as const;
        },
        (result) => {
          nativeInstallStatus = { state: 'finished', result };
        },
        (error) => {
          nativeInstallStatus = { state: 'finished', result: failure(error) };
        },
      );
      return nativeInstallStatus;
    },
    nativeRuntimeInstallStatus(): NativeRuntimeInstallStatus {
      return nativeInstallStatus;
    },
    async stop(): Promise<void> {
      lifetime.abort();
      await Promise.allSettled([
        releaseService(),
        pendingService,
        pendingBrowser?.response,
        pendingInstall,
      ]);
    },
  };
}
