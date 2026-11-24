import { Icon } from '@getpaseo/plugin/client/ui';
import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { colors as palette } from '../shared/reporting-palette.ts';
import {
  groupSessions,
  HQ_COPY,
  recentIdleLabel,
  stateWords,
  summaryLine,
  type AgentNode,
  type Session,
} from './native-hq-art.generated.mjs';
import { NativeBuddy } from './native-hq-crew.tsx';
import { IllustratedHq } from './native-hq-scene.tsx';
import {
  requestMessage,
  useNativeAction,
  useNativePoll,
  type NativeRequest,
} from './native-api.ts';
import {
  hostQueryKey,
  ReportLoading,
  useDashboard,
  useDashboardQuery,
} from './native-reporting.tsx';
import type { NativeQuota, NativeRoster, NativeUsageProvider } from './native-types.ts';
import {
  cardShadow,
  NativeButton,
  NativeCard,
  NativeProblem,
  NativeRow,
  NativeText,
} from './native-ui.tsx';

const providers = { codex: 'Codex', claude: 'Claude Code', other: 'Other agent' } as const;
const feedName = { codex: 'Codex', claude: 'Claude Code', paseo: 'Paseo' } as const;
const feedStatus: Record<NativeRoster['feeds'][number]['status'], string> = {
  unavailable: 'Unavailable',
  setup_incomplete: 'Setup incomplete',
  starting: 'Starting…',
  live: 'Live',
  notrunning: 'Not running',
  needspassword: 'Needs a password',
  notfound: 'Not found',
  denied: 'Access denied',
  failed: 'Could not read',
};
function RosterRow({
  node,
  depth,
  now,
  openAgent,
}: {
  node: AgentNode;
  depth: number;
  now: number;
  openAgent?: (id: string) => void;
}) {
  const { agent } = node;
  const { paseoAgentId } = agent;
  const place = agent.repo ?? agent.workspace;
  const title = agent.title?.trim() || 'No name recorded';
  return (
    <View role="listitem" style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 5 }}>
        <NativeBuddy
          provider={agent.provider}
          size={28}
          mood={
            agent.state === 'error'
              ? 'dizzy'
              : !agent.backgroundWorkActive &&
                  (agent.state === 'idle' || agent.state === 'finished')
                ? 'sleep'
                : 'awake'
          }
        />
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <View style={{ maxWidth: '100%' }}>
            <NativeText heading>{title}</NativeText>
            <NativeText size={12} tone="foregroundMuted">
              {providers[agent.provider]}
              {place ? ` · ${place}` : ''}
              {agent.parentAway ? ' · Started by an agent that isn’t listed' : ''}
            </NativeText>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {agent.state === 'waiting' && (
              <Icon name="TriangleAlert" color={palette.warning} size={14} />
            )}
            {agent.state === 'error' && <Icon name="CircleX" color={palette.danger} size={14} />}
            <NativeText
              size={12}
              tone={
                agent.state === 'waiting'
                  ? 'statusWarning'
                  : agent.state === 'error'
                    ? 'statusDanger'
                    : 'foregroundMuted'
              }
              style={
                agent.state === 'waiting' || agent.state === 'error'
                  ? { fontWeight: '600' }
                  : undefined
              }
            >
              {stateWords(agent, now)}
            </NativeText>
          </View>
        </View>
      </View>
      {paseoAgentId && openAgent ? (
        <NativeButton
          label="Open Paseo agent"
          accessibilityLabel={`Open Paseo agent ${title}`}
          onPress={() => openAgent(paseoAgentId)}
        />
      ) : null}
      {node.children.length > 0 && (
        <View
          role="list"
          style={
            depth < 3
              ? {
                  marginStart: 15,
                  paddingStart: 12,
                  borderStartWidth: 1,
                  borderColor: palette.border,
                }
              : undefined
          }
        >
          {node.children.map((child) => (
            <RosterRow
              key={child.agent.id}
              node={child}
              now={now}
              depth={depth + 1}
              openAgent={openAgent}
            />
          ))}
        </View>
      )}
    </View>
  );
}

interface RosterListProps {
  sessions: readonly Session[];
  now: number;
  openAgent?: (id: string) => void;
}

