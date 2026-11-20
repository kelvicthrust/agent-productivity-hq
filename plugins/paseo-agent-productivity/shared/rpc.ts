import { defineRpc, type RpcOutput } from '@getpaseo/plugin';
import { z } from 'zod';

const dashboardLaunchResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), url: z.string() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'tailscale-unavailable',
      'route-conflict',
      'dashboard-unavailable',
      'runtime-required',
      'runtime-installing',
      'runtime-install-failed',
    ]),
    message: z.string(),
  }),
]);

export const launchDashboard = defineRpc({
  name: 'dashboard.launch',
  input: z.strictObject({}),
  output: dashboardLaunchResult,
});

export const runtimeInstall = defineRpc({
  name: 'dashboard.runtime-install',
  input: z.strictObject({ action: z.enum(['start', 'status']) }),
  output: z.discriminatedUnion('state', [
    z.object({ state: z.literal('idle') }),
    z.object({ state: z.literal('installing') }),
    z.object({ state: z.literal('finished'), result: dashboardLaunchResult }),
  ]),
});

export type DashboardLaunchResult = RpcOutput<typeof launchDashboard>;
export type RuntimeInstallStatus = RpcOutput<typeof runtimeInstall>;
