import { useCallback, useState } from 'react';
import { Icon } from '@getpaseo/plugin/client/ui';
import { View } from 'react-native';
import { colors as palette } from '../shared/reporting-palette.ts';
import type { AccountStatus, NativeQuota, SourceStatus } from './native-types.ts';
import { NativeAccount } from './native-accounts.tsx';
import {
  requestMessage,
  useNativeAction,
  useNativePoll,
  type NativeRequest,
} from './native-api.ts';
import { NativeRepos } from './native-repos.tsx';
import { NativeBuddy, NativeCrewArt } from './native-hq-crew.tsx';
import {
  NativeButton,
  NativeCard,
  NativeProblem,
  NativeRow,
  NativeText,
  useDashboardLayout,
} from './native-ui.tsx';

const steps = ['Local sources', 'Accounts', 'Repositories'] as const;
type Step = 0 | 1 | 2;
const sourceNames = { codex: 'Codex', claude: 'Claude Code', paseo: 'Paseo' } as const;
const sourceLabels: Record<SourceStatus['status'], string> = {
  checking: 'Checking…',
  ok: 'Found',
  partial: 'Partially readable',
  failed: 'Could not check',
  notfound: 'Not found',
  denied: 'Access denied',
  notrunning: 'Not running',
  needspassword: 'Needs a password',
};

