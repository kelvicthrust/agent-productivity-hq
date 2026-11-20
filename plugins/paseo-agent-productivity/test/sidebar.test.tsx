import type {
  PluginClientContext,
  PluginOpenScreenInput,
  PluginScreenProps,
} from '@getpaseo/plugin/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigureLauncher } from '../client/settings.tsx';
import contribute from '../index.client.tsx';

const { useSettings, launch, installRuntime, usePaseo, listWorkspaces, externalBrowser } =
  vi.hoisted(() => ({
    useSettings: vi.fn(),
    launch: vi.fn(),
    installRuntime: vi.fn(),
    usePaseo: vi.fn(),
    listWorkspaces: vi.fn(),
    externalBrowser: { open: undefined as ((url: string) => Promise<void>) | undefined },
  }));
vi.mock('@getpaseo/plugin/client', () => ({
  useSettings,
  useRpc: ({ name }: { name: string }) => (name === 'dashboard.launch' ? launch : installRuntime),
  usePaseo,
  useWorkspaces: () => {
    throw new Error('Plugin state hooks must run inside a plugin host');
  },
  get openExternalUrl() {
    return externalBrowser.open;
  },
}));
vi.mock('@getpaseo/plugin/client/ui', () => ({
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
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children, selectable }: { children: ReactNode; selectable?: boolean }) => (
    <span style={selectable ? { userSelect: 'text' } : undefined}>{children}</span>
  ),
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  TextInput: ({ accessibilityLabel, value }: { accessibilityLabel: string; value: string }) => (
    <input aria-label={accessibilityLabel} value={value} readOnly />
  ),
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
  sourceWorkspace: string,
  openBrowser: (source: string, target: BrowserTarget) => void,
  clientLayout: PluginScreenProps['layout'] = layout,
  embeddedBrowser = clientLayout.platform === 'web',
) {
  const addSidebarHeaderItem = vi.fn<PluginClientContext['addSidebarHeaderItem']>(() => () => {});
  const addScreen = vi.fn<PluginClientContext['addScreen']>(() => () => {});
  const openSettings = vi.fn<PluginClientContext['openSettings']>();
  contribute({
    addSidebarHeaderItem,
    addScreen,
    addSettingsScreen: () => () => {},
    openSettings,
  } as unknown as PluginClientContext);
  const { Component: SidebarItem } = addSidebarHeaderItem.mock.calls[0]![0];
  const { Component: Launcher } = addScreen.mock.calls[0]![0];

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
                      openAgent: () => {},
                      openBrowser: (target) => {
                        openBrowser(sourceWorkspace, target);
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

  const renderHost = (selectedHost = host) => (
    <StrictMode>
      <HostFrame selectedHost={selectedHost} />
    </StrictMode>
  );
  const { rerender } = render(renderHost());
  return {
    openSettings,
    refreshSettings: () => rerender(renderHost()),
    switchHost: (selectedHost: PluginScreenProps['host']) => rerender(renderHost(selectedHost)),
  };
}

function workspacePage(ids: string[], nextCursor: string | null = null) {
  return {
    entries: ids.map((id) => ({ id, name: id, workspaceDirectory: '/workspaces/' + id })),
    pageInfo: { nextCursor },
  };
}

beforeEach(() => {
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

it('offers a private Node.js install only after a launch discovers it is needed', async () => {
  const openBrowser = vi.fn();
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
  renderLauncher('other', openBrowser);

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  const install = await screen.findByRole('button', { name: 'Install runtime' });
  expect(launch.mock.calls).toEqual([[{}]]);
  expect(installRuntime).not.toHaveBeenCalled();
  expect(openBrowser).not.toHaveBeenCalled();

  fireEvent.click(install);
  await screen.findByText('The download could not be verified.');
  expect(installRuntime.mock.calls).toEqual([[{ action: 'start' }]]);
  expect(openBrowser).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Install runtime' }));
  await waitFor(() =>
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith('other', {
      serverId: host.id,
      workspaceId,
      url: privateUrl,
    }),
  );
  expect(installRuntime.mock.calls).toEqual([[{ action: 'start' }], [{ action: 'start' }]]);
});

it('polls an acknowledged runtime install beyond the invocation deadline without starting it again', async () => {
  vi.useFakeTimers();
  try {
    const openBrowser = vi.fn();
    launch.mockResolvedValue({ ok: false, reason: 'runtime-required', message: 'Node.js needed.' });
    installRuntime.mockResolvedValue({ state: 'installing' });
    renderLauncher('other', openBrowser);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Install runtime' })));
    fireEvent.click(screen.getByRole('button', { name: 'Installing…' }));
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    expect(installRuntime.mock.calls.filter(([input]) => input.action === 'start')).toEqual([
      [{ action: 'start' }],
    ]);
    expect(installRuntime.mock.calls.filter(([input]) => input.action === 'status')).toHaveLength(
      31,
    );
    expect(openBrowser).not.toHaveBeenCalled();

    installRuntime.mockResolvedValue({ state: 'finished', result: { ok: true, url: privateUrl } });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith('other', {
      serverId: host.id,
      workspaceId,
      url: privateUrl,
    });
  } finally {
    vi.useRealTimers();
  }
});

it('opens the private dashboard on iOS without the entity state provider', async () => {
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  const openBrowser = vi.fn();
  const phoneLayout = { platform: 'ios', compact: true } as const;
  renderLauncher('other', openBrowser, phoneLayout);

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(openBrowser).not.toHaveBeenCalled();
  expect(useSettings).not.toHaveBeenCalled();
  expect(usePaseo).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Leave launcher' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to launcher' }));
  expect(screen.getByRole('button', { name: 'Open dashboard' })).toBeTruthy();
  expect(launch).toHaveBeenCalledTimes(1);

  render(<ConfigureLauncher host={host} layout={phoneLayout} theme={theme} />);
  expect(screen.getByText('Choose a dashboard workspace in Paseo Desktop.')).toBeTruthy();
  expect(useSettings).not.toHaveBeenCalled();
  expect(usePaseo).not.toHaveBeenCalled();
});