function RosterList({ sessions, now, openAgent, label }: RosterListProps & { label: string }) {
  return (
    <View role="list" accessibilityLabel={label} style={{ gap: 12 }}>
      {sessions.map((session) => (
        <View
          key={session.id}
          role="listitem"
          style={{
            ...cardShadow,
            backgroundColor: session.waiting ? palette['warning-surface'] : palette.surface,
            borderColor: session.waiting ? palette.warning : palette.border,
            borderWidth: 1,
            borderRadius: 14,
            paddingHorizontal: 16,
            paddingVertical: 8,
          }}
        >
          <View
            role="list"
            accessibilityLabel={`${session.root.agent.title ?? 'No name recorded'}: ${session.size} ${session.size === 1 ? 'agent' : 'agents'}`}
          >
            <RosterRow node={session.root} depth={0} now={now} openAgent={openAgent} />
          </View>
        </View>
      ))}
    </View>
  );
}

function RecentIdleRoster(props: RosterListProps) {
  const [open, setOpen] = useState(false);
  const label = recentIdleLabel(props.sessions.length);
  return (
    <View
      style={{
        ...cardShadow,
        backgroundColor: palette.surface,
        borderColor: palette.border,
        borderWidth: 1,
        borderRadius: 14,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        aria-expanded={open}
        onPress={() => setOpen((current) => !current)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          paddingHorizontal: 16,
        }}
      >
        <View aria-hidden importantForAccessibility="no-hide-descendants">
          <Icon
            name={open ? 'ChevronDown' : 'ChevronRight'}
            color={palette['text-muted']}
            size={16}
          />
        </View>
        <NativeText style={{ fontWeight: '600' }}>{label}</NativeText>
      </Pressable>
      {open && (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
          <RosterList {...props} label={HQ_COPY.recentIdle} />
        </View>
      )}
    </View>
  );
}

export function NativeRosterPanel({
  request,
  host,
  navigation,
  onSetupRequired,
  headingActions,
  refreshNotice,
}: Pick<PluginScreenProps, 'host' | 'navigation'> & {
  request: NativeRequest;
  onSetupRequired(): void;
  headingActions?: ReactNode;
  refreshNotice?: ReactNode;
}) {
  const [roster, setRoster] = useState<NativeRoster>();
  const [problem, setProblem] = useState<string>();
  const [retry, setRetry] = useState(0);
  const openAgent = navigation?.openAgent;

  useNativePoll(
    useCallback(
      async (signal: AbortSignal) => {
        try {
          const next = await request('roster');
          if (!signal.aborted) {
            if (next.feeds.some((feed) => feed.status === 'setup_incomplete')) {
              onSetupRequired();
              return;
            }
            setRoster(next);
            setProblem(undefined);
          }
          return 2_000;
        } catch (error) {
          if (!signal.aborted) {
            setProblem(requestMessage(error));
          }
          return 10_000;
        }
      },
      [request, onSetupRequired],
    ),
    retry,
  );

  const quiet =
    !problem &&
    roster?.feeds.some((feed) => feed.status === 'live') &&
    roster.feeds.every((feed) => ['live', 'unavailable', 'notfound'].includes(feed.status));

  const now = roster?.generatedAt ? Date.parse(roster.generatedAt) : undefined;
  const summary = roster ? summaryLine(roster.agents) : '';
  const { focus, recentIdle } = groupSessions(roster?.agents ?? []);
  const selectAgent = openAgent
    ? (agentId: string) => openAgent({ agentId, serverId: host.id })
    : undefined;
  const faults = roster?.feeds.filter(
    (feed) => feed.status !== 'live' && feed.status !== 'unavailable',
  );
  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <NativeText heading size={24} announce>
            HQ
          </NativeText>
          {summary ? <NativeText tone="foregroundMuted">{summary}</NativeText> : null}
        </View>
        {headingActions}
      </View>
      {refreshNotice}
      {problem ? (
        <View style={{ gap: 8 }}>
          <NativeProblem message={problem} />
          {roster ? (
            <NativeText tone="foregroundMuted">
              The list below is the last one HQ received.
            </NativeText>
          ) : null}
          <NativeButton label="Retry live roster" onPress={() => setRetry((n) => n + 1)} />
        </View>
      ) : null}
      {!roster && !problem && <NativeText tone="foregroundMuted">Loading HQ…</NativeText>}
      {faults && faults.length > 0 && (
        <View style={{ gap: 6 }}>
          {faults.map((feed) => (
            <NativeText key={feed.id} size={13} tone="foregroundMuted">
              {feedName[feed.id]} · {feedStatus[feed.status]}
            </NativeText>
          ))}
        </View>
      )}
      {roster?.truncated && (
        <NativeText tone="foregroundMuted">
          The roster was cut to fit, so some agents aren’t shown.
        </NativeText>
      )}
      {roster && (
        <IllustratedHq sessions={focus} quiet={Boolean(quiet && focus.length === 0)} nowMs={now} />
      )}
      {roster && focus.length === 0 && (
        <NativeText tone="foregroundMuted">
          {quiet
            ? HQ_COPY.quiet
            : roster.feeds.length === 0 ||
                roster.feeds.every((feed) => feed.status === 'unavailable')
              ? 'Live agents aren’t available in this session.'
              : 'No agents to show right now.'}
        </NativeText>
      )}
      {focus.length > 0 && (
        <RosterList
          sessions={focus}
          now={now ?? 0}
          openAgent={selectAgent}
          label={HQ_COPY.sessions}
        />
      )}
      {recentIdle.length > 0 && (
        <RecentIdleRoster sessions={recentIdle} now={now ?? 0} openAgent={selectAgent} />
      )}
    </>
  );
}

