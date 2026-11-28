import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Bucket, OverviewResponse, Provider } from '../shared/report-contracts.ts';
import { compactCount as compact } from '../shared/reporting-chart-utils.ts';
import { formatRange } from '../shared/reporting-dates.ts';
import { addDays, periodOf, weekEnd, weekStart } from '../shared/reporting-filters.ts';
import { greeting } from '../shared/reporting-greeting.ts';
import { colors } from '../shared/reporting-palette.ts';
import { ReportSvg } from './native-chart-drawing.tsx';
import { NativeSeriesChart } from './native-chart.tsx';
import { NativeBuddy, NativeCrewArt } from './native-hq-crew.tsx';
import { NativeRecords, type RecordPeriod } from './native-records.tsx';
import {
  coverageLabel,
  deliveryScope,
  formatDay,
  int,
  periodNotHappened,
  providerColors,
  providerNames,
  providersInScope,
  RangeNotices,
  reportBody,
  ReportCard,
  reportCardStyle,
  reportCaption,
  reportData,
  ReportEmptyRepos,
  ReportNotice,
  ReportProviderLabel,
  ReportPrRow,
  usageScope,
} from './native-report-details.tsx';
import {
  ReportLoading,
  reportPeriodLabel,
  useDashboard,
  useDashboardQuery,
  useReportFilters,
} from './native-reporting.tsx';
import { NativeUsagePanel } from './native-roster.tsx';
import { NativeText, useDashboardLayout } from './native-ui.tsx';
import { dashboardDisplayFont } from './web.ts';

export function NativeOverviewHeading() {
  const { bootstrap, filters } = useDashboard();
  const [openedAt] = useState(Date.now);
  return (
    <View style={{ gap: 4 }}>
      <NativeText heading size={24}>
        {greeting(openedAt, bootstrap.timezone, bootstrap.greetingName)}
      </NativeText>
      <Text style={[reportBody, { color: colors['text-muted'] }]}>
        Here’s what merged and where your agents spent their tokens ·{' '}
        {reportPeriodLabel(periodOf(filters, bootstrap)).toLowerCase()},{' '}
        {formatRange(filters.start, filters.end)}
      </Text>
    </View>
  );
}

