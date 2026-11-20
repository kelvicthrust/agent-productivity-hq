// Types for claude-hook.mjs, so tests can call its pure functions. The script itself stays plain JavaScript with no build step: it
// is copied byte for byte into the data folder and run by Node.

export const DEADLINE_MS: number;
export const MAX_STDIN_BYTES: number;
export interface HookMessage {
  hook_event_name: string;
  session_id: string;
  notification_type?: string;
  reason?: string;
  cwd?: string;
}
export function messageFor(input: unknown): HookMessage | null;
export const MAX_REGISTRY_BYTES: number;
export function isTrustedRegistry(stat: {
  isFile(): boolean;
  size: number;
  uid: number;
  mode: number;
}): boolean;
export function parseRegistryBytes(
  bytes: Buffer,
): { pid: number; port: number; token: string } | null;
export function findApp(dir: string): Promise<{ port: number; token: string } | null>;
export function post(
  app: { port: number; token: string },
  message: HookMessage,
  timeoutMs?: number,
): Promise<void>;
export function runHook(options: {
  dir: string;
  stdin: Buffer | null;
  timeoutMs?: number;
}): Promise<void>;
