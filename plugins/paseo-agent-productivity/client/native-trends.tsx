import { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View, type DimensionValue } from 'react-native';
import type { ModelShare, Provider, YearResponse } from '../shared/report-contracts.ts';
import { compactCount as compact } from '../shared/reporting-chart-utils.ts';
import { colors } from '../shared/reporting-palette.ts';
import { layoutYearGrid } from '../shared/reporting-year-layout.ts';
import { ClaudeModelFill, PlotLabel, ReportSvg } from './native-chart-drawing.tsx';
import { NativeSeriesChart } from './native-chart.tsx';
import { NativeRecords, type RecordPeriod } from './native-records.tsx';
import {
  deliveryScope,
  formatShortDay,
  formatDayWithWeekday,
  int,
  periodNotHappened,
  providerColors,
  providersInScope,
  RangeNotices,
  reportBody,
  ReportCard,
  reportCaption,
  reportData,
  ReportProviderLabel,
  usageScope,
} from './native-report-details.tsx';
import {
  ReportLoading,
  useDashboard,
  useDashboardQuery,
  useReportFilters,
} from './native-reporting.tsx';
import { useDashboardLayout } from './native-ui.tsx';

export function NativeTrends() {
  const { filters } = useDashboard();
  const { width } = useDashboardLayout();
  const sources = useDashboardQuery('sources');
  return (
    <>
      {sources.data?.sources && <RangeNotices scope={filters} sources={sources.data.sources} />}
      <TrendsActivity
        rangeKey={`${filters.start}/${filters.end}/${filters.gran}`}
        phone={width < 720}
      />
      <Models columns={width >= 1024 ? 2 : 1} wide={width >= 720} />
    </>
  );
}

function TrendsActivity({ rangeKey, phone }: { rangeKey: string; phone: boolean }) {
  const [period, setPeriod] = useState<RecordPeriod>();
  const [selected, setSelected] = useState<RecordPeriod>();
  const [previousRange, setPreviousRange] = useState(rangeKey);
  if (previousRange !== rangeKey) {
    setPreviousRange(rangeKey);
    setSelected(undefined);
    setPeriod(undefined);
  }
  return (
    <>
      <YearCard select={setPeriod} phone={phone} />
      <NativeSeriesChart
        title="Merged PRs and recorded local tokens"
        selected={selected}
        onSelect={(item) => {
          setSelected(item);
          setPeriod(item);
        }}
        onClear={() => setSelected(undefined)}
      />
      {period && (
        <NativeRecords
          key={`${period.start}/${period.end}`}
          period={period}
          onClose={() => setPeriod(undefined)}
        />
      )}
    </>
  );
}

const heat = [
  colors['surface-sunken'],
  colors['heat-1'],
  colors['heat-2'],
  colors['heat-3'],
  colors['heat-4'],
];

function YearCard({ select, phone }: { select(period: RecordPeriod): void; phone: boolean }) {
  const { filters } = useDashboard();
  const { repos, author } = useReportFilters();
  const query = useDashboardQuery('year', { repos, author });
  const data = query.data;
  if (data?.delivery === 'none') return null;
  const legend = (
    <View
      accessible={false}
      aria-hidden
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <Text style={reportCaption}>Fewer</Text>
      {heat.map((backgroundColor) => (
        <View
          key={backgroundColor}
          style={{ width: 11, height: 11, borderRadius: 3, backgroundColor }}
        />
      ))}
      <Text style={reportCaption}>More</Text>
    </View>
  );
  const countStyle = [reportData, { fontWeight: '700' as const }];
  return (
    <ReportCard
      title="A year of merges"
      scope={`${deliveryScope(filters)} · last 12 months · selected period outlined`}
      accessory={data ? legend : undefined}
    >
      {data ? (
        <>
          <View style={{ gap: 8 }}>
            <MergeCalendar data={data} range={filters} select={select} />
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                columnGap: 24,
                rowGap: 8,
              }}
            >
              <Text style={reportCaption}>
                <Text style={countStyle}>{int(data.total)}</Text> merged{' '}
                {data.total === 1 ? 'PR' : 'PRs'}
              </Text>
              <Text style={reportCaption}>
                <Text style={countStyle}>{int(data.daysWithMerge)}</Text>{' '}
                {data.daysWithMerge === 1 ? 'day' : 'days'} with a merge
              </Text>
              {data.busiestDay?.date && data.busiestDay.count != null && (
                <Text style={reportCaption}>
                  Busiest day <Text style={countStyle}>{formatShortDay(data.busiestDay.date)}</Text>{' '}
                  ({int(data.busiestDay.count)})
                </Text>
              )}
              <Text style={reportCaption}>
                {Platform.OS === 'web' ? 'Click' : 'Tap'} a day to see its records.
              </Text>
              {phone && (
                <Text style={reportCaption}>
                  Scroll sideways to see the full year; it opens on the newest weeks.
                </Text>
              )}
            </View>
          </View>
          {data.delivery === 'syncing' && (
            <Text style={reportCaption}>
              Merged PRs are still being collected, so a day may show fewer merges than it had.
            </Text>
          )}
        </>
      ) : (
        <ReportLoading
          label="the year of merges"
          error={query.error}
          retry={() => void query.refetch()}
        />
      )}
    </ReportCard>
  );
}

