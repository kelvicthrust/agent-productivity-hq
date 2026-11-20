import { rmSync } from 'node:fs';
import { z } from 'zod';
import { readIfPresent, writePrivateFile } from './files.ts';
import { generationSnapshot, type CapturePaths } from './paths.ts';

const StateFields = z.object({
  settingsPath: z.string(),
  node: z.string(),
  script: z.string(),
  wrapper: z.string(),
  previousStatusLine: z.record(z.string(), z.unknown()).nullable(),
  backupPath: z.string().nullable(),
  installedAt: z.number().int(),
});
const LegacyState = StateFields.extend({ v: z.literal(1) });
const ManualState = StateFields.extend({
  v: z.literal(2),
  snapshotId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullable(),
  phase: z.enum(['awaiting_edit', 'active', 'awaiting_removal']),
  settingsRealPath: z.string().nullable(),
  expectedStatusLine: z.record(z.string(), z.unknown()).nullable(),
  retired: z.literal(true).optional(),
});
const StateSchema = z.discriminatedUnion('v', [LegacyState, ManualState]);

export type CaptureState = z.infer<typeof StateSchema>;
export type ManualCaptureState = z.infer<typeof ManualState>;

export class InvalidCaptureState extends Error {}

export function readState(paths: CapturePaths): CaptureState | null {
  try {
    const raw = readIfPresent(paths.state);
    if (raw === null) return null;
    const state = StateSchema.parse(JSON.parse(raw.toString('utf8')));
    return state;
  } catch {
    throw new InvalidCaptureState('The saved Claude capture record can’t be read.');
  }
}

export function activeSnapshotPath(paths: CapturePaths): string | null {
  try {
    const state = readState(paths);
    if (state?.v !== 2 || state.phase !== 'active' || state.snapshotId === null) return null;
    return generationSnapshot(paths, state.snapshotId);
  } catch {
    return null;
  }
}

export function writeState(paths: CapturePaths, state: ManualCaptureState): void {
  writePrivateFile(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function removeState(paths: CapturePaths): void {
  rmSync(paths.state, { force: true });
}