export function NativeOverview({ workReview }: { workReview: ReactNode }) {
  const { bootstrap, request } = useDashboard();
  const { width: screenWidth } = useDashboardLayout();
  const { start, end, repos, provider, author } = useReportFilters();
  const overview = useDashboardQuery(
    'overview',
    { start, end, repos, provider, author },
    { keepPrevious: true },
  );
  const trend = useDashboardQuery(
    'series',
    {
      start: addDays(weekStart(bootstrap.today), -77),
      end: weekEnd(bootstrap.today),
      gran: 'week',
      repos,
      provider,
      author,
    },
    { keepPrevious: true },
  );
  const [period, setPeriod] = useState<RecordPeriod>();
  const [width, setWidth] = useState(0);
  const data = overview.data;
  const updating = overview.isPlaceholderData;
  const wide = screenWidth >= 1280;
  const linkWarning =
    data && (data.coverage.github?.tracked ?? 0) > 0 ? data.linkHealth.state : null;

  return (
    <View
      style={{ gap: 16 }}
      onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}
    >
      {data ? (
        <Kpis
          data={data}
          trend={updating || trend.isPlaceholderData ? undefined : trend.data?.buckets}
          width={width}
          screenWidth={screenWidth}
        />
      ) : (
        <ReportLoading
          label="overview"
          error={overview.error}
          retry={() => void overview.refetch()}
        />
      )}
      {updating && (
        <NativeText size={12} tone="foregroundMuted" announce>
          Updating overview for the selected filters…
        </NativeText>
      )}
      {data && (
        <>
          {linkWarning === 'stale' && (
            <ReportNotice
              warning
              text="Pull request links are out of date. Showing the last successful rebuild."
            />
          )}
          {linkWarning === 'unavailable' && (
            <ReportNotice
              warning
              text="Links between pull requests and agent sessions haven’t been calculated yet. Imported pull requests can still appear."
            />
          )}
          <RangeNotices scope={data.scope} sources={data.coverage.sources ?? []} />
          {data.trueZero && (
            <View
              style={[
                reportCardStyle,
                {
                  flexDirection: screenWidth >= 720 ? 'row' : 'column',
                  alignItems: screenWidth >= 720 ? 'center' : 'flex-start',
                  gap: 16,
                  paddingVertical: 12,
                  borderStyle: 'dashed',
                  borderColor: colors['border-strong'],
                },
              ]}
            >
              <NativeCrewArt mood="sleep" />
              <View style={{ flexShrink: 1, gap: 2, maxWidth: 450 }}>
                <NativeText heading size={16}>
                  A quiet one.
                </NativeText>
                <Text style={[reportBody, { color: colors['text-muted'] }]}>
                  No recorded agent activity and no merges in this period. Every source was
                  collecting, so this is a true zero, not missing data.
                </Text>
              </View>
            </View>
          )}
        </>
      )}
      {workReview}
      <View
        style={{
          gap: 16,
          flexDirection: wide ? 'row' : 'column',
          alignItems: wide ? 'flex-start' : 'stretch',
        }}
      >
        <View style={wide ? { width: gridWidth(width, 8), minWidth: 0 } : undefined}>
          <NativeSeriesChart
            title="Delivery and usage over time"
            selected={period}
            onSelect={setPeriod}
          />
        </View>
        {wide && (
          <View style={{ flex: 1, minWidth: 0 }}>
            <NativeUsagePanel request={request} provider={provider} timezone={bootstrap.timezone} />
          </View>
        )}
      </View>
      {data && (
        <>
          <RecentMerged data={data} updating={updating} />
          <Repositories data={data} narrow={screenWidth < 640} />
        </>
      )}
      {!wide && (
        <NativeUsagePanel request={request} provider={provider} timezone={bootstrap.timezone} />
      )}
      {period && (
        <NativeRecords
          key={`${period.start}/${period.end}`}
          period={period}
          onClose={() => setPeriod(undefined)}
        />
      )}
    </View>
  );
}

function Tile({
  label,
  scope,
  detail,
  width,
  delivery,
  children,
}: {
  label: string;
  scope: string;
  detail?: ReactNode;
  width: number | undefined;
  delivery?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={[
        reportCardStyle,
        {
          width: width ?? '100%',
          paddingTop: 12,
          gap: 4,
          borderColor: delivery ? colors['heat-1'] : colors.border,
          backgroundColor: delivery ? colors['delivery-surface'] : colors.surface,
        },
      ]}
    >
      <Text style={[reportData, { fontWeight: '600' }]}>{label}</Text>
      <Text style={reportCaption}>{scope}</Text>
      {children}
      {detail && (
        <View style={{ marginTop: 'auto', paddingTop: 2 }}>
          {typeof detail === 'string' ? <Text style={reportCaption}>{detail}</Text> : detail}
        </View>
      )}
    </View>
  );
}

const gridWidth = (width: number, span: number) =>
  width > 0 ? Math.floor(((width + 16) * span) / 12 - 16) : undefined;

function Metric({
  children,
  unit,
  small = false,
}: {
  children: ReactNode;
  unit?: string | undefined;
  small?: boolean;
}) {
  const { web } = useDashboardLayout();
  return (
    <Text
      style={{
        color: colors.text,
        fontSize: small ? 24 : 30,
        lineHeight: small ? 30 : 36,
        letterSpacing: small ? -0.36 : -0.45,
        fontWeight: '700',
        fontFamily: web ? dashboardDisplayFont : undefined,
        fontVariant: ['tabular-nums'],
      }}
    >
      {children}
      {unit && (
        <Text
          style={[
            reportData,
            {
              color: colors['text-muted'],
              letterSpacing: 0,
              fontFamily: web ? 'system-ui' : undefined,
              fontWeight: '400',
            },
          ]}
        >
          {' '}
          {unit}
        </Text>
      )}
    </Text>
  );
}

