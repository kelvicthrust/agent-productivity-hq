import { useMemo, useState, type KeyboardEvent } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { Bucket, Provider } from '../shared/report-contracts.ts';
import { layoutAlignedChart } from '../shared/reporting-chart-layout.ts';
import {
  deliveryOf,
  noTrackedRepos as chartHasNoRepos,
  providerTokens,
  providerUsage,
  railOf,
} from '../shared/reporting-chart-model.ts';
import { compactCount as compact } from '../shared/reporting-chart-utils.ts';
import { colors } from '../shared/reporting-palette.ts';
import { ChartSwatch, NativeChartDrawing } from './native-chart-drawing.tsx';
import type { RecordPeriod } from './native-records.tsx';
import {
  deliveryScope,
  int,
  noTrackedRepos,
  providerNames,
  providersInScope,
  reportBody,
  ReportCard,
  reportCaption,
  reportData,
  ReportSegments,
  usageScope,
} from './native-report-details.tsx';
import {
  ReportLoading,
  useDashboard,
  useDashboardQuery,
  useReportFilters,
} from './native-reporting.tsx';
import { NativeButton, NativeText } from './native-ui.tsx';

const chartModes = [
  { value: 'chart', label: 'Chart' },
  { value: 'table', label: 'Table' },
] as const;

const keyboardHelp =
  'Use the left and right arrow keys to move between periods; press Enter to see its records.';

export function NativeSeriesChart({
  title,
  selected,
  onSelect,
  onClear,
}: {
  title: string;
  selected?: RecordPeriod;
  onSelect(period: RecordPeriod): void;
  onClear?(): void;
}) {
  const { filters } = useDashboard();
  const { start, end, gran, repos, provider, author } = useReportFilters();
  const query = useDashboardQuery(
    'series',
    { start, end, gran, repos, provider, author },
    { keepPrevious: true },
  );
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const data = query.data;
  const scope = data?.scope ?? filters;
  const seriesProviders = useMemo(() => providersInScope(scope.provider), [scope.provider]);
  const selectedIndex =
    data && selected
      ? data.buckets.findIndex(
          (bucket) => bucket.start === selected.start && bucket.end === selected.end,
        )
      : -1;

  return (
    <ReportCard title={title} scope={`PRs: ${deliveryScope(scope)} · Tokens: ${usageScope(scope)}`}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          columnGap: 16,
          rowGap: 8,
        }}
      >
        <SeriesLegend providers={seriesProviders} />
        <ReportSegments<'chart' | 'table'>
          label="Chart display"
          options={chartModes}
          value={mode}
          onChange={setMode}
        />
      </View>
      {mode === 'table' ? (
        <SeriesTable
          buckets={data?.buckets ?? []}
          providers={seriesProviders}
          selected={selectedIndex}
          disabled={query.isPlaceholderData}
          onSelect={onSelect}
        />
      ) : !data ? (
        <ReportLoading label="chart" error={query.error} retry={() => void query.refetch()} />
      ) : data.buckets.length === 0 ? (
        <NativeText tone="foregroundMuted">No periods to display.</NativeText>
      ) : (
        <SeriesPlot
          title={title}
          key={`${data.scope.start}/${data.scope.end}/${data.scope.gran}`}
          buckets={data.buckets}
          providers={seriesProviders}
          unavailableText={data.unavailableText}
          selected={selectedIndex}
          disabled={query.isPlaceholderData}
          onSelect={onSelect}
        />
      )}
      {query.isPlaceholderData && (
        <NativeText tone="foregroundMuted" size={12} announce>
          Updating chart for the selected filters…
        </NativeText>
      )}
      {onClear && selected && selectedIndex >= 0 && !query.isPlaceholderData && (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            columnGap: 16,
            rowGap: 8,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            paddingTop: 12,
          }}
        >
          <Text style={[reportBody, { color: colors['text-muted'] }]}>
            Selected period:{' '}
            <Text style={[reportBody, { fontWeight: '600' }]}>{selected.label}</Text>
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <NativeButton label="Show records" onPress={() => onSelect(selected)} />
            <NativeButton label="Clear selection" onPress={onClear} />
          </View>
        </View>
      )}
    </ReportCard>
  );
}

