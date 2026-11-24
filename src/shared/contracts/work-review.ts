import { z } from 'zod';
import { DateString, Instant } from './common.ts';

export const WorkReviewEvidence = z.object({
  kind: z.enum(['pr', 'session']),
  id: z.string(),
  label: z.string(),
  date: DateString,
  repo: z.string().nullable(),
  notes: z.array(z.string()).optional(),
});
export type WorkReviewEvidence = z.infer<typeof WorkReviewEvidence>;

export const WorkReviewBullet = z.object({
  kind: z.enum(['shipped', 'team', 'progress', 'open']),
  text: z.string(),
  evidence: z.array(WorkReviewEvidence),
});
export type WorkReviewBullet = z.infer<typeof WorkReviewBullet>;

export const WorkReviewVersion = z.object({
  version: z.int().positive(),
  createdAt: Instant,
  headline: z.string(),
  headlineEvidence: z.array(WorkReviewEvidence),
  bullets: z.array(WorkReviewBullet),
  coverage: z.array(z.string()),
});
export type WorkReviewVersion = z.infer<typeof WorkReviewVersion>;

export const WorkReviewState = z.object({
  status: z.enum(['idle', 'running', 'failed']),
  message: z.string().nullable(),
  review: WorkReviewVersion.nullable(),
  versions: z.array(z.int().positive()),
  changed: z.boolean(),
  locked: z.boolean(),
});
export type WorkReviewState = z.infer<typeof WorkReviewState>;

export const GenerateWorkReview = z.strictObject({
  consent: z.literal(true),
  revision: z.boolean().optional(),
});

export const WorkReviewAccount = z.object({
  status: z.enum(['unavailable', 'disconnected', 'pending', 'connected', 'needs_consent']),
  account: z.string().nullable(),
  message: z.string().nullable(),
});
export type WorkReviewAccount = z.infer<typeof WorkReviewAccount>;
export const WorkReviewConnect = z.object({ url: z.url() });
export type WorkReviewConnect = z.infer<typeof WorkReviewConnect>;
export const WorkReviewConnectRequest = z.strictObject({ newProfile: z.boolean().optional() });
export const WorkReviewDisconnectRequest = z.strictObject({});