function MergeCalendar({
  data,
  range,
  select,
}: {
  data: YearResponse;
  range: Pick<RecordPeriod, 'start' | 'end'>;
  select(period: RecordPeriod): void;
}) {
  const [width, setWidth] = useState(0);
  const scroller = useRef<ScrollView>(null);
  const positioned = useRef(0);
  const grid = useMemo(() => layoutYearGrid({ ...data, range, width }), [data, range, width]);
  const [hovered, setHovered] = useState<string>();
  const marks = useMemo(
    () =>
      grid.cells
        .map(
          ({ x, y, level, inRange }) =>
            `<rect x="${x}" y="${y}" width="${grid.cell}" height="${grid.cell}" rx="3" fill="${heat[level]}"${inRange ? ` stroke="${colors.text}" stroke-width="1.2"` : ''}/>`,
        )
        .join(''),
    [grid],
  );
  const active = hovered ? grid.cells.find((cell) => cell.date === hovered) : undefined;
  return (
    <View
      onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}
      style={{ minHeight: grid.height, paddingBottom: 4 }}
    >
      {width > 0 && (
        <ScrollView
          horizontal
          ref={scroller}
          focusable
          showsHorizontalScrollIndicator={false}
          accessibilityLabel="A year of merges, scrolls sideways"
          onContentSizeChange={() => {
            if (positioned.current === grid.width) return;
            positioned.current = grid.width;
            if (grid.width > width) scroller.current?.scrollToEnd({ animated: false });
          }}
        >
          <View style={{ width: grid.width, height: grid.height, overflow: 'hidden' }}>
            <ReportSvg
              width={grid.width}
              height={grid.height}
              layers={[
                marks,
                ...(active
                  ? [
                      `<rect x="${active.x}" y="${active.y}" width="${grid.cell}" height="${grid.cell}" rx="3" fill="none" stroke="${colors.action}" stroke-width="1.5"/>`,
                    ]
                  : []),
              ]}
            />
            {grid.months.map(({ text, x, y }) => (
              <PlotLabel key={x} x={x} y={y} width={40}>
                {text}
              </PlotLabel>
            ))}
            {grid.weekdays.map(({ text, x, y }) => (
              <PlotLabel key={y} x={x} y={y} width={30}>
                {text}
              </PlotLabel>
            ))}
            {grid.cells.map(({ date, x, y }) => (
              <Pressable
                key={date}
                testID={`paseo-year-day-${date}`}
                accessible={false}
                focusable={false}
                tabIndex={-1}
                onHoverIn={() => setHovered(date)}
                onHoverOut={() => setHovered(undefined)}
                onPress={() =>
                  select({ start: date, end: date, label: formatDayWithWeekday(date) })
                }
                style={{
                  position: 'absolute',
                  left: x,
                  top: y,
                  width: grid.cell,
                  height: grid.cell,
                }}
              />
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function Models({ columns, wide }: { columns: 1 | 2; wide: boolean }) {
  const { filters } = useDashboard();
  const { start, end, repos, provider } = useReportFilters();
  const query = useDashboardQuery('models', { start, end, repos, provider });
  const data = query.data;
  return (
    <ReportCard
      title="Recorded tokens by model"
      scope={`${usageScope(filters)} · share within each provider; providers aren’t compared on one scale`}
    >
      {data ? (
        <View style={{ flexDirection: columns === 2 ? 'row' : 'column', gap: 16 }}>
          {providersInScope(filters.provider).map((id) => (
            <ProviderModels key={id} provider={id} share={data[id]} wide={wide} />
          ))}
        </View>
      ) : (
        <ReportLoading
          label="tokens by model"
          error={query.error}
          retry={() => void query.refetch()}
        />
      )}
    </ReportCard>
  );
}

function ProviderModels({
  provider,
  share,
  wide,
}: {
  provider: Provider;
  share?: ModelShare | undefined;
  wide: boolean;
}) {
  const rows = share?.rows ?? [];
  const coverage = share?.coverage;
  const [width, setWidth] = useState(0);
  const nameWidth = wide ? 160 : 110;
  const numberWidth = wide ? 84 : 72;
  const trackWidth = Math.max(18, width - nameWidth - numberWidth - 24);
  return (
    <View
      style={{ flex: 1, minWidth: 0, gap: 8 }}
      onLayout={
        provider === 'claude' ? (event) => setWidth(event.nativeEvent.layout.width) : undefined
      }
    >
      <ReportProviderLabel provider={provider} strong />
      {rows.length === 0 ? (
        <Text style={[reportBody, { color: colors['text-muted'] }]}>
          {coverage === 'future'
            ? periodNotHappened
            : coverage === 'none'
              ? 'No local records on this machine.'
              : coverage === 'unavailable'
                ? 'History unavailable for this period.'
                : 'No recorded sessions in scope.'}
        </Text>
      ) : (
        rows.map((row, index) => {
          const percent = Math.max(0, Math.min(100, row.sharePercent ?? 0));
          const fillWidth = Math.round(trackWidth * percent) / 100;
          return (
            <View
              key={row.model ?? index}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
            >
              <Text
                numberOfLines={1}
                style={[
                  reportData,
                  {
                    width: nameWidth,
                    fontSize: 12,
                    lineHeight: 16,
                    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  },
                ]}
              >
                {row.model ?? 'Unknown model'}
              </Text>
              <View
                accessible={false}
                aria-hidden
                style={{
                  flex: 1,
                  minWidth: 18,
                  height: 10,
                  borderRadius: 5,
                  overflow: 'hidden',
                  backgroundColor: colors['surface-sunken'],
                }}
              >
                {provider === 'claude' && fillWidth > 0 && width > 0 ? (
                  <ClaudeModelFill width={fillWidth} />
                ) : (
                  <View
                    style={{
                      width: `${percent}%` as DimensionValue,
                      height: 10,
                      backgroundColor: providerColors[provider],
                      borderRadius: 5,
                    }}
                  />
                )}
              </View>
              <Text style={[reportData, { width: numberWidth, textAlign: 'right' }]}>
                {compact(row.tokens)} <Text style={reportCaption}>{row.sharePercent ?? 0}%</Text>
              </Text>
            </View>
          );
        })
      )}
    </View>
  );
}
