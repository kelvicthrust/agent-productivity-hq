import { Modal, ScrollView } from '@getpaseo/plugin/client/ui';
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { Provider, RecordsResponse } from '../shared/report-contracts.ts';
import { compactCount as compact } from '../shared/reporting-chart-utils.ts';
import { colors } from '../shared/reporting-palette.ts';
import {
  deliveryScope,
  int,
  measured,
  periodNotHappened,
  providerNames,
  reportCaption,
  reportData,
  ReportEmptyRepos,
  ReportNotice,
  ReportPrRow,
  ReportSegments,
  usageScope,
} from './native-report-details.tsx';
import { NativeBuddy } from './native-hq-crew.tsx';
import { ReportLoading, useDashboard, useDashboardQuery } from './native-reporting.tsx';
import { SessionIdentity } from './native-session.tsx';
import {
  NativeAppearance,
  NativeButton,
  NativeText,
  useColors,
  useDashboardLayout,
} from './native-ui.tsx';

export interface RecordPeriod {
  start: string;
  end: string;
  label: string;
}

const standardLimit = 30;
const expandedLimit = 100;
const providers = ['codex', 'claude'] as const;

export function NativeRecords({ period, onClose }: { period: RecordPeriod; onClose(): void }) {
  const { filters, bootstrap, navigate } = useDashboard();
  const theme = useColors();
  const layout = useDashboardLayout();
  const [limit, setLimit] = useState(standardLimit);
  const [chosen, setChosen] = useState<'prs' | 'sessions'>();
  const { start, end } = period;
  const dates = { start, end };
  const query = useDashboardQuery(
    'records',
    {
      ...dates,
      provider: filters.provider,
      author: filters.author,
      ...(filters.repos.length > 0 ? { repos: filters.repos.join(',') } : {}),
      limit,
    },
    { keepPrevious: true },
  );
  const data = query.data;
  const delivery = data?.coverage?.delivery;
  const prCount = delivery === 'ok' || delivery === 'syncing' ? (data?.prTotal ?? 0) : null;
  const sessionCount = providers.some((provider) => measured(data?.coverage?.[provider]))
    ? (data?.sessionTotal ?? 0)
    : null;
  const tab = chosen ?? ((data?.prTotal ?? 0) > 0 ? 'prs' : 'sessions');
  const timezone = data?.scope?.timezone ?? bootstrap.timezone;
  const count = tab === 'prs' ? data?.prs?.length : data?.sessions?.length;
  const total = tab === 'prs' ? data?.prTotal : data?.sessionTotal;
  const showMore = (count ?? 0) < (total ?? 0);

  function open(page: 'delivery' | 'usage' | 'sources') {
    onClose();
    navigate(page, page === 'sources' ? undefined : dates);
  }

  return (
    <Modal
      title={period.label}
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Modal.Content
        scrollable={false}
        style={{ backgroundColor: colors.surface }}
        contentContainerStyle={{ padding: 0, gap: 0, flex: 1, minHeight: 0 }}
      >
        {/* Paseo's phone sheet mounts its contents in a separate React root. */}
        <NativeAppearance colors={theme} layout={layout}>
          <View
            style={{
              paddingHorizontal: 20,
              paddingBottom: 12,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Text style={reportCaption}>
              Records in this period · PRs: {deliveryScope(filters)} · Sessions:{' '}
              {usageScope(filters)}
            </Text>
          </View>
          {data && (
            <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
              <ReportSegments<'prs' | 'sessions'>
                label="Record type"
                options={[
                  { value: 'prs', label: `Merged PRs ${int(prCount)}` },
                  { value: 'sessions', label: `Sessions ${int(sessionCount)}` },
                ]}
                value={tab}
                onChange={setChosen}
              />
            </View>
          )}
          <ScrollView
            style={{ minHeight: 0, flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 12, gap: 12 }}
          >
            {data ? (
              <>
                {tab === 'prs' ? (
                  <PrRecords
                    data={data}
                    timezone={timezone}
                    mine={filters.author === 'mine'}
                    onSources={() => open('sources')}
                  />
                ) : (
                  <SessionRecords data={data} timezone={timezone} />
                )}
                {showMore &&
                  (limit === expandedLimit && !query.isPlaceholderData ? (
                    <Text style={reportCaption}>
                      {tab === 'prs'
                        ? `Showing the newest ${int(count)} of ${int(total)} merged PRs. Open in Delivery for all.`
                        : `Showing the ${int(count)} largest of ${int(total)} sessions. Open in Usage for all.`}
                    </Text>
                  ) : (
                    <View
                      style={{
                        flexDirection: 'row',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <Text style={reportCaption}>
                        Showing {int(count)} of {int(total)}
                      </Text>
                      <NativeButton
                        label={query.isFetching ? 'Loading records…' : 'Show more'}
                        disabled={query.isFetching}
                        onPress={() => setLimit(expandedLimit)}
                      />
                    </View>
                  ))}
              </>
            ) : (
              <ReportLoading
                label="records"
                error={query.error}
                retry={() => void query.refetch()}
              />
            )}
          </ScrollView>
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              gap: 8,
              borderTopColor: colors.border,
              borderTopWidth: 1,
              paddingHorizontal: 20,
              paddingVertical: 12,
            }}
          >
            <NativeButton label="Open in Usage" onPress={() => open('usage')} />
            <NativeButton label="Open in Delivery" primary onPress={() => open('delivery')} />
          </View>
        </NativeAppearance>
      </Modal.Content>
    </Modal>
  );
}

function PrRecords({
  data,
  timezone,
  mine,
  onSources,
}: {
  data: RecordsResponse;
  timezone: string;
  mine: boolean;
  onSources(): void;
}) {
  const coverage = data.coverage?.delivery;
  const prs = data.prs ?? [];
  if (coverage === 'future')
    return <NativeText tone="foregroundMuted">{periodNotHappened}</NativeText>;
  if (coverage === 'none') return <ReportEmptyRepos compact onAdd={onSources} />;
  if (prs.length === 0) {
    return (
      <NativeText tone="foregroundMuted">
        {coverage === 'syncing'
          ? 'Merged PRs are still being collected, so none are listed yet.'
          : `No merged PRs in this period${mine ? ' authored by you' : ''}. GitHub history for tracked repos covers these dates, so this is a true zero.`}
      </NativeText>
    );
  }
  return (
    <>
      {coverage === 'syncing' && (
        <ReportNotice text="Merged PRs are still being collected, so this list may be incomplete." />
      )}
      <View accessibilityLabel="Merged pull requests">
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
    </>
  );
}

function SessionRecords({ data, timezone }: { data: RecordsResponse; timezone: string }) {
  const coverage = data.coverage;
  const inScope = providers.filter((provider) => coverage?.[provider] !== undefined);
  if (inScope.length > 0 && inScope.every((provider) => coverage?.[provider] === 'future')) {
    return <NativeText tone="foregroundMuted">{periodNotHappened}</NativeText>;
  }
  const sessions = data.sessions ?? [];
  return (
    <>
      {inScope.map((provider) => (
        <SessionCoverage key={provider} provider={provider} value={coverage?.[provider]} />
      ))}
      {sessions.length === 0 && inScope.some((provider) => measured(coverage?.[provider])) && (
        <NativeText tone="foregroundMuted">
          No recorded sessions in this period. Covered sources had no activity, so this is a true
          zero.
        </NativeText>
      )}
      {sessions.length > 0 && (
        <View accessibilityLabel="Sessions">
          {sessions.map((session, index) => (
            <View
              key={session.id}
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 8,
                paddingTop: index === 0 ? 0 : 10,
                paddingBottom: 10,
                borderBottomWidth: index === sessions.length - 1 ? 0 : 1,
                borderBottomColor: colors.border,
              }}
            >
              <View style={{ marginTop: 2 }}>
                <NativeBuddy provider={session.provider} size={15} />
              </View>
              <SessionIdentity session={session} timezone={timezone} />
              <Text
                accessibilityLabel={`${compact(session.tokens)} tokens`}
                style={[reportData, { fontWeight: '600' }]}
              >
                {compact(session.tokens)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

function SessionCoverage({
  provider,
  value,
}: {
  provider: Provider;
  value?: NonNullable<RecordsResponse['coverage']>[Provider];
}) {
  const text =
    value === 'unavailable'
      ? 'History unavailable for this period.'
      : value === 'none'
        ? 'No local records on this machine.'
        : value === 'partial'
          ? 'only part of this period is covered.'
          : value === 'stale'
            ? 'not collected after the failed refresh.'
            : null;
  return text ? (
    <ReportNotice warning={value === 'stale'} text={`${providerNames[provider]}: ${text}`} />
  ) : null;
}
