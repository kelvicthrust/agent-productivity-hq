import { Button } from '@astryxdesign/core/Button';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { DiscoveredRepo, GithubRepoAccount } from '../../shared/contracts/repos';
import { parseRepoInput } from '../../shared/domain/repoInput';
import { ApiRequestError } from '../lib/api';
import { SOURCES_COPY } from '../lib/copy';
import { queryKeys } from '../lib/queryClient';
import {
  problemOf,
  useAddRepo,
  useRepoDiscovery,
  useRepoList,
  type AddedRepo,
  type Problem,
} from '../lib/repos';
import { Icon } from './Icon';

const BUTTON = 'max-[719px]:min-h-11 aria-disabled:cursor-default';
const FALLBACK = 'Couldn’t check this repository. Try again.';

function isChangedConnection(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.code === 'github_account_changed' ||
      error.code === 'github_not_connected' ||
      error.code === 'github_app_required')
  );
}

function PickerProblem({
  id,
  problem,
  onNeedsGithub,
}: {
  id?: string;
  problem: Problem;
  onNeedsGithub?: (() => void) | undefined;
}) {
  return (
    <div
      id={id}
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-danger"
    >
      <span>{problem.message}</span>
      {problem.installUrl && (
        <Button
          label="Open your GitHub App installations"
          href={problem.installUrl}
          target="_blank"
          rel="noopener noreferrer"
          size="sm"
          variant="secondary"
          className={BUTTON}
        />
      )}
      {problem.needsGithub && onNeedsGithub && (
        <Button
          label="Go to GitHub connection"
          size="sm"
          variant="secondary"
          className={BUTTON}
          onClick={onNeedsGithub}
        />
      )}
    </div>
  );
}

function PickerRow({
  repo,
  trackingState,
  account,
  onNeedsGithub,
  onTracked,
}: {
  repo: DiscoveredRepo;
  trackingState: DiscoveredRepo['trackingState'];
  account: GithubRepoAccount;
  onNeedsGithub?: (() => void) | undefined;
  onTracked?: ((repo: AddedRepo) => void) | undefined;
}) {
  const add = useAddRepo();
  const problemId = useId();
  const tracked = trackingState === 'active';
  const pending = add.isPending;
  const problem = add.isError && !tracked ? problemOf(add.error, FALLBACK) : null;
  const label = tracked
    ? 'Tracking'
    : pending
      ? 'Tracking…'
      : trackingState === 'stopped'
        ? 'Track again'
        : 'Track';
  return (
    <li className="flex min-w-0 flex-col gap-1.5 border-b border-border py-2 last:border-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0 text-copy text-ink">
          <div className="font-semibold [overflow-wrap:anywhere]">{repo.displayName}</div>
          <div className="text-caption text-ink-muted capitalize">{repo.visibility}</div>
        </div>
        <Button
          label={label}
          aria-label={`${label} ${repo.displayName}`}
          size="sm"
          variant={tracked ? 'ghost' : 'secondary'}
          icon={<Icon name={tracked ? 'check' : pending ? 'spinner' : 'plus'} />}
          aria-busy={pending || undefined}
          aria-disabled={tracked || pending || undefined}
          aria-describedby={problem ? problemId : undefined}
          className={`${BUTTON} shrink-0`}
          onClick={() => {
            if (!tracked && !pending)
              add.mutate(
                { input: repo.displayName, githubAccount: account, repositoryNodeId: repo.nodeId },
                { onSuccess: onTracked },
              );
          }}
        />
      </div>
      {problem && <PickerProblem id={problemId} problem={problem} onNeedsGithub={onNeedsGithub} />}
      <span className="sr-only" role="status">
        {add.isSuccess && tracked ? `Tracking ${repo.displayName}` : ''}
      </span>
    </li>
  );
}

