import type {
  PluginClientContext,
  PluginOpenScreenInput,
  PluginScreenProps,
} from '@getpaseo/plugin/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { idleReviewRoster } from '../../../test/fixtures/hq/scripted.ts';
import { ConfigureLauncher } from '../client/settings.tsx';
import contribute from '../index.client.tsx';

const {
  useSettings,
  launch,
  installRuntime,
  native,
  installNativeRuntime,
  usePaseo,
  listWorkspaces,
  externalBrowser,
} = vi.hoisted(() => ({
  useSettings: vi.fn(),
  launch: vi.fn(),
  installRuntime: vi.fn(),
  native: vi.fn(),
  installNativeRuntime: vi.fn(),
  usePaseo: vi.fn(),
  listWorkspaces: vi.fn(),
  externalBrowser: { open: undefined as ((url: string) => Promise<void>) | undefined },
}));
vi.mock('@getpaseo/plugin/client', () => ({
  useSettings,
  useRpc: ({ name }: { name: string }) => {
    switch (name) {
      case 'dashboard.launch':
        return launch;
      case 'dashboard.runtime-install':
        return installRuntime;
      case 'dashboard.native':
        return native;
      case 'dashboard.native-runtime-install':
        return installNativeRuntime;
      default:
        throw new Error(`Unknown RPC ${name}`);
    }
  },
  usePaseo,
  useWorkspaces: () => {
    throw new Error('Plugin state hooks must run inside a plugin host');
  },
  get openExternalUrl() {
    return externalBrowser.open;
  },
}));
vi.mock('@getpaseo/plugin/client/ui', () => ({
  ExternalLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  Icon: () => null,
  SidebarRow: ({ onPress }: { onPress: () => void }) => <button onClick={onPress}>Agent HQ</button>,
  SettingsAction: ({
    actionLabel,
    disabled,
    error,
    onPress,
  }: {
    actionLabel: string;
    disabled?: boolean;
    error?: string;
    onPress(): void;
  }) => (
    <div>
      <button disabled={disabled} onClick={onPress}>
        {actionLabel}
      </button>
      {error && <div role="alert">{error}</div>}
    </div>
  ),
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    label,
    children,
    hint,
  }: {
    label: string;
    children?: ReactNode;
    hint?: string;
  }) => (
    <div>
      {label}
      <span>{hint}</span>
      {children}
    </div>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({
    accessibilityRole,
    children,
    selectable,
  }: {
    accessibilityRole?: string;
    children: ReactNode;
    selectable?: boolean;
  }) => (
    <span
      role={accessibilityRole === 'header' ? 'heading' : undefined}
      style={selectable ? { userSelect: 'text' } : undefined}
    >
      {children}
    </span>
  ),
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel?: string;
    accessibilityRole?: string;
    children: ReactNode;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      role={accessibilityRole}
      aria-label={accessibilityLabel}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  TextInput: ({
    accessibilityLabel,
    onChangeText,
    value,
  }: {
    accessibilityLabel: string;
    onChangeText?(value: string): void;
    value: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText?.(event.target.value)}
      readOnly={!onChangeText}
    />
  ),
}));
vi.mock('../client/native-hq-scene.tsx', () => ({
  IllustratedHq: ({ quiet }: { quiet: boolean }) => (
    <div data-testid={quiet ? 'hq-afk' : 'hq-scene'} />
  ),
}));

vi.mock('../client/native-hq-crew.tsx', () => ({
  NativeBuddy: () => null,
  NativeCrewArt: () => null,
}));

const host = { id: 'srv_mini', label: 'Mac mini' };
const workspaceId = 'dashboard-service';
const privateUrl = 'https://mini.example-tailnet.ts.net:8443';
const theme = { colors: {} } as PluginScreenProps['theme'];
const layout = { compact: false, platform: 'web' } as const;

type BrowserTarget = Parameters<
  NonNullable<NonNullable<PluginScreenProps['navigation']>['openBrowser']>
>[0];

