import { ApiError } from '../../../shared/contracts/errors.ts';

export const CAPTURE_ERROR_CODES = [
  'claude_settings_conflict',
  'claude_settings_unreadable',
  'claude_statusline_unsupported',
] as const;

export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number];

export class CaptureError extends ApiError {
  constructor(code: CaptureErrorCode, message: string, settingsPath?: string) {
    super(code, message, settingsPath === undefined ? {} : { details: { settingsPath } });
    this.name = 'CaptureError';
  }
}

export const conflict = (
  settingsPath: string,
  message = 'Claude Code’s settings changed. Review the preview again.',
): CaptureError => new CaptureError('claude_settings_conflict', message, settingsPath);

export const unreadable = (settingsPath: string): CaptureError =>
  new CaptureError(
    'claude_settings_unreadable',
    'Claude Code’s settings file can’t be read, so nothing was changed.',
    settingsPath,
  );

export const unsupported = (settingsPath: string): CaptureError =>
  new CaptureError(
    'claude_statusline_unsupported',
    'Your Claude Code status line isn’t a command, so the dashboard can’t run it alongside its own. Nothing was changed.',
    settingsPath,
  );