function Unavailable({ children }: { children: ReactNode }) {
  return (
    <Text style={[reportData, { color: colors['text-muted'], paddingVertical: 6 }]}>
      {children}
    </Text>
  );
}

function CrewRow({ crew = [], count }: { crew?: readonly Provider[] | undefined; count: number }) {
  const shown = crew.slice(0, 3);
  return (
    shown.length > 0 && (
      <View
        accessible={false}
        aria-hidden
        style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}
      >
        {shown.map((provider, index) => (
          <NativeBuddy key={index} provider={provider} />
        ))}
        {count > shown.length && <Text style={reportCaption}>+{count - shown.length}</Text>}
      </View>
    )
  );
}

function ReportTextLink({
  children,
  disabled,
  onPress,
}: {
  children: string;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10 }}
    >
      <Text
        style={[
          reportBody,
          { color: colors.action, opacity: disabled ? 0.55 : 1, textDecorationLine: 'underline' },
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

function Kpis({
  data,
  trend,
  width,
  screenWidth,
}: {
  data: OverviewResponse;
  trend?: Bucket[] | undefined;
  width: number;
  screenWidth: number;
}) {
  const { navigate } = useDashboard();
  const { kpis, scope } = data;
  const merged = kpis.mergedPrs;
  const linked = kpis.linkedPrs;
  const previous = merged?.previous;
  const previousText = previous?.label
    ? `${previous.label}: ${previous.outsideLookback || previous.value == null ? 'outside the 12-month lookback' : int(previous.value)}`
    : undefined;
  const desktop = screenWidth >= 1280;
  const medium = screenWidth >= 720;
  const standard = gridWidth(width, desktop ? 2 : medium ? 4 : 6);
  const deliveryWidth = gridWidth(width, desktop ? 3 : medium ? 4 : 6);
  const tokensWidth = gridWidth(width, desktop ? 3 : medium ? 4 : 12);
  const splitTokens = (tokensWidth ?? 0) >= 234;
  const noSessions = merged?.delivery === 'future' ? periodNotHappened : 'No local records';
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
      <Tile
        label="Merged PRs"
        scope={deliveryScope(scope)}
        width={deliveryWidth}
        delivery
        detail={
          merged?.delivery === 'none' ? (
            <ReportTextLink onPress={() => navigate('sources')}>Add repositories</ReportTextLink>
          ) : merged?.delivery === 'syncing' ? (
            'So far · still syncing'
          ) : (
            previousText
          )
        }
      >
        {merged?.delivery === 'none' ? (
          <Unavailable>No tracked repos</Unavailable>
        ) : merged?.delivery === 'future' ? (
          <Unavailable>{periodNotHappened}</Unavailable>
        ) : merged?.value == null ? (
          <Unavailable>—</Unavailable>
        ) : (
          <ValueWithSpark
            value={int(merged?.value)}
            trend={
              merged?.delivery === 'syncing' || merged?.value == null
                ? undefined
                : trend?.map((bucket) => bucket.prs)
            }
            color={colors['series-delivery']}
          />
        )}
      </Tile>
      <Tile
        label="Linked PRs"
        scope="Evidence or owner-confirmed"
        width={standard}
        detail={linked?.of ? `${int(linked.suggestedOnly ?? 0)} with suggestions only` : undefined}
      >
        {linked?.value != null && linked.of != null ? (
          <Metric unit={`of ${int(linked.of)}`}>{int(linked.value)}</Metric>
        ) : (
          <Unavailable>—</Unavailable>
        )}
      </Tile>
      <Tile
        label="Recorded local tokens"
        scope={usageScope(scope)}
        width={tokensWidth}
        detail="Provider totals aren’t combined."
      >
        <View style={{ flexDirection: splitTokens ? 'row' : 'column', gap: splitTokens ? 12 : 8 }}>
          {providersInScope(scope.provider).map((provider) => {
            const tokens = kpis.localTokens?.[provider];
            if (!tokens) return null;
            const note =
              tokens.note === 'From <date> only' && tokens.coveredFrom
                ? `From ${formatDay(tokens.coveredFrom)} only`
                : tokens.note === 'Cached; recent days missing'
                  ? 'Cached; recent days missing'
                  : undefined;
            return (
              <View key={provider} style={splitTokens ? { flex: 1, minWidth: 0 } : undefined}>
                <View
                  style={{
                    flexDirection: splitTokens ? 'column' : 'row',
                    alignItems: splitTokens ? 'flex-start' : 'baseline',
                    justifyContent: 'space-between',
                    columnGap: 12,
                  }}
                >
                  <ReportProviderLabel provider={provider} />
                  {tokens.value == null ? (
                    <Text
                      style={[
                        reportData,
                        {
                          color: colors['text-muted'],
                          flexShrink: 1,
                          textAlign: splitTokens ? 'left' : 'right',
                          paddingVertical: splitTokens ? 6 : 0,
                        },
                      ]}
                    >
                      {tokens.coverage === 'future'
                        ? periodNotHappened
                        : coverageLabel(tokens.coverage)}
                    </Text>
                  ) : (
                    <View style={{ alignItems: splitTokens ? 'flex-start' : 'flex-end' }}>
                      <Metric small>{compact(tokens.value)}</Metric>
                      {trend && (
                        <View style={{ marginTop: 4 }}>
                          <Sparkline
                            values={trend.map((bucket) => bucket.tokens[provider] ?? null)}
                            color={providerColors[provider]}
                            name={providerNames[provider]}
                            format={compact}
                          />
                        </View>
                      )}
                    </View>
                  )}
                </View>
                {note && tokens.value != null && <Text style={reportCaption}>{note}</Text>}
              </View>
            );
          })}
        </View>
      </Tile>
      <Tile
        label="Root sessions"
        scope="Active in period"
        width={standard}
        detail={
          kpis.rootSessions?.value == null
            ? undefined
            : `${int(kpis.rootSessions.unknownRelationship ?? 0)} with unknown relationship`
        }
      >
        {kpis.rootSessions?.value == null ? (
          <Unavailable>{noSessions}</Unavailable>
        ) : (
          <>
            <Metric>{int(kpis.rootSessions.value)}</Metric>
            <CrewRow crew={kpis.rootSessions.crew} count={kpis.rootSessions.value} />
          </>
        )}
      </Tile>
      <Tile
        label="Child agents"
        scope="Known parent, active in period"
        width={standard}
        detail={
          kpis.childAgents?.value == null
            ? undefined
            : `Paseo ${int(kpis.childAgents.paseo ?? 0)} · native ${int(kpis.childAgents.native ?? 0)}`
        }
      >
        {kpis.childAgents?.value == null ? (
          <Unavailable>{noSessions}</Unavailable>
        ) : (
          <>
            <Metric>{int(kpis.childAgents.value)}</Metric>
            <CrewRow crew={kpis.childAgents.crew} count={kpis.childAgents.value} />
          </>
        )}
      </Tile>
    </View>
  );
}

function ValueWithSpark({
  value,
  trend,
  color,
}: {
  value: string;
  trend?: Array<number | null> | undefined;
  color: string;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        rowGap: 4,
        columnGap: 8,
      }}
    >
      <Metric>{value}</Metric>
      {trend && <Sparkline values={trend} color={color} />}
    </View>
  );
}