function renderLauncher(
  openBrowser: (target: BrowserTarget) => void,
  clientLayout: PluginScreenProps['layout'] = layout,
  embeddedBrowser = clientLayout.platform === 'web',
) {
  const addSidebarHeaderItem = vi.fn<PluginClientContext['addSidebarHeaderItem']>(() => () => {});
  const addScreen = vi.fn<PluginClientContext['addScreen']>(() => () => {});
  contribute({
    addSidebarHeaderItem,
    addScreen,
    addSettingsScreen: () => () => {},
  } as unknown as PluginClientContext);
  const { Component: SidebarItem } = addSidebarHeaderItem.mock.calls[0]![0];
  const { Component: Launcher } = addScreen.mock.calls[0]![0];
  const openAgent = vi.fn();

  function HostFrame({ selectedHost }: { selectedHost: PluginScreenProps['host'] }) {
    const [route, setRoute] = useState<PluginOpenScreenInput>();
    const [launcherVisible, setLauncherVisible] = useState(false);
    return (
      <>
        <SidebarItem
          host={selectedHost}
          layout={clientLayout}
          theme={theme}
          currentScreen={
            route && launcherVisible
              ? { screenId: route.screenId, params: route.params ?? {} }
              : null
          }
          openScreen={(nextRoute) => {
            setRoute(nextRoute);
            setLauncherVisible(true);
          }}
          openPopover={() => {}}
        />
        {!launcherVisible && route && (
          <button onClick={() => setLauncherVisible(true)}>Back to launcher</button>
        )}
        {launcherVisible && route && (
          <>
            <button onClick={() => setLauncherVisible(false)}>Leave launcher</button>
            <Launcher
              host={selectedHost}
              layout={clientLayout}
              theme={theme}
              params={route.params ?? {}}
              navigation={
                embeddedBrowser
                  ? {
                      openWorkspace: () => {},
                      openAgent,
                      openBrowser: (target) => {
                        openBrowser(target);
                        setLauncherVisible(false);
                      },
                    }
                  : undefined
              }
            />
          </>
        )}
      </>
    );
  }

  const query = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  const renderHost = (selectedHost = host) => (
    <StrictMode>
      <QueryClientProvider client={query}>
        <HostFrame selectedHost={selectedHost} />
      </QueryClientProvider>
    </StrictMode>
  );
  const { rerender } = render(renderHost());
  return {
    openAgent,
    switchHost: (selectedHost: PluginScreenProps['host']) => rerender(renderHost(selectedHost)),
  };
}

function workspacePage(ids: string[]) {
  return {
    entries: ids.map((id) => ({ id, name: id, workspaceDirectory: '/workspaces/' + id })),
    pageInfo: { nextCursor: null },
  };
}

function ok(data: unknown) {
  return {
    ok: true,
    data:
      data && typeof data === 'object' && 'setupComplete' in data
        ? { timezone: 'UTC', today: '2026-11-20', lookbackStart: '2025-11-20', issues: [], ...data }
        : data,
  };
}

function openDashboard() {
  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open full dashboard' }));
}

beforeEach(() => {
  native.mockReset().mockImplementation(async ({ operation }) => {
    if (operation === 'bootstrap') return ok({ setupComplete: true });
    if (operation === 'roster') return ok({ agents: [], feeds: [], truncated: false });
    if (operation === 'sources') return ok({ sources: [], accounts: [] });
    if (operation === 'repos') return ok({ active: [] });
    if (operation === 'usage') return ok({ providers: [] });
    throw new Error(`Unexpected operation ${operation}`);
  });
  installNativeRuntime.mockReset();
  launch.mockReset().mockResolvedValue({ ok: true, url: privateUrl });
  installRuntime.mockReset();
  externalBrowser.open = undefined;
  listWorkspaces.mockReset().mockResolvedValue(workspacePage([workspaceId]));
  usePaseo.mockReset().mockReturnValue({ workspaces: { list: listWorkspaces } });
  useSettings.mockReset().mockReturnValue({
    status: 'ready',
    values: { workspaceId, privateUrl: 'https://old.example.ts.net' },
  });
});

afterEach(cleanup);