export function RepoPicker({
  account,
  inputRef,
  focusSearch = false,
  onNeedsGithub,
  onTracked,
}: {
  account: GithubRepoAccount;
  inputRef?: RefObject<HTMLInputElement | null>;
  focusSearch?: boolean;
  onNeedsGithub?: () => void;
  onTracked?: (repo: AddedRepo) => void;
}) {
  const headingId = useId();
  const fieldId = useId();
  const localInput = useRef<HTMLInputElement>(null);
  const input = inputRef ?? localInput;
  const [search, setSearch] = useState('');
  const { data, error, fetchNextPage, hasNextPage, isFetching, isPending, refetch } =
    useRepoDiscovery(account);
  const list = useRepoList(false).data;
  const client = useQueryClient();
  const add = useAddRepo();
  const parsed = parseRepoInput(search);
  const slug = parsed.ok ? `${parsed.owner}/${parsed.name}` : null;
  const filter = (slug ?? search.trim()).toLowerCase();
  const connectionChanged = isChangedConnection(error) || isChangedConnection(add.error);

  useEffect(() => {
    if (focusSearch) input.current?.focus();
  }, [focusSearch, input]);

  useEffect(() => {
    if (filter && hasNextPage && !isFetching && !error && !connectionChanged) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [filter, hasNextPage, isFetching, error, connectionChanged, fetchNextPage]);

  useEffect(() => {
    if (connectionChanged) void client.invalidateQueries({ queryKey: queryKeys.sources });
  }, [client, connectionChanged]);

  const repositories = useMemo(() => {
    const unique = new Map<string, DiscoveredRepo>();
    for (const page of data?.pages ?? []) {
      for (const repo of page.repositories) {
        if (!unique.has(repo.nodeId)) unique.set(repo.nodeId, repo);
      }
    }
    return [...unique.values()];
  }, [data]);
  const tracked = useMemo(() => {
    const byId = new Map(
      (list?.active ?? []).concat(list?.stopped ?? []).map((repo) => [repo.id, repo]),
    );
    const byNode = new Map(
      [...byId.values()]
        .filter((repo) => repo.githubNodeId)
        .map((repo) => [repo.githubNodeId, repo]),
    );
    return { byId, byNode };
  }, [list]);

  const matching = connectionChanged
    ? []
    : repositories.filter((repo) => repo.displayName.toLowerCase().includes(filter));
  const rank = (repo: DiscoveredRepo) => {
    const name = repo.displayName.toLowerCase();
    if (name === filter) return 0;
    return name.split('/')[1] === filter ? 1 : 2;
  };
  if (filter) matching.sort((a, b) => rank(a) - rank(b));
  const exact = matching.some((repo) => repo.displayName.toLowerCase() === filter);
  const currentEntry = typeof add.variables !== 'string' && add.variables?.input === search.trim();
  const directProblem = currentEntry && add.isError ? problemOf(add.error, FALLBACK) : null;
  const directTracking =
    currentEntry && add.isSuccess && tracked.byId.get(add.data.id)?.trackingState === 'active';
  const directLabel = add.isPending
    ? SOURCES_COPY.repos.adding
    : directTracking
      ? `Tracking ${add.data.displayName}`
      : slug
        ? `Track ${slug} directly`
        : 'Track by name or URL';
  const directEntry = slug !== null || /[/@]/.test(search);
  const searchingMore = filter !== '' && hasNextPage && !error && !connectionChanged;
  const retryPage = () => {
    if (hasNextPage) void fetchNextPage({ cancelRefetch: false });
    else void refetch();
  };

  function trackDirect() {
    if (add.isPending || directTracking || connectionChanged) return;
    add.mutate(
      { input: search.trim(), githubAccount: account },
      { onSuccess: onTracked, onError: () => input.current?.focus() },
    );
  }

  return (
    <section
      aria-label="Repository picker"
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border px-3 py-3 sm:px-4"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-label font-semibold text-ink">
          Find a repository
        </label>
        <input
          ref={input}
          id={fieldId}
          type="search"
          autoComplete="off"
          spellCheck={false}
          className="h-11 w-full min-w-0 rounded-sm border border-control-border bg-surface px-3 text-[16px] text-ink placeholder:text-ink-muted min-[720px]:h-8 min-[720px]:text-copy aria-invalid:border-danger"
          placeholder="Search by name or paste a GitHub URL"
          value={search}
          aria-invalid={directProblem !== null || undefined}
          aria-describedby={directProblem ? `${fieldId}-problem` : undefined}
          onChange={(event) => {
            setSearch(event.target.value);
            if (!add.isPending) add.reset();
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              slug &&
              !exact &&
              !isFetching &&
              !searchingMore
            ) {
              event.preventDefault();
              trackDirect();
            }
          }}
        />
        {directEntry && !connectionChanged && (!exact || add.isPending || directProblem) && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              label={directLabel}
              icon={<Icon name={add.isPending ? 'spinner' : directTracking ? 'check' : 'plus'} />}
              size="sm"
              variant="secondary"
              aria-busy={add.isPending || undefined}
              aria-disabled={add.isPending || directTracking || undefined}
              className={`${BUTTON} max-w-full whitespace-normal [overflow-wrap:anywhere]`}
              onClick={trackDirect}
            />
          </div>
        )}
        {directProblem && (
          <PickerProblem
            id={`${fieldId}-problem`}
            problem={directProblem}
            onNeedsGithub={onNeedsGithub}
          />
        )}
        <p role="status" className="sr-only">
          {add.isSuccess ? `Tracking ${add.data.displayName}` : ''}
        </p>
      </div>
      <h3 id={headingId} className="text-label font-semibold text-ink">
        {filter ? 'Matching repositories' : 'Recently pushed repositories'}
      </h3>
      {matching.length > 0 && (
        <div
          role="region"
          aria-labelledby={headingId}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          className="max-h-80 overflow-y-auto overscroll-contain px-1"
        >
          <ul>
            {matching.map((repo) => {
              const saved =
                tracked.byNode.get(repo.nodeId) ??
                (repo.trackedRepoId ? tracked.byId.get(repo.trackedRepoId) : undefined);
              return (
                <PickerRow
                  key={repo.nodeId}
                  repo={repo}
                  account={account}
                  onNeedsGithub={onNeedsGithub}
                  onTracked={onTracked}
                  trackingState={saved?.trackingState ?? repo.trackingState}
                />
              );
            })}
          </ul>
        </div>
      )}
      <div role="status" className="text-caption text-ink-muted">
        {isPending
          ? 'Loading repositories from GitHub…'
          : searchingMore
            ? 'Searching more repositories…'
            : !error && matching.length === 0
              ? filter
                ? 'No matching repositories.'
                : 'GitHub returned no repositories.'
              : null}
      </div>
      {error && (
        <div className="flex flex-col items-start gap-1.5">
          <PickerProblem
            problem={problemOf(error, 'Couldn’t load repositories from GitHub.')}
            onNeedsGithub={onNeedsGithub}
          />
          <Button
            label="Try again"
            size="sm"
            variant="secondary"
            className={BUTTON}
            onClick={retryPage}
          />
        </div>
      )}
      {!filter && hasNextPage && !error && !connectionChanged && (
        <Button
          label={isFetching ? 'Loading more repositories…' : 'Load more repositories'}
          size="sm"
          variant="secondary"
          className={`${BUTTON} self-start`}
          aria-disabled={isFetching || undefined}
          onClick={() => {
            if (!isFetching) retryPage();
          }}
        />
      )}
    </section>
  );
}
