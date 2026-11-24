import { defineRpc, type RpcOutput } from '@getpaseo/plugin';
import { z } from 'zod';

const dashboardLaunchFailure = z.object({
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
});

const dashboardLaunchResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), url: z.string() }),
  dashboardLaunchFailure,
]);

export const launchDashboard = defineRpc({
  name: 'dashboard.launch',
  input: z.strictObject({}),
  output: dashboardLaunchResult,
});

export const browserTicket = z.object({
  ticket: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/),
  expiresAt: z.int().positive(),
});

export const browserHandoffTicket = z.object({
  ticket: browserTicket.shape.ticket,
  validForMs: z.int().positive().max(120_000),
});

export const browserHandoff = defineRpc({
  name: 'dashboard.browser-handoff',
  input: z.strictObject({}),
  output: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), url: z.string(), ...browserHandoffTicket.shape }),
    dashboardLaunchFailure,
  ]),
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
export type BrowserHandoffResult = RpcOutput<typeof browserHandoff>;
export type RuntimeInstallStatus = RpcOutput<typeof runtimeInstall>;
