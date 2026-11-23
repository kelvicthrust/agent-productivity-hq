import { ExternalLink, Icon } from '@getpaseo/plugin/client/ui';
import { type ReactNode } from 'react';
import { Pressable, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import type {
  AuthorFilter,
  LinkClass,
  Provider,
  ProviderFilter,
  PullRequest,
  UsageCoverage,
} from '../shared/report-contracts.ts';
import { colors } from '../shared/reporting-palette.ts';
import { NativeBuddy, NativeCrewArt } from './native-hq-crew.tsx';
import { cardShadow, NativeButton, NativeText, useDashboardLayout } from './native-ui.tsx';
import { dashboardDisplayFont } from './web.ts';

export const providerNames = { codex: 'Codex', claude: 'Claude Code' } as const;
export const providerColors = { codex: colors['series-codex'], claude: colors['series-claude'] };
export const providersInScope = (provider: ProviderFilter): Provider[] =>
  provider === 'all' ? ['codex', 'claude'] : [provider];

export const periodNotHappened = 'This period hasn’t happened yet.';
export const noTrackedRepos = 'No tracked repositories';

const countFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const int = (value: number | null | undefined) =>
  value == null ? '—' : countFormat.format(value);

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const weekdayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });

export const formatDay = (day: string) => dateFormat.format(new Date(`${day}T00:00:00Z`));
export const formatShortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
export const formatDayWithWeekday = (day: string) =>
  `${weekdayFormat.format(new Date(`${day}T00:00:00Z`))}, ${formatDay(day)}`;

export function formatInstant(instant: string, timeZone: string) {
  const date = new Date(instant);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

const repoScope = (repos: readonly string[]) =>
  repos.length === 0 ? 'All repos' : repos.length === 1 ? repos[0] : `${repos.length} repos`;

export function deliveryScope(scope: { repos: readonly string[]; author: AuthorFilter }) {
  return `${repoScope(scope.repos)} · ${scope.author === 'mine' ? 'Authored by you' : 'All authors'}`;
}

export function usageScope(scope: { repos: readonly string[]; provider: ProviderFilter }) {
  const provider = scope.provider === 'all' ? 'All providers' : providerNames[scope.provider];
  return `This machine · ${repoScope(scope.repos)} · ${provider}`;
}

export function coverageLabel(coverage?: UsageCoverage): string {
  switch (coverage) {
    case 'ok':
      return 'Complete';
    case 'none':
      return 'No local records';
    case 'unavailable':
      return 'History unavailable';
    case 'future':
      return 'Upcoming';
    case 'partial':
      return 'Partial coverage';
    case 'stale':
      return 'Cached · recent days missing';
    default:
      return 'Unavailable';
  }
}

export const measured = (coverage?: UsageCoverage) =>
  coverage === 'ok' || coverage === 'partial' || coverage === 'stale';

export function ReportNotice({ text, warning = false }: { text: string; warning?: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 12,
        backgroundColor: warning ? colors['warning-surface'] : colors['surface-sunken'],
      }}
    >
      <View style={{ marginTop: 1 }} accessible={false} aria-hidden>
        <Icon
          name={warning ? 'TriangleAlert' : 'Info'}
          color={warning ? colors.warning : colors['text-muted']}
          size={16}
        />
      </View>
      <Text style={{ ...reportCaption, flex: 1, color: colors.text }}>{text}</Text>
    </View>
  );
}

export function RangeNotices({
  scope,
  sources,
}: {
  scope: { start: string; repos: readonly string[]; provider: ProviderFilter };
  sources: readonly { id: string; oldestDate?: string | null | undefined }[];
}) {
  const oldestDates = providersInScope(scope.provider).map((provider) => ({
    provider,
    start: sources.find((source) => source.id === provider)?.oldestDate,
  }));
  const history = oldestDates.flatMap(({ provider, start }) =>
    start && scope.start < start ? [`${providerNames[provider]} from ${formatDay(start)}`] : [],
  );
  return (
    <>
      {!oldestDates.some(({ start }) => start) ? (
        <ReportNotice
          warning
          text="No local agent records were found on this machine. Usage here comes from account reports only and can’t be split by repo, session or PR."
        />
      ) : history.length > 0 ? (
        <ReportNotice
          text={`Local usage history on this machine starts: ${history.join('; ')}. Earlier dates show as unavailable, not zero.`}
        />
      ) : null}
      {scope.repos.length > 0 && (
        <ReportNotice text="Repo filter is on: sessions with an unknown or untracked repo are excluded. Account-reported usage is not filtered by repo." />
      )}
    </>
  );
}

const linkBadges = {
  evidence: ['Evidence link', 'Circle', colors.action, colors['selection-surface'], 'transparent'],
  owner: ['Owner-confirmed', 'Check', colors.text, colors.surface, colors.text],
  suggested: [
    'Suggested',
    'CircleDashed',
    colors['text-muted'],
    colors.surface,
    colors['control-border'],
  ],
  unlinked: ['Unlinked', 'Minus', colors['text-muted'], colors['surface-sunken'], 'transparent'],
} as const satisfies Record<LinkClass, readonly [string, string, string, string, string]>;

