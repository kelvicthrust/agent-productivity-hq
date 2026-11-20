import { z } from 'zod';
import { DateString, DeliveryCoverage, Int, Scope, TokenCount, UsageCoverage } from './common.ts';

export const Bucket = z.object({
  start: DateString,
  end: DateString,
  label: z.string(),
  short: z.string(),
  /** True when the bucket is clipped by the selected range. */
  partOfRange: z.boolean().optional(),
  /** null when delivery is none or future. */
  prs: Int.nullable(),
  delivery: DeliveryCoverage,
  tokens: z.object({ codex: TokenCount.optional(), claude: TokenCount.optional() }),
  usage: z.object({
    codex: UsageCoverage.optional(),
    claude: UsageCoverage.optional(),
    rail: UsageCoverage.optional(),
  }),
});
export type Bucket = z.infer<typeof Bucket>;

export const SeriesResponse = z.object({
  scope: Scope,
  buckets: z.array(Bucket),
  unavailableText: z.string().nullable().optional(),
});
export type SeriesResponse = z.infer<typeof SeriesResponse>;

export const YearResponse = z.object({
  start: DateString,
  today: DateString,
  /** date → merged PRs; an absent date is a covered zero. */
  counts: z.record(z.string(), Int),
  total: Int,
  daysWithMerge: Int,
  busiestDay: z
    .object({ date: DateString.optional(), count: Int.optional() })
    .nullable()
    .optional(),
  delivery: DeliveryCoverage.optional(),
});
export type YearResponse = z.infer<typeof YearResponse>;
