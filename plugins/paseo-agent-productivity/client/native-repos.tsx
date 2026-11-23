import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { colors } from '../shared/reporting-palette.ts';
import type { DiscoveredRepo, GithubRepoAccount, Repo } from './native-types.ts';
import {
  requestMessage,
  useNativeAction,
  useNativePoll,
  type NativeRequest,
} from './native-api.ts';
import { formatInstant, int } from './native-report-details.tsx';
import { ReportIcon, ReportText } from './native-session.tsx';
import {
  NativeActions,
  NativeButton,
  NativeCard,
  NativeInput,
  NativeProblem,
  NativeRow,
  NativeText,
} from './native-ui.tsx';

const accessLabels: Record<Repo['accessState'], string> = {
  ok: 'Access confirmed',
  inaccessible: 'Inaccessible',
  unknown: 'Access not checked yet',
};

function RepositoryPicker({
  account,
  active,
  request,
  onAdded,
  inSources = false,
}: {
  account: GithubRepoAccount;
  active: Repo[];
  request: NativeRequest;
  onAdded(repo: Repo): void;
  inSources?: boolean;
}) {
  const [input, setInput] = useState('');
  const [repositories, setRepositories] = useState<DiscoveredRepo[]>([]);
  const [page, setPage] = useState(1);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [looking, setLooking] = useState(true);
  const [searchProblem, setSearchProblem] = useState<string>();
  const [retry, setRetry] = useState(0);
  const add = useNativeAction();
  const query = input.trim().toLowerCase();
  const { login, via } = account;

  useNativePoll(
    useCallback(
      async (signal: AbortSignal) => {
        setLooking(true);
        setSearchProblem(undefined);
        try {
          // This endpoint pages the authenticated repository list, so search can cover all its pages.
          const result = await request('repoDiscover', { login, via, page });
          if (signal.aborted) return;
          setRepositories((previous) => {
            const known = new Set(previous.map((repo) => repo.nodeId));
            return [...previous, ...result.repositories.filter((repo) => !known.has(repo.nodeId))];
          });
          setNextPage(result.nextPage);
        } catch (error) {
          if (!signal.aborted) setSearchProblem(requestMessage(error));
        } finally {
          if (!signal.aborted) setLooking(false);
        }
      },
      [login, page, request, via],
    ),
    retry,
  );

  useNativePoll(
    useCallback(async () => {
      if (query && !looking && !searchProblem && nextPage !== null && nextPage > page) {
        setPage(nextPage);
      }
    }, [looking, nextPage, page, query, searchProblem]),
  );

  function track(name: string, repositoryNodeId?: string) {
    void add.run(async (signal) => {
      const repo = await request('repoAdd', {
        input: name,
        githubAccount: { login, via },
        ...(repositoryNodeId ? { repositoryNodeId } : {}),
      });
      if (signal.aborted) return;
      onAdded(repo);
      setInput('');
    });
  }

  const matches = repositories.filter((repo) => repo.displayName.toLowerCase().includes(query));
  const trackedIds = new Set(active.map((repo) => repo.id));
  const trackedNodes = new Set(active.map((repo) => repo.githubNodeId));
  const isTracking = (repo: DiscoveredRepo) =>
    (repo.trackedRepoId !== null && trackedIds.has(repo.trackedRepoId)) ||
    trackedIds.has(repo.displayName.toLowerCase()) ||
    trackedNodes.has(repo.nodeId);

  return (
    <NativeRow>
      <NativeText heading>Find a repository</NativeText>
      <NativeInput
        accessibilityLabel="Find a repository"
        placeholder="Search GitHub or enter owner/name"
        maxLength={300}
        value={input}
        onChangeText={setInput}
      />
      {input.includes('/') ? (
        <NativeButton
          label={inSources ? 'Add repository' : 'Track by name or URL'}
          disabled={add.busy}
          onPress={() => track(input.trim())}
        />
      ) : null}
      <NativeProblem message={add.problem ?? searchProblem} />
      {looking ? <NativeText tone="foregroundMuted">Looking at repositories…</NativeText> : null}
      {searchProblem ? (
        <NativeButton label="Retry repository search" onPress={() => setRetry((n) => n + 1)} />
      ) : null}
      {!looking && !searchProblem && !matches.length && nextPage === null ? (
        <NativeText tone="foregroundMuted">
          {query ? 'No matching repositories.' : 'No repositories found.'}
        </NativeText>
      ) : null}
      {matches.map((repo) => (
        <NativeRow key={repo.nodeId}>
          <View
            style={{
              flexDirection: inSources ? 'row' : 'column',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: inSources ? 'center' : 'stretch',
              gap: inSources ? 8 : 6,
            }}
          >
            <View style={{ flexShrink: 1 }}>
              <NativeText>{repo.displayName}</NativeText>
              {inSources && repo.visibility && (
                <ReportText muted size={12}>
                  {repo.visibility[0]?.toUpperCase()}
                  {repo.visibility.slice(1)}
                </ReportText>
              )}
            </View>
            {isTracking(repo) ? (
              <NativeText tone="foregroundMuted">
                {inSources ? 'Tracking' : 'Already tracking'}
              </NativeText>
            ) : (
              <NativeButton
                label={inSources && repo.trackingState === 'stopped' ? 'Track again' : 'Track'}
                accessibilityLabel={`${inSources && repo.trackingState === 'stopped' ? 'Track again' : 'Track'} ${repo.displayName}`}
                disabled={add.busy}
                onPress={() => track(repo.displayName, repo.nodeId)}
              />
            )}
          </View>
        </NativeRow>
      ))}
      {!looking && !searchProblem && nextPage !== null && nextPage > page ? (
        <NativeButton label="Load more repositories" onPress={() => setPage(nextPage)} />
      ) : null}
    </NativeRow>
  );
}

