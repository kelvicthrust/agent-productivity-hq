import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { View } from 'react-native';
import { formatRange } from '../shared/reporting-dates.ts';
import { periodOf } from '../shared/reporting-filters.ts';
import { colors } from '../shared/reporting-palette.ts';
import type { NativeRequest } from './native-api.ts';
import { NativeDelivery } from './native-delivery.tsx';
import { NativeOverview, NativeOverviewHeading } from './native-overview.tsx';
import { NativeRosterPanel } from './native-roster.tsx';
import { useDashboardRefresh } from './native-refresh.ts';
import { deliveryScope, usageScope } from './native-report-details.tsx';
import {
  ReportingFilters,
  reportPeriodLabel,
  useDashboard,
  type DashboardPage,
} from './native-reporting.tsx';
import { NativeSources } from './native-sources.tsx';
import { NativeTrends } from './native-trends.tsx';
import {
  NativeActions,
  NativeButton,
  NativeProblem,
  NativeText,
  useDashboardLayout,
} from './native-ui.tsx';
import { NativeUsage } from './native-usage.tsx';

const names = {
  hq: 'HQ',
  overview: 'Overview',
  trends: 'Trends',
  delivery: 'Delivery',
  usage: 'Usage',
  sources: 'Sources & repos',
};

export function NativeDashboard({
  host,
  navigation,
  page,
  request,
  onSetupRequired,
  onOpenOwnerSettings,
}: Pick<PluginScreenProps, 'host' | 'navigation'> & {
  page: DashboardPage;
  request: NativeRequest;
  onSetupRequired(): void;
  onOpenOwnerSettings(): void;
}) {
  const refresh = useDashboardRefresh();
  const { compact } = useDashboardLayout();
  const { bootstrap, filters, navigate } = useDashboard();
  const actions = (
    <NativeActions>
      {compact && (
        <NativeButton
          label="HQ"
          accessibilityLabel={page === 'hq' ? 'HQ, current page' : 'HQ'}
          icon="House"
          iconOnly
          style={
            page === 'hq'
              ? { borderColor: colors.action, backgroundColor: colors['selection-surface'] }
              : undefined
          }
          onPress={() => navigate('hq')}
        />
      )}
      <NativeButton
        label={refresh.busy ? 'Refreshing…' : page === 'sources' ? 'Refresh all' : 'Refresh'}
        icon="RefreshCw"
        iconOnly={compact}
        disabled={refresh.busy}
        onPress={() => refresh.refresh()}
      />
    </NativeActions>
  );
  const refreshNotice = (
    <>
      {refresh.status && (
        <NativeText announce tone="foregroundMuted">
          {refresh.status}
        </NativeText>
      )}
      <NativeProblem message={refresh.problem} />
    </>
  );
  if (page === 'hq') {
    return (
      <NativeRosterPanel
        request={request}
        host={host}
        navigation={navigation}
        onSetupRequired={onSetupRequired}
        headingActions={actions}
        refreshNotice={refreshNotice}
      />
    );
  }
  const subtitle =
    page === 'sources'
      ? 'Setup and upkeep. Everyday review lives in Overview.'
      : [
          reportPeriodLabel(periodOf(filters, bootstrap)),
          formatRange(filters.start, filters.end),
          page === 'trends'
            ? `by ${filters.gran}`
            : page === 'delivery'
              ? deliveryScope(filters)
              : usageScope(filters),
        ].join(' · ');
  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          gap: 8,
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          {page === 'overview' ? (
            <NativeOverviewHeading />
          ) : (
            <>
              <NativeText heading size={24} announce>
                {names[page]}
              </NativeText>
              <NativeText tone="foregroundMuted">{subtitle}</NativeText>
            </>
          )}
        </View>
        {actions}
      </View>
      {refreshNotice}
      {page !== 'sources' && <ReportingFilters key={page} page={page} />}
      {page === 'overview' && <NativeOverview />}
      {page === 'trends' && <NativeTrends />}
      {page === 'delivery' && <NativeDelivery compact={compact} />}
      {page === 'usage' && <NativeUsage compact={compact} />}
      {page === 'sources' && (
        <NativeSources
          compact={compact}
          refresh={refresh}
          onOpenOwnerSettings={onOpenOwnerSettings}
        />
      )}
    </>
  );
}