type SeriesSurface = {
  buckets: Bucket[];
  providers: readonly Provider[];
  selected: number;
  disabled: boolean;
  onSelect(bucket: Bucket): void;
};

function SeriesPlot({
  title,
  buckets,
  providers,
  unavailableText,
  selected,
  disabled,
  onSelect,
}: SeriesSurface & {
  title: string;
  unavailableText?: string | null | undefined;
}) {
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number>();
  const [hovered, setHovered] = useState<number>();
  const active = hovered ?? cursor ?? selected;
  const bucket = buckets[active];
  const keyboardBucket = cursor === undefined ? undefined : buckets[cursor];
  const startCursor =
    selected >= 0
      ? selected
      : Math.max(
          0,
          buckets.findLastIndex((item) => item.delivery !== 'future'),
        );
  const webKeys =
    Platform.OS === 'web'
      ? {
          tabIndex: 0 as const,
          onFocus: () => setCursor(startCursor),
          onBlur: () => setCursor(undefined),
          onKeyDown: (event: KeyboardEvent) => {
            if (disabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
              return;
            const current = cursor ?? startCursor;
            if (event.key === 'Enter' || event.key === ' ') {
              const period = buckets[current];
              if (period) {
                event.preventDefault();
                onSelect(period);
              }
              return;
            }
            const next =
              event.key === 'ArrowLeft'
                ? Math.max(0, current - 1)
                : event.key === 'ArrowRight'
                  ? Math.min(buckets.length - 1, current + 1)
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buckets.length - 1
                      : null;
            if (next !== null) {
              event.preventDefault();
              setHovered(undefined);
              setCursor(next);
            }
          },
        }
      : {};
  const layout = useMemo(
    () =>
      layoutAlignedChart(buckets, width, {
        providers,
        unavailableText: unavailableText ?? 'History unavailable',
        ...(chartHasNoRepos(buckets) ? { noDeliveryText: noTrackedRepos } : {}),
        upcomingText: 'Upcoming',
      }),
    [buckets, providers, unavailableText, width],
  );

  return (
    <>
      <View
        style={{
          minHeight: 22,
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          columnGap: 16,
          rowGap: 2,
        }}
      >
        {bucket ? (
          <>
            <Text style={[reportData, { fontWeight: '700' }]}>{bucket.label}</Text>
            {bucket.delivery === 'future' ? (
              <Text style={[reportData, { color: colors['text-muted'] }]}>
                Upcoming, no data yet
              </Text>
            ) : (
              <>
                <Text style={reportData}>
                  Merged PRs:{' '}
                  <Text style={{ fontWeight: '700' }}>{deliveryValue(bucket, 'readout')}</Text>
                </Text>
                {providers.map((provider) => (
                  <Text key={provider} style={reportData}>
                    {providerNames[provider]}:{' '}
                    <Text style={{ fontWeight: '700' }}>
                      {tokenValue(bucket, provider, 'readout')}
                    </Text>
                  </Text>
                ))}
              </>
            )}
          </>
        ) : (
          <Text style={[reportData, { color: colors['text-muted'] }]}>
            {Platform.OS === 'web'
              ? 'Hover a bucket, or focus the chart and use the arrow keys, to read its values.'
              : 'Tap a bucket to see its records or switch to Table to read its values.'}
          </Text>
        )}
      </View>
      <View
        onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}
        style={{ minHeight: layout.height }}
        accessibilityRole="image"
        accessibilityLabel={Platform.OS === 'web' ? `${title}. ${keyboardHelp}` : title}
        {...webKeys}
      >
        {width > 0 && (
          <ScrollView horizontal scrollEnabled={width < layout.width}>
            <View style={{ width: layout.width, height: layout.height }}>
              <NativeChartDrawing
                layout={layout}
                selected={selected}
                cursor={cursor ?? -1}
                hovered={hovered ?? -1}
              />
              {layout.buckets.map(({ index, band }) => {
                const period = buckets[index];
                if (!period) return null;
                return (
                  <Pressable
                    key={period.start}
                    testID={`paseo-series-period-${period.start}`}
                    accessible={false}
                    focusable={false}
                    tabIndex={-1}
                    disabled={disabled}
                    onHoverIn={() => setHovered(index)}
                    onHoverOut={() => setHovered(undefined)}
                    onPress={() => {
                      setHovered(undefined);
                      onSelect(period);
                    }}
                    style={{
                      position: 'absolute',
                      left: band.x,
                      top: band.y,
                      width: band.width,
                      height: band.height,
                    }}
                  />
                );
              })}
            </View>
          </ScrollView>
        )}
      </View>
      <Text style={reportCaption}>
        {Platform.OS === 'web' ? 'Click a bucket or press Enter' : 'Tap a bucket'} to see its
        records. Merged PRs and tokens have separate axes and are never compared on one scale.
      </Text>
      <Text aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}>
        {keyboardBucket && readoutAnnouncement(keyboardBucket, providers)}
      </Text>
    </>
  );
}