it.each([
  { label: 'a fresh install', workspace: '' },
  { label: 'an upgrade with a saved workspace', workspace: workspaceId },
])('opens the system browser on desktop for $label', async ({ workspace }) => {
  useSettings.mockReturnValue({
    status: 'ready',
    values: { workspaceId: workspace, privateUrl: '' },
  });
  listWorkspaces.mockResolvedValue(workspacePage(['first', 'second']));
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  const openBrowser = vi.fn();
  renderLauncher(openBrowser);

  openDashboard();
  await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(openBrowser).not.toHaveBeenCalled();
  expect(useSettings).not.toHaveBeenCalled();
  expect(listWorkspaces).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Choose' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Leave launcher' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to launcher' }));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(openExternal).toHaveBeenCalledTimes(1);
});

it('offers a private Node.js install only after a launch discovers it is needed', async () => {
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  launch.mockResolvedValueOnce({
    ok: false,
    reason: 'runtime-required',
    message: 'Node.js needed.',
  });
  installRuntime
    .mockResolvedValueOnce({
      state: 'finished',
      result: {
        ok: false,
        reason: 'runtime-install-failed',
        message: 'The download could not be verified.',
      },
    })
    .mockResolvedValueOnce({ state: 'finished', result: { ok: true, url: privateUrl } });
  renderLauncher(vi.fn());

  openDashboard();
  const install = await screen.findByRole('button', { name: 'Install runtime' });
  expect(launch.mock.calls).toEqual([[{}]]);
  expect(installRuntime).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();

  fireEvent.click(install);
  await screen.findByText('The download could not be verified.');
  expect(installRuntime.mock.calls).toEqual([[{ action: 'start' }]]);
  expect(openExternal).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Install runtime' }));
  await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl));
  expect(installRuntime.mock.calls).toEqual([[{ action: 'start' }], [{ action: 'start' }]]);
});

it('polls an acknowledged runtime install beyond the invocation deadline without starting it again', async () => {
  vi.useFakeTimers();
  try {
    const openExternal = vi.fn(async () => {});
    externalBrowser.open = openExternal;
    launch.mockResolvedValue({ ok: false, reason: 'runtime-required', message: 'Node.js needed.' });
    installRuntime.mockResolvedValue({ state: 'installing' });
    renderLauncher(vi.fn());

    fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Open full dashboard' })),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Install runtime' })));
    fireEvent.click(screen.getByRole('button', { name: 'Installing…' }));
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    expect(installRuntime.mock.calls.filter(([input]) => input.action === 'start')).toEqual([
      [{ action: 'start' }],
    ]);
    expect(installRuntime.mock.calls.filter(([input]) => input.action === 'status')).toHaveLength(
      31,
    );
    expect(openExternal).not.toHaveBeenCalled();

    installRuntime.mockResolvedValue({ state: 'finished', result: { ok: true, url: privateUrl } });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl);
  } finally {
    vi.useRealTimers();
  }
});

it('opens the private dashboard on iOS without the entity state provider', async () => {
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  const openBrowser = vi.fn();
  const phoneLayout = { platform: 'ios', compact: true } as const;
  renderLauncher(openBrowser, phoneLayout);

  openDashboard();
  await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(openBrowser).not.toHaveBeenCalled();
  expect(useSettings).not.toHaveBeenCalled();
  expect(usePaseo).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Leave launcher' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to launcher' }));
  expect(screen.getByRole('button', { name: 'Open full dashboard' })).toBeTruthy();
  expect(launch).toHaveBeenCalledTimes(1);

  render(<ConfigureLauncher host={host} layout={phoneLayout} theme={theme} />);
  expect(screen.getByText('Use Paseo Desktop to repair saved launcher settings.')).toBeTruthy();
  expect(useSettings).not.toHaveBeenCalled();
  expect(usePaseo).not.toHaveBeenCalled();
});

