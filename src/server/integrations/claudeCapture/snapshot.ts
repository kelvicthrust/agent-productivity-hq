import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

// The snapshot the hook writes (schema v1) and the one reader the dashboard has for it. The hook is
// plain JavaScript with no dependencies, so it cannot share this schema: it writes exactly these fields and nothing else, and
// this reader refuses anything that is not them.

/** The latest second a plausible time can name (the end of year 9999). Keeps `× 1000` a safe integer. */
export const MAX_EPOCH_SECONDS = 253_402_300_799;

const Epoch = z.number().int().min(0).max(MAX_EPOCH_SECONDS);
const Window = z.object({
  used_percentage: z.number().min(0),
  resets_at: Epoch,
});

/** `v` is checked strictly (an unknown version is refused, not guessed at); the rest tolerates a field the hook left out. */
export const ClaudeSnapshotSchema = z.object({
  v: z.literal(1),
  /** When a window was last updated, or null when none has ever arrived (the `no_limits` case). */
  captured_at: Epoch.nullish().transform((value) => value ?? null),
  /** When the hook last ran, even when Claude Code sent no `rate_limits`. */
  invoked_at: Epoch.nullish().transform((value) => value ?? null),
  claude_version: z
    .string()
    .max(40)
    .nullish()
    .transform((value) => value ?? null),
  /** A window is null when never reported or already reset. */
  five_hour: Window.nullish().transform((value) => value ?? null),
  seven_day: Window.nullish().transform((value) => value ?? null),
});

export type ClaudeSnapshot = z.infer<typeof ClaudeSnapshotSchema>;

export type SnapshotRead =
  /** No file: capture is off, or the hook has not run yet. */
  | { kind: 'absent' }
  /** A file that is not valid JSON, has an unknown `v` or the wrong shape. */
  | { kind: 'invalid' }
  | { kind: 'ok'; snapshot: ClaudeSnapshot };

export function readSnapshot(path: string): SnapshotRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'invalid' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  const parsed = ClaudeSnapshotSchema.safeParse(json);
  return parsed.success ? { kind: 'ok', snapshot: parsed.data } : { kind: 'invalid' };
}

/**
 * A short string that changes whenever the file is replaced (the hook renames a new file over it), or null when there is none.
 * The collector runs on each refresh and again when this changes ("when the file's mtime changes").
 */
export function snapshotStamp(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}
