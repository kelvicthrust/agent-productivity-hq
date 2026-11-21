import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

// The launch RPC returns a root HTTPS endpoint on the daemon host’s Tailscale DNS name.
// A matching name alone cannot distinguish Serve from Funnel.
const tailnetOrigin =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net(?::([0-9]{1,5}))?\/?$/i;

export function isTailnetHttpsOrigin(value: string): boolean {
  const match = tailnetOrigin.exec(value);
  if (match?.[0] !== value) return false;
  const port = match[1] === undefined ? 443 : Number(match[1]);
  return port > 0 && port <= 65535;
}

const bindingSchema = z.object({
  // Keep the stored preference readable when rolling back to a workspace-based launcher.
  workspaceId: z.string().trim().default(''),
  // Only identifies the old share during an upgrade. Navigation always uses the launch RPC.
  privateUrl: z
    .string()
    .trim()
    .refine((value) => !value || isTailnetHttpsOrigin(value))
    .default(''),
});

export const dashboardSettings = defineSettings({
  id: 'dashboard',
  scope: 'host',
  version: 2,
  schema: bindingSchema,
  migrate(values, fromVersion) {
    if (fromVersion !== 1) throw new Error('Unsupported launcher settings version.');
    return bindingSchema.parse(values);
  },
});