it.each([
  {
    label: 'the Android opener is missing',
    clientLayout: { platform: 'android', compact: true } as const,
    behavior: 'missing',
  },
  {
    label: 'the Android opener rejects',
    clientLayout: { platform: 'android', compact: true } as const,
    behavior: 'rejects',
  },
  { label: 'the desktop opener rejects', clientLayout: layout, behavior: 'rejects' },
])('keeps the selectable URL and retry when $label', async ({ clientLayout, behavior }) => {
  if (behavior === 'rejects') {
    externalBrowser.open = vi.fn().mockRejectedValue(new Error('No browser handler'));
  }
  renderLauncher(vi.fn(), clientLayout);

  openDashboard();
  const address = await screen.findByText(privateUrl);
  expect(address.style.userSelect).toBe('text');
  expect(screen.getByText('Copy the private address and open it in your browser.')).toBeTruthy();

  launch.mockResolvedValueOnce({ ok: true, url: 'https://invalid.example.com' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText(/The host returned an invalid private address/);
  expect(screen.queryByText(privateUrl)).toBeNull();
  expect(screen.queryByText('https://invalid.example.com')).toBeNull();
  if (externalBrowser.open)
    expect(externalBrowser.open).toHaveBeenCalledExactlyOnceWith(privateUrl);
});

it('waits for a browser button press on web clients without workspace navigation', async () => {
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  renderLauncher(vi.fn(), layout, false);

  openDashboard();
  const openButton = await screen.findByRole('button', { name: 'Open in browser' });
  expect(openExternal).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(openButton);
  });
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(screen.getByText(privateUrl).style.userSelect).toBe('text');
  expect(screen.getByRole('button', { name: 'Open in browser' })).toBeTruthy();
  expect(
    screen.getByText('Open the dashboard in your browser or copy the private address.'),
  ).toBeTruthy();
});

it('ignores a launch result from the host the phone left', async () => {
  const firstLaunch = Promise.withResolvers<{ ok: true; url: string }>();
  launch.mockReturnValueOnce(firstLaunch.promise);
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  const { switchHost } = renderLauncher(vi.fn(), { platform: 'ios', compact: true });

  openDashboard();
  await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  switchHost({ id: 'another-host', label: 'Another host' });
  await act(async () =>
    firstLaunch.resolve({ ok: true, url: 'https://old.example-tailnet.ts.net' }),
  );
  expect(openExternal).not.toHaveBeenCalled();
  expect(launch).toHaveBeenCalledTimes(1);

  openDashboard();
  await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl));
  expect(launch).toHaveBeenCalledTimes(2);
});

it('offers a reset for invalid saved settings and shows the ready state after a successful reset', () => {
  const reset = vi.fn(async () => true);
  useSettings.mockReturnValue({ status: 'invalid', reset });
  const view = <ConfigureLauncher host={host} layout={layout} theme={theme} />;
  const { rerender } = render(view);

  fireEvent.click(screen.getByRole('button', { name: 'Reset settings' }));
  expect(reset).toHaveBeenCalledTimes(1);

  useSettings.mockReturnValue({ status: 'ready', values: { workspaceId: '', privateUrl: '' } });
  rerender(<ConfigureLauncher host={host} layout={layout} theme={theme} />);
  expect(screen.getByText('Launcher settings are ready.')).toBeTruthy();
});

it('displays a reset failure and keeps the reset action available', () => {
  const reset = vi.fn(async () => false);
  useSettings.mockReturnValue({ status: 'invalid', reset });
  const { rerender } = render(<ConfigureLauncher host={host} layout={layout} theme={theme} />);

  fireEvent.click(screen.getByRole('button', { name: 'Reset settings' }));
  expect(reset).toHaveBeenCalledTimes(1);

  useSettings.mockReturnValue({ status: 'invalid', reset, saveError: 'Could not reset settings.' });
  rerender(<ConfigureLauncher host={host} layout={layout} theme={theme} />);
  expect(screen.getByRole('alert').textContent).toBe('Could not reset settings.');
  expect(screen.getByRole('button', { name: 'Reset settings' })).toBeTruthy();
});

it('shows a host recovery message and retries the managed launch without using the old URL', async () => {
  launch.mockResolvedValueOnce({
    ok: false,
    reason: 'route-conflict',
    message: 'Remove the previous private share.',
  });
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  renderLauncher(vi.fn());
  openDashboard();
  await screen.findByText('Remove the previous private share.');
  expect(openExternal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl));
});

