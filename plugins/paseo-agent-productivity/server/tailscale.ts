import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createServer, isIP } from 'node:net';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { isTailnetHttpsOrigin } from '../shared/dashboard.ts';
import { LaunchError, routeConflict, tailscaleUnavailable } from './errors.ts';

export const dashboardHttpsPort = 4317;

const executeFile = promisify(execFile);

export function findTailscale(): string {
  const candidates = [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(isAbsolute)
      .map((directory) => join(directory, 'tailscale')),
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ];
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      continue;
    }
  }
  throw new LaunchError(
    'tailscale-unavailable',
    'Install Tailscale on the dashboard host and sign in.',
  );
}

const tailnetStatus = z.object({
  BackendState: z.literal('Running'),
  Self: z.object({
    DNSName: z.string(),
    UserID: z.int().positive(),
    TailscaleIPs: z.array(z.string().refine((ip) => isIP(ip) !== 0)).min(1),
    Tags: z.array(z.string()).nullish(),
  }),
  User: z.record(z.string(), z.object({ LoginName: z.string() })),
  CertDomains: z.array(z.string()).nullish(),
});

export interface TailnetHost {
  authority: string;
  ownerLogin: string;
  addresses: string[];
}

export function readTailnetHost(value: unknown): TailnetHost {
  const parsed = tailnetStatus.safeParse(value);
  if (!parsed.success) throw tailscaleUnavailable();
  const { Self, User, CertDomains } = parsed.data;
  const name = Self.DNSName.toLowerCase().replace(/\.$/, '');
  const authority = `${name}:${dashboardHttpsPort}`;
  const ownerLogin = User[String(Self.UserID)]?.LoginName;
  if (
    Self.Tags?.length ||
    !ownerLogin ||
    !/^[!-~]+$/.test(ownerLogin) ||
    ownerLogin.includes(',')
  ) {
    throw new LaunchError(
      'tailscale-unavailable',
      'Sign the dashboard host in to Tailscale as its owner using an untagged device.',
    );
  }
  if (!isTailnetHttpsOrigin(`https://${authority}`) || !CertDomains?.includes(name)) {
    throw new LaunchError(
      'tailscale-unavailable',
      'Enable MagicDNS and HTTPS certificates for this tailnet in the Tailscale admin console.',
    );
  }
  return { authority, ownerLogin, addresses: Self.TailscaleIPs };
}

const tcp = z.strictObject({
  HTTPS: z.boolean().optional(),
  HTTP: z.boolean().optional(),
  TCPForward: z.string().optional(),
  TerminateTLS: z.string().optional(),
  ProxyProtocol: z.number().optional(),
});

const handler = z.strictObject({
  Proxy: z.string().optional(),
  Text: z.string().optional(),
  Path: z.string().optional(),
  Redirect: z.string().optional(),
  AcceptAppCaps: z.array(z.string()).optional(),
});

const hostPort = z.string().regex(/^.+:\d{1,5}$/);
const routes = {
  TCP: z.record(z.string().regex(/^\d{1,5}$/), tcp).optional(),
  Web: z.record(hostPort, z.strictObject({ Handlers: z.record(z.string(), handler) })).optional(),
};

const serveRoutes = z.strictObject({
  ...routes,
  AllowFunnel: z.record(hostPort, z.boolean()).optional(),
});

const serveConfig = serveRoutes.extend({
  Foreground: z.record(z.string(), serveRoutes).optional(),
  Services: z
    .record(z.string(), z.strictObject({ ...routes, Tun: z.boolean().optional() }))
    .optional(),
});

type ServeConfig = z.infer<typeof serveConfig>;
type ServeRoutes = z.infer<typeof serveRoutes>;

function parsedConfig(value: unknown): ServeConfig {
  // Tailscale has emitted both null and {} when it has no Serve configuration.
  const parsed = serveConfig.safeParse(value === null ? {} : value);
  if (!parsed.success) throw tailscaleUnavailable();
  return parsed.data;
}

function targetPort(target: string): number | undefined {
  if (target.startsWith('unix:')) return;
  if (/^\d+$/.test(target)) return Number(target);
  const address = target.includes('://') ? target : `http://${target}`;
  try {
    const parsed = new URL(address.replace(/^https\+insecure:/, 'https:'));
    return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  } catch {
    throw tailscaleUnavailable();
  }
}