function LegendMark({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      {children}
      <Text style={[reportCaption, { flexShrink: 1 }]}>{label}</Text>
    </View>
  );
}

function SeriesLegend({ providers }: { providers: readonly Provider[] }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 16,
        rowGap: 4,
        maxWidth: '100%',
      }}
    >
      <LegendMark label="Merged PRs">
        <ChartSwatch kind="delivery" />
      </LegendMark>
      {providers.map((provider) => (
        <LegendMark key={provider} label={`${providerNames[provider]} tokens`}>
          <ChartSwatch kind={provider} />
        </LegendMark>
      ))}
      <LegendMark label="History unavailable">
        <ChartSwatch kind="unavailable" />
      </LegendMark>
      <LegendMark label="Zero, covered">
        <ChartSwatch kind="zero" />
      </LegendMark>
      <LegendMark label="Local coverage: complete, partial, none">
        <ChartSwatch kind="complete" />
        <ChartSwatch kind="partial" />
        <ChartSwatch kind="none" />
      </LegendMark>
    </View>
  );
}

function readoutAnnouncement(bucket: Bucket, providers: readonly Provider[]): string {
  if (bucket.delivery === 'future') return `${bucket.label}. Upcoming, no data yet.`;
  return [
    bucket.label,
    `Merged PRs: ${deliveryValue(bucket, 'readout')}`,
    ...providers.map(
      (provider) => `${providerNames[provider]}: ${tokenValue(bucket, provider, 'readout')}`,
    ),
  ].join('. ');
}

function deliveryValue(bucket: Bucket, mode: 'readout' | 'table'): string {
  const delivery = deliveryOf(bucket);
  const table = mode === 'table';
  switch (delivery.kind) {
    case 'future':
      return table ? '—' : 'Upcoming';
    case 'none':
      return table ? 'n/a' : 'no tracked repos';
    case 'syncing':
      return delivery.prs
        ? `${int(delivery.prs)}${table ? ' (syncing)' : ' so far · still syncing'}`
        : table
          ? 'Syncing'
          : 'still syncing';
    case 'ok':
      return int(delivery.prs);
    case 'unknown':
      return table ? 'Not available' : 'not available';
  }
}

