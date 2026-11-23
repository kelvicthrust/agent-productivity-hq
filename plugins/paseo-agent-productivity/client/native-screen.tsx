import { useRpc, type PluginScreenProps } from '@getpaseo/plugin/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { nativeRuntimeInstall, type NativeRuntimeInstallStatus } from '../shared/native.ts';
import {
  NativeRequestError,
  requestMessage,
  useNativeAction,
  useNativePoll,
  useNativeRequest,
} from './native-api.ts';
import { NativeDashboard } from './native-dashboard.tsx';
import { NativeNavigation } from './native-navigation.tsx';
import {
  hostQueryKey,
  ReportingProvider,
  type DashboardPage,
  type DrillDown,
} from './native-reporting.tsx';
import { NativeSetup } from './native-setup.tsx';
import type { NativeBootstrap } from './native-types.ts';
import {
  NativeActions,
  NativeButton,
  NativeCard,
  NativePage,
  NativeProblem,
  NativeProjectCredit,
  NativeText,
} from './native-ui.tsx';

interface Problem {
  reason?: string;
  message: string;
}

export function NativeScreen({
  host,
  navigation,
  page,
  drill,
  navigate,
  onOpenDashboard,
  onOpenOwnerSettings,
  ...surface
}: PluginScreenProps & {
  page: DashboardPage;
  drill?: DrillDown;
  navigate(page: DashboardPage, drill?: DrillDown): void;
  onOpenDashboard(): void;
  onOpenOwnerSettings(): void;
}) {
  const request = useNativeRequest();
  const cache = useQueryClient();
  const install = useRpc(nativeRuntimeInstall);
  const startInstall = useNativeAction();
  const [mode, setMode] = useState<'setup' | 'roster'>();
  const [accounting, setAccounting] = useState<NativeBootstrap>();
  const [problem, setProblem] = useState<Problem>();
  const [waitingOnInstall, setWaitingOnInstall] = useState(false);
  const [bootRetry, setBootRetry] = useState(0);
  const previousSetup = useRef<boolean | undefined>(undefined);
  const showSetup = useCallback(() => {
    previousSetup.current = false;
    setMode('setup');
    cache.removeQueries({ queryKey: hostQueryKey(host.id) });
  }, [cache, host.id]);

  const bootstrap = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await request('bootstrap');
        if (signal.aborted) return;
        setAccounting(result);
        setProblem(undefined);
        if (!result.setupComplete) {
          showSetup();
        } else {
          previousSetup.current = true;
          setMode('roster');
          return 10_000;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof NativeRequestError && error.reason === 'runtime-installing') {
          setWaitingOnInstall(true);
        } else {
          setProblem({
            reason: error instanceof NativeRequestError ? error.reason : undefined,
            message: requestMessage(error),
          });
        }
        if (previousSetup.current) return 10_000;
      }
    },
    [request, showSetup],
  );

  useNativePoll(bootstrap, bootRetry);

  useEffect(() => {
    const subscription = AppState?.addEventListener?.('change', (state) => {
      if (state === 'active' && previousSetup.current) setBootRetry((value) => value + 1);
    });
    return () => subscription?.remove();
  }, []);

  const applyInstall = useCallback((status: NativeRuntimeInstallStatus) => {
    setWaitingOnInstall(status.state === 'installing');
    if (status.state === 'installing') return;
    if (status.state === 'finished') {
      if (status.result.ok) setBootRetry((value) => value + 1);
      else setProblem(status.result);
      return;
    }
    setProblem({
      reason: 'runtime-required',
      message: 'Try installing the private Node.js runtime again.',
    });
  }, []);

  useNativePoll(
    useCallback(
      async (signal: AbortSignal) => {
        if (!waitingOnInstall) return;
        try {
          const status = await install({ action: 'status' });
          if (signal.aborted) return;
          applyInstall(status);
          if (status.state === 'installing') return 1_000;
        } catch (error) {
          if (signal.aborted) return;
          setWaitingOnInstall(false);
          setProblem({ message: requestMessage(error) });
        }
      },
      [applyInstall, install, waitingOnInstall],
    ),
  );

  const needsRuntime =
    problem?.reason === 'runtime-required' || problem?.reason === 'runtime-install-failed';
  const installing = waitingOnInstall || startInstall.busy;

  return (
    <NativePage
      {...surface}
      scrollKey={mode === 'roster' ? page : mode}
      navigation={
        mode === 'roster' ? (
          <NativeNavigation current={page} issues={accounting?.issues.length} navigate={navigate} />
        ) : undefined
      }
    >
      {mode === undefined && (
        <View style={{ gap: 5 }}>
          <NativeText heading size={28}>
            Agent HQ
          </NativeText>
          <NativeText tone="foregroundMuted">{host.label}</NativeText>
        </View>
      )}
      {mode === undefined ? (
        <NativeCard title="Agent HQ on this host">
          {installing ? (
            <NativeText announce>Installing the private Node.js runtime on this host…</NativeText>
          ) : null}
          {!installing && !problem ? (
            <NativeText announce>Connecting to Agent HQ…</NativeText>
          ) : null}
          {!installing ? (
            <NativeProblem message={startInstall.problem ?? problem?.message} />
          ) : null}
          {needsRuntime && !installing ? (
            <>
              <NativeText tone="foregroundMuted">
                Agent HQ needs a private Node.js runtime on this host.
              </NativeText>
              <NativeButton
                primary
                label="Install runtime"
                onPress={() =>
                  void startInstall.run(async (signal) => {
                    const status = await install({ action: 'start' });
                    if (signal.aborted) return;
                    setProblem(undefined);
                    applyInstall(status);
                  })
                }
              />
            </>
          ) : null}
          {!needsRuntime && !installing && problem ? (
            <NativeButton
              label="Retry connection"
              onPress={() => {
                setProblem(undefined);
                setBootRetry((value) => value + 1);
              }}
            />
          ) : null}
        </NativeCard>
      ) : null}
      {mode === 'setup' ? (
        <NativeSetup
          request={request}
          onFinish={() => {
            previousSetup.current = true;
            navigate('hq');
            setMode('roster');
            setBootRetry((value) => value + 1);
          }}
        />
      ) : null}
      {mode === 'roster' && accounting ? (
        <ReportingProvider
          hostId={host.id}
          request={request}
          bootstrap={accounting}
          navigate={navigate}
          drill={drill}
        >
          <NativeDashboard
            page={page}
            request={request}
            host={host}
            navigation={navigation}
            onSetupRequired={showSetup}
            onOpenOwnerSettings={onOpenOwnerSettings}
          />
        </ReportingProvider>
      ) : null}
      {mode !== 'setup' && (
        <NativeActions>
          <NativeButton label="Open full dashboard" onPress={onOpenDashboard} />
        </NativeActions>
      )}
      {mode !== undefined && <NativeProjectCredit />}
    </NativePage>
  );
}