it.each(['missing', 'rejects'])(
  'keeps the selectable URL and retry when the phone opener %s',
  async (behavior) => {
    if (behavior === 'rejects') {
      externalBrowser.open = vi.fn().mockRejectedValue(new Error('No browser handler'));
    }
    renderLauncher('other', vi.fn(), { platform: 'android', compact: true });

    fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
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
  },
);

it('waits for a browser button press on web clients without workspace navigation', async () => {
  const openExternal = vi.fn(async () => {});
  externalBrowser.open = openExternal;
  renderLauncher('other', vi.fn(), layout, false);

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
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
  const { switchHost } = renderLauncher('other', vi.fn(), { platform: 'ios', compact: true });

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  expect(launch).toHaveBeenCalledTimes(1);
  switchHost({ id: 'another-host', label: 'Another host' });
  await act(async () =>
    firstLaunch.resolve({ ok: true, url: 'https://old.example-tailnet.ts.net' }),
  );
  expect(openExternal).not.toHaveBeenCalled();
  expect(launch).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(privateUrl));
  expect(launch).toHaveBeenCalledTimes(2);
});

it.each(['source-workspace-a', 'source-workspace-b'])(
  'opens the same bound workspace when clicked from %s and does not replay on Back',
  async (source) => {
    const openBrowser = vi.fn();
    renderLauncher(source, openBrowser);

    fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
    await screen.findByRole('button', { name: 'Back to launcher' });
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith(source, {
      url: privateUrl,
      workspaceId,
      serverId: host.id,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back to launcher' }));
    await screen.findByRole('button', { name: 'Change workspace' });
    expect(openBrowser).toHaveBeenCalledTimes(1);
  },
);

it('shows the saved destination and the settings action if the bound workspace is unavailable', async () => {
  const openBrowser = vi.fn(() => {
    throw new Error('Workspace is unavailable on the requested host.');
  });
  const { openSettings } = renderLauncher('source-workspace-b', openBrowser);

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await screen.findByText(
    'This workspace is unavailable. Choose another dashboard workspace, then retry.',
  );
  expect(screen.getByText(host.label)).toBeTruthy();
  expect(launch).toHaveBeenCalledTimes(1);
  expect(openBrowser).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
  await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'Change workspace' }));
  expect(openSettings).toHaveBeenCalledExactlyOnceWith('dashboard');
});

