import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  useEffect,
  useImperativeHandle,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeRequest } from '../client/native-api.ts';
import { NativeDelivery } from '../client/native-delivery.tsx';
import { ReportingProvider } from '../client/native-reporting.tsx';
import { NativeRepos } from '../client/native-repos.tsx';
import { NativePage } from '../client/native-ui.tsx';
import { NativeUsage } from '../client/native-usage.tsx';
import type { PullRequest, Session } from '../shared/report-contracts.ts';

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock('@getpaseo/plugin/client', () => ({ openExternalUrl, useRpc: vi.fn() }));
vi.mock('@getpaseo/plugin/client/ui', () => ({ Icon: () => null }));
vi.mock('react-native', () => {
  const Container = ({
    children,
    ref,
    role,
    style,
    testID,
  }: {
    children: ReactNode;
    ref?: Ref<{ measureInWindow(callback: (...bounds: number[]) => void): void; scrollTo(): void }>;
    role?: string;
    style?: CSSProperties;
    testID?: string;
  }) => {
    useImperativeHandle(ref, () => ({
      measureInWindow: (callback) => callback(680, 340, 120, 44),
      scrollTo: () => {},
    }));
    return (
      <div data-testid={testID} role={role} style={Array.isArray(style) ? undefined : style}>
        {children}
      </div>
    );
  };
  function Modal({
    'aria-label': label,
    children,
    onRequestClose,
  }: {
    'aria-label': string;
    children: ReactNode;
    onRequestClose(): void;
  }) {
    useEffect(() => {
      const handleEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') onRequestClose();
      };
      document.addEventListener('keyup', handleEscape);
      return () => document.removeEventListener('keyup', handleEscape);
    }, [onRequestClose]);
    return createPortal(
      <div aria-label={label} role="dialog">
        {children}
      </div>,
      document.body,
    );
  }
  return {
    View: Container,
    ScrollView: Container,
    KeyboardAvoidingView: Container,
    StyleSheet: { absoluteFill: {} },
    Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 1024, height: 720 }),
    Modal,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      'aria-expanded': ariaExpanded,
      'aria-selected': ariaSelected,
      children,
      disabled,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { expanded?: boolean; selected?: boolean };
      'aria-expanded'?: boolean;
      'aria-selected'?: boolean;
      children: ReactNode;
      disabled?: boolean;
      onPress(): void;
    }) => (
      <button
        aria-label={accessibilityLabel}
        aria-expanded={ariaExpanded ?? accessibilityState?.expanded}
        aria-selected={ariaSelected ?? accessibilityState?.selected}
        disabled={disabled}
        onClick={onPress}
        role={accessibilityRole}
      >
        {children}
      </button>
    ),
    TextInput: ({
      accessibilityLabel,
      onChangeText,
      value,
      ref,
    }: {
      accessibilityLabel: string;
      onChangeText?(value: string): void;
      value?: string;
      ref?: Ref<HTMLInputElement>;
    }) => (
      <input
        aria-label={accessibilityLabel}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
        value={value}
        ref={ref}
      />
    ),
  };
});

afterEach(() => {
  cleanup();
  openExternalUrl.mockReset();
});

const mergedAt = '2026-11-05T01:00:00Z';
const pr: PullRequest = {
  id: 'legacy/PR+=',
  repo: 'kelvin/app',
  number: 23,
  title: 'Example change',
  url: 'https://github.com/kelvin/app/pull/23',
  mergedAt,
  author: 'kelvin',
  mergedBy: 'kelvin',
  authoredByMe: true,
  linkClass: 'suggested',
  linkedSessionCount: 0,
  suggestedCount: 1,
  providers: ['codex'],
};
const session: Session = {
  id: 1,
  provider: 'codex',
  kind: 'root',
  nameLead: 'Example session',
  named: true,
  providerSessionRef: 'session-1',
  tokens: 275,
  startedAt: mergedAt,
  startedBasis: 'source_start',
  firstEventAt: mergedAt,
  lastEventAt: mergedAt,
  linkStatus: 'linked',
  linkedPrs: [{ prId: pr.id, repo: pr.repo, number: pr.number, mergedAt, class: 'suggested' }],
};

function reporting(children: ReactNode, request: ReturnType<typeof vi.fn>) {
  const navigate = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ReportingProvider
        hostId="test"
        request={request as NativeRequest}
        navigate={navigate}
        bootstrap={{
          setupComplete: true,
          timezone: 'America/Los_Angeles',
          today: '2026-11-05',
          lookbackStart: '2025-11-05',
          issues: [],
        }}
      >
        <NativePage
          theme={{ colors: {} } as PluginScreenProps['theme']}
          layout={{ compact: true, platform: 'web' }}
        >
          {children}
        </NativePage>
      </ReportingProvider>
    </QueryClientProvider>,
  );
  return navigate;
}

