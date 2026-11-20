import { z } from 'zod';
import { Instant, Int, LinkClass, Provider, Scope } from './common.ts';
import { UsageCoverage, DeliveryCoverage } from './common.ts';
import { LinkHealth } from './link-health.ts';
import { Session } from './usage.ts';

export const PullRequest = z.object({
  /** The GitHub node id. */
  id: z.string(),
  repo: z.string(),
  number: Int,
  title: z.string(),
  url: z.url(),
  mergedAt: Instant,
  author: z.string().nullable(),
  mergedBy: z.string().nullable(),
  authoredByMe: z.boolean(),
  linkClass: LinkClass,
  /** Evidence plus owner links. */
  linkedSessionCount: Int,
  suggestedCount: Int,
  providers: z.array(Provider),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const EvidenceItem = z.object({
  session: Session,
  effectiveClass: z.enum(['evidence', 'owner', 'suggested', 'rejected']),
  /** The computed claim, kept even when the owner overrides it. */
  sourceClass: z.enum(['evidence', 'suggested']).nullable().optional(),
  basis: z.enum(['pr_reference', 'commit_match', 'same_branch', 'same_repo_window', 'owner']),
  basisText: z.string(),
  actions: z.array(z.enum(['confirm', 'dismiss', 'reject', 'restore', 'remove'])),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const PrsResponse = z.object({
  scope: Scope.optional(),
  linkHealth: LinkHealth,
  counts: z
    .object({
      all: Int.optional(),
      evidence: Int.optional(),
      owner: Int.optional(),
      suggested: Int.optional(),
      unlinked: Int.optional(),
    })
    .optional(),
  items: z.array(PullRequest).optional(),
  nextCursor: z.string().nullable().optional(),
  inaccessibleRepos: z.array(z.string()).optional(),
});

export const PrDetailResponse = z.object({
  pr: PullRequest.optional(),
  evidence: z.array(EvidenceItem).optional(),
  /** Local sessions in the same repo up to 3 days before the merge, not already listed. */
  candidates: z.array(Session).max(30).optional(),
});

export const LinkDecisionRequest = z.object({
  decision: z.enum(['confirmed', 'rejected', 'dismissed']),
});

export const RecordsResponse = z.object({
  scope: Scope.optional(),
  prs: z.array(PullRequest).optional(),
  prTotal: Int.optional(),
  sessions: z.array(Session).optional(),
  sessionTotal: Int.optional(),
  coverage: z
    .object({
      codex: UsageCoverage.optional(),
      claude: UsageCoverage.optional(),
      delivery: DeliveryCoverage.optional(),
    })
    .optional(),
});
