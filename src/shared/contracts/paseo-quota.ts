import { z } from 'zod';
import { Instant, Provider } from './common.ts';

const QuotaSource = z.enum(['paseo', 'direct']);

const PaseoQuotaWindow = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: Instant.nullable(),
  source: QuotaSource,
  refreshedAt: Instant.nullable(),
  stale: z.boolean(),
});
export type PaseoQuotaWindow = z.infer<typeof PaseoQuotaWindow>;

const PaseoProviderQuota = z.object({
  provider: Provider,
  // These fields describe the general seven-day subscription window.
  source: QuotaSource.nullable(),
  usedPercent: z.number().nullable(),
  resetsAt: Instant.nullable(),
  refreshedAt: Instant.nullable(),
  stale: z.boolean(),
  canCheck: z.boolean(),
  // Additional weekly model, feature or surface windows retain their own labels and provenance.
  windows: z.array(PaseoQuotaWindow),
});
export type PaseoProviderQuota = z.infer<typeof PaseoProviderQuota>;

export const PaseoQuotaResponse = z.object({ providers: z.array(PaseoProviderQuota) });
export type PaseoQuotaResponse = z.infer<typeof PaseoQuotaResponse>;
