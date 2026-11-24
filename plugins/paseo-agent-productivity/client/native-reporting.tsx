import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import type { NativeOperation } from '../shared/native.ts';
import { formatRange } from '../shared/reporting-dates.ts';
import { colors as palette } from '../shared/reporting-palette.ts';
import {
  applyChange,
  checkCustomRange,
  defaultFilters,
  filtersQuery,
  periodOf,
  type FilterChange,
  type Filters,
  type PeriodPreset,
} from '../shared/reporting-filters.ts';
import { requestMessage, type NativeParameters, type NativeRequest } from './native-api.ts';
import type { NativeBootstrap } from './native-types.ts';
import {
  NativeActions,
  NativeButton,
  NativeCard,
  NativeInput,
  NativeProblem,
  NativeText,
  useDashboardLayout,
} from './native-ui.tsx';

export type DashboardPage = 'hq' | 'overview' | 'trends' | 'delivery' | 'usage' | 'sources';
export interface DrillDown {
  start: string;
  end: string;
  prId?: string;
}

interface DashboardState {
  hostId: string;
  request: NativeRequest;
  bootstrap: NativeBootstrap;
  filters: Filters;
  changeFilters(change: FilterChange): void;
  navigate(page: DashboardPage, drill?: DrillDown): void;
  drill?: DrillDown;
}

const Dashboard = createContext<DashboardState | null>(null);

export function ReportingProvider({
  children,
  ...data
}: Omit<DashboardState, 'filters' | 'changeFilters'> & { children: ReactNode }) {
  const [selection, setSelection] = useState<Filters>();
  const filters = selection ?? defaultFilters(data.bootstrap);

  return (
    <Dashboard.Provider
      value={{
        ...data,
        filters,
        navigate: (page, drill) => {
          if (drill) {
            const range = { start: drill.start, end: drill.end };
            setSelection((previous) =>
              applyChange(previous ?? defaultFilters(data.bootstrap), { range }, data.bootstrap),
            );
          }
          data.navigate(page, drill);
        },
        changeFilters: (change) =>
          setSelection((previous) =>
            applyChange(previous ?? defaultFilters(data.bootstrap), change, data.bootstrap),
          ),
      }}
    >
      {children}
    </Dashboard.Provider>
  );
}

export function useDashboard() {
  const state = useContext(Dashboard);
  if (!state) throw new Error('Agent HQ reporting requires the host dashboard.');
  return state;
}

export function useReportFilters() {
  const { filters, bootstrap } = useDashboard();
  return { ...filtersQuery(filters), timezone: bootstrap.timezone };
}

export const hostQueryKey = (hostId: string) => ['agent-hq', hostId] as const;

