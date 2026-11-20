import { z } from 'zod';
import { DateString, Instant, Int, Provider, Scope, UsageCoverage } from './common.ts';

export const Session = z.object({
  id: Int,
  provider: Provider,
  kind: z.enum(['root', 'child', 'unknown']),
  relationshipLabel: z
    .enum(['Root session', 'Native subagent', 'Paseo child agent', 'Unknown relationship'])
    .optional(),
  /** The recorded name, else the relationship label. Never invented. */
  nameLead: z.string(),
  named: z.boolean(),
  nameSource: z.enum(['provider_title', 'paseo']).nullable().optional(),
  paseo: z
    .object({ agentId: z.string().optional(), workspace: z.string().nullable().optional() })
    .nullable()
    .optional(),
  /** The shortened id shown as "Session ID:". */
  providerSessionRef: z.string(),
  repo: z.string().nullable().optional(),
  repoGroup: z.enum(['tracked', 'untracked', 'unknown']).optional(),
  model: z.string().optional(),
  /** provider_total within the requested scope. */
  tokens: Int,
  /** The one session time the UI shows, labelled "Started". Set once from the source; retention never moves it later. */
  startedAt: Instant,
  startedBasis: z.enum(['source_start', 'first_event']),
  firstEventAt: Instant,
  lastEventAt: Instant,
  parentId: Int.nullable().optional(),
  childCount: Int.optional(),
  linkStatus: z.enum([
    'linked',
    'unlinked',
    'repo_not_tracked',
    'repo_unknown',
    'prs_not_collected',
  ]),
  linkedPrs: z.array(
    z.object({
      prId: z.string(),
      repo: z.string(),
      number: Int,
      /** When the PR merged: the Usage tree's `#number` link opens Delivery on that day, so the PR is on the page it lands on. */
      mergedAt: Instant,
      class: z.enum(['evidence', 'owner', 'suggested']),
    }),
  ),
});
export type Session = z.infer<typeof Session>;

export const UsageCategoriesResponse = z.object({
  scope: Scope.optional(),
  codex: z
    .object({
      coverage: UsageCoverage.optional(),
      coveredFrom: DateString.nullable().optional(),
      sessions: Int.optional(),
      input: Int.optional(),
      /** A subset of input. */
      cachedInput: Int.optional(),
      output: Int.optional(),
      /** A subset of output. */
      reasoning: Int.optional(),
      /** input + output. */
      total: Int.optional(),
    })
    .optional(),
  claude: z
    .object({
      coverage: UsageCoverage.optional(),
      coveredFrom: DateString.nullable().optional(),
      sessions: Int.optional(),
      inputUncached: Int.optional(),
      cacheWrite: Int.optional(),
      cacheRead: Int.optional(),
      output: Int.optional(),
      /** The sum of the four. */
      total: Int.optional(),
    })
    .optional(),
  paseoNote: z.string().nullable().optional(),
});

export const UsageGroupsResponse = z.object({
  scope: Scope.optional(),
  groups: z
    .array(
      z.object({
        /** A repo id, '__untracked' or '__unknown'. */
        key: z.string().optional(),
        label: z.string().optional(),
        note: z.string().nullable().optional(),
        roots: Int.optional(),
        sessions: Int.optional(),
        tokens: z.object({ codex: Int.optional(), claude: Int.optional() }).optional(),
      }),
    )
    .optional(),
});

export const UsageRootsResponse = z.object({
  roots: z.array(Session.extend({ children: z.array(Session).optional() })).optional(),
  orphans: z.array(Session).optional(),
  unknownRelationship: z.array(Session).optional(),
  nextCursor: z.string().nullable().optional(),
  remaining: Int.optional(),
});

export const ProviderKpi = z.object({
  coverage: UsageCoverage,
  /** null when coverage is unavailable or none. */
  value: Int.nullable().optional(),
  note: z.enum(['From <date> only', 'Cached; recent days missing']).nullable().optional(),
  /** The date the note "From <date> only" names; null otherwise. */
  coveredFrom: DateString.nullable().optional(),
});
export type ProviderKpi = z.infer<typeof ProviderKpi>;

export const ModelShare = z.object({
  coverage: UsageCoverage.optional(),
  rows: z
    .array(
      z.object({
        model: z.string().optional(),
        tokens: Int.optional(),
        sessions: Int.optional(),
        sharePercent: Int.optional(),
      }),
    )
    .optional(),
});
export type ModelShare = z.infer<typeof ModelShare>;

export const ModelsResponse = z.object({
  codex: ModelShare.optional(),
  claude: ModelShare.optional(),
});