it('opens live HQ in Paseo, navigates only matched agents, and uses the explicit quota fallback', async () => {
  const date = '2026-11-20T12:00:00.000Z';
  const quota = {
    provider: 'codex',
    source: 'paseo',
    usedPercent: 25,
    resetsAt: date,
    refreshedAt: date,
    stale: false,
    canCheck: false,
  };
  native.mockImplementation(async ({ operation }) => {
    switch (operation) {
      case 'bootstrap':
        return ok({ setupComplete: true });
      case 'roster':
        return ok({
          feeds: [{ id: 'paseo', status: 'live' }],
          agents: [
            {
              id: 'child',
              title: 'Child task',
              provider: 'codex',
              state: 'working',
              kind: 'child',
              parentId: 'a',
              seenBy: { paseo: true },
            },
            {
              id: 'a',
              title: 'Paseo task',
              provider: 'codex',
              state: 'working',
              seenBy: { paseo: true },
              paseoAgentId: 'agent-1',
            },
            {
              id: 'b',
              title: 'Local task',
              provider: 'claude',
              state: 'waiting',
              waitReason: 'permission',
              seenBy: { paseo: false },
            },
          ],
          truncated: false,
        });
      case 'usage':
        return ok({
          providers: [
            quota,
            {
              provider: 'claude',
              source: null,
              usedPercent: null,
              resetsAt: null,
              refreshedAt: null,
              stale: false,
              canCheck: true,
            },
          ],
        });
      case 'sources':
        return ok({ sources: [], accounts: [] });
      case 'repos':
        return ok({ active: [] });
      case 'usageFallback':
        return ok({
          providers: [{ ...quota, provider: 'claude', source: 'direct', usedPercent: 5 }],
        });
    }
  });
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  const { openAgent } = renderLauncher(vi.fn());

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await screen.findByText('Paseo task');
  expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(
    expect.arrayContaining(['Paseo task', 'Child task', 'Local task']),
  );
  expect(
    screen.getByText('Paseo task').compareDocumentPosition(screen.getByText('Child task')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByText('Local task')).toBeTruthy();
  expect(screen.getByText('Needs you: permission')).toBeTruthy();
  expect(screen.getByText('Claude Code')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open Paseo agent Local task' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open Paseo agent Paseo task' }));
  expect(openAgent).toHaveBeenCalledExactlyOnceWith({ agentId: 'agent-1', serverId: host.id });
  expect(native.mock.calls.map(([input]) => input.operation)).not.toContain('usage');
  fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  await screen.findByText('25% used this week');
  expect(screen.getByText('Source · Paseo')).toBeTruthy();
  expect(screen.getByText('Weekly quota unavailable')).toBeTruthy();
  expect(native.mock.calls.map(([input]) => input.operation)).not.toContain('usageFallback');
  expect(launch).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Check Claude Code directly' }));
  await screen.findByText('5% used this week');
  expect(screen.getByText('Source · Claude Code')).toBeTruthy();
  expect(screen.getByText('25% used this week')).toBeTruthy();
  expect(native).toHaveBeenLastCalledWith({
    operation: 'usageFallback',
    parameters: { provider: 'claude' },
  });
});

it('shows unreviewed results and background work, then reveals recent idle on demand', async () => {
  const roster = idleReviewRoster(Date.parse('2026-11-20T12:00:00.000Z'));
  native.mockImplementation(async ({ operation }) => {
    if (operation === 'bootstrap') return ok({ setupComplete: true });
    if (operation === 'roster') return ok(roster);
  });
  renderLauncher(vi.fn());

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  const disclosure = await screen.findByRole('button', { name: 'Recent idle (2)' });
  expect(screen.getByText('Ready to review')).toBeTruthy();
  expect(screen.getByText('Background work running')).toBeTruthy();
  expect(screen.queryByText('Recently acknowledged')).toBeNull();
  expect(screen.queryByText('Older imported thread')).toBeNull();

  fireEvent.click(disclosure);
  const recent = screen.getByText('Recently acknowledged');
  const older = screen.getByText('Older imported thread');
  expect(recent.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText('Opened by accident')).toBeNull();
});