export function ReportLinkBadge({ kind }: { kind: LinkClass }) {
  const [label, icon, color, backgroundColor, borderColor] = linkBadges[kind];
  return (
    <View
      style={{
        height: 22,
        borderRadius: 11,
        borderWidth: 1,
        borderStyle: kind === 'suggested' ? 'dashed' : 'solid',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 7,
        paddingRight: 9,
        backgroundColor,
        borderColor,
      }}
    >
      <View accessible={false} aria-hidden>
        {kind === 'evidence' ? (
          <View
            style={{ margin: 3, width: 6, height: 6, borderRadius: 3, backgroundColor: color }}
          />
        ) : (
          <Icon name={icon} size={12} color={color} />
        )}
      </View>
      <Text style={{ ...reportCaption, color, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

function githubUrl(value: string) {
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function ReportPrRow({
  pr,
  timezone,
  index,
  last,
}: {
  pr: PullRequest;
  timezone: string;
  index: number;
  last: boolean;
}) {
  const href = githubUrl(pr.url);
  const title = <Text style={{ ...reportBody, fontWeight: '600', flexShrink: 1 }}>{pr.title}</Text>;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        paddingTop: index === 0 ? 0 : 10,
        paddingBottom: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        {href ? (
          <ExternalLink href={href} accessibilityLabel={`${pr.title}, opens on GitHub`}>
            {title}
          </ExternalLink>
        ) : (
          title
        )}
        <Text style={reportCaption}>
          {pr.repo} #{pr.number}
        </Text>
        <Text style={[reportCaption, { marginTop: 2 }]}>
          {formatInstant(pr.mergedAt, timezone)}
          {!pr.authoredByMe && pr.author ? ` · by ${pr.author}` : ''}
        </Text>
      </View>
      <ReportLinkBadge kind={pr.linkClass} />
    </View>
  );
}

export const reportCardStyle: ViewStyle = {
  ...cardShadow,
  padding: 16,
  gap: 12,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 14,
  backgroundColor: colors.surface,
};

export const reportCaption: TextStyle = {
  color: colors['text-muted'],
  fontSize: 12,
  lineHeight: 16,
};

export const reportBody: TextStyle = { color: colors.text, fontSize: 14, lineHeight: 20 };
export const reportData: TextStyle = {
  color: colors.text,
  fontSize: 13,
  lineHeight: 18,
  fontVariant: ['tabular-nums'],
};

export function ReportCard({
  title,
  scope,
  accessory,
  children,
}: {
  title: string;
  scope?: string;
  accessory?: ReactNode;
  children: ReactNode;
}) {
  const { web } = useDashboardLayout();
  return (
    <View style={reportCardStyle}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <View style={{ flexShrink: 1, minWidth: 0, gap: 2 }}>
          <NativeText
            size={16}
            heading
            style={{ fontFamily: web ? dashboardDisplayFont : undefined }}
          >
            {title}
          </NativeText>
          {scope && <Text style={reportCaption}>{scope}</Text>}
        </View>
        {accessory}
      </View>
      {children}
    </View>
  );
}

export function ReportProviderLabel({
  provider,
  strong = false,
}: {
  provider: Provider;
  strong?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <NativeBuddy provider={provider} size={15} />
      <Text style={strong ? [reportData, { fontWeight: '600' }] : reportCaption}>
        {providerNames[provider]}
      </Text>
    </View>
  );
}

export function ReportEmptyRepos({ onAdd, compact = false }: { onAdd(): void; compact?: boolean }) {
  return (
    <View
      style={{
        alignItems: 'flex-start',
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: colors['border-strong'],
        borderRadius: 14,
        gap: 8,
        padding: compact ? 16 : 24,
      }}
    >
      <NativeCrewArt mood="search" />
      <NativeText heading size={16}>
        {noTrackedRepos}
      </NativeText>
      <Text style={[reportBody, { color: colors['text-muted'], maxWidth: 440 }]}>
        Add the GitHub repositories you want to follow. Merged PRs, and their links to agent
        sessions, appear once a repo is tracked. Local usage is still shown without them.
      </Text>
      <NativeButton label="Add repositories" primary onPress={onAdd} />
    </View>
  );
}

export function ReportSegments<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { label: string; value: Value }[];
  value: Value;
  onChange(value: Value): void;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        flexWrap: 'wrap',
        maxWidth: '100%',
        backgroundColor: '#F0EFEF',
        padding: 1,
        borderRadius: 18,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            aria-checked={selected}
            hitSlop={{ top: 7, bottom: 7 }}
            onPress={() => onChange(option.value)}
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: selected ? colors.action : 'transparent',
              backgroundColor: selected ? colors['selection-surface'] : 'transparent',
              minHeight: 30,
              justifyContent: 'center',
              paddingHorizontal: 12,
            }}
          >
            <Text
              style={[
                reportBody,
                {
                  fontWeight: selected ? '600' : '500',
                  color: selected ? colors.action : colors['text-muted'],
                },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
