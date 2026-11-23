import type { RpcInput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { nativeDashboard, type NativeOperation } from '../shared/native.ts';
import type { ReportInputs, ReportOutputs } from '../shared/report-contracts.ts';
import type {
  AccountStatus,
  ConnectPollResponse,
  ConnectResponse,
  DiscoveredRepo,
  NativeBootstrap,
  NativeQuota,
  NativeRoster,
  Repo,
  SourceReport,
} from './native-types.ts';

interface OperationData extends ReportOutputs {
  bootstrap: NativeBootstrap;
  roster: NativeRoster;
  discover: SourceReport;
  sources: SourceReport;
  finish: unknown;
  githubConnect: ConnectResponse;
  githubPoll: ConnectPollResponse;
  githubDisconnect: AccountStatus;
  githubApp: AccountStatus;
  chatgptConnect: ConnectResponse;
  chatgptPoll: ConnectPollResponse;
  chatgptDisconnect: AccountStatus;
  repos: { active?: Repo[]; stopped?: Repo[] };
  repoDiscover: { repositories: DiscoveredRepo[]; nextPage: number | null };
  repoAdd: Repo;
  repoRecheck: Repo;
  repoRemove: null;
  usage: { providers: NativeQuota[] };
  usageFallback: { providers: NativeQuota[] };
}

export class NativeRequestError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly details?: { runId?: number },
  ) {
    super(message);
  }
}

export function requestMessage(error: unknown): string {
  return error instanceof NativeRequestError
    ? error.message
    : 'Could not reach Agent HQ on this host. Reconnect and try again.';
}

export type NativeParameters<Operation extends NativeOperation> =
  Operation extends keyof ReportInputs
    ? ReportInputs[Operation]
    : RpcInput<typeof nativeDashboard>['parameters'];

export function useNativeRequest() {
  const invoke = useRpc(nativeDashboard);
  return useCallback(
    async <Operation extends NativeOperation>(
      operation: Operation,
      parameters?: NativeParameters<Operation>,
    ): Promise<OperationData[Operation]> => {
      const result = await invoke({
        operation,
        parameters: parameters as Parameters<typeof invoke>[0]['parameters'],
      });
      if (!result.ok) throw new NativeRequestError(result.reason, result.message, result.details);
      // The daemon dispatches to the same routes as the dashboard and returns their response bodies.
      return result.data as OperationData[Operation];
    },
    [invoke],
  );
}

export type NativeRequest = ReturnType<typeof useNativeRequest>;

/** Run one request at a time and stop polling as soon as this view is left. */
export function useNativePoll(run: (signal: AbortSignal) => Promise<number | void>, retryKey = 0) {
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (signal.aborted) return;
      const delay = await run(signal);
      if (!signal.aborted && delay !== undefined) timer = setTimeout(() => void poll(), delay);
    }

    // Avoid a duplicate initial request when StrictMode rehearses mounting the effect.
    queueMicrotask(() => void poll());
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [run, retryKey]);
}

/** Lock an explicit action against repeated presses and ignore completion after unmount. */
export function useNativeAction() {
  const scope = useRef<AbortController | null>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  useLayoutEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    return () => controller.abort();
  }, []);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const signal = scope.current?.signal;
    if (!signal || signal.aborted || running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      await action(signal);
    } catch (error) {
      if (!signal.aborted) setProblem(requestMessage(error));
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  return { busy, problem, run, setProblem };
}