export function useDashboardQuery<Operation extends NativeOperation>(
  operation: Operation,
  parameters?: NativeParameters<Operation>,
  options: { enabled?: boolean; interval?: number; keepPrevious?: boolean } = {},
) {
  const { hostId, request } = useDashboard();

  return useQuery({
    queryKey: [...hostQueryKey(hostId), operation, parameters ?? null],
    queryFn: () => request(operation, parameters),
    enabled: options.enabled,
    refetchInterval: options.interval,
    retry: false,
    ...(options.keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

export function useRefreshDashboardData() {
  const queryClient = useQueryClient();
  const { hostId } = useDashboard();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: hostQueryKey(hostId) }),
    [queryClient, hostId],
  );
}

export function ReportLoading({
  label,
  error,
  retry,
}: {
  label: string;
  error: unknown;
  retry(): void;
}) {
  return error ? (
    <View style={{ gap: 8 }}>
      <NativeProblem message={requestMessage(error)} />
      <NativeButton label={`Retry ${label}`} onPress={retry} />
    </View>
  ) : (
    <NativeText tone="foregroundMuted" announce>
      Loading {label}…
    </NativeText>
  );
}

const presets: ReadonlyArray<[PeriodPreset, string]> = [
  ['today', 'Today'],
  ['this-week', 'This week'],
  ['this-month', 'This month'],
  ['last-week', 'Last week'],
  ['last-month', 'Last month'],
  ['last-30', 'Last 30 days'],
  ['last-90', 'Last 90 days'],
  ['last-12m', 'Last 12 months'],
];
const granularity = { day: 'Day', week: 'Week', month: 'Month' } as const;
const providers = { all: 'All providers', codex: 'Codex', claude: 'Claude Code' } as const;
const primaryPresets = presets.slice(0, 3);

export function reportPeriodLabel(period: PeriodPreset | 'custom') {
  return presets.find(([key]) => key === period)?.[1] ?? 'Custom range';
}

export function ReportingFilters({ page }: { page: 'overview' | 'trends' | 'delivery' | 'usage' }) {
  const { filters, bootstrap, changeFilters } = useDashboard();
  const { compact } = useDashboardLayout();
  const [expanded, setExpanded] = useState(false);
  const [range, setRange] = useState<{ start: string; end: string }>();
  const [problem, setProblem] = useState<string>();
  const repos = useDashboardQuery('repos', undefined, { enabled: expanded });
  const period = periodOf(filters, bootstrap);
  const filterButton = (
    <NativeButton
      label={expanded ? 'Hide filters' : 'Filters'}
      icon="Funnel"
      style={{ borderRadius: 999 }}
      onPress={() => setExpanded(!expanded)}
    />
  );
  const repoScope =
    filters.repos.length === 0
      ? 'All repos'
      : filters.repos.length === 1
        ? (repos.data?.active?.find((repo) => repo.id === filters.repos[0])?.displayName ??
          filters.repos[0])
        : `${filters.repos.length} repos`;
  const scope = [
    repoScope,
    ...(page === 'delivery' ? [] : [providers[filters.provider]]),
    ...(page === 'usage' ? [] : [filters.author === 'mine' ? 'My PRs' : 'All PRs']),
  ];

  function openCustomRange() {
    setExpanded(true);
    setProblem(undefined);
    setRange({
      start: filters.start,
      end: filters.end > bootstrap.today ? bootstrap.today : filters.end,
    });
  }

  function applyRange() {
    if (!range) return;
    const check = checkCustomRange(range.start, range.end, bootstrap);
    if (!check.ok) {
      setProblem(
        check.reason === 'missing'
          ? 'Enter both dates as YYYY-MM-DD.'
          : check.reason === 'order'
            ? 'Start must come before end.'
            : `Choose dates between ${bootstrap.lookbackStart} and ${bootstrap.today}.`,
      );
      return;
    }
    changeFilters({ range });
    setProblem(undefined);
    setRange(undefined);
  }

  return (
    <View style={{ gap: 8 }}>
      {compact ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingVertical: 6,
            paddingLeft: 14,
            paddingRight: 6,
            borderWidth: 1,
            borderColor: palette.border,
            borderRadius: 999,
            backgroundColor: palette.surface,
          }}
        >
          <NativeText size={12} tone="foregroundMuted" style={{ flex: 1 }}>
            <NativeText size={13} style={{ fontWeight: '700' }}>
              {reportPeriodLabel(period)}
            </NativeText>
            {' · '}
            {scope.join(' · ')}
          </NativeText>
          {filterButton}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Period"
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              backgroundColor: palette['surface-sunken'],
              borderRadius: 999,
            }}
          >
            {primaryPresets.map(([key, label]) => (
              <NativeButton
                key={key}
                label={label}
                variant="pill"
                selectionRole="radio"
                selected={period === key}
                onPress={() => {
                  changeFilters({ period: key });
                  setRange(undefined);
                }}
              />
            ))}
            <NativeButton
              label="Custom"
              icon="CalendarDays"
              variant="pill"
              selectionRole="radio"
              selected={!!range || !primaryPresets.some(([key]) => key === period)}
              onPress={openCustomRange}
            />
          </View>
          {filterButton}
          <NativeText size={13} style={{ fontWeight: '600' }}>
            {formatRange(filters.start, filters.end)}
          </NativeText>
          <NativeText size={12} tone="foregroundMuted" style={{ marginStart: 'auto' }}>
            Times in {bootstrap.timezone} (this machine)
          </NativeText>
        </View>
      )}
      {expanded && (
        <NativeCard title="Report filters">
          <NativeText heading>Period</NativeText>
          <NativeActions>
            {presets.map(([key, label]) => (
              <NativeButton
                key={key}
                label={label}
                selectionRole="radio"
                variant="pill"
                selected={period === key}
                onPress={() => {
                  changeFilters({ period: key });
                  setRange(undefined);
                }}
              />
            ))}
            <NativeButton
              label="Custom range"
              selectionRole="radio"
              selected={!!range || period === 'custom'}
              onPress={openCustomRange}
            />
          </NativeActions>
          {range && (
            <>
              <NativeInput
                accessibilityLabel="Start date"
                placeholder="YYYY-MM-DD"
                value={range.start}
                onChangeText={(start) => setRange({ ...range, start })}
              />
              <NativeInput
                accessibilityLabel="End date"
                placeholder="YYYY-MM-DD"
                value={range.end}
                onChangeText={(end) => setRange({ ...range, end })}
              />
              <NativeProblem message={problem} />
              <NativeButton label="Apply dates" onPress={applyRange} />
            </>
          )}
          {page !== 'delivery' && (
            <>
              <NativeText heading>Group by</NativeText>
              <NativeActions>
                {Object.entries(granularity).map(([key, label]) => (
                  <NativeButton
                    key={key}
                    label={label}
                    selectionRole="radio"
                    selected={filters.gran === key}
                    onPress={() => changeFilters({ gran: key as Filters['gran'] })}
                  />
                ))}
              </NativeActions>
            </>
          )}
          <NativeText heading>Repos</NativeText>
          <NativeActions>
            <NativeButton
              label="All repos"
              selected={filters.repos.length === 0}
              onPress={() => changeFilters({ repos: [] })}
            />
            {repos.data?.active?.map((repo) => (
              <NativeButton
                key={repo.id}
                label={repo.displayName}
                selected={filters.repos.includes(repo.id)}
                onPress={() => {
                  const next = filters.repos.includes(repo.id)
                    ? filters.repos.filter((id) => id !== repo.id)
                    : [...filters.repos, repo.id];
                  changeFilters({ repos: next });
                }}
              />
            ))}
          </NativeActions>
          {page !== 'delivery' && (
            <>
              <NativeText heading>Provider</NativeText>
              <NativeActions>
                {Object.entries(providers).map(([key, label]) => (
                  <NativeButton
                    key={key}
                    label={label}
                    selectionRole="radio"
                    selected={filters.provider === key}
                    onPress={() => changeFilters({ provider: key as Filters['provider'] })}
                  />
                ))}
              </NativeActions>
            </>
          )}
          {page !== 'usage' && (
            <>
              <NativeText heading>Author</NativeText>
              <NativeActions>
                <NativeButton
                  label="Mine"
                  selectionRole="radio"
                  selected={filters.author === 'mine'}
                  onPress={() => changeFilters({ author: 'mine' })}
                />
                <NativeButton
                  label="All authors"
                  selectionRole="radio"
                  selected={filters.author === 'all'}
                  onPress={() => changeFilters({ author: 'all' })}
                />
              </NativeActions>
            </>
          )}
          <NativeText tone="foregroundMuted">Report timezone · {bootstrap.timezone}</NativeText>
          <NativeButton
            label="Reset filters"
            onPress={() => {
              changeFilters({ reset: true });
              setRange(undefined);
              setProblem(undefined);
            }}
          />
        </NativeCard>
      )}
    </View>
  );
}
