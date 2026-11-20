import { z } from 'zod';
import { Instant } from './common.ts';

export const LinkRebuildResult = z.enum(['pending', 'succeeded', 'failed', 'interrupted']);
export type LinkRebuildResult = z.infer<typeof LinkRebuildResult>;

export const LinkHealth = z.object({
  state: z.enum(['fresh', 'stale', 'unavailable']),
  lastSuccessfulAt: Instant.nullable(),
});
export type LinkHealth = z.infer<typeof LinkHealth>;