export function NativeSetup({ request, onFinish }: { request: NativeRequest; onFinish(): void }) {
  const { compact } = useDashboardLayout();
  const [step, setStep] = useState<Step>(0);
  const [sources, setSources] = useState<SourceStatus[]>();
  const [accounts, setAccounts] = useState<AccountStatus[]>();
  const [discoveredAccounts, setDiscoveredAccounts] = useState<AccountStatus[]>();
  const [discoveryProblem, setDiscoveryProblem] = useState<string>();
  const [accountProblem, setAccountProblem] = useState<string>();
  const [codexQuota, setCodexQuota] = useState<NativeQuota>();
  const [checking, setChecking] = useState(true);
  const [retry, setRetry] = useState(0);
  const [accountRetry, setAccountRetry] = useState(0);
  const finish = useNativeAction();

  useNativePoll(
    useCallback(
      async (signal: AbortSignal) => {
        setChecking(true);
        setDiscoveryProblem(undefined);
        try {
          const result = await request('discover');
          if (signal.aborted) return;
          setSources(result.sources ?? []);
          setDiscoveredAccounts(result.accounts);
        } catch (error) {
          if (!signal.aborted) setDiscoveryProblem(requestMessage(error));
        } finally {
          if (!signal.aborted) setChecking(false);
        }
      },
      [request],
    ),
    retry,
  );

  useNativePoll(
    useCallback(
      async (signal: AbortSignal) => {
        if (step !== 1) return;
        setAccountProblem(undefined);
        try {
          const result = await request('sources');
          if (signal.aborted) return;
          setAccounts(result.accounts ?? []);
        } catch (error) {
          if (!signal.aborted) setAccountProblem(requestMessage(error));
        }
      },
      [request, step],
    ),
    accountRetry,
  );

  useNativePoll(
    useCallback(
      async (signal: AbortSignal) => {
        if (step !== 1) return;
        try {
          const result = await request('usage');
          if (!signal.aborted)
            setCodexQuota(result.providers.find((quota) => quota.provider === 'codex'));
        } catch {
          // Quota is optional in Setup, so account controls stay available when the report cannot load.
          if (!signal.aborted) setCodexQuota(undefined);
        }
      },
      [request, step],
    ),
  );

  const setAccount = useCallback((account: AccountStatus) => {
    setAccounts((current) => [
      ...(current ?? []).filter((item) => item.id !== account.id),
      account,
    ]);
  }, []);
  const github = (accounts ?? discoveredAccounts)?.find((account) => account.id === 'github');
  const discoveredChatgpt = discoveredAccounts?.find((account) => account.id === 'chatgpt');
  const liveChatgpt = accounts?.find((account) => account.id === 'chatgpt');
  const chatgpt =
    liveChatgpt?.status === 'notconnected' && discoveredChatgpt?.status === 'unavailable'
      ? discoveredChatgpt
      : (liveChatgpt ?? discoveredChatgpt);
  const githubAccount =
    (github?.status === 'connected' || github?.status === 'existing') &&
    github.login &&
    (github.via === 'gh' || github.via === 'app')
      ? { login: github.login, via: github.via }
      : null;

  function rediscover() {
    setRetry((n) => n + 1);
  }

  const found =
    sources?.filter((source) => source.status === 'ok' || source.status === 'partial').length ?? 0;
  const sourcesToShow = Object.entries(sourceNames).filter(
    ([id]) => sources === undefined || sources.some((source) => source.id === id),
  );
  const primaryWidth = compact ? { width: '100%' as const } : undefined;
  return (
    <View style={{ gap: 20 }}>
      <View
        style={{
          flexDirection: compact ? 'column' : 'row',
          alignItems: compact ? 'flex-start' : 'center',
          gap: compact ? 10 : 24,
        }}
      >
        <NativeCrewArt
          mood={
            checking ||
            !sources?.some(
              (source) =>
                source.id !== 'paseo' && (source.status === 'ok' || source.status === 'partial'),
            )
              ? 'search'
              : 'awake'
          }
        />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <NativeText heading size={24}>
            Let’s find your agents
          </NativeText>
          <NativeText tone="foregroundMuted">
            This dashboard reads agent records on the computer it’s installed on, so there’s nothing
            to pick. Connect accounts only where they add data, then choose the repos to track.
          </NativeText>
        </View>
      </View>
      <View
        role="list"
        accessibilityLabel="Setup progress"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
      >
        {steps.map((label, index) => {
          const current = index === step;
          const done = index < step;
          return (
            <View
              key={label}
              role="listitem"
              accessibilityLabel={`Step ${index + 1} of ${steps.length}, ${label}${current ? ', current' : done ? ', done' : ''}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                borderRadius: 999,
                paddingLeft: 6,
                paddingRight: 12,
                paddingVertical: 6,
                backgroundColor: current ? palette['selection-surface'] : palette['surface-sunken'],
              }}
            >
              <View
                aria-hidden
                accessibilityElementsHidden
                style={{
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  borderWidth: 1,
                  borderColor: current
                    ? palette.action
                    : done
                      ? palette.success
                      : palette['control-border'],
                  backgroundColor: current
                    ? palette.action
                    : done
                      ? palette['success-surface']
                      : palette.surface,
                }}
              >
                {done ? (
                  <Icon name="Check" color={palette.success} size={12} />
                ) : (
                  <NativeText
                    size={12}
                    tone={current ? 'accentForeground' : 'foreground'}
                    style={{ fontWeight: '700' }}
                  >
                    {index + 1}
                  </NativeText>
                )}
              </View>
              <NativeText
                size={13}
                tone={current ? 'foreground' : 'foregroundMuted'}
                style={{ fontWeight: current ? '600' : '500' }}
              >
                {label}
              </NativeText>
            </View>
          );
        })}
      </View>
      {step === 0 ? (
        <NativeCard title="Finding agent records on this machine">
          <NativeText tone="foregroundMuted" size={12}>
            Automatic and read-only
          </NativeText>
          {!(discoveryProblem && !sources) &&
            sourcesToShow.map(([id, name]) => {
              const source = sources?.find((item) => item.id === id);
              return (
                <NativeRow key={id}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {id === 'codex' || id === 'claude' ? (
                      <NativeBuddy
                        provider={id}
                        mood={source?.status === 'notfound' ? 'sleep' : 'awake'}
                      />
                    ) : null}
                    <NativeText heading>{name}</NativeText>
                  </View>
                  <NativeText tone="foregroundMuted" size={12}>
                    {checking ? 'Checking…' : source ? sourceLabels[source.status] : 'Not checked'}
                  </NativeText>
                  {source?.location ? (
                    <NativeText tone="foregroundMuted" selectable>
                      {source.location}
                    </NativeText>
                  ) : null}
                  {source?.message ? (
                    <NativeText tone="foregroundMuted">{source.message}</NativeText>
                  ) : null}
                </NativeRow>
              );
            })}
          <NativeProblem message={discoveryProblem} />
          {checking ? (
            <NativeText announce tone="foregroundMuted" size={12}>
              Looking for records…
            </NativeText>
          ) : (
            sources && (
              <View
                style={{
                  padding: 8,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 8,
                  backgroundColor:
                    found > 0 ? palette['selection-surface'] : palette['warning-surface'],
                }}
              >
                <Icon
                  name={found > 0 ? 'CircleCheck' : 'TriangleAlert'}
                  size={14}
                  color={found > 0 ? palette.success : palette.warning}
                />
                <NativeText announce size={12} style={{ flex: 1 }}>
                  {found > 0
                    ? `Found local records for ${found} of ${sources.length} sources.`
                    : 'No local agent records found on this machine. You can still connect accounts for account-reported usage and track repos for merged PRs.'}
                </NativeText>
              </View>
            )
          )}
          {!checking &&
          (discoveryProblem ||
            sourcesToShow.some(([id]) =>
              sources?.find((source) => source.id === id && source.status !== 'ok'),
            )) ? (
            <NativeButton
              label={discoveryProblem ? 'Retry discovery' : 'Check sources again'}
              onPress={rediscover}
            />
          ) : null}
        </NativeCard>
      ) : null}
      {step === 1 ? (
        <NativeCard title="Connect accounts">
          <NativeText size={12} tone="foregroundMuted">
            Only where they add data
          </NativeText>
          <NativeProblem message={accountProblem ?? discoveryProblem} />
          {accountProblem ? (
            <NativeButton label="Retry accounts" onPress={() => setAccountRetry((n) => n + 1)} />
          ) : null}
          {accounts === undefined && !accountProblem ? (
            <NativeText tone="foregroundMuted">Checking account connections…</NativeText>
          ) : null}
          <NativeAccount
            setup
            id="github"
            account={github}
            request={request}
            onAccount={setAccount}
            onCheckSources={rediscover}
          />
          <NativeAccount
            setup
            id="chatgpt"
            account={chatgpt}
            request={request}
            onAccount={setAccount}
            onCheckSources={rediscover}
          />
          {codexQuota?.source === 'paseo' && codexQuota.usedPercent !== null ? (
            <NativeText tone="foregroundMuted">
              Paseo already reports Codex weekly quota for this host ({codexQuota.usedPercent}% used
              {codexQuota.stale ? ', last available reading' : ''}). You can skip ChatGPT if you
              only need weekly quota.
            </NativeText>
          ) : null}
          <NativeText size={12} tone="foregroundMuted">
            You can check Claude plan limits later in Sources &amp; repos using your existing Claude
            Code sign-in.
          </NativeText>
          <NativeText size={12} tone="foregroundMuted">
            Sign-in happens on the provider’s own page. This dashboard never asks for your password,
            model API keys or browser cookies. Local usage works without any of these.
          </NativeText>
        </NativeCard>
      ) : null}
      {step === 2 ? <NativeRepos account={githubAccount} request={request} /> : null}
      <NativeProblem message={finish.problem} />
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: compact ? 'space-between' : 'flex-end',
          gap: 8,
        }}
      >
        {step > 0 ? (
          <NativeButton
            label="Back"
            disabled={finish.busy}
            onPress={() => setStep(step === 2 ? 1 : 0)}
          />
        ) : null}
        {step < 2 ? (
          <>
            <NativeButton
              label="Skip this step"
              variant="ghost"
              onPress={() => setStep(step === 0 ? 1 : 2)}
            />
            <NativeButton
              primary
              label={
                step === 1 && accounts && !githubAccount ? 'Continue without GitHub' : 'Continue'
              }
              style={primaryWidth}
              disabled={step === 0 && checking}
              onPress={() => setStep(step === 0 ? 1 : 2)}
            />
          </>
        ) : (
          <NativeButton
            primary
            label={finish.busy ? 'Finishing setup…' : 'Finish setup'}
            style={primaryWidth}
            disabled={finish.busy}
            onPress={() =>
              void finish.run(async (signal) => {
                await request('finish');
                if (!signal.aborted) onFinish();
              })
            }
          />
        )}
      </View>
    </View>
  );
}
