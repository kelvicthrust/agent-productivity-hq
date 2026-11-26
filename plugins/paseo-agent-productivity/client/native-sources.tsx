import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { colors } from '../shared/reporting-palette.ts';
import { NativeAccount } from './native-accounts.tsx';
import { useNativeAction } from './native-api.ts';
import { formatDay, formatInstant, int } from './native-report-details.tsx';
import { NativeRepos } from './native-repos.tsx';
import { NativeUsagePanel } from './native-roster.tsx';
import type { useDashboardRefresh } from './native-refresh.ts';
import {
  ReportLoading,
  useDashboard,
  useDashboardQuery,
  useRefreshDashboardData,
} from './native-reporting.tsx';
import { ReportIcon, ReportText } from './native-session.tsx';
import type { AccountStatus, SourceReport, SourceStatus } from './native-types.ts';
import {
  cardShadow,
  NativeActions,
  NativeButton,
  NativeCard,
  NativeProblem,
  NativeText,
} from './native-ui.tsx';

const sourceNames = { codex: 'Codex', claude: 'Claude Code', paseo: 'Paseo', github: 'GitHub' };
const stateNames = {
  checking: 'Looking…',
  ok: 'Found',
  partial: 'Partial',
  failed: 'Refresh failed',
  notfound: 'Not found',
  denied: 'Access denied',
  notrunning: 'Not running',
  needspassword: 'Needs a password',
} as const;
const hookStates = {
  on: 'On. Claude Code tells HQ when it needs you.',
  off: 'Off. HQ guesses, and says “May be waiting for you”.',
  needs_repair:
    'Needs repair. HQ’s entries in Claude Code’s settings don’t match this version of the app.',
  unavailable: 'Not available. HQ can’t find a Claude Code settings file it is able to change.',
} as const;

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';
type Status = { text: string; tone: Tone };

function latest(instants: (string | null | undefined)[]) {
  return instants
    .flatMap((value) => (value ? [value] : []))
    .sort()
    .at(-1);
}

function sourceStatus(source: SourceStatus): Status {
  if (source.lastAttemptResult === 'failed' && source.hasRetainedData) {
    return { text: 'Refresh failed · last known', tone: 'warn' };
  }
  const label = stateNames[source.status];
  if (source.status === 'partial') {
    return {
      text: source.unreadable ? `${label} · ${int(source.unreadable)} unreadable` : label,
      tone: 'warn',
    };
  }
  if (
    source.status === 'denied' ||
    source.status === 'failed' ||
    source.status === 'needspassword'
  ) {
    return { text: label, tone: 'danger' };
  }
  return {
    text: label,
    tone:
      source.status === 'ok'
        ? 'ok'
        : source.status === 'notrunning' && source.hasRetainedData
          ? 'warn'
          : 'neutral',
  };
}

function accountStatus(account: AccountStatus, report: SourceReport['chatgptCoverage']): Status {
  if (account.id === 'claude') {
    const plan = account.planLimits;
    if (plan?.state === 'ok' && plan.report) {
      return plan.report.stale
        ? { text: 'Limits only · last known', tone: 'warn' }
        : { text: 'Limits only', tone: 'ok' };
    }
    if (plan?.state === 'ok') return { text: 'No current windows', tone: 'neutral' };
    if (!plan || plan.state === 'unchecked') return { text: 'Not checked yet', tone: 'neutral' };
    return { text: account.statusText || 'Last check unsuccessful', tone: 'warn' };
  }
  if (account.status === 'reconnect') return { text: 'Reconnect needed', tone: 'warn' };
  if (account.status === 'failed')
    return { text: account.statusText || 'Connection problem', tone: 'danger' };
  if (account.status !== 'existing' && account.status !== 'connected') {
    return { text: account.statusText || 'Not connected', tone: 'neutral' };
  }
  if (!report) return { text: 'Connected · no report yet', tone: 'ok' };
  const { bucketSpan, stale, unit } = report;
  const window =
    bucketSpan?.start && bucketSpan.end
      ? ` · ${formatDay(bucketSpan.start)} – ${formatDay(bucketSpan.end)}`
      : '';
  return {
    text: `${unit === 'tokens' ? `Tokens${window}` : 'Limits only'}${stale ? ' · last known' : ''}`,
    tone: stale ? 'warn' : 'ok',
  };
}

