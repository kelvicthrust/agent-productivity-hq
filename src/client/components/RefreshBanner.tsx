import { Button } from '@astryxdesign/core/Button';
import { useToast } from '@astryxdesign/core/Toast';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, type ComponentProps } from 'react';
import { Link } from 'react-router';
import type { z } from 'zod';
import { RefreshRun, SourcesResponse, type SourceStatus } from '../../shared/contracts/sources';
import { useClaudePlanLimitsCheck } from '../lib/accounts';
import { ApiRequestError, apiGet, apiSend } from '../lib/api';
import { useBootstrap } from '../lib/bootstrap';
import { BANNER_COPY, REFRESH_COPY, SOURCE_NAMES, recordsOf } from '../lib/copy';
import { formatWhen } from '../lib/format';
import { invalidateServerState, queryKeys } from '../lib/queryClient';
import { sourceRefreshFailed } from '../lib/sourceStatus';
import { Icon } from './Icon';

// The failed-refresh banner, and the refresh machinery it shares with the Sources page (src/client/features/sources).
// The two live together because a feature may import components but a component may not import a feature, and the
// banner's Retry and a Sources row's Retry are one behaviour, not two.
//
// Where each piece of state lives (TECH › State ownership):
//   what each source looks like     TanStack Query, key `queryKeys.sources`, from GET /api/sources
//   whether a refresh is going      the run itself, polled: POST /api/refresh, then GET /api/refresh/{id} every second
//                                   until it is no longer `running`. "Retrying…" lasts exactly that long: no timer pads it.
//   which sources are being retried the pending mutation, which every banner and row reads (`useMutationState`), so a
//                                   Retry pressed in the banner also shows on the Sources row, and the other way round
// A finished run invalidates every server number, so the banner clears (success) or restates its attempt line (failure)
// from fresh data, never from anything this file remembers.

export type SourceId = SourceStatus['id'];
type Sources = z.infer<typeof SourcesResponse>;

/** `sources` omitted means every source (POST /api/refresh). */
export interface RefreshInput {
  sources?: SourceId[] | undefined;
}

const POLL_MS = 1000;
const REFRESH_KEY = ['refresh'] as const;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** While a run is going (a button, the 15-minute timer, the first run at launch) the rows are read again every two seconds. */
const RUNNING_REFETCH_MS = 2000;

export function useSources(enabled = true) {
  return useQuery({
    queryKey: queryKeys.sources,
    queryFn: ({ signal }) => apiGet('/api/sources', SourcesResponse, { signal }),
    enabled,
    refetchInterval: (query) => (query.state.data?.running != null ? RUNNING_REFETCH_MS : false),
  });
}

/**
 * The run the SERVER says is going, whoever started it: the first run at launch and the 15-minute timer start one with no
 * button pressed, so a page that only follows runs its own buttons started would show nothing while a first import goes
 * (G5_9). `GET /api/sources` names the running run; this polls it every second while it runs, and when it ends every number and
 * row is read again. The per-source `message` of a running source is its progress ("Importing 42 of 380 files").
 */
export function useServerRun(): RefreshRun | null {
  const client = useQueryClient();
  const runId = useSources().data?.running ?? null;
  const run = useQuery({
    queryKey: ['refresh-run', runId] as const,
    queryFn: ({ signal }) => apiGet(`/api/refresh/${runId}`, RefreshRun, { signal }),
    enabled: runId !== null,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? POLL_MS : false),
  });
  const state = run.data?.state;
  const pending = useRef(false);
  useEffect(() => {
    if (runId !== null) pending.current = true;
    // Sources can stop reporting a running id before this poll sees the terminal result.
    if (pending.current && (runId === null || (state !== undefined && state !== 'running'))) {
      pending.current = false;
      void invalidateServerState(client).catch(() => undefined);
    }
  }, [runId, state, client]);
  return runId !== null && state === 'running' ? (run.data ?? null) : null;
}

// ---- starting a run and following it ----

/** Starts a run, or, when one is already going (the 15-minute timer, another tab), attaches to that one (409 refresh_running). */
async function startOrAttach(request: RefreshInput): Promise<number> {
  try {
    return (await apiSend('POST', '/api/refresh', RefreshRun, request)).id;
  } catch (error) {
    const running =
      error instanceof ApiRequestError && error.code === 'refresh_running'
        ? error.details?.['runId']
        : undefined;
    if (typeof running === 'number') return running;
    throw error;
  }
}

/** Polls the run until it ends. The first read is immediate; after that, one a second. */
async function followRun(runId: number): Promise<RefreshRun> {
  for (;;) {
    const run = await apiGet(`/api/refresh/${runId}`, RefreshRun);
    if (run.state !== 'running') return run;
    await sleep(POLL_MS);
  }
}