it('discovers sources, connects both providers, tracks and removes a repo, then finishes in native HQ', async () => {
  const github = { id: 'github', name: 'GitHub', status: 'needsapp' };
  const githubConnected = { ...github, status: 'connected', login: 'owner', via: 'app' };
  const chatgpt = { id: 'chatgpt', name: 'ChatGPT', status: 'notconnected' };
  const repo = { id: 'owner/project', displayName: 'owner/project', accessState: 'ok' };
  const githubPoll = Promise.withResolvers<ReturnType<typeof ok>>();
  const chatgptPoll = Promise.withResolvers<ReturnType<typeof ok>>();
  let setupComplete = false;
  native.mockImplementation(async ({ operation, parameters }) => {
    switch (operation) {
      case 'bootstrap':
        return ok({ setupComplete });
      case 'discover':
        return ok({
          sources: [{ id: 'codex', name: 'Codex', status: 'ok', location: '~/.codex/sessions' }],
          accounts: [github, chatgpt],
        });
      case 'sources':
        return ok({ accounts: [github, chatgpt] });
      case 'githubApp':
        return ok({ ...github, status: 'notconnected', appClientIdSaved: true });
      case 'githubConnect':
        return ok({
          mode: 'device',
          loginId: 'github-flow',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://github.com/login/device',
        });
      case 'githubPoll':
        return githubPoll.promise;
      case 'chatgptConnect':
        return ok({
          mode: 'browser',
          loginId: 'chatgpt-flow',
          authUrl: 'https://auth.openai.com/test',
        });
      case 'chatgptPoll':
        return chatgptPoll.promise;
      case 'repos':
        return ok({ active: [] });
      case 'repoDiscover':
        return ok(
          parameters.page === 1
            ? {
                repositories: [{ displayName: 'owner/another-repo', nodeId: 'repo-a' }],
                nextPage: 2,
              }
            : {
                repositories: [{ displayName: 'owner/project', nodeId: 'repo-b' }],
                nextPage: null,
              },
        );
      case 'repoAdd':
        return ok(repo);
      case 'repoRecheck':
        return ok({ ...repo, accessState: 'inaccessible', accessError: 'Removed on GitHub' });
      case 'repoRemove':
        return ok(null);
      case 'finish':
        setupComplete = true;
        return ok({ state: 'running' });
      case 'roster':
        return ok({ feeds: [{ id: 'codex', status: 'live' }], agents: [], truncated: false });
      case 'usage':
        return ok({
          providers: [
            { provider: 'codex', source: 'paseo', usedPercent: 21, canCheck: false, windows: [] },
          ],
        });
    }
  });
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  renderLauncher(vi.fn());

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await screen.findByText('~/.codex/sessions');
  expect(screen.getByText('Local sources')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText(/Paseo already reports Codex weekly quota/);
  expect(native.mock.calls.some(([input]) => input.operation === 'usageFallback')).toBe(false);
  fireEvent.click(await screen.findByRole('button', { name: 'Set up GitHub App' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'GitHub App client ID' }), {
    target: { value: 'Iv.123' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save client ID' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
  await screen.findByText('ABCD-EFGH');
  fireEvent.click(screen.getByRole('button', { name: 'Open GitHub sign-in' }));
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open ChatGPT sign-in' }));
  expect(openExternal.mock.calls).toEqual([
    ['https://github.com/login/device'],
    ['https://auth.openai.com/test'],
  ]);
  await act(async () => githubPoll.resolve(ok({ state: 'connected', account: githubConnected })));
  await act(async () =>
    chatgptPoll.resolve(ok({ state: 'connected', account: { ...chatgpt, status: 'connected' } })),
  );
  await waitFor(() => expect(screen.getAllByText('Connected')).toHaveLength(2));

  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  const search = await screen.findByRole('textbox', { name: 'Find a repository' });
  fireEvent.change(search, { target: { value: 'project' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Track owner/project' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Recheck access for owner/project' }));
  await screen.findByText('Removed on GitHub');
  fireEvent.click(screen.getByRole('button', { name: 'Stop tracking owner/project' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Stop tracking owner/project' })).toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
  await screen.findByText('A quiet one. No agents are running right now.');
  expect(native).toHaveBeenCalledWith({
    operation: 'githubApp',
    parameters: { clientId: 'Iv.123' },
  });
  expect(native).toHaveBeenCalledWith({
    operation: 'githubPoll',
    parameters: { loginId: 'github-flow' },
  });
  expect(native).toHaveBeenCalledWith({
    operation: 'chatgptPoll',
    parameters: { loginId: 'chatgpt-flow' },
  });
  expect(native).toHaveBeenCalledWith({
    operation: 'repoDiscover',
    parameters: { login: 'owner', via: 'app', page: 2 },
  });
  expect(native).toHaveBeenCalledWith({
    operation: 'repoAdd',
    parameters: {
      input: repo.id,
      githubAccount: { login: 'owner', via: 'app' },
      repositoryNodeId: 'repo-b',
    },
  });
  expect(native).toHaveBeenCalledWith({ operation: 'repoRecheck', parameters: { id: repo.id } });
  expect(native).toHaveBeenCalledWith({ operation: 'repoRemove', parameters: { id: repo.id } });
  expect(launch).not.toHaveBeenCalled();
});

it('starts a native runtime install only after explicit consent and resumes bootstrap in Paseo', async () => {
  native.mockImplementationOnce(async () => ({
    ok: false,
    reason: 'runtime-required',
    message: 'Runtime required.',
  }));
  installNativeRuntime
    .mockResolvedValueOnce({ state: 'installing' })
    .mockResolvedValueOnce({ state: 'finished', result: { ok: true } });
  renderLauncher(vi.fn());

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  const install = await screen.findByRole('button', { name: 'Install runtime' });
  expect(installNativeRuntime).not.toHaveBeenCalled();
  fireEvent.click(install);
  await screen.findByText('Live agents aren’t available in this session.');
  expect(installNativeRuntime.mock.calls).toEqual([[{ action: 'start' }], [{ action: 'status' }]]);
  expect(launch).not.toHaveBeenCalled();
});

it('returns to native setup when the shared dashboard has been reset', async () => {
  native.mockImplementation(async ({ operation }) => {
    if (operation === 'bootstrap') return ok({ setupComplete: true });
    if (operation === 'roster') {
      return ok({
        agents: [],
        feeds: [{ id: 'paseo', status: 'setup_incomplete' }],
        truncated: false,
      });
    }
    if (operation === 'discover') return ok({ sources: [], accounts: [] });
    return ok({ providers: [] });
  });
  renderLauncher(vi.fn());
  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await screen.findByText('Finding agent records on this machine');
  expect(launch).not.toHaveBeenCalled();
});

it('discards prior-host requests and keeps quota available when the new host roster fails', async () => {
  const oldQuota = Promise.withResolvers<ReturnType<typeof ok>>();
  let firstHost = true;
  native.mockImplementation(async ({ operation }) => {
    if (operation === 'bootstrap') return ok({ setupComplete: true });
    if (operation === 'roster') {
      if (!firstHost)
        return { ok: false, reason: 'unavailable', message: 'Roster unavailable here.' };
      return ok({
        agents: [
          {
            id: 'old',
            title: 'Previous host task',
            provider: 'codex',
            state: 'working',
            seenBy: {},
          },
        ],
        feeds: [],
        truncated: false,
      });
    }
    if (operation === 'usage') {
      if (firstHost) return oldQuota.promise;
      return ok({
        providers: [{ provider: 'codex', source: 'paseo', usedPercent: 14, canCheck: false }],
      });
    }
    if (operation === 'sources') return ok({ sources: [], accounts: [] });
    if (operation === 'repos') return ok({ active: [] });
  });
  const { switchHost } = renderLauncher(vi.fn());
  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await screen.findByText('Previous host task');
  fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  await waitFor(() =>
    expect(native).toHaveBeenCalledWith(expect.objectContaining({ operation: 'usage' })),
  );
  firstHost = false;
  switchHost({ id: 'srv_second', label: 'New host' });
  expect(screen.queryByText('Previous host task')).toBeNull();
  await screen.findByText('Roster unavailable here.');
  fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  await screen.findByText('14% used this week');
  await act(async () =>
    oldQuota.resolve(ok({ providers: [{ provider: 'codex', source: 'paseo', usedPercent: 90 }] })),
  );
  expect(screen.queryByText('90% used this week')).toBeNull();
  expect(screen.getByText('14% used this week')).toBeTruthy();
});

it('opens owner settings at the protected Sources destination after an explicit action', async () => {
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  renderLauncher(vi.fn());
  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await screen.findByText('Live agents aren’t available in this session.');
  fireEvent.click(screen.getByRole('tab', { name: /^Sources & repos/ }));
  const settings = await screen.findByRole('button', { name: 'Open owner settings' });
  expect(launch).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
  fireEvent.click(settings);
  await waitFor(() =>
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl + '/sources'),
  );
});
