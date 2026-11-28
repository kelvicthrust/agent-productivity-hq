import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { View } from 'react-native';
import { formatRange } from '../shared/reporting-dates.ts';
import { periodOf } from '../shared/reporting-filters.ts';
import { colors } from '../shared/reporting-palette.ts';
import type { NativeRequest } from './native-api.ts';
import { NativeAbout } from './native-about.tsx';
import { NativeDelivery } from './native-delivery.tsx';
import { NativeOverview, NativeOverviewHeading } from './native-overview.tsx';
import { NativeRosterPanel } from './native-roster.tsx';
import { useDashboardRefresh } from './native-refresh.ts';
import { deliveryScope, ReportSegments, usageScope } from './native-report-details.tsx';
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
import { NativeWorkReview, NativeWorkReviewPreview } from './native-work-review.tsx';

const names = {
  hq: 'HQ',
  overview: 'Overview',
  trends: 'Trends',
  delivery: 'Delivery',
  'work-review': 'Delivery',
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
  onOpenDashboard,
}: Pick<PluginScreenProps, 'host' | 'navigation'> & {
  page: DashboardPage;
  request: NativeRequest;
  onSetupRequired(): void;
  onOpenOwnerSettings(): void;
  onOpenDashboard(): void;
}) {
  const refresh = useDashboardRefresh();
  const { compact } = useDashboardLayout();
  const { bootstrap, filters, navigate } = useDashboard();
  const delivery = page === 'delivery' || page === 'work-review';
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
      <NativeButton
        label="Open full dashboard"
        icon="ExternalLink"
        iconOnly={compact}
        onPress={onOpenDashboard}
      />
      <NativeAbout />
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
        workReview={<NativeWorkReviewPreview />}
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
              : page === 'work-review'
                ? null
                : usageScope(filters),
        ]
          .filter(Boolean)
          .join(' · ');
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
      {page === 'overview' && <NativeOverview workReview={<NativeWorkReviewPreview />} />}
      {page === 'trends' && <NativeTrends />}
      {delivery && (
        <ReportSegments
          label="Delivery section"
          options={[
            { value: 'delivery', label: 'Merged PRs' },
            { value: 'work-review', label: 'Work Review' },
          ]}
          value={page}
          onChange={navigate}
        />
      )}
      {page === 'delivery' && <NativeDelivery compact={compact} />}
      {page === 'work-review' && <NativeWorkReview />}
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
