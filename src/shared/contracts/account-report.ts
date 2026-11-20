import { z } from 'zod';
import { DateString, Instant, Int } from './common.ts';

export const AccountReport = z.object({
  account: z.enum(['chatgpt', 'claude']),
  unit: z.enum(['tokens', 'percent']),
  periodTokens: Int.nullable().optional(),
  bucketSpan: z
    .object({ start: DateString.optional(), end: DateString.optional() })
    .nullable()
    .optional(),
  rateLimits: z
    .array(
      z.object({
        limitId: z.string(),
        label: z.string().nullable().optional(),
        usedPercent: z.number(),
        windowMinutes: Int.nullable().optional(),
        resetsAt: Instant.nullable().optional(),
      }),
    )
    .optional(),
  scopeLabel: z.string(),
  localSameWindow: Int.nullable().optional(),
  windowDiffers: z.boolean().optional(),
  refreshedAt: Instant,
  stale: z.boolean().optional(),
  provenance: z.enum(['claude_code_oauth', 'claude_statusline']).optional(),
});
export type AccountReport = z.infer<typeof AccountReport>;
