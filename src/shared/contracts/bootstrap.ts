import { z } from 'zod';
import { DateString, Int } from './common.ts';

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  schemaVersion: Int,
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const BootstrapIssue = z.object({
  kind: z.enum(['source', 'account', 'repo']).optional(),
  id: z.string().optional(),
  label: z.string().optional(),
});

export const BootstrapResponse = z.object({
  setupComplete: z.boolean(),
  timezone: z.string(),
  today: DateString,
  lookbackStart: DateString,
  githubLogin: z.string().nullable().optional(),
  greetingName: z.string().nullable().optional(),
  paseoManaged: z.literal(true).optional(),
  issues: z.array(BootstrapIssue),
});
export type BootstrapResponse = z.infer<typeof BootstrapResponse>;
