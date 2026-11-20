import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  AddRepoResponse,
  Repo,
  RepoDiscoveryResponse,
  ReposResponse,
  type AddRepoRequest,
  type GithubRepoAccount,
} from '../../shared/contracts/repos';
import type { AccountStatus } from '../../shared/contracts/sources';
import { ApiRequestError, apiGet, apiSend } from './api';
import { invalidateServerState, queryKeys } from './queryClient';

// Where the repository manager reads and writes. The list is server state: TanStack Query, under the same key the filter
// bar's repo list uses (`analytics` › `repos`), so adding or stopping a repo refreshes the filter, every number and the
// coverage strip with it (`invalidateServerState`). Nothing is copied into component state.

/** While a repo's first pass runs the merged-PR count grows; read it again this often until it is done. */
const FIRST_PASS_POLL_MS = 3000;

export type AddedRepo = z.infer<typeof AddRepoResponse>;
type RepoList = z.infer<typeof ReposResponse>;

/** True while a readable, tracked repo has not finished its first full read of merged PRs. */
function firstPassRunning(list: RepoList | undefined): boolean {
  return (list?.active ?? []).some((repo) => repo.accessState === 'ok' && !repo.backfillComplete);
}

export function useRepoList(poll = true) {
  return useQuery({
    queryKey: queryKeys.analytics('repos'),
    queryFn: ({ signal }) => apiGet('/api/repos', ReposResponse, { signal }),
    refetchInterval: (query) =>
      poll && firstPassRunning(query.state.data) ? FIRST_PASS_POLL_MS : false,
  });
}

/** `owner/name` as the two path parts the routes take; the slash between them is the route's, not an encoded one. */
function repoPath(id: string): string {
  const [owner = '', name = ''] = id.split('/');
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** What the API said about a failed call, in the parts the screen shows. */
export interface Problem {
  message: string;
  /** `repo_inaccessible` from the App route: where the owner adds an installation. Only ever a github.com address. */
  installUrl?: string;
  /** `github_app_required`: the one-time App setup (the GitHub section) is what to do next. */
  needsApp?: boolean;
  needsGithub?: boolean;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The message for one named field of a 400 (`details.fields.input`), when the server named it. */
function fieldMessage(
  details: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const fields = details?.['fields'];
  return typeof fields === 'object' && fields !== null
    ? text((fields as Record<string, unknown>)[field])
    : undefined;
}

export function problemOf(error: unknown, fallback: string): Problem {
  if (!(error instanceof ApiRequestError)) return { message: fallback };
  const message = fieldMessage(error.details, 'input') ?? text(error.message) ?? fallback;
  switch (error.code) {
    case 'repo_inaccessible': {
      const installUrl = text(error.details?.['installUrl']);
      return installUrl?.startsWith('https://github.com/') ? { message, installUrl } : { message };
    }
    case 'github_app_required':
      return { message, needsApp: true, needsGithub: true };
    case 'github_not_connected':
      return { message, needsGithub: true };
    default:
      return { message };
  }
}

const discoveryKey = (account: GithubRepoAccount) =>
  ['repo-discovery', account.via, account.login.toLowerCase()] as const;

export function githubRepoAccount(account: AccountStatus | undefined): GithubRepoAccount | null {
  if (account?.status !== 'connected' && account?.status !== 'existing') return null;
  const { login, via } = account;
  return login && (via === 'gh' || via === 'app') ? { login, via } : null;
}

export function useRepoDiscovery(account: GithubRepoAccount) {
  return useInfiniteQuery({
    queryKey: discoveryKey(account),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ ...account, page: String(pageParam) });
      return apiGet(`/api/repos/discover?${query}`, RepoDiscoveryResponse, { signal });
    },
    getNextPageParam: (last) => last.nextPage ?? undefined,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/** Add by name or URL, with the account and repository identity when a picker row was selected. */
export function useAddRepo() {
  const client = useQueryClient();
  return useMutation<AddedRepo, unknown, string | AddRepoRequest>({
    mutationFn: (selection) =>
      apiSend(
        'POST',
        '/api/repos',
        AddRepoResponse,
        typeof selection === 'string' ? { input: selection } : selection,
      ),
    onSuccess: (repo) => {
      client.setQueryData<RepoList>(
        queryKeys.analytics('repos'),
        (list) =>
          list && {
            active: [
              ...(list.active ?? []).filter((candidate) => candidate.id !== repo.id),
              repo,
            ].sort((a, b) => a.displayName.localeCompare(b.displayName)),
            stopped: (list.stopped ?? []).filter((candidate) => candidate.id !== repo.id),
          },
      );
      void invalidateServerState(client).catch(() => undefined);
    },
    onError: (error, selection) => {
      if (
        !(error instanceof ApiRequestError) ||
        typeof selection === 'string' ||
        !selection.githubAccount
      )
        return;
      if (error.code === 'already_tracked') {
        void client.invalidateQueries({ queryKey: queryKeys.analytics('repos') });
      }
      if (error.code === 'github_account_changed' || error.code === 'github_not_connected') {
        void client.invalidateQueries({ queryKey: queryKeys.sources });
        void client.resetQueries({ queryKey: discoveryKey(selection.githubAccount), exact: true });
      }
    },
  });
}

export function useStopTracking() {
  const client = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: (id) => apiSend('DELETE', repoPath(id), null),
    onSuccess: () => invalidateServerState(client).catch(() => undefined),
  });
}

/** "Check again": the repo as GitHub answers now, readable or not (it is a 200 either way). */
export function useRecheckRepo() {
  const client = useQueryClient();
  return useMutation<Repo, unknown, string>({
    mutationFn: (id) => apiSend('POST', `${repoPath(id)}/recheck`, Repo),
    onSuccess: () => invalidateServerState(client).catch(() => undefined),
  });
}

/** The repository filter lists active repositories, including ones the connection cannot read. */
export function useRepos() {
  return useQuery({
    queryKey: queryKeys.analytics('repos'),
    queryFn: ({ signal }) => apiGet('/api/repos', ReposResponse, { signal }),
    select: (response) => response.active ?? [],
  });
}
