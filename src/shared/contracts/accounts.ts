import { z } from 'zod';
import { AccountStatus } from './sources.ts';
import { Instant } from './common.ts';

export { AccountReport } from './account-report.ts';

export const AccountParam = z.enum(['github', 'chatgpt', 'claude']);
export const DisconnectableAccount = z.enum(['github', 'chatgpt']);

export const ConnectResponse = z.object({
  loginId: z.string().nullable().optional(),
  mode: z.enum(['existing', 'browser', 'device']).optional(),
  authUrl: z.url().nullable().optional(),
  userCode: z.string().nullable().optional(),
  verificationUri: z.url().nullable().optional(),
  expiresAt: Instant.nullable().optional(),
});

export const ConnectPollResponse = z.object({
  state: z.enum(['pending', 'connected', 'failed', 'expired', 'cancelled']).optional(),
  account: AccountStatus.optional(),
  message: z.string().nullable().optional(),
});

export const GithubAppRequest = z
  .object({
    clientId: z
      .string()
      .max(40)
      .regex(/^[A-Za-z0-9.]+$/),
  })
  .strict();

export const CapturePreviewAction = z.literal('remove');
export type CapturePreviewAction = z.infer<typeof CapturePreviewAction>;

const StatusLine = z.record(z.string(), z.unknown());

export const UsageCapturePreview = z.object({
  action: z.literal('remove'),
  settingsPath: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      exists: z.boolean(),
      current: z.unknown(),
      next: StatusLine.nullable(),
      hookReferenced: z.boolean(),
    }),
  ),
  backupPath: z.string().nullable(),
});

export const UsageCaptureRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('begin_remove') }),
  z.strictObject({ action: z.literal('verify_remove') }),
]);
export type CaptureRequest = z.infer<typeof UsageCaptureRequest>;

export const UsageCaptureResponse = z.object({ account: AccountStatus });

export const ClaudePlanLimitsCheckRequest = z.strictObject({
  mode: z.literal('refresh').optional(),
});
export type ClaudePlanLimitsCheckRequest = z.infer<typeof ClaudePlanLimitsCheckRequest>;
export const ClaudePlanLimitsCheckResponse = z.object({ account: AccountStatus });
