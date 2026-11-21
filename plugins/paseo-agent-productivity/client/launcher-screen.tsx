import * as paseoClient from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@getpaseo/plugin/client/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { isTailnetHttpsOrigin } from '../shared/dashboard.ts';
import { launchDashboard, runtimeInstall } from '../shared/rpc.ts';
import type { LaunchRequests } from './launch.ts';

interface LauncherScreenProps extends paseoClient.PluginScreenProps {
  requests: LaunchRequests;
}

export function LauncherScreen({
  host,
  layout,
  navigation,
  params,
  requests,
  theme,
}: LauncherScreenProps) {
  const launch = paseoClient.useRpc(launchDashboard);
  const install = paseoClient.useRpc(runtimeInstall);
  const externalOpen =
    typeof paseoClient.openExternalUrl === 'function' ? paseoClient.openExternalUrl : undefined;
  // Paseo Desktop also reports `web`. Only Desktop supplies workspace browser navigation.
  const browserNeedsClick =
    layout.platform === 'web' && typeof navigation?.openBrowser !== 'function';
  const [status, setStatus] = useState<string>();
  const [privateUrl, setPrivateUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [installNeeded, setInstallNeeded] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(false);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const openInBrowser = useCallback(
    async (url: string) => {
      try {
        if (externalOpen) {
          await externalOpen(url);
          if (active.current && !browserNeedsClick) {
            setPrivateUrl(undefined);
            setStatus('The dashboard is open in your browser.');
          }
          return;
        }
      } catch {
        // Keep the validated address available for copying if the client cannot open it.
      }
      if (active.current) {
        setPrivateUrl(url);
        setStatus('Copy the private address and open it in your browser.');
      }
    },
    [externalOpen, browserNeedsClick],
  );

  const waitForRuntime = useCallback(
    async (action: 'start' | 'status') => {
      setStatus('Installing the private Node.js runtime on the Paseo host…');
      let progress = await install({ action });
      while (active.current && progress.state === 'installing') {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        if (!active.current) return null;
        progress = await install({ action: 'status' });
      }
      if (progress.state === 'finished') return progress.result;
      return {
        ok: false,
        reason: 'runtime-required',
        message: 'The host no longer has an active install. Try installing the runtime again.',
      } as const;
    },
    [install],
  );

  const open = useCallback(
    async (installRuntime = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setPrivateUrl(undefined);
      setStatus(
        installRuntime
          ? 'Installing the private Node.js runtime on the Paseo host…'
          : 'Starting the dashboard and checking private access…',
      );
      try {
        let result = installRuntime ? await waitForRuntime('start') : await launch({});
        if (active.current && result?.ok === false && result.reason === 'runtime-installing') {
          result = await waitForRuntime('status');
        }
        if (!active.current || !result) return;
        if (!result.ok) {
          setInstallNeeded(
            result.reason === 'runtime-required' || result.reason === 'runtime-install-failed',
          );
          setStatus(result.message);
          return;
        }
        setInstallNeeded(false);
        if (!isTailnetHttpsOrigin(result.url)) {
          setStatus(
            'The host returned an invalid private address. Check Tailscale on the host and retry.',
          );
          return;
        }
        if (browserNeedsClick && externalOpen) {
          // The RPC can outlive a browser's user activation. Offer a fresh click to open it.
          setPrivateUrl(result.url);
          setStatus('Open the dashboard in your browser or copy the private address.');
        } else {
          await openInBrowser(result.url);
        }
      } catch {
        if (active.current)
          setStatus('The launcher could not reach the Paseo host. Reconnect to it and retry.');
      } finally {
        inFlight.current = false;
        if (active.current) setBusy(false);
      }
    },
    [launch, browserNeedsClick, externalOpen, openInBrowser, waitForRuntime],
  );

  // A restored route can contain an old launch ID. Only a fresh sidebar click starts the service.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && requests.take(params.launch, host.id)) void open();
    });
    return () => {
      cancelled = true;
    };
  }, [params.launch, host.id, requests, open]);

  const textStyle = { color: theme.colors.foreground, paddingHorizontal: 16, paddingVertical: 12 };
  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 12 }}>
      <SettingsSection title="Agent HQ">
        <SettingsCard>
          <SettingsRow label="Host" hint={host.label} />
          <Text accessibilityLiveRegion="polite" style={textStyle}>
            {status ?? 'Open the dashboard in your browser.'}
          </Text>
          {privateUrl && (
            <>
              <Text selectable style={textStyle}>
                {privateUrl}
              </Text>
              {layout.platform === 'web' && externalOpen && (
                <SettingsAction
                  label="Private dashboard address"
                  actionLabel="Open in browser"
                  disabled={busy}
                  onPress={() => void openInBrowser(privateUrl)}
                />
              )}
            </>
          )}
          <SettingsAction
            label="Dashboard"
            actionLabel={
              installNeeded
                ? busy
                  ? 'Installing…'
                  : 'Install runtime'
                : busy
                  ? 'Opening…'
                  : status
                    ? 'Retry'
                    : 'Open dashboard'
            }
            disabled={busy}
            onPress={() => void open(installNeeded)}
          />
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}