function usesTargetPort(routes: ServeRoutes, ports: readonly number[]): boolean {
  const targets = [
    ...Object.values(routes.TCP ?? {}).map((entry) => entry.TCPForward),
    ...Object.values(routes.Web ?? {}).flatMap((entry) =>
      Object.values(entry.Handlers).map((handler) => handler.Proxy),
    ),
  ];
  return targets.some((target) => {
    const port = target ? targetPort(target) : undefined;
    return port !== undefined && ports.includes(port);
  });
}

function usesListenPort(routes: ServeRoutes, ports: readonly number[]): boolean {
  const hosts = [
    ...Object.keys(routes.Web ?? {}),
    ...Object.entries(routes.AllowFunnel ?? {})
      .filter(([, enabled]) => enabled)
      .map(([authority]) => authority),
  ];
  return (
    Object.keys(routes.TCP ?? {}).some((port) => ports.includes(Number(port))) ||
    hosts.some((authority) =>
      ports.includes(Number(authority.slice(authority.lastIndexOf(':') + 1))),
    )
  );
}

function usesLegacyOrigin(routes: ServeRoutes, legacyUrl: string): boolean {
  if (!legacyUrl || !isTailnetHttpsOrigin(legacyUrl)) return false;
  const { hostname, port } = new URL(legacyUrl);
  const legacyPort = port || '443';
  const authority = `${hostname}:${legacyPort}`;
  return (
    Object.hasOwn(routes.TCP ?? {}, legacyPort) ||
    Object.keys(routes.Web ?? {}).some((key) => key.toLowerCase() === authority) ||
    Object.entries(routes.AllowFunnel ?? {}).some(
      ([key, enabled]) => enabled && key.toLowerCase() === authority,
    )
  );
}

function isExactRoute(config: ServeRoutes, authority: string, remotePort: number): boolean {
  const tcpEntries = Object.entries(config.TCP ?? {});
  const webEntries = Object.entries(config.Web ?? {});
  if (tcpEntries.length !== 1 || webEntries.length !== 1) return false;
  const [port, tcpHandler] = tcpEntries[0]!;
  const [host, webServer] = webEntries[0]!;
  const handlers = Object.entries(webServer.Handlers);
  return (
    port === String(dashboardHttpsPort) &&
    Object.keys(tcpHandler).length === 1 &&
    tcpHandler.HTTPS === true &&
    host === authority &&
    handlers.length === 1 &&
    handlers[0]![0] === '/' &&
    Object.keys(handlers[0]![1]).length === 1 &&
    handlers[0]![1].Proxy === `http://127.0.0.1:${remotePort}` &&
    !Object.values(config.AllowFunnel ?? {}).some(Boolean)
  );
}

interface RouteCheck {
  authority: string;
  legacyUrl: string;
  localPort: number;
  remotePort?: number;
  ownSession?: string;
  discoverNewSession?: boolean;
}

/** A newly acknowledged foreground command owns one exact config; nothing existing is adopted. */
export function checkRoutes(value: unknown, check: RouteCheck): string | undefined {
  const { authority, legacyUrl, localPort, remotePort, ownSession, discoverNewSession } = check;
  const config = parsedConfig(value);
  const targetPorts = [
    dashboardHttpsPort,
    localPort,
    ...(remotePort === undefined ? [] : [remotePort]),
  ];
  const conflictingNodeRoute = (routes: ServeRoutes) =>
    usesListenPort(routes, [dashboardHttpsPort]) ||
    usesTargetPort(routes, targetPorts) ||
    usesLegacyOrigin(routes, legacyUrl);
  if (conflictingNodeRoute(config)) throw routeConflict();
  // Service listeners have distinct virtual IPs. Their proxy targets can still reach the dashboard.
  if (Object.values(config.Services ?? {}).some((routes) => usesTargetPort(routes, targetPorts))) {
    throw routeConflict();
  }
  let exact: string | undefined;
  for (const [session, routes] of Object.entries(config.Foreground ?? {})) {
    if (
      !exact &&
      remotePort !== undefined &&
      (session === ownSession || discoverNewSession) &&
      isExactRoute(routes, authority, remotePort)
    ) {
      exact = session;
    } else if (conflictingNodeRoute(routes)) {
      throw routeConflict();
    }
  }
  if ((ownSession || discoverNewSession) && !exact) throw routeConflict();
  return exact;
}

export async function readTailscaleJson(
  binary: string,
  args: string[],
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const { stdout } = await executeFile(binary, args, {
      signal,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  } catch {
    throw tailscaleUnavailable();
  }
}

export async function requireFreeTailnetPort(addresses: readonly string[]): Promise<void> {
  for (const address of addresses) {
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(routeConflict()));
      probe.listen(dashboardHttpsPort, address, () => probe.close(() => resolve()));
    });
  }
}
