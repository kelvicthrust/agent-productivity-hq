import { createHash } from 'node:crypto';
import { isRecord } from './files.ts';
import { unsupported } from './errors.ts';
import type { CapturePaths } from './paths.ts';
import { statusLineOf, type Json, type SettingsRead } from './settings.ts';
import type { CaptureState } from './state.ts';
import { buildWrapper, isWrapper, previousCommandOf } from './wrapper.ts';

export type PreviewNote =
  | 'footer_hints_hidden'
  | 'project_status_lines_override'
  | 'previous_status_line_kept'
  | 'compact_usage_line_shown';

export const SAMPLE_STATUS_ROW = '5h 23% · 7d 41%';

export interface CapturePlan {
  action: 'install';
  settingsPath: string;
  resolvedSettingsPath: string;
  settingsFileExists: boolean;
  current: Json | null;
  next: Json;
  wrapperCommand: string;
  previousStatusLine: Json | null;
  previousCommand: string | null;
  notes: PreviewNote[];
  sampleStatusRow: string | null;
  previewDigest: string;
}

/** A known wrapper is repaired from its saved original, or from the shell fallback if its record was lost. */
function previousOf(current: Json | null, state: CaptureState | null, path: string): Json | null {
  if (current === null) return null;
  const command = current['command'] as string;
  if (!isWrapper(command)) return current;
  if (state?.wrapper === command) return state.previousStatusLine;
  const inside = previousCommandOf(command);
  if (inside === undefined) throw unsupported(path);
  return inside === null ? null : { ...current, command: inside };
}

export function buildPlan({
  read,
  state,
  paths,
  node,
  keepPrepared = false,
}: {
  read: SettingsRead;
  state: CaptureState | null;
  paths: CapturePaths;
  node: string;
  keepPrepared?: boolean;
}): CapturePlan {
  const pending =
    keepPrepared &&
    state?.v === 2 &&
    state.phase === 'awaiting_edit' &&
    state.expectedStatusLine !== null
      ? state
      : null;
  const observed = read.value['statusLine'];
  const current = pending === null ? statusLineOf(read) : isRecord(observed) ? observed : null;
  const previous =
    pending === null ? previousOf(current, state, read.path) : pending.previousStatusLine;
  const rawCommand = previous === null ? null : (previous['command'] as string);
  const previousCommand = rawCommand !== null && rawCommand.trim() !== '' ? rawCommand : null;
  const wrapperCommand =
    pending?.wrapper ?? buildWrapper({ node, script: paths.script, previousCommand });
  const next: Json = pending?.expectedStatusLine ?? {
    ...(previous ?? { type: 'command' }),
    command: wrapperCommand,
  };
  const notes: PreviewNote[] = ['footer_hints_hidden', 'project_status_lines_override'];
  notes.push(previousCommand === null ? 'compact_usage_line_shown' : 'previous_status_line_kept');

  return {
    action: 'install',
    settingsPath: read.path,
    resolvedSettingsPath: read.realPath,
    settingsFileExists: read.exists,
    current,
    next,
    wrapperCommand,
    previousStatusLine: previous,
    previousCommand,
    notes,
    sampleStatusRow: previousCommand === null ? SAMPLE_STATUS_ROW : null,
    previewDigest: createHash('sha256')
      .update(JSON.stringify([read.path, read.realPath, observed, next]))
      .digest('hex'),
  };
}
