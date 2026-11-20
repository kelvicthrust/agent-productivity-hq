import { z } from 'zod';
import { DeliveryCoverage, Instant, Int, Provider, Scope, TokenCount } from './common.ts';
import { AccountReport } from './accounts.ts';
import { LinkHealth } from './link-health.ts';
import { PullRequest } from './prs.ts';
import { AccountStatus, SourceStatus } from './sources.ts';
import { ProviderKpi } from './usage.ts';

export const OverviewResponse = z.object({
  scope: Scope,
  linkHealth: LinkHealth,
  kpis: z.object({
    mergedPrs: z
      .object({
        value: Int.nullable().optional(),
        delivery: DeliveryCoverage.optional(),
        previous: z
          .object({
            label: z.string().optional(),
            value: Int.nullable().optional(),
            outsideLookback: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    linkedPrs: z
      .object({
        value: Int.nullable().optional(),
        of: Int.nullable().optional(),
        suggestedOnly: Int.optional(),
      })
      .optional(),
    localTokens: z
      .object({ codex: ProviderKpi.optional(), claude: ProviderKpi.optional() })
      .strict()
      .optional(),
    rootSessions: z
      .object({
        value: Int.nullable().optional(),
        unknownRelationship: Int.optional(),
        crew: z.array(Provider).max(10).optional(),
      })
      .optional(),
    childAgents: z
      .object({
        value: Int.nullable().optional(),
        paseo: Int.optional(),
        native: Int.optional(),
        crew: z.array(Provider).max(10).optional(),
      })
      .optional(),
  }),
  coverage: z.object({
    sources: z.array(SourceStatus).optional(),
    github: z.object({ tracked: Int.optional(), inaccessible: Int.optional() }).optional(),
    accounts: z.array(AccountStatus).optional(),
    lastRefreshAt: Instant.nullable().optional(),
    refreshFailed: z.boolean().optional(),
  }),
  /** ChatGPT contributes its saved seven-day Codex quota when available. */
  accounts: z.array(AccountReport),
  repoRows: z.array(
    z.object({
      group: z.enum(['tracked', 'untracked', 'unknown']).optional(),
      repo: z.string().nullable().optional(),
      accessState: z.string().optional(),
      mergedPrs: Int.nullable().optional(),
      linkedPrs: Int.nullable().optional(),
      tokens: z.object({ codex: TokenCount.optional(), claude: TokenCount.optional() }).optional(),
      rootSessions: Int.optional(),
    }),
  ),
  recentPrs: z.array(PullRequest).max(6),
  periodMergedCount: Int.optional(),
  /** Every in-scope source covered the whole elapsed range and there were no events or merges (the quiet panel). */
  trueZero: z.boolean().optional(),
});
export type OverviewResponse = z.infer<typeof OverviewResponse>;