function TrackedRepository({
  repo,
  request,
  onChange,
  onRemove,
  sources,
}: {
  repo: Repo;
  request: NativeRequest;
  onChange(repo: Repo): void;
  onRemove(id: string): void;
  sources?: { compact: boolean; first: boolean };
}) {
  const action = useNativeAction();
  const [confirming, setConfirming] = useState(false);

  function stopTracking() {
    void action.run(async (signal) => {
      await request('repoRemove', { id: repo.id });
      if (!signal.aborted) onRemove(repo.id);
    });
  }

  const check = (
    <NativeButton
      label={sources ? 'Check again' : 'Recheck access'}
      accessibilityLabel={`${sources ? 'Check again' : 'Recheck access'} for ${repo.displayName}`}
      disabled={action.busy}
      onPress={() =>
        void action.run(async (signal) => {
          const checked = await request('repoRecheck', { id: repo.id });
          if (!signal.aborted) onChange(checked);
        })
      }
    />
  );

  if (sources) {
    const okay = repo.accessState === 'ok';
    const statusColor = okay
      ? colors.success
      : repo.accessState === 'inaccessible'
        ? colors.danger
        : colors['text-muted'];
    const prs = repo.mergedPrsLast12Months;
    return (
      <View
        style={{
          borderTopWidth: sources.first ? 0 : 1,
          borderTopColor: colors.border,
          paddingTop: sources.first ? 0 : 12,
          paddingBottom: 12,
          gap: 10,
        }}
      >
        <View
          style={{
            flexDirection: sources.compact ? 'column' : 'row',
            alignItems: 'flex-start',
            columnGap: 24,
            rowGap: 8,
          }}
        >
          <View style={{ width: sources.compact ? undefined : 220, gap: 4 }}>
            <ReportText strong size={14}>
              {repo.displayName}
            </ReportText>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <ReportIcon name={okay ? 'check' : 'circle'} size={14} color={statusColor} />
              <ReportText strong size={12} color={statusColor}>
                {okay ? 'Collecting' : accessLabels[repo.accessState]}
              </ReportText>
            </View>
          </View>
          <View style={{ flex: sources.compact ? undefined : 1, minWidth: 0 }}>
            {prs === undefined ? null : (
              <ReportText muted size={12}>
                {int(prs)} merged {prs === 1 ? 'PR' : 'PRs'} in the last 12 months
              </ReportText>
            )}
            <NativeProblem message={action.problem ?? repo.accessError ?? undefined} />
          </View>
          <NativeActions>
            {!okay && check}
            <NativeButton
              label="Stop tracking"
              accessibilityLabel={`Stop tracking ${repo.displayName}`}
              disabled={action.busy || confirming}
              onPress={() => setConfirming(true)}
            />
          </NativeActions>
        </View>
        {confirming && (
          <View
            accessibilityLabel={`Confirm stop tracking ${repo.displayName}`}
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              padding: 12,
              gap: 8,
              borderRadius: 8,
              backgroundColor: colors['danger-surface'],
            }}
          >
            <View style={{ flexGrow: 1, flexBasis: 240, minWidth: 0 }}>
              <ReportText size={12} strong>
                Stop tracking {repo.displayName}?
              </ReportText>
              <ReportText size={12}>
                Collection stops and it leaves the overview. Imported history stays on this machine
                for 12 months, so tracking it again restores it.
              </ReportText>
            </View>
            <NativeActions>
              <NativeButton
                label="Cancel"
                disabled={action.busy}
                onPress={() => setConfirming(false)}
              />
              <NativeButton
                label={action.busy ? 'Stopping…' : 'Stop tracking'}
                style={{ backgroundColor: colors.danger, borderColor: colors.danger }}
                primary
                disabled={action.busy}
                onPress={stopTracking}
              />
            </NativeActions>
          </View>
        )}
      </View>
    );
  }

  return (
    <NativeRow>
      <NativeText heading>{repo.displayName}</NativeText>
      <NativeText tone="foregroundMuted" announce>
        {accessLabels[repo.accessState]}
      </NativeText>
      <NativeProblem message={action.problem ?? repo.accessError ?? undefined} />
      <NativeActions>
        {check}
        <NativeButton
          label="Stop tracking"
          accessibilityLabel={`Stop tracking ${repo.displayName}`}
          disabled={action.busy}
          onPress={stopTracking}
        />
      </NativeActions>
    </NativeRow>
  );
}