function Sparkline({
  values,
  color,
  name,
  format = int,
}: {
  values: Array<number | null>;
  color: string;
  name?: string;
  format?(value: number): string;
}) {
  const counts = values.filter((value): value is number => value !== null);
  if (counts.length === 0) return null;
  const low = Math.min(...counts);
  const high = Math.max(...counts);
  const points = values.map((value, index) =>
    value === null
      ? null
      : {
          x: Math.round((3 + (index * 58) / Math.max(1, values.length - 1)) * 100) / 100,
          y: high === low ? 10 : Math.round((17 - (14 * (value - low)) / (high - low)) * 100) / 100,
        },
  );
  const marks = points
    .map((point, index) => {
      if (!point) return '';
      const previous = points[index - 1];
      const next = points[index + 1];
      const line = previous
        ? `<path d="M${previous.x} ${previous.y}L${point.x} ${point.y}" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`
        : '';
      const last = index === points.length - 1;
      const dot =
        last || (!previous && !next)
          ? `<circle cx="${point.x}" cy="${point.y}" r="${last ? 2.5 : 1}" fill="${color}"/>`
          : '';
      return line + dot;
    })
    .join('');
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`${name ? `${name} ` : ''}${values.length}-week trend, oldest to newest: ${values.map((value) => (value === null ? 'no data' : format(value))).join(', ')}; this week ${values.at(-1) == null ? 'no data' : format(values.at(-1)!)}`}
      style={{ width: 64, height: 20 }}
    >
      <ReportSvg width={64} height={20} layers={[marks]} />
    </View>
  );
}