function tokenValue(bucket: Bucket, provider: Provider, mode: 'readout' | 'table'): string {
  const coverage = providerUsage(bucket, provider);
  const value = providerTokens(bucket, provider);
  if (mode === 'table') {
    if (coverage === 'future') return '—';
    if (coverage === 'none') return 'No records';
    if (coverage === 'unavailable') return 'Unavailable';
    if (value === null) return 'Not available';
    return int(value) + (coverage === 'partial' || coverage === 'stale' ? ' *' : '');
  }
  if (coverage === 'unavailable') return 'history unavailable';
  if (coverage === 'none') return 'no local records';
  if (coverage === 'future') return 'upcoming, no data yet';
  if (value === null) return 'not available';
  return (
    (value === 0 ? '0 (no recorded activity)' : `${compact(value)} tokens`) +
    (coverage === 'partial'
      ? ' · partial coverage'
      : coverage === 'stale'
        ? ' · not collected since failed refresh'
        : '')
  );
}

function SeriesTable({ buckets, providers, selected, disabled, onSelect }: SeriesSurface) {
  const coverageWords = {
    ok: 'Complete',
    partial: 'Partial',
    stale: 'Partial',
    unavailable: 'Unavailable',
    none: 'None',
    future: 'Upcoming',
  } as const;
  const columns = [
    { label: 'Merged PRs', width: 112 },
    ...providers.map((provider) => ({ label: `${providerNames[provider]} tokens`, width: 135 })),
    { label: 'Local coverage', width: 112 },
  ];
  return (
    <View style={{ gap: 8 }}>
      <ScrollView
        horizontal
        focusable
        accessibilityLabel="Chart values as a table, scrolls sideways"
        contentContainerStyle={{ minWidth: '100%' }}
      >
        <View style={{ flexGrow: 1 }}>
          <View style={tableRowStyle}>
            <TableCell header>Period</TableCell>
            {columns.map(({ label, width }, index) => (
              <TableCell key={label} width={width} right={index < columns.length - 1} header>
                {label}
              </TableCell>
            ))}
          </View>
          {buckets.map((bucket, index) => {
            const active = index === selected;
            return (
              <View
                key={bucket.start}
                style={[tableRowStyle, active && { backgroundColor: colors['selection-surface'] }]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled }}
                  {...(Platform.OS === 'web' && active ? { 'aria-current': true } : {})}
                  disabled={disabled}
                  accessibilityHint="Show records for this period"
                  onPress={() => onSelect(bucket)}
                  style={{ flex: 1, minWidth: 150, paddingHorizontal: 10, paddingVertical: 6 }}
                >
                  <Text
                    style={[
                      reportData,
                      { fontWeight: '600', paddingVertical: 2, paddingHorizontal: 6 },
                    ]}
                  >
                    {bucket.label}
                  </Text>
                </Pressable>
                <TableCell width={columns[0]!.width} right>
                  {deliveryValue(bucket, 'table')}
                </TableCell>
                {providers.map((provider, position) => (
                  <TableCell key={provider} width={columns[position + 1]!.width} right>
                    {tokenValue(bucket, provider, 'table')}
                  </TableCell>
                ))}
                <TableCell width={columns.at(-1)!.width}>
                  {coverageWords[railOf(bucket, providers)]}
                </TableCell>
              </View>
            );
          })}
        </View>
      </ScrollView>
      <Text style={reportCaption}>
        * Partial: part of this period is before available history or not yet collected. Select a
        period to see its records.
      </Text>
    </View>
  );
}

const tableRowStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  borderBottomColor: colors.border,
  borderBottomWidth: 1,
} as const;

function TableCell({
  width,
  header,
  right,
  children,
}: {
  width?: number;
  header?: boolean;
  right?: boolean;
  children: string;
}) {
  return (
    <Text
      style={[
        header ? reportCaption : reportData,
        width ? { width } : { minWidth: 150, flex: 1 },
        {
          paddingHorizontal: 10,
          paddingVertical: header ? 8 : 6,
          fontWeight: header ? '600' : '400',
          textAlign: right ? 'right' : 'left',
        },
      ]}
    >
      {children}
    </Text>
  );
}
