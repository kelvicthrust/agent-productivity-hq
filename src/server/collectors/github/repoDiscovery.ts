import { z } from 'zod';
import { Instant } from '../../../shared/contracts/common.ts';
import { DiscoveredRepo, type RepoDiscoveryResponse } from '../../../shared/contracts/repos.ts';
import { openSession, type Reply } from './client.ts';
import type { GithubAuth, NetFetch } from './ports.ts';
import { isGithubRepoSlug } from '../../../shared/domain/repoInput.ts';

const Repositories = z.array(
  z.object({
    full_name: z.string().refine(isGithubRepoSlug),
    node_id: DiscoveredRepo.shape.nodeId,
    pushed_at: Instant.nullish(),
    private: z.boolean(),
    visibility: DiscoveredRepo.shape.visibility.optional(),
  }),
);

type Discovery =
  | {
      kind: 'ok';
      repositories: Omit<
        RepoDiscoveryResponse['repositories'][number],
        'trackingState' | 'trackedRepoId'
      >[];
      nextPage: number | null;
    }
  | Extract<Reply, { kind: 'no_credential' | 'rate_limited' | 'unreachable' }>;

/** Read one bounded metadata page. Use the Link header only as a continuation signal, never as a URL. */
export async function discoverRepoPage(
  net: NetFetch,
  auth: GithubAuth,
  now: () => number,
  page: number,
  signal?: AbortSignal,
): Promise<Discovery> {
  const opened = await openSession(net, auth, now);
  if (!opened.ok) return { kind: 'no_credential', failure: opened.failure };
  const reply = await opened.session.get(
    `/user/repos?sort=pushed&direction=desc&per_page=30&page=${page}`,
    signal,
  );
  if (reply.kind === 'no_credential' || reply.kind === 'rate_limited') return reply;
  if (reply.kind !== 'ok') return { kind: 'unreachable' };
  const body = Repositories.safeParse(reply.body);
  if (!body.success) return { kind: 'unreachable' };

  return {
    kind: 'ok',
    repositories: body.data.map((repo) => ({
      displayName: repo.full_name,
      nodeId: repo.node_id,
      pushedAt: repo.pushed_at ?? null,
      visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    })),
    nextPage:
      /<[^<>]+>\s*;\s*rel="next"/i.test(reply.headers.get('link') ?? '') &&
      page < Number.MAX_SAFE_INTEGER
        ? page + 1
        : null,
  };
}