const statusAppearance = {
  ok: { color: colors.success, icon: 'check' },
  warn: { color: colors.warning, icon: 'alert' },
  danger: { color: colors.danger, icon: 'alert' },
  neutral: { color: colors['text-muted'], icon: 'circle' },
} as const;

function StatusIcon({ tone }: { tone: Tone }) {
  const { color, icon } = statusAppearance[tone];
  return <ReportIcon name={icon} color={color} size={14} />;
}

function StatusLine({ text, tone }: Status) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <StatusIcon tone={tone} />
      <ReportText strong size={12} color={statusAppearance[tone].color}>
        {text}
      </ReportText>
    </View>
  );
}

export function NativeSourceCoverage({
  compact,
  pill = false,
  detail = false,
}: {
  compact: boolean;
  pill?: boolean;
  detail?: boolean;
}) {
  const { bootstrap, navigate } = useDashboard();
  const [open, setOpen] = useState(false);
  const sources = useDashboardQuery('sources');
  const repos = useDashboardQuery('repos');
  if ((!sources.data || !repos.data) && !detail) return null;
  const sourceList = sources.data?.sources ?? [];
  const tracked = repos.data?.active ?? [];
  const inaccessible = tracked.filter((repo) => repo.accessState === 'inaccessible').length;
  const githubFailed = sourceList.some(
    (source) => source.id === 'github' && source.lastAttemptResult === 'failed',
  );
  const groups = [
    {
      heading: 'On this machine',
      items: sourceList
        .filter((source) => source.id !== 'github')
        .map((source) => {
          const status = sourceStatus(source);
          return {
            name: source.name ?? sourceNames[source.id],
            ...status,
            text:
              source.status === 'ok' && source.oldestDate
                ? `${detail ? 'History since' : 'since'} ${formatDay(source.oldestDate)}`
                : detail
                  ? status.text
                  : status.text.toLowerCase(),
          };
        }),
    },
    {
      heading: 'Delivery',
      items: [
        {
          name: 'GitHub',
          tone: (githubFailed
            ? 'danger'
            : inaccessible
              ? 'warn'
              : tracked.length
                ? 'ok'
                : 'neutral') as Tone,
          text: `${int(tracked.length)} ${tracked.length === 1 ? 'repo' : 'repos'} tracked${inaccessible ? ` · ${int(inaccessible)} inaccessible` : ''}${githubFailed ? ' · refresh failed' : ''}`,
        },
      ],
    },
    ...(detail
      ? [
          {
            heading: 'Account reports',
            items: (sources.data?.accounts ?? [])
              .filter((account) => account.id !== 'github')
              .map((account) => ({
                name: account.id === 'claude' ? 'Claude plan limits' : 'ChatGPT',
                ...accountStatus(account, sources.data?.chatgptCoverage),
              })),
          },
        ]
      : []),
  ].filter((group) => group.items.length > 0);
  const needsAttention = groups.some((group) =>
    group.items.some(({ tone }) => tone === 'warn' || tone === 'danger'),
  );
  const lastSuccess = latest(sourceList.map((source) => source.lastSuccessAt));
  const lastAttempt = latest(
    sourceList
      .filter((source) => !detail || source.lastAttemptResult === 'failed')
      .map((source) => source.lastAttemptAt),
  );
  const lastFailed =
    lastAttempt && (!lastSuccess || lastAttempt > lastSuccess) ? lastAttempt : null;
  const stamp = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      <ReportText muted size={12}>
        {lastSuccess
          ? `Last successful refresh ${formatWhen(lastSuccess, bootstrap)}`
          : 'No successful refresh yet'}
      </ReportText>
      {lastFailed && (
        <ReportText muted size={12}>
          {detail ? 'Last failed attempt' : 'Latest attempt'} {formatWhen(lastFailed, bootstrap)}
        </ReportText>
      )}
    </View>
  );
  const usageCapsule = pill && !detail && !compact;
  const heading = detail ? (
    <NativeText heading size={16}>
      Source coverage
    </NativeText>
  ) : (
    <ReportText strong>Source coverage</ReportText>
  );
  return (
    <View
      role="region"
      accessibilityLabel="Source coverage"
      style={{
        ...(detail ? cardShadow : {}),
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        borderRadius: usageCapsule ? 32 : 14,
        paddingHorizontal: detail ? 16 : 14,
        paddingVertical: detail || !compact ? (usageCapsule ? 8 : 16) : 0,
        gap: detail ? 12 : 8,
      }}
    >
      {(detail || compact) && (
        <View
          style={
            detail && !compact
              ? {
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 12,
                }
              : undefined
          }
        >
          {compact ? (
            <Pressable
              accessibilityRole="button"
              aria-expanded={open}
              onPress={() => setOpen(!open)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 6,
                minHeight: 44,
              }}
            >
              {heading}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {needsAttention && <StatusLine text="Needs attention" tone="warn" />}
                <ReportIcon name={open ? 'down' : 'right'} />
              </View>
            </Pressable>
          ) : (
            heading
          )}
          {detail && stamp}
        </View>
      )}
      {(!compact || open) &&
        (!sources.data || !repos.data ? (
          <ReportLoading
            label="source coverage"
            error={sources.error ?? repos.error}
            retry={() => {
              void sources.refetch();
              void repos.refetch();
            }}
          />
        ) : (
          <View
            style={{
              flexDirection: usageCapsule || (detail && !compact) ? 'row' : 'column',
              flexWrap: usageCapsule ? 'wrap' : 'nowrap',
              gap: detail ? 16 : 10,
              borderTopWidth: detail || compact ? 1 : 0,
              borderTopColor: colors.border,
              paddingTop: detail || compact ? 12 : 0,
              paddingBottom: compact && !detail ? 8 : 0,
            }}
          >
            {groups.map((group) => (
              <View
                key={group.heading}
                style={{
                  flex: detail && !compact ? 1 : undefined,
                  flexDirection: usageCapsule ? 'row' : 'column',
                  flexWrap: usageCapsule ? 'wrap' : 'nowrap',
                  alignItems: usageCapsule ? 'center' : 'stretch',
                  gap: detail ? 8 : 6,
                  minWidth: 0,
                }}
              >
                <ReportText muted size={detail ? 13 : 12} strong={!usageCapsule}>
                  {usageCapsule && group.heading === 'On this machine'
                    ? 'This machine'
                    : group.heading}
                </ReportText>
                {group.items.map((item) => (
                  <View
                    key={item.name}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: 6,
                      maxWidth: '100%',
                    }}
                  >
                    <StatusIcon tone={item.tone} />
                    <View style={{ flexShrink: 1 }}>
                      {detail ? (
                        <>
                          <ReportText size={14} strong>
                            {item.name}
                          </ReportText>
                          <ReportText size={14} muted>
                            {item.text}
                          </ReportText>
                        </>
                      ) : (
                        <ReportText size={12}>
                          <ReportText strong size={12}>
                            {item.name}
                          </ReportText>{' '}
                          {item.text}
                        </ReportText>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            ))}
            {!detail && (
              <View
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 12,
                  flexGrow: 1,
                }}
              >
                {stamp}
                <Pressable
                  accessibilityRole="link"
                  onPress={() => navigate('sources')}
                  style={{ justifyContent: 'center', minHeight: compact ? 44 : undefined }}
                >
                  <ReportText size={12} color={colors.action}>
                    Manage sources
                  </ReportText>
                </Pressable>
              </View>
            )}
          </View>
        ))}
    </View>
  );
}

