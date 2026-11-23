import * as paseo from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/ui';
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { colors } from '../shared/reporting-palette.ts';
import type { AccountStatus } from './native-types.ts';
import {
  NativeRequestError,
  requestMessage,
  useNativeAction,
  useNativePoll,
  type NativeRequest,
} from './native-api.ts';
import {
  NativeActions,
  NativeButton,
  NativeInput,
  NativeProblem,
  NativeText,
  useDashboardLayout,
} from './native-ui.tsx';

type AccountId = 'github' | 'chatgpt';
const providers = {
  github: {
    name: 'GitHub',
    purpose: 'Connect GitHub to track merged pull requests in the repositories you choose.',
    connect: 'githubConnect',
    poll: 'githubPoll',
    disconnect: 'githubDisconnect',
  },
  chatgpt: {
    name: 'ChatGPT',
    purpose: 'Adds account-reported Codex usage. Connecting can also sign Codex in on this host.',
    connect: 'chatgptConnect',
    poll: 'chatgptPoll',
    disconnect: 'chatgptDisconnect',
  },
} as const;

const statusLabels: Record<AccountStatus['status'], string> = {
  existing: 'Using your existing sign-in',
  connected: 'Connected',
  notconnected: 'Not connected',
  needsapp: 'GitHub App setup needed',
  reconnect: 'Reconnect needed',
  unavailable: 'Sign-in unavailable',
  connecting: 'Waiting for sign-in…',
  failed: 'Connection problem',
};

interface Flow {
  id: string;
  url: string | null;
  code?: string | null;
}

function signInUrl(url: string | null | undefined, id: AccountId): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (id === 'github' && parsed.origin !== 'https://github.com') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

async function openSignIn(url: string) {
  try {
    await paseo.openExternalUrl(url);
  } catch {
    throw new NativeRequestError('open-failed', 'Copy the address and open it in your browser.');
  }
}

function GitHubAppSetup({
  request,
  onAccount,
  close,
}: {
  request: NativeRequest;
  onAccount(account: AccountStatus): void;
  close(): void;
}) {
  const action = useNativeAction();
  const [clientId, setClientId] = useState('');
  const registration = 'https://github.com/settings/apps/new';
  return (
    <>
      <NativeText heading>Register your GitHub App</NativeText>
      <NativeText tone="foregroundMuted">
        Register a personal GitHub App with a unique name and http://127.0.0.1:4317 as its homepage.
        Leave webhooks off, enable Device Flow, and give Pull requests read-only access.
      </NativeText>
      <NativeText tone="foregroundMuted">
        Keep expiring user tokens on. Install the App on each account or organization that owns a
        repository you’ll track. Copy the Client ID from the App settings.
      </NativeText>
      <NativeButton
        label="Register at GitHub"
        onPress={() => void action.run(() => openSignIn(registration))}
        disabled={action.busy}
      />
      <NativeInput
        accessibilityLabel="GitHub App client ID"
        placeholder="GitHub App client ID"
        maxLength={40}
        value={clientId}
        onChangeText={setClientId}
      />
      <NativeActions>
        <NativeButton
          label="Save client ID"
          disabled={action.busy || !clientId.trim()}
          onPress={() =>
            void action.run(async (signal) => {
              const account = await request('githubApp', { clientId: clientId.trim() });
              if (signal.aborted) return;
              onAccount(account);
              close();
            })
          }
        />
        <NativeButton label="Close GitHub App setup" disabled={action.busy} onPress={close} />
      </NativeActions>
      <NativeProblem message={action.problem} />
    </>
  );
}