function RecentMerged({ data, updating }: { data: OverviewResponse; updating: boolean }) {
  const { navigate } = useDashboard();
  const { start, end, timezone, author } = data.scope;
  const delivery = data.kpis.mergedPrs?.delivery;
  const prs = data.recentPrs;
  return (
    <ReportCard title="Recently merged" scope={deliveryScope(data.scope)}>
      {delivery === 'none' ? (
        <ReportEmptyRepos onAdd={() => navigate('sources')} />
      ) : prs.length === 0 ? (
        <NativeText tone="foregroundMuted">
          {delivery === 'future'
            ? periodNotHappened
            : delivery === 'syncing'
              ? 'Merged PRs are still being collected, so none are listed yet.'
              : `No merged PRs in this period${author === 'mine' ? ' authored by you' : ''}. Agent work that didn’t merge still appears in Usage.`}
        </NativeText>
      ) : (
        <>
          <View>
            {prs.map((pr, index) => (
              <ReportPrRow
                key={pr.id}
                pr={pr}
                timezone={timezone}
                index={index}
                last={index === prs.length - 1}
              />
            ))}
          </View>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              columnGap: 12,
              rowGap: 4,
            }}
          >
            <Text style={reportCaption}>
              {int(data.periodMergedCount ?? prs.length)} merged in this period
            </Text>
            <ReportTextLink
              disabled={updating}
              onPress={() => navigate('delivery', { start, end })}
            >
              View all in Delivery
            </ReportTextLink>
          </View>
        </>
      )}
    </ReportCard>
  );
}