type ReportTime = { timezone: string; today: string };

function formatWhen(value: string, { timezone, today }: ReportTime) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const day = ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
  return day === today
    ? `today, ${instant.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' })}`
    : formatInstant(value, timezone);
}

function SourceRow({
  source,
  compact,
  first,
  refresh,
  clock,
}: {
  source: SourceStatus;
  compact: boolean;
  first: boolean;
  refresh: ReturnType<typeof useDashboardRefresh>;
  clock: ReportTime;
}) {
  const status = sourceStatus(source);
  const name = source.name ?? sourceNames[source.id];
  const retry =
    source.status === 'failed' || source.status === 'denied' || source.status === 'needspassword';
  const checkAgain = source.status === 'notfound' || source.status === 'notrunning';
  const attempt =
    source.lastAttemptAt && source.lastAttemptResult
      ? `${{ succeeded: 'Succeeded', partial: 'Succeeded with problems', failed: (source.consecutiveFailures ?? 0) > 1 ? 'Failed again' : 'Failed' }[source.lastAttemptResult]} ${formatWhen(source.lastAttemptAt, clock)}`
      : undefined;
  const lastSuccess = source.lastSuccessAt ? formatWhen(source.lastSuccessAt, clock) : '—';
  return (
    <View
      style={{
        flexDirection: compact ? 'column' : 'row',
        alignItems: compact ? 'stretch' : 'flex-start',
        columnGap: 24,
        rowGap: 8,
        borderTopColor: colors.border,
        borderTopWidth: first ? 0 : 1,
        paddingTop: first ? 0 : 12,
        paddingBottom: 12,
      }}
    >
      <View style={{ width: compact ? undefined : 220, gap: 4 }}>
        <ReportText size={14} strong>
          {name}
        </ReportText>
        <StatusLine {...status} />
      </View>
      <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: 4 }}>
        {source.status === 'notfound' ? (
          <ReportText muted size={12}>
            Nothing in its usual locations on this machine. If you use it here, run it once, then
            check again.
          </ReportText>
        ) : source.status === 'notrunning' || source.status === 'needspassword' ? (
          <ReportText muted size={12}>
            {source.status === 'needspassword'
              ? 'Paseo is asking for a password, which this dashboard doesn’t support.'
              : 'Start Paseo, then check again.'}
            {source.hasRetainedData ? ' Names and parents come from its last snapshot.' : ''}
          </ReportText>
        ) : source.location ? (
          <ReportText muted size={12}>
            Location{' '}
            <ReportText size={12} mono>
              {source.location}
            </ReportText>{' '}
            · found automatically
          </ReportText>
        ) : null}
        {source.oldestDate && source.hasRetainedData !== false && (
          <ReportText muted size={12}>
            History from {formatDay(source.oldestDate)}
            {source.sessions ? ` · ${int(source.sessions)} sessions` : ''}
          </ReportText>
        )}
        <ReportText muted size={12}>
          Last successful refresh: {lastSuccess.charAt(0).toUpperCase() + lastSuccess.slice(1)}
          {attempt ? ` · Latest attempt: ${attempt}` : ''}
        </ReportText>
        {source.message && (
          <ReportText
            muted
            size={12}
            color={source.lastAttemptResult === 'failed' ? colors.danger : undefined}
          >
            {source.message}
          </ReportText>
        )}
        {source.retentionNote && (
          <ReportText muted size={12}>
            {source.retentionNote}
          </ReportText>
        )}
      </View>
      <View style={{ alignSelf: compact ? 'flex-start' : undefined }}>
        <NativeButton
          label={retry ? 'Retry' : checkAgain ? 'Check again' : 'Refresh'}
          icon="RefreshCw"
          accessibilityLabel={`${retry ? 'Retry' : checkAgain ? 'Check again' : 'Refresh'} ${name}`}
          disabled={refresh.busy}
          primary={retry}
          onPress={() => refresh.refresh(source.id)}
        />
      </View>
    </View>
  );
}

