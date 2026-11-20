// Types for claude-statusline.mjs, so tests can call its pure functions. The script itself stays plain JavaScript with no
// build step: it is copied byte for byte into the data folder and run by Node.

export interface HookWindow {
  used_percentage: number;
  resets_at: number;
}

export interface HookSnapshot {
  v: 1;
  captured_at: number | null;
  invoked_at: number | null;
  claude_version: string | null;
  five_hour: HookWindow | null;
  seven_day: HookWindow | null;
}

export const SNAPSHOT_FILE: string;
export const CONFIG_FILE: string;
export const CHAIN_TIMEOUT_MS: number;

export function sanitizeSnapshot(value: unknown): HookSnapshot | null;
export function mergeSnapshot(
  existing: HookSnapshot | null,
  input: Record<string, unknown>,
  now: number,
): HookSnapshot;
export function compactLine(snapshot: HookSnapshot, now: number): string;
export function runHook(options: {
  dir: string;
  stdin: Buffer;
  now: number;
  chainTimeoutMs?: number;
  snapshotPath?: string | null;
}): Promise<{ out: Buffer; err: Buffer }>;