export function NativeAccount({
  id,
  account,
  request,
  onAccount,
  onCheckSources,
  setup = false,
}: {
  id: AccountId;
  account?: AccountStatus;
  request: NativeRequest;
  onAccount(account: AccountStatus): void;
  onCheckSources(): void;
  setup?: boolean;
}) {
  const provider = providers[id];
  const { compact } = useDashboardLayout();
  const action = useNativeAction();
  const flowRef = useRef<Flow | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [showApp, setShowApp] = useState(false);
  const [pollProblem, setPollProblem] = useState<string>();
  const [retryPoll, setRetryPoll] = useState(0);

  function changeFlow(next: Flow | null) {
    flowRef.current = next;
    setFlow(next);
  }

  const refreshAccount = useCallback(
    async (signal: AbortSignal) => {
      const { accounts } = await request('sources');
      const next = accounts?.find((card) => card.id === id);
      if (!signal.aborted && next) onAccount(next);
    },
    [id, onAccount, request],
  );

  useNativePoll(
    useCallback(
      async (signal: AbortSignal) => {
        if (!flow || action.busy) return;
        try {
          const result = await request(provider.poll, { loginId: flow.id });
          if (signal.aborted || flowRef.current !== flow) return;
          setPollProblem(undefined);
          if (result.state === 'pending') return 2_000;
          if (result.account) onAccount(result.account);
          else await refreshAccount(signal);
          if (signal.aborted) return;
          changeFlow(null);
          if (result.state !== 'connected') {
            setPollProblem(result.message ?? 'Sign-in ended. Start again to reconnect.');
          }
        } catch (error) {
          if (!signal.aborted) setPollProblem(requestMessage(error));
        }
      },
      [action.busy, flow, onAccount, provider.poll, refreshAccount, request],
    ),
    retryPoll,
  );

  function connect() {
    void action.run(async (signal) => {
      changeFlow(null);
      setPollProblem(undefined);
      setShowApp(false);
      const result = await request(provider.connect);
      if (signal.aborted) return;
      if (result.mode === 'existing') {
        await refreshAccount(signal);
        return;
      }
      const expectedMode = id === 'github' ? 'device' : 'browser';
      if (result.mode !== expectedMode || !result.loginId) {
        throw new NativeRequestError(
          'sign-in-unavailable',
          'The host could not start sign-in. Try again.',
        );
      }
      changeFlow({
        id: result.loginId,
        code: result.userCode,
        url: signInUrl(id === 'github' ? result.verificationUri : result.authUrl, id),
      });
    });
  }

  function disconnect() {
    void action.run(async (signal) => {
      setPollProblem(undefined);
      const updated = await request(provider.disconnect);
      if (signal.aborted) return;
      changeFlow(null);
      onAccount(updated);
    });
  }

  const connected = account?.status === 'existing' || account?.status === 'connected';
  const pending = Boolean(flow) || account?.status === 'connecting';
  const needsApp = id === 'github' && account?.status === 'needsapp';
  const unavailable = !account || account.status === 'unavailable';
  const authUrl = flow?.url;
  const status = pending ? 'Waiting for sign-in…' : statusLabels[account?.status ?? 'unavailable'];
  const purpose = !setup
    ? provider.purpose
    : id === 'github'
      ? 'Merged PRs require a GitHub connection and a tracked repository.'
      : 'Optional · adds account-reported Codex usage.';

  return (
    <View
      style={{
        borderTopWidth: setup && id === 'github' ? 0 : 1,
        borderTopColor: colors.border,
        paddingTop: setup && id === 'github' ? 0 : 12,
        flexDirection: compact ? 'column' : 'row',
        gap: compact ? 6 : 12,
        flexWrap: 'wrap',
      }}
    >
      <View style={{ flexBasis: compact ? 'auto' : '34%', gap: 4 }}>
        <NativeText heading>{provider.name}</NativeText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon
            name={connected ? 'Check' : 'CircleMinus'}
            size={14}
            color={connected ? colors.success : colors['text-muted']}
          />
          <NativeText
            announce
            tone="foregroundMuted"
            size={12}
            style={{
              color: connected ? colors.success : colors['text-muted'],
              fontWeight: '600',
              flexShrink: 1,
            }}
          >
            {status}
          </NativeText>
        </View>
      </View>
      <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: 4 }}>
        <NativeText size={12} tone="foregroundMuted">
          {purpose}
        </NativeText>
        {account?.statusText && account.statusText !== status && (
          <NativeText size={12} tone="foregroundMuted">
            {account.statusText}
          </NativeText>
        )}
        {connected && account.login && (
          <NativeText size={12} tone="foregroundMuted">
            {id === 'github'
              ? `Identity: ${account.login} (used for “Authored by you”)`
              : account.login}
          </NativeText>
        )}
      </View>
      <View
        style={{
          alignItems: compact ? 'flex-start' : 'flex-end',
          gap: 4,
          width: compact ? '100%' : 192,
        }}
      >
        <NativeActions>
          {pending && authUrl ? (
            <NativeButton
              label={id === 'chatgpt' ? 'Open ChatGPT sign-in' : 'Open GitHub sign-in'}
              disabled={action.busy}
              onPress={() => void action.run(() => openSignIn(authUrl))}
            />
          ) : null}
          {flow && pollProblem ? (
            <NativeButton label="Check sign-in again" onPress={() => setRetryPoll((n) => n + 1)} />
          ) : null}
          {pending || (connected && !setup) ? (
            <NativeButton
              label={pending ? `Cancel ${provider.name} sign-in` : `Disconnect ${provider.name}`}
              onPress={disconnect}
              disabled={action.busy}
            />
          ) : null}
          {pending && !flow ? (
            <NativeButton
              label={`Restart ${provider.name} sign-in`}
              onPress={connect}
              disabled={action.busy}
            />
          ) : null}
          {!pending && !connected && !unavailable && !needsApp && !showApp ? (
            <NativeButton
              primary={setup}
              label={`${account.status === 'reconnect' ? 'Reconnect' : 'Connect'} ${provider.name}`}
              onPress={connect}
              disabled={action.busy}
            />
          ) : null}
          {!pending && !connected && !showApp && !unavailable && id === 'github' ? (
            <NativeButton
              primary={setup && needsApp}
              label={needsApp ? 'Set up GitHub App' : 'Change GitHub App client ID'}
              onPress={() => setShowApp(true)}
              disabled={action.busy}
            />
          ) : null}
          {unavailable && id === 'chatgpt' ? (
            <NativeButton label="Check for Codex again" onPress={onCheckSources} />
          ) : null}
        </NativeActions>
        {setup && id === 'chatgpt' && !pending && !connected && !unavailable && (
          <NativeText
            size={12}
            tone="foregroundMuted"
            style={{ textAlign: compact ? 'left' : 'right' }}
          >
            This signs Codex in on the selected host too.
          </NativeText>
        )}
      </View>
      {(pending || action.problem || pollProblem || showApp) && (
        <View style={{ width: '100%', gap: 6 }}>
          {pending && flow?.code ? (
            <NativeText selectable heading size={20}>
              {flow.code}
            </NativeText>
          ) : null}
          {pending && authUrl ? (
            <>
              <NativeText tone="foregroundMuted">
                {id === 'github'
                  ? 'Enter the code on GitHub to continue.'
                  : 'Finish signing in from a browser on the selected host so Codex can receive the sign-in response.'}
              </NativeText>
              <NativeText selectable>{authUrl}</NativeText>
            </>
          ) : pending ? (
            <NativeText tone="foregroundMuted">Start again to get a fresh sign-in.</NativeText>
          ) : null}
          <NativeProblem message={action.problem ?? pollProblem} />
          {showApp ? (
            <GitHubAppSetup
              request={request}
              onAccount={onAccount}
              close={() => setShowApp(false)}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}
