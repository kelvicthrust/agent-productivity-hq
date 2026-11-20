import { z } from 'zod';

export const ERROR_CODES = [
  'invalid_input',
  'invalid_range',
  'forbidden_origin',
  'not_found',
  'already_tracked',
  'refresh_running',
  'reset_in_progress',
  'repo_inaccessible',
  'github_not_connected',
  'github_app_required',
  'github_account_changed',
  'claude_settings_unreadable',
  'claude_statusline_unsupported',
  'claude_settings_conflict',
  'claude_hooks_blocked',
  'claude_hooks_unavailable',
  'claude_hooks_stale',
  'claude_hooks_failed',
  'upstream_unavailable',
  'internal',
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** The HTTP status each code answers with (forbidden_origin is 403 for CSRF and 421 for Host; the guard picks). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  invalid_range: 400,
  forbidden_origin: 403,
  not_found: 404,
  already_tracked: 409,
  refresh_running: 409,
  reset_in_progress: 409,
  repo_inaccessible: 422,
  github_not_connected: 422,
  github_app_required: 422,
  github_account_changed: 409,
  claude_settings_unreadable: 422,
  claude_statusline_unsupported: 422,
  claude_settings_conflict: 409,
  claude_hooks_blocked: 422,
  claude_hooks_unavailable: 422,
  claude_hooks_stale: 409,
  claude_hooks_failed: 500,
  upstream_unavailable: 502,
  internal: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'upstream_unavailable',
  'refresh_running',
  'reset_in_progress',
  'internal',
]);

/** An error a route throws on purpose. The HTTP layer turns it into the envelope; messages are plain English and never carry file content or tokens (P-31). */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code];
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