// ---- what to say when it ends ----

// Sentences the designed copy has no line for: a source that fails for the first time, a refresh of everything with a
// failure in it, a run cut short, and a request that never got through.
const COPY = {
  allWithFailures: (sources: string) => `Couldn’t refresh ${sources}. Retry in Sources.`,
  interrupted: 'The refresh was cut short. Nothing was duplicated; try again.',
  linksFailed: 'Couldn’t rebuild pull request links.',
  requestFailed: (reason: string) => `Couldn’t refresh. ${reason}`,
} as const;

const names = (ids: readonly string[]): string =>
  ids.map((id) => SOURCE_NAMES[id as SourceId] ?? id).join(' and ');

const failedBefore = (before: Sources | undefined, id: string): boolean =>
  before?.sources?.some((source) => source.id === id && sourceRefreshFailed(source)) ?? false;

/**
 * The toast for a finished run, from the run's own result and what the source was before it: "failed again" only for a
 * source that was already failing, "recovered" only for one that was.
 */
export function outcomeText(
  run: RefreshRun,
  request: RefreshInput,
  before: Sources | undefined,
): string {
  if (run.state === 'interrupted') return COPY.interrupted;
  const sourceOutcome = sourceOutcomeText(run, request, before);
  return run.linkRebuild === 'failed' ? `${sourceOutcome} ${COPY.linksFailed}` : sourceOutcome;
}

function sourceOutcomeText(
  run: RefreshRun,
  request: RefreshInput,
  before: Sources | undefined,
): string {
  const entries = Object.entries(run.sources);
  const only = request.sources?.length === 1 ? request.sources[0] : undefined;
  if (only) {
    const name = SOURCE_NAMES[only];
    const entry = run.sources[only];
    const alreadyFailed = failedBefore(before, only);
    switch (entry?.state) {
      case 'failed':
        return REFRESH_COPY.toast.failed(name, alreadyFailed);
      case 'partial':
        // A source that says why in a sentence of its own (the GitHub sync: a rate limit, a repo it cannot read) is quoted;
        // the local sources count what they could not read.
        return entry.message && !entry.unreadable
          ? `${name}: ${entry.message}`
          : REFRESH_COPY.toast.partial(name, entry.unreadable ?? 0);
      case 'skipped':
        return entry.message ? `${name}: ${entry.message}` : REFRESH_COPY.toast.notFound(name);
      case 'succeeded': {
        const imported = entry.imported ?? 0;
        return alreadyFailed || imported > 0
          ? REFRESH_COPY.toast.recovered(name, imported, recordsOf(only).noun)
          : REFRESH_COPY.toast.noNewRecords(name);
      }
      default:
        return REFRESH_COPY.toast.all;
    }
  }
  const failed = entries.filter(([, entry]) => entry.state === 'failed').map(([id]) => id);
  if (failed.length > 0) return COPY.allWithFailures(names(failed));
  const recovered = entries.find(
    ([id, entry]) =>
      failedBefore(before, id) && (entry.state === 'succeeded' || entry.state === 'partial'),
  );
  if (recovered) {
    return REFRESH_COPY.toast.allRecovered(
      SOURCE_NAMES[recovered[0] as SourceId] ?? recovered[0],
      recovered[1].imported ?? 0,
      recordsOf(recovered[0]).noun,
    );
  }
  return REFRESH_COPY.toast.all;
}

/**
 * Refresh one source, several, or everything, and follow the run to its end. Every banner and row that calls this shares
 * one run: while it goes, `isRefreshing` is true for the sources in it, wherever the button was pressed. The outcome
 * toast is said once, by the instance that started the run.
 */
export function useRefresh() {
  const client = useQueryClient();
  const toast = useToast();
  const refreshClaudePlan = useClaudePlanLimitsCheck('refresh');
  const mutation = useMutation({
    mutationKey: REFRESH_KEY,
    mutationFn: async (request: RefreshInput) => followRun(await startOrAttach(request)),
    onMutate: () => client.getQueryData<Sources>(queryKeys.sources),
    onSuccess: async (run, request, before) => {
      // Fresh numbers first, so the banner and the rows already say what the toast is about to.
      await invalidateServerState(client).catch(() => undefined);
      toast({ body: outcomeText(run, request, before) });
    },
    onError: (error) => {
      const reason = error instanceof ApiRequestError ? error.message : 'Try again.';
      toast({ body: COPY.requestFailed(reason), type: 'error', isAutoHide: true });
    },
  });
  const running = useMutationState({
    filters: { mutationKey: REFRESH_KEY, status: 'pending' },
    select: (mutation) => (mutation.state.variables as RefreshInput | undefined) ?? {},
  });

  return {
    /** Starts a run for these sources (all when none are named); ignored while a run this tab follows is going. */
    refresh(sources?: SourceId[]) {
      if (running.length > 0) return;
      mutation.mutate(sources ? { sources } : {});
      if (!sources) {
        void refreshClaudePlan.mutateAsync().catch(() => {
          toast({ body: 'Couldn’t reach the Claude plan check. Retry in Sources.', type: 'error' });
        });
      }
    },
    /** Whether a run this tab follows covers this source. */
    isRefreshing(id: SourceId): boolean {
      return running.some((request) => !request.sources || request.sources.includes(id));
    },
    /** Whether any run this tab follows is going. Every refresh button says so, because a press would be ignored. */
    isBusy: running.length > 0,
  };
}

