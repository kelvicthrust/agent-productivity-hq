import { z } from 'zod';
import { Instant, Int } from './common.ts';

export const Repo = z.object({
  id: z.string(),
  displayName: z.string(),
  githubNodeId: z.string().nullable().optional(),
  trackingState: z.enum(['active', 'stopped']),
  accessState: z.enum(['ok', 'inaccessible', 'unknown']),
  accessError: z.string().nullable().optional(),
  mergedPrsLast12Months: Int.optional(),
  backfillComplete: z.boolean().optional(),
  lastSyncSuccessAt: Instant.nullable().optional(),
  stoppedAt: Instant.nullable().optional(),
});
export type Repo = z.infer<typeof Repo>;

export const ReposResponse = z.object({
  active: z.array(Repo).optional(),
  stopped: z.array(Repo).optional(),
});

export const GithubRepoAccount = z.object({
  login: z.string().min(1).max(100),
  via: z.enum(['gh', 'app']),
});
export type GithubRepoAccount = z.infer<typeof GithubRepoAccount>;

export const DiscoveredRepo = z.object({
  displayName: z.string(),
  nodeId: z.string().min(1).max(256),
  pushedAt: Instant.nullable(),
  visibility: z.enum(['public', 'private', 'internal']),
  trackingState: z.enum(['untracked', 'active', 'stopped']),
  trackedRepoId: z.string().nullable(),
});
export type DiscoveredRepo = z.infer<typeof DiscoveredRepo>;

export const RepoDiscoveryResponse = z.object({
  repositories: z.array(DiscoveredRepo),
  nextPage: Int.positive().nullable(),
});
export type RepoDiscoveryResponse = z.infer<typeof RepoDiscoveryResponse>;

export const AddRepoRequest = z.object({
  input: z.string().max(300),
  githubAccount: GithubRepoAccount.optional(),
  repositoryNodeId: DiscoveredRepo.shape.nodeId.optional(),
});
export type AddRepoRequest = z.infer<typeof AddRepoRequest>;

export const AddRepoResponse = Repo.extend({ reactivated: z.boolean().optional() });