export function NativeRepos({
  account,
  request,
  mode = 'setup',
  compact = true,
  timezone,
  onReposChange,
}: {
  account: GithubRepoAccount | null;
  request: NativeRequest;
  mode?: 'setup' | 'sources';
  compact?: boolean;
  timezone?: string;
  onReposChange?(): void;
}) {
  const inSources = mode === 'sources';
  const [active, setActive] = useState<Repo[]>();
  const [stopped, setStopped] = useState<Repo[]>([]);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [retry, setRetry] = useState(0);

  useNativePoll(
    useCallback(
      async (signal: AbortSignal) => {
        setProblem(undefined);
        try {
          const result = await request('repos');
          if (!signal.aborted) {
            setActive(result.active ?? []);
            if (inSources) setStopped(result.stopped ?? []);
          }
        } catch (error) {
          if (!signal.aborted) setProblem(requestMessage(error));
        }
      },
      [inSources, request],
    ),
    retry,
  );

  function upsert(repo: Repo) {
    setActive((previous) =>
      [...(previous ?? []).filter((item) => item.id !== repo.id), repo].sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
    );
    if (inSources) setStopped((previous) => previous.filter((item) => item.id !== repo.id));
    onReposChange?.();
  }

  const picker =
    account && active ? (
      <RepositoryPicker
        key={`${account.via}:${account.login}`}
        account={account}
        active={active}
        request={request}
        onAdded={upsert}
        inSources={inSources}
      />
    ) : null;

  const listed =
    inSources && active
      ? [...active].sort(
          (left, right) =>
            Number(left.accessState === 'inaccessible') -
            Number(right.accessState === 'inaccessible'),
        )
      : active;

  return (
    <NativeCard
      title={inSources ? 'Tracked repositories' : 'Choose repositories to track'}
      headingAccessory={
        inSources ? (
          <NativeButton
            label={adding ? 'Close repository picker' : 'Add repository'}
            onPress={() => setAdding(!adding)}
          />
        ) : undefined
      }
    >
      {inSources ? (
        <ReportText muted size={12}>
          Merged PRs come only from repos listed here
        </ReportText>
      ) : (
        <NativeText tone="foregroundMuted">
          Merged pull requests come only from the repositories you track.
        </NativeText>
      )}
      {inSources &&
        adding &&
        (picker ??
          (!account && <NativeText>Connect GitHub in Accounts to add repositories.</NativeText>))}
      {!inSources && !account ? (
        <NativeText>
          Connect GitHub to add repositories, or finish setup and connect later.
        </NativeText>
      ) : null}
      <NativeProblem message={problem} />
      {problem ? (
        <NativeButton label="Retry tracked repositories" onPress={() => setRetry((n) => n + 1)} />
      ) : null}
      {active === undefined && !problem ? (
        <NativeText tone="foregroundMuted">Loading tracked repositories…</NativeText>
      ) : null}
      {active?.length === 0 ? (
        <NativeText tone="foregroundMuted">No repositories tracked yet.</NativeText>
      ) : null}
      <View style={{ gap: inSources ? 0 : 10 }}>
        {listed?.map((repo, index) => (
          <TrackedRepository
            key={repo.id}
            repo={repo}
            request={request}
            onChange={upsert}
            sources={inSources ? { compact, first: index === 0 } : undefined}
            onRemove={(id) => {
              setActive((previous) => previous?.filter((item) => item.id !== id));
              if (inSources) setRetry((value) => value + 1);
              onReposChange?.();
            }}
          />
        ))}
      </View>
      {!inSources && picker}
      {inSources && stopped.length > 0 && (
        <View style={{ gap: 8 }}>
          <View>
            <ReportText strong>Previously tracked</ReportText>
            <ReportText muted size={12}>
              History is kept on this machine within the 12-month window.
            </ReportText>
          </View>
          {stopped.map((repo) => (
            <StoppedRepository
              key={repo.id}
              repo={repo}
              request={request}
              timezone={timezone}
              compact={compact}
              onTrack={upsert}
            />
          ))}
        </View>
      )}
    </NativeCard>
  );
}