function formatQuotaTime(value: string | null, timezone?: string): string | null {
  if (!value) return null;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  return instant.toLocaleString(undefined, {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function QuotaRow({
  provider,
  quota,
  request,
  timezone,
  onChecked,
  inline,
  compact,
}: {
  provider: NativeUsageProvider;
  quota?: NativeQuota;
  request: NativeRequest;
  timezone?: string;
  onChecked(quota: NativeQuota, signal: AbortSignal): Promise<void>;
  inline: boolean;
  compact: boolean;
}) {
  const check = useNativeAction();
  const reset = formatQuotaTime(quota?.resetsAt ?? null, timezone);
  const refreshed = formatQuotaTime(quota?.refreshedAt ?? null, timezone);
  const name = providers[provider];
  const source = quota?.source === 'paseo' ? 'Paseo' : quota?.source === 'direct' ? name : null;

  const button = quota?.canCheck && (
    <NativeButton
      label={
        check.busy
          ? `Checking ${name}…`
          : inline && provider === 'claude'
            ? refreshed
              ? 'Check plan limits again'
              : 'Show Claude plan limits'
            : `Check ${name} directly`
      }
      disabled={check.busy}
      onPress={() =>
        void check.run(async (signal) => {
          const result = await request('usageFallback', { provider });
          const matched = result.providers.find((item) => item.provider === provider);
          if (!signal.aborted && matched) await onChecked(matched, signal);
        })
      }
    />
  );
  const title = inline && provider === 'claude' ? 'Claude plan limits' : name;
  const status =
    quota?.usedPercent != null
      ? `${quota.usedPercent}% used this week`
      : inline && !refreshed
        ? 'Not checked yet'
        : 'Weekly quota unavailable';
  const windows = quota?.windows?.map((window) => {
    const windowReset = formatQuotaTime(window.resetsAt, timezone);
    const label = `${window.label} · ${window.usedPercent}% used`;
    const detail = [
      window.source === 'paseo' ? 'Paseo' : name,
      window.stale ? 'Last available reading' : null,
      windowReset ? `Resets ${windowReset}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const key = `${window.source}:${window.id}`;
    return inline ? (
      <NativeText key={key} tone="foregroundMuted" size={12}>
        {label} · {detail}
      </NativeText>
    ) : (
      <View key={key} style={{ gap: 2 }}>
        <NativeText size={13} style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}>
          {label}
        </NativeText>
        <NativeText tone="foregroundMuted" size={12}>
          {detail}
        </NativeText>
      </View>
    );
  });
  const details = (
    <>
      {source ? (
        <NativeText tone="foregroundMuted" size={12}>
          Source · {source}
          {quota?.stale ? ' · Last available reading' : ''}
        </NativeText>
      ) : null}
      {reset ? (
        <NativeText tone="foregroundMuted" size={12}>
          Resets {reset}
        </NativeText>
      ) : null}
      {refreshed ? (
        <NativeText tone="foregroundMuted" size={12}>
          Checked {refreshed}
        </NativeText>
      ) : null}
    </>
  );

  if (inline) {
    return (
      <NativeRow>
        <View
          style={{
            flexDirection: compact ? 'column' : 'row',
            alignItems: 'flex-start',
            columnGap: 24,
            rowGap: 8,
          }}
        >
          <View style={{ width: compact ? undefined : 220, gap: 4 }}>
            <NativeText heading>{title}</NativeText>
            <NativeText announce tone="foregroundMuted" size={12}>
              {status}
            </NativeText>
          </View>
          <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: 4 }}>
            {quota?.canCheck && (
              <NativeText tone="foregroundMuted" size={12}>
                Uses the existing {name} sign-in if Paseo has no current reading.
              </NativeText>
            )}
            {windows}
            {details}
            <NativeProblem message={check.problem} />
          </View>
          {button}
        </View>
      </NativeRow>
    );
  }

  return (
    <NativeRow>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          columnGap: 16,
          rowGap: 4,
        }}
      >
        <NativeText heading>{title}</NativeText>
        {quota?.usedPercent != null ? (
          <NativeText
            announce
            size={24}
            style={{ maxWidth: '100%', fontWeight: '700', fontVariant: ['tabular-nums'] }}
          >
            {quota.usedPercent}%{' '}
            <NativeText size={12} tone="foregroundMuted">
              used this week
            </NativeText>
          </NativeText>
        ) : (
          <NativeText announce size={12} tone="foregroundMuted">
            {status}
          </NativeText>
        )}
      </View>
      {(source || reset || refreshed) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 }}>
          {details}
        </View>
      )}
      {!!windows?.length && <View style={{ marginTop: 4, gap: 6 }}>{windows}</View>}
      {quota?.canCheck ? (
        <>
          {button}
          <NativeText size={12} tone="foregroundMuted">
            Uses the existing {name} sign-in if Paseo has no current reading.
          </NativeText>
        </>
      ) : null}
      <NativeProblem message={check.problem} />
    </NativeRow>
  );
}

export function NativeUsagePanel({
  request,
  provider = 'all',
  timezone,
  inline = false,
  compact = false,
}: {
  request: NativeRequest;
  provider?: NativeUsageProvider | 'all';
  timezone?: string;
  inline?: boolean;
  compact?: boolean;
}) {
  const { hostId, bootstrap } = useDashboard();
  const client = useQueryClient();
  const query = useDashboardQuery('usage');
  const queryKey = [...hostQueryKey(hostId), 'usage', null];
  const quotas = query.data?.providers;

  async function updateQuota(checked: NativeQuota, signal: AbortSignal) {
    await client.cancelQueries({ queryKey });
    if (signal.aborted) return;
    client.setQueryData(queryKey, (previous: { providers: NativeQuota[] } | undefined) => ({
      providers: [
        ...(previous?.providers ?? []).filter((quota) => quota.provider !== checked.provider),
        checked,
      ],
    }));
  }

  const rows = quotas ? (
    (provider === 'all' ? (['codex', 'claude'] as const) : [provider]).map((provider) => (
      <QuotaRow
        key={provider}
        provider={provider}
        quota={quotas.find((quota) => quota.provider === provider)}
        request={request}
        timezone={timezone ?? bootstrap.timezone}
        onChecked={updateQuota}
        inline={inline}
        compact={compact}
      />
    ))
  ) : (
    <ReportLoading label="weekly quota" error={query.error} retry={() => void query.refetch()} />
  );
  if (inline) return rows;
  return (
    <NativeCard title="Weekly subscription quota">
      <NativeText tone="foregroundMuted" size={12}>
        Each provider reports its own seven-day window.
      </NativeText>
      {rows}
    </NativeCard>
  );
}
