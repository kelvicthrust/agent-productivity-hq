import type { DashboardLaunchResult } from '../shared/rpc.ts';

type LaunchFailure = Extract<DashboardLaunchResult, { ok: false }>;

export class LaunchError extends Error {
  readonly reason: LaunchFailure['reason'];

  constructor(reason: LaunchFailure['reason'], message: string) {
    super(message);
    this.reason = reason;
  }

  result(): LaunchFailure {
    return { ok: false, reason: this.reason, message: this.message };
  }
}

export const routeConflict = () =>
  new LaunchError(
    'route-conflict',
    'A Tailscale Serve or Funnel route conflicts with Agent HQ. On the dashboard host, stop the old Ports share or clear the conflicting route, then try again.',
  );

export const dashboardUnavailable = () =>
  new LaunchError(
    'dashboard-unavailable',
    'Agent HQ did not start. Check the Paseo plugin logs and stop any older dashboard running on the host, then try again.',
  );

export const runtimeRequired = () =>
  new LaunchError(
    'runtime-required',
    'This host needs Node.js 22.x (22.16.0+) or any stable 24.0.0+. Install the private runtime to download Node.js from nodejs.org on the Paseo host and open the dashboard.',
  );

export const runtimeInstalling = () =>
  new LaunchError(
    'runtime-installing',
    'Installing the private Node.js runtime on the Paseo host…',
  );

export const runtimeInstallFailed = (
  message = 'Could not install the private Node.js runtime. Check that the Paseo host can reach nodejs.org and has space, then retry.',
) => new LaunchError('runtime-install-failed', message);

export const tailscaleUnavailable = () =>
  new LaunchError(
    'tailscale-unavailable',
    'Tailscale Serve did not become available. Check that Tailscale is connected and HTTPS is enabled on the dashboard host, then try again.',
  );