// ---- the banner ----

/** React Router's Link under the `href` name Astryx's Button passes to a custom link component. */
function RouterLink({ href, ...rest }: Omit<ComponentProps<typeof Link>, 'to'> & { href: string }) {
  return <Link to={href} {...rest} />;
}

function StaleSource({
  source,
  today,
  timeZone,
}: {
  source: SourceStatus;
  today: string;
  timeZone: string;
}) {
  const { refresh, isRefreshing, isBusy } = useRefresh();
  const busy = isRefreshing(source.id);
  const retained = source.hasRetainedData === true;
  const when = (instant: string | null | undefined): string | null =>
    instant ? formatWhen(instant, { timeZone, today }) : null;
  const box = useRef<HTMLDivElement>(null);
  // A successful Retry removes this banner, and with it the button the keyboard is on: focus would fall to <body> and the next Tab
  // would start from the top. When the banner goes while focus is inside it, the page's heading takes the focus (the same place a
  // route change puts it), so the keyboard user keeps their place. The layout cleanup runs while the buttons are still attached,
  // which is what makes "was focus inside?" answerable; the move itself waits for the removal to finish.
  useLayoutEffect(() => {
    const node = box.current;
    return () => {
      if (node?.contains(document.activeElement)) {
        queueMicrotask(() =>
          document.getElementById('main')?.querySelector<HTMLElement>('h1')?.focus(),
        );
      }
    };
  }, []);
  return (
    <div
      ref={box}
      className="flex flex-wrap items-center gap-3 rounded-md border border-warning bg-warning-surface px-4 py-3 max-[719px]:grid max-[719px]:grid-cols-[16px_minmax(0,1fr)] max-[719px]:items-start"
    >
      <Icon name="clock" className="text-warning max-[719px]:mt-0.5" />
      <div className="min-w-0 flex-[1_1_320px]">
        <strong className="font-semibold text-ink">{BANNER_COPY.heading}</strong>
        <p className="text-caption text-ink">
          {BANNER_COPY.body(
            source.name,
            source.consecutiveFailures ?? 1,
            when(source.lastAttemptAt) ?? 'earlier',
            when(source.lastSuccessAt),
            retained,
            recordsOf(source.id).uncollected(source.name),
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 max-[719px]:col-span-full">
        <Button
          label={BANNER_COPY.viewSource}
          href="/sources"
          as={RouterLink}
          size="sm"
          variant="secondary"
          className="max-[719px]:min-h-11"
        />
        {/* Busy is aria-disabled, not `disabled`: the button keeps keyboard focus while the run goes, and its new name
            ("Retrying…") is announced in place. The click is ignored while busy (useRefresh), so nothing starts twice. */}
        <Button
          label={busy ? BANNER_COPY.retrying : BANNER_COPY.retry}
          icon={<Icon name={busy ? 'spinner' : 'refresh'} />}
          size="sm"
          variant="primary"
          aria-busy={busy || undefined}
          aria-disabled={isBusy || undefined}
          className="max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70"
          onClick={() => refresh([source.id])}
        />
      </div>
    </div>
  );
}

/**
 * One banner for each source whose latest refresh failed, above the page on every screen but Setup. The container is a
 * polite live region that is always present, so a banner appearing, saying "failed again" or clearing is announced.
 */
export function RefreshBanner() {
  const { data } = useSources();
  const bootstrap = useBootstrap().data;
  const failures = bootstrap ? (data?.sources ?? []).filter(sourceRefreshFailed) : [];
  return (
    <div role="status" className={failures.length > 0 ? 'mb-4 flex flex-col gap-2' : 'sr-only'}>
      {bootstrap &&
        failures.map((source) => (
          <StaleSource
            key={source.id}
            source={source}
            today={bootstrap.today}
            timeZone={bootstrap.timezone}
          />
        ))}
    </div>
  );
}