function StoppedRepository({
  repo,
  request,
  timezone,
  compact,
  onTrack,
}: {
  repo: Repo;
  request: NativeRequest;
  timezone?: string;
  compact: boolean;
  onTrack(repo: Repo): void;
}) {
  const action = useNativeAction();
  return (
    <View
      style={{
        flexDirection: compact ? 'column' : 'row',
        alignItems: 'flex-start',
        columnGap: 24,
        rowGap: 8,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingTop: 12,
      }}
    >
      <View style={{ width: compact ? undefined : 220, gap: 4 }}>
        <ReportText size={14} strong>
          {repo.displayName}
        </ReportText>
        <ReportText size={12} muted>
          Stopped
        </ReportText>
      </View>
      <View style={{ flex: compact ? undefined : 1, minWidth: 0 }}>
        <ReportText muted size={12}>
          {repo.mergedPrsLast12Months === undefined
            ? 'Imported history retained'
            : `${int(repo.mergedPrsLast12Months)} merged ${repo.mergedPrsLast12Months === 1 ? 'PR' : 'PRs'} retained`}
          {repo.stoppedAt && timezone
            ? ` · stopped ${formatInstant(repo.stoppedAt, timezone)}`
            : ''}
        </ReportText>
        <NativeProblem message={action.problem} />
      </View>
      <NativeButton
        label="Track again"
        accessibilityLabel={`Track again ${repo.displayName}`}
        disabled={action.busy}
        onPress={() =>
          void action.run(async (signal) => {
            const updated = await request('repoAdd', { input: repo.displayName });
            if (!signal.aborted) onTrack(updated);
          })
        }
      />
    </View>
  );
}
