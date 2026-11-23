import { useEffect, useState } from 'react';
import type { RefreshSource } from '../shared/report-contracts.ts';
import { NativeRequestError, requestMessage, useNativeAction } from './native-api.ts';
import { useDashboard, useDashboardQuery, useRefreshDashboardData } from './native-reporting.tsx';

export function useDashboardRefresh() {
  const { request } = useDashboard();
  const invalidate = useRefreshDashboardData();
  const action = useNativeAction();
  const [startedId, setStartedId] = useState<number>();
  const [finished, setFinished] = useState<{ id: number; message: string }>();

  const sources = useDashboardQuery('sources', undefined, { interval: 4_000 });
  const runId = startedId ?? sources.data?.running ?? undefined;
  const status = useDashboardQuery('refreshStatus', runId === undefined ? undefined : { runId }, {
    enabled: runId !== undefined && finished?.id !== runId,
    interval: 1_000,
  });
  const run = status.data;

  useEffect(() => {
    if (!run || run.state === 'running' || run.id === finished?.id) return;
    const message =
      run.state === 'succeeded'
        ? 'Refresh finished.'
        : run.state === 'partial'
          ? 'Refresh finished with some source problems.'
          : run.state === 'interrupted'
            ? 'Refresh was interrupted. Try again.'
            : 'Refresh failed. Check Sources & repos for details.';
    let staying = true;
    queueMicrotask(() => {
      if (!staying) return;
      setStartedId(undefined);
      setFinished({ id: run.id, message });
      void invalidate();
    });
    return () => {
      staying = false;
    };
  }, [run, finished?.id, invalidate]);

  function refresh(source?: RefreshSource) {
    void action.run(async (signal) => {
      let id: number;
      try {
        const result = await request('refresh', source ? { sources: [source] } : {});
        id = result.id;
      } catch (error) {
        if (
          !(error instanceof NativeRequestError) ||
          error.reason !== 'refresh_running' ||
          error.details?.runId === undefined
        )
          throw error;
        id = error.details.runId;
      }
      if (!signal.aborted) setStartedId(id);
    });
  }

  const busy = action.busy || (runId !== undefined && runId !== finished?.id && !status.error);
  return {
    refresh,
    sources,
    busy,
    status: busy ? undefined : finished?.message,
    problem: action.problem ?? (status.error ? requestMessage(status.error) : undefined),
  };
}