it('keeps Undo available when a confirmed suggestion leaves the filtered Delivery list', async () => {
  let applied = false;
  const request = vi.fn(async (operation, parameters) => {
    if (operation === 'repos') return { active: [{ id: pr.repo, displayName: pr.repo }] };
    if (operation === 'prs') {
      return {
        counts: { all: 1, suggested: applied ? 0 : 1, owner: applied ? 1 : 0 },
        items: applied && parameters.linkClass === 'suggested' ? [] : [pr],
        linkHealth: { state: 'fresh', lastSuccessfulAt: mergedAt },
      };
    }
    if (operation === 'prDetail') {
      return {
        pr,
        evidence: [
          {
            session,
            effectiveClass: 'suggested',
            basis: 'same_branch',
            basisText: 'Same branch',
            actions: ['confirm', 'dismiss'],
          },
        ],
      };
    }
    if (operation === 'prLinkSet') applied = true;
    if (operation === 'prLinkRemove') applied = false;
    return null;
  });
  reporting(<NativeDelivery />, request);

  fireEvent.click(await screen.findByRole('tab', { name: 'Suggested only 1' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Show link evidence for Example change' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: /^Confirm link for Example session/ }));
  await screen.findByText('No PRs match these filters.');
  expect(request).toHaveBeenCalledWith('prLinkSet', {
    prId: pr.id,
    sessionId: session.id,
    decision: 'confirmed',
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  await screen.findByText('Change undone.');
  expect(request).toHaveBeenCalledWith('prLinkRemove', { prId: pr.id, sessionId: session.id });
  fireEvent.click(await screen.findByRole('link', { name: 'Example change (opens GitHub)' }));
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(pr.url);
});

it('offers the GitHub opener only for HTTPS GitHub URLs', async () => {
  const request = vi.fn(async (operation) => {
    if (operation === 'repos') return { active: [{ id: pr.repo, displayName: pr.repo }] };
    return {
      counts: { all: 2 },
      items: [
        pr,
        {
          ...pr,
          id: 'other-id',
          number: 24,
          title: 'Other change',
          url: 'blob:https://github.com/fixture',
        },
      ],
      linkHealth: { state: 'fresh', lastSuccessfulAt: mergedAt },
    };
  });
  reporting(<NativeDelivery compact={false} />, request);
  await screen.findByRole('columnheader', { name: 'Merged by' });
  await screen.findByText('Other change');
  expect(screen.getByRole('link', { name: 'Example change (opens GitHub)' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Other change (opens GitHub)' })).toBeNull();
});

it('keeps the last filter’s pull requests out of a pending Delivery view', async () => {
  const request = vi.fn(async (operation, parameters) => {
    if (operation === 'repos') return { active: [{ id: pr.repo, displayName: pr.repo }] };
    if (parameters.linkClass === 'unlinked') return new Promise(() => undefined);
    return {
      counts: { all: 1, unlinked: 0 },
      items: [pr],
      linkHealth: { state: 'fresh', lastSuccessfulAt: mergedAt },
    };
  });
  reporting(<NativeDelivery />, request);
  await screen.findByText('Example change');
  fireEvent.click(screen.getByRole('tab', { name: 'Unlinked 0' }));
  expect(await screen.findByText('Loading pull requests…')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Show link evidence for Example change' }),
  ).toBeNull();
});

it('requires confirmation before stopping a repository in Sources', async () => {
  const repo = { id: pr.repo, displayName: pr.repo, accessState: 'ok' };
  let stopped = false;
  const request = vi.fn(async (operation) => {
    if (operation === 'repoRemove') stopped = true;
    if (operation === 'repos') return stopped ? { stopped: [repo] } : { active: [repo] };
    return null;
  });
  reporting(
    <NativeRepos account={null} mode="sources" request={request as NativeRequest} />,
    request,
  );
  fireEvent.click(await screen.findByRole('button', { name: `Stop tracking ${pr.repo}` }));
  expect(request).not.toHaveBeenCalledWith('repoRemove', expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('button', { name: 'Stop tracking' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: `Stop tracking ${pr.repo}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop tracking' }));
  await screen.findByText('Previously tracked');
  expect(request.mock.calls.filter(([operation]) => operation === 'repoRemove')).toEqual([
    ['repoRemove', { id: pr.repo }],
  ]);
});

it('opens the Sources repository picker in a bounded overlay and keeps setup inline', async () => {
  const account = { login: 'kelvin', via: 'gh' } as const;
  const repositories = Array.from({ length: 20 }, (_, index) => ({
    displayName: `kelvin/repo-${index}`,
    nodeId: `node-${index}`,
    trackedRepoId: null,
  }));
  const request = vi.fn(async (operation) => {
    if (operation === 'repos') return { active: [] };
    if (operation === 'repoDiscover') return { repositories, nextPage: null };
    if (operation === 'repoAdd') {
      return { id: 'kelvin/repo-19', displayName: 'kelvin/repo-19', accessState: 'ok' };
    }
    return null;
  });
  reporting(
    <NativeRepos account={account} mode="sources" request={request as NativeRequest} />,
    request,
  );
  await screen.findByText('No repositories tracked yet.');

  const trigger = screen.getByRole('button', { name: 'Add repository' });
  expect(request.mock.calls.some(([operation]) => operation === 'repoDiscover')).toBe(false);
  fireEvent.click(trigger);

  const dropdown = await screen.findByRole('dialog', { name: 'Add repository' });
  const page = screen.getByTestId('agent-hq-app');
  const results = within(dropdown).getByTestId('repository-picker-results');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(page.contains(dropdown)).toBe(false);
  expect(results.style.maxHeight).toBe('320px');
  const search = within(dropdown).getByRole('textbox', { name: 'Find a repository' });
  expect(document.activeElement).toBe(search);
  await within(results).findByRole('button', { name: 'Track kelvin/repo-1' });
  fireEvent.change(search, { target: { value: 'repo-19' } });
  expect(within(results).queryByRole('button', { name: 'Track kelvin/repo-1' })).toBeNull();
  fireEvent.click(await within(results).findByRole('button', { name: 'Track kelvin/repo-19' }));
  expect(await within(page).findByText('kelvin/repo-19')).toBeTruthy();
  expect(within(results).getByText('Tracking')).toBeTruthy();
  expect(request).toHaveBeenCalledWith('repoAdd', {
    input: 'kelvin/repo-19',
    githubAccount: account,
    repositoryNodeId: 'node-19',
  });
  fireEvent.keyUp(search, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  cleanup();
  reporting(<NativeRepos account={account} request={request as NativeRequest} />, request);
  expect(
    await within(screen.getByTestId('agent-hq-app')).findByRole('textbox', {
      name: 'Find a repository',
    }),
  ).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('updates tracked repositories after dismissing the picker during an add', async () => {
  const repo = { id: pr.repo, displayName: pr.repo, accessState: 'ok' } as const;
  const addition = Promise.withResolvers<typeof repo>();
  const request = vi.fn(async (operation) => {
    if (operation === 'repos') return { active: [] };
    if (operation === 'repoDiscover') {
      return {
        repositories: [{ displayName: pr.repo, nodeId: 'repo-node', trackedRepoId: null }],
        nextPage: null,
      };
    }
    if (operation === 'repoAdd') return addition.promise;
    return null;
  });
  const onReposChange = vi.fn();
  reporting(
    <NativeRepos
      account={{ login: 'kelvin', via: 'gh' }}
      mode="sources"
      request={request as NativeRequest}
      onReposChange={onReposChange}
    />,
    request,
  );
  await screen.findByText('No repositories tracked yet.');
  const trigger = screen.getByRole('button', { name: 'Add repository' });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('button', { name: `Track ${pr.repo}` }));
  expect(request).toHaveBeenCalledWith('repoAdd', expect.objectContaining({ input: pr.repo }));

  fireEvent.keyUp(screen.getByRole('textbox', { name: 'Find a repository' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  addition.resolve(repo);
  await within(screen.getByTestId('agent-hq-app')).findByText(pr.repo);
  expect(onReposChange).toHaveBeenCalledTimes(1);

  fireEvent.click(trigger);
  const dropdown = await screen.findByRole('dialog', { name: 'Add repository' });
  expect(await within(dropdown).findByText('Tracking')).toBeTruthy();
  expect(within(dropdown).queryByRole('button', { name: `Track ${pr.repo}` })).toBeNull();
});

it('expands and pages Usage roots and drills through on the merge day in the report timezone', async () => {
  const child: Session = { ...session, id: 2, kind: 'child', nameLead: 'Child agent task' };
  const request = vi.fn(async (operation, parameters) => {
    if (operation === 'usageCategories') {
      return { codex: { coverage: 'ok', input: 200, cachedInput: 90, output: 75, total: 275 } };
    }
    if (operation === 'usageGroups') {
      return { groups: [{ key: pr.repo, roots: 2, sessions: 3, tokens: { codex: 275 } }] };
    }
    if (operation === 'usageRoots') {
      return parameters.cursor
        ? { roots: [{ ...session, id: 3, nameLead: 'Next root', linkedPrs: [] }], remaining: 0 }
        : { roots: [{ ...session, children: [child] }], nextCursor: 'next', remaining: 1 };
    }
    return null;
  });
  const navigate = reporting(<NativeUsage />, request);
  await screen.findByText('included in input');
  expect(request).not.toHaveBeenCalledWith('usageRoots', expect.anything());
  fireEvent.click(await screen.findByRole('button', { name: 'Expand kelvin/app' }));
  fireEvent.click(
    await screen.findByRole('button', { name: /^Show 1 child agent of Example session/ }),
  );
  await screen.findByText('Child agent task');
  fireEvent.click(await screen.findByRole('button', { name: 'Show 1 more root' }));
  await screen.findByText('Next root');
  expect(request).toHaveBeenCalledWith(
    'usageRoots',
    expect.objectContaining({ cursor: 'next', limit: 15 }),
  );
  const [openPr] = screen.getAllByRole('link', {
    name: '#23 Suggested, view kelvin/app in Delivery',
  });
  fireEvent.click(openPr!);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('delivery', {
    start: '2026-11-04',
    end: '2026-11-04',
    prId: pr.id,
  });
});