export function NativeSources({
  refresh,
  onOpenOwnerSettings,
  compact = true,
}: {
  refresh: ReturnType<typeof useDashboardRefresh>;
  onOpenOwnerSettings(): void;
  compact?: boolean;
}) {
  const { request, bootstrap } = useDashboard();
  const invalidate = useRefreshDashboardData();
  const discover = useNativeAction();
  const { data, error, refetch } = refresh.sources;
  const roster = useDashboardQuery('roster');
  const github = data?.accounts?.find((account) => account.id === 'github');
  const githubAccount =
    github?.login &&
    (github.via === 'gh' || github.via === 'app') &&
    (github.status === 'connected' || github.status === 'existing')
      ? { login: github.login, via: github.via }
      : null;
  const hooks = roster.data?.exactPrompts;
  const sourceRows = data?.sources?.filter((source) => source.id !== 'github') ?? [];
  const ownerAction = (label: string) => (
    <NativeButton label={label} onPress={onOpenOwnerSettings} />
  );
  const cards: ReactNode = data && (
    <>
      <NativeCard title="On this machine">
        <ReportText size={12} muted>
          The dashboard reads supported agent records on the computer it’s installed on. There’s
          nothing to choose; what it finds appears here.
        </ReportText>
        {sourceRows.length ? (
          <View style={{ marginBottom: -12 }}>
            {sourceRows.map((source, index) => (
              <SourceRow
                key={source.id}
                source={source}
                compact={compact}
                first={index === 0}
                refresh={refresh}
                clock={bootstrap}
              />
            ))}
          </View>
        ) : (
          <ReportText muted>
            Nothing has been checked yet. Use Refresh all to look for records on this machine.
          </ReportText>
        )}
      </NativeCard>
      <NativeCard title="Know when Claude Code needs you">
        <ReportText size={12} muted>
          This only changes what HQ can show. Your usage and delivery numbers are unaffected.
        </ReportText>
        <View style={{ gap: 4, maxWidth: 470 }}>
          <ReportText size={12} muted>
            HQ can only guess when an agent outside Paseo is waiting for you. Turn this on to have
            Claude Code tell HQ directly.
          </ReportText>
          <ReportText size={12} muted>
            Turning it on adds five entries to your Claude Code settings. Everything else in them is
            kept, and turning it off removes only those entries.
          </ReportText>
          <ReportText size={12} muted>
            Owner settings also has a separate option to report Claude Code background work. It
            shares task IDs, categories, states and observation times while the wait hooks are on.
          </ReportText>
        </View>
        {hooks && (
          <ReportText size={12} strong>
            {hookStates[hooks]}
          </ReportText>
        )}
        <NativeActions>{ownerAction('Open owner settings')}</NativeActions>
      </NativeCard>
      <NativeCard title="Accounts">
        <ReportText size={12} muted>
          Connection and report availability are shown separately. A connection doesn’t guarantee a
          report or local history.
        </ReportText>
        <NativeAccount
          id="github"
          account={github}
          request={request}
          onAccount={() => {
            void invalidate();
          }}
          onCheckSources={() => refresh.refresh('github')}
        />
        <NativeAccount
          id="chatgpt"
          account={data.accounts?.find((account) => account.id === 'chatgpt')}
          request={request}
          onAccount={() => {
            void invalidate();
          }}
          onCheckSources={() =>
            void discover.run(async (signal) => {
              await request('discover');
              if (!signal.aborted) await invalidate();
            })
          }
        />
        {discover.busy && (
          <NativeText announce tone="foregroundMuted">
            Checking for Codex…
          </NativeText>
        )}
        <NativeProblem message={discover.problem} />
        <NativeUsagePanel request={request} provider="claude" inline compact={compact} />
        <ReportText size={12} muted>
          Sign-in opens the provider’s own page. The dashboard never asks for your password, model
          API keys or browser cookies. Local usage works without any account connection.
        </ReportText>
      </NativeCard>
      <NativeRepos
        account={githubAccount}
        request={request}
        mode="sources"
        compact={compact}
        timezone={bootstrap.timezone}
        onReposChange={() => void invalidate()}
      />
      <NativeCard title="Data kept on this machine">
        <ReportText size={12} muted>
          Stored on this computer only
        </ReportText>
        <View style={{ maxWidth: 660 }}>
          <ReportText size={14}>
            Usage metrics and link metadata are kept for 12 months on this machine so history
            survives log cleanup. Prompts, responses, tool output and credentials aren’t stored.
            GitHub and account-report reads are the only network requests. Checking Claude plan
            limits contacts Anthropic using your existing Claude Code sign-in and saves the limit
            percentages, reset times and check status.
          </ReportText>
        </View>
      </NativeCard>
      <NativeCard
        title="Reset Agent Productivity HQ"
        headingAccessory={ownerAction('Review reset in browser')}
      >
        <ReportText size={12} muted>
          Clear this app’s data and return to first-time setup.
        </ReportText>
      </NativeCard>
    </>
  );
  return (
    <View style={{ gap: 16 }}>
      <NativeSourceCoverage compact={compact} detail />
      {!data && <ReportLoading label="sources" error={error} retry={() => void refetch()} />}
      {cards}
      {data && error && (
        <NativeProblem message="Sources could not refresh. The last available information is shown." />
      )}
    </View>
  );
}