it('opens the dashboard once when the first sidebar click precedes the settings response', async () => {
  useSettings.mockReturnValue({ status: 'loading' });
  const openBrowser = vi.fn();
  const source = 'source-workspace-a';
  const { refreshSettings } = renderLauncher(source, openBrowser);

  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await screen.findByText('Loading workspace settings…');
  expect(openBrowser).not.toHaveBeenCalled();

  launch.mockReset().mockResolvedValue({ ok: true, url: privateUrl });
  useSettings.mockReturnValue({
    status: 'ready',
    values: { workspaceId, privateUrl: 'https://old.example.ts.net' },
  });
  refreshSettings();
  await screen.findByRole('button', { name: 'Back to launcher' });
  expect(openBrowser).toHaveBeenCalledExactlyOnceWith(source, {
    url: privateUrl,
    workspaceId,
    serverId: host.id,
  });
});

it('offers a reset for invalid saved settings and shows the empty form after a successful reset', async () => {
  const reset = vi.fn(async () => true);
  useSettings.mockReturnValue({ status: 'invalid', reset });
  const view = <ConfigureLauncher host={host} layout={layout} theme={theme} />;
  const { rerender } = render(view);

  fireEvent.click(screen.getByRole('button', { name: 'Reset settings' }));
  expect(reset).toHaveBeenCalledTimes(1);

  useSettings.mockReturnValue({ status: 'ready', values: { workspaceId: '', privateUrl: '' } });
  rerender(<ConfigureLauncher host={host} layout={layout} theme={theme} />);
  expect(await screen.findByRole('button', { name: 'Choose' })).toBeTruthy();
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
  const openBrowser = vi.fn();
  renderLauncher('other', openBrowser);
  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  await screen.findByText('Remove the previous private share.');
  expect(openBrowser).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
  await waitFor(() =>
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith('other', {
      serverId: host.id,
      workspaceId,
      url: privateUrl,
    }),
  );
});

it('offers a host workspace picker before starting when a new installation has several workspaces', async () => {
  const save = vi.fn();
  useSettings.mockReturnValue({
    status: 'ready',
    values: { workspaceId: '', privateUrl: '' },
    save,
    revision: 'one',
  });
  listWorkspaces.mockImplementation(async ({ page }: { page: { cursor?: string } }) =>
    page.cursor ? workspacePage(['second']) : workspacePage(['first'], 'next-page'),
  );
  const openBrowser = vi.fn();
  const { refreshSettings } = renderLauncher('other', openBrowser);
  fireEvent.click(screen.getByRole('button', { name: 'Agent HQ' }));
  const choices = await screen.findAllByRole('button', { name: 'Choose' });
  expect(launch).not.toHaveBeenCalled();
  fireEvent.click(choices[1]!);
  expect(save).toHaveBeenCalledWith({ workspaceId: 'second', privateUrl: '' }, 'one');
  useSettings.mockReturnValue({
    status: 'ready',
    values: { workspaceId: 'second', privateUrl: '' },
  });
  refreshSettings();
  await waitFor(() =>
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith('other', {
      serverId: host.id,
      workspaceId: 'second',
      url: privateUrl,
    }),
  );
});