function Repositories({ data, narrow }: { data: OverviewResponse; narrow: boolean }) {
  const { navigate } = useDashboard();
  const providers = providersInScope(data.scope.provider);
  const columns = [
    'Merged PRs',
    'Linked',
    ...providers.map((provider) => `${providerNames[provider]} tokens`),
    'Root sessions',
  ];
  const usageOnly = (row: OverviewResponse['repoRows'][number]) =>
    row.group === 'untracked' || row.group === 'unknown';
  const ranked = data.repoRows
    .filter((row) => !usageOnly(row))
    .sort(
      (a, b) =>
        Number(a.accessState === 'inaccessible') - Number(b.accessState === 'inaccessible') ||
        (b.mergedPrs ?? 0) - (a.mergedPrs ?? 0) ||
        (a.repo ?? '').localeCompare(b.repo ?? ''),
    );
  const rows = ranked.concat(data.repoRows.filter(usageOnly));
  return (
    <ReportCard
      title="By repository"
      scope={`PRs: ${deliveryScope(data.scope)} · Tokens: ${usageScope(data.scope)}`}
    >
      {data.kpis.mergedPrs?.delivery === 'none' && (
        <Text style={reportCaption}>
          No tracked repositories yet, so merged PRs aren’t available. Recorded usage is grouped by
          the repo each session recorded.
        </Text>
      )}
      {rows.length === 0 && (
        <NativeText tone="foregroundMuted">No recorded activity in this period.</NativeText>
      )}
      {rows.length > 0 && (
        <View>
          {!narrow && (
            <View
              style={{
                flexDirection: 'row',
                gap: 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
                paddingHorizontal: 10,
                paddingVertical: 8,
              }}
            >
              <Text style={[reportCaption, { flex: 2, fontWeight: '600' }]}>Repository</Text>
              {columns.map((label) => (
                <Text
                  key={label}
                  style={[reportCaption, { flex: 1, fontWeight: '600', textAlign: 'right' }]}
                >
                  {' '}
                  {label}
                </Text>
              ))}
            </View>
          )}
          {rows.map((row, index) => {
            const group = usageOnly(row);
            const label =
              row.group === 'untracked'
                ? 'Untracked repos'
                : row.group === 'unknown'
                  ? 'Unknown repo'
                  : (row.repo ?? '—');
            const values = [
              group ? 'n/a' : int(row.mergedPrs),
              group ? 'n/a' : int(row.linkedPrs),
              ...providers.map((provider) =>
                row.tokens?.[provider] == null
                  ? tokenGap(data.kpis.localTokens?.[provider]?.coverage)
                  : compact(row.tokens[provider]),
              ),
              int(row.rootSessions ?? 0),
            ];
            return (
              <View
                key={row.repo ?? row.group}
                style={{
                  flexDirection: narrow ? 'column' : 'row',
                  gap: narrow ? 8 : 12,
                  paddingHorizontal: narrow ? 0 : 10,
                  paddingTop: narrow && index === 0 ? 0 : narrow ? 12 : 10,
                  paddingBottom: narrow && index === rows.length - 1 ? 0 : narrow ? 12 : 10,
                  borderBottomWidth: index === rows.length - 1 ? 0 : 1,
                  borderBottomColor: colors.border,
                  backgroundColor: !narrow && group ? colors.canvas : colors.surface,
                }}
              >
                <View style={narrow ? undefined : { flex: 2, minWidth: 0 }}>
                  <Text
                    style={[
                      reportData,
                      {
                        color: group ? colors['text-muted'] : colors.text,
                        fontWeight: narrow ? '600' : '400',
                      },
                    ]}
                  >
                    {label}
                    {group && <Text style={reportCaption}> (usage only)</Text>}
                  </Text>
                  {row.accessState === 'inaccessible' && (
                    <View
                      style={{
                        flexDirection: 'row',
                        flexWrap: 'wrap',
                        alignItems: 'baseline',
                        gap: 6,
                      }}
                    >
                      <Text style={[reportCaption, { color: colors.warning }]}>Inaccessible</Text>
                      <ReportTextLink onPress={() => navigate('sources')}>Fix</ReportTextLink>
                    </View>
                  )}
                </View>
                {narrow ? (
                  <View style={{ gap: 4 }}>
                    {values.map((value, column) => (
                      <View
                        key={columns[column]}
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          columnGap: 12,
                        }}
                      >
                        <Text style={reportCaption}>{columns[column]}</Text>
                        <Text
                          style={[
                            reportData,
                            { color: group ? colors['text-muted'] : colors.text },
                          ]}
                        >
                          {value}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  values.map((value, index) => (
                    <Text
                      key={columns[index]}
                      style={[
                        reportData,
                        {
                          flex: 1,
                          textAlign: 'right',
                          color: group ? colors['text-muted'] : colors.text,
                        },
                      ]}
                    >
                      {value}
                    </Text>
                  ))
                )}
              </View>
            );
          })}
        </View>
      )}
    </ReportCard>
  );
}

function tokenGap(coverage?: string) {
  if (coverage === 'none') return 'No records';
  if (coverage === 'unavailable') return 'Unavailable';
  return '—';
}
