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
import {
  browserHandoff,
  browserHandoffTicket,
  launchDashboard,
  runtimeInstall,
} from '../shared/rpc.ts';
import type { DashboardDestination, LaunchRequests } from './launch.ts';

interface LauncherScreenProps extends paseoClient.PluginScreenProps {
  requests: LaunchRequests;
  destination?: DashboardDestination;
  search?: string;
}

const expiredHandoff = 'This browser handoff expired. Retry to open the dashboard.';

export function LauncherScreen({
  host,
  layout,
  navigation,
  params,
  requests,
  destination,
  search,
  theme,
}: LauncherScreenProps) {
  const launch = paseoClient.useRpc(launchDashboard);
  const handoff = paseoClient.useRpc(browserHandoff);
  const install = paseoClient.useRpc(runtimeInstall);
  const ownerView = destination === 'sources' || destination === 'work-review';
  const externalOpen =
    typeof paseoClient.openExternalUrl === 'function' ? paseoClient.openExternalUrl : undefined;
  // Paseo Desktop also reports `web`. Only Desktop supplies workspace browser navigation.
  const browserNeedsClick =
    layout.platform === 'web' && typeof navigation?.openBrowser !== 'function';
  const [status, setStatus] = useState<string>();
  const [privateUrl, setPrivateUrl] = useState<string>();
  const [handoffExpiry, setHandoffExpiry] = useState<number>();
  const preparedHandoff = useRef<{ url: string; expiresAt: number } | undefined>(undefined);
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

  useEffect(() => {
    if (handoffExpiry === undefined) return;
    const timer = setTimeout(() => {
      if (preparedHandoff.current?.expiresAt !== handoffExpiry) return;
      preparedHandoff.current = undefined;
      setHandoffExpiry(undefined);
      setStatus(expiredHandoff);
    }, handoffExpiry - performance.now());
    return () => clearTimeout(timer);
  }, [handoffExpiry]);

  const openInBrowser = useCallback(
    async (url: string, expiresAt?: number) => {
      if (expiresAt !== undefined && expiresAt <= performance.now()) {
        setStatus(expiredHandoff);
        return;
      }
      try {
        if (externalOpen) {
          await externalOpen(url);
          if (active.current && (expiresAt !== undefined || !browserNeedsClick)) {
            setPrivateUrl(undefined);
            setStatus('The dashboard is open in your browser.');
          }
          return;
        }
      } catch {
        // The owner settings link can be copied if the client cannot open it.
      }
      if (active.current) {
        if (expiresAt === undefined) {
          setPrivateUrl(url);
          setStatus('Copy the private address and open it in your browser.');
        } else {
          setStatus('Could not open the dashboard in your browser. Try again.');
        }
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
        const request = () => (ownerView ? launch({}) : handoff({}));
        const finishInstall = async (action: 'start' | 'status') => {
          const result = await waitForRuntime(action);
          return result?.ok && active.current && !ownerView ? request() : result;
        };
        let result = installRuntime ? await finishInstall('start') : await request();
        if (active.current && result?.ok === false && result.reason === 'runtime-installing') {
          result = await finishInstall('status');
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
        if (ownerView) {
          const page = new URL(
            destination === 'work-review' ? '/work-review' : '/sources',
            result.url,
          );
          if (destination === 'work-review' && search) page.search = search;
          const target = page.href;
          if (browserNeedsClick && externalOpen) {
            setPrivateUrl(target);
            setStatus('Open the dashboard in your browser or copy the private address.');
          } else {
            await openInBrowser(target);
          }
          return;
        }
        const parsed = browserHandoffTicket.safeParse(result);
        if (!parsed.success) {
          setStatus('The host could not prepare a browser handoff. Try again.');
          return;
        }
        const { ticket, validForMs } = parsed.data;
        const expiresAt = performance.now() + validForMs;
        const target = new URL('/paseo/', result.url);
        target.hash = `ticket=${ticket}`;
        if (browserNeedsClick && externalOpen) {
          // The RPC can outlive a browser's user activation. Offer a fresh click to open it.
          preparedHandoff.current = { url: target.href, expiresAt };
          setHandoffExpiry(expiresAt);
          setStatus('The dashboard is ready to open in your browser.');
        } else {
          await openInBrowser(target.href, expiresAt);
        }
      } catch {
        if (active.current)
          setStatus('The launcher could not reach the Paseo host. Reconnect to it and retry.');
      } finally {
        inFlight.current = false;
        if (active.current) setBusy(false);
      }
    },
    [
      launch,
      handoff,
      browserNeedsClick,
      ownerView,
      destination,
      search,
      externalOpen,
      openInBrowser,
      waitForRuntime,
    ],
  );

  async function openPreparedHandoff() {
    const target = preparedHandoff.current;
    if (!target || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    preparedHandoff.current = undefined;
    setHandoffExpiry(undefined);
    try {
      await openInBrowser(target.url, target.expiresAt);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  // Only an explicit browser action issues a launch ID.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const request = requests.take(params.launch, host.id);
      if (request && request.destination === destination) void open();
    });
    return () => {
      cancelled = true;
    };
  }, [destination, params.launch, host.id, requests, open]);

  const textStyle = { color: theme.colors.foreground, paddingHorizontal: 16, paddingVertical: 12 };
  const handoffReady = handoffExpiry !== undefined;
  const launchLabel = installNeeded
    ? busy
      ? 'Installing…'
      : 'Install runtime'
    : busy
      ? 'Opening…'
      : status
        ? 'Retry'
        : 'Open dashboard';
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
            actionLabel={handoffReady ? 'Open in browser' : launchLabel}
            disabled={busy}
            onPress={
              handoffReady ? () => void openPreparedHandoff() : () => void open(installNeeded)
            }
          />
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}
