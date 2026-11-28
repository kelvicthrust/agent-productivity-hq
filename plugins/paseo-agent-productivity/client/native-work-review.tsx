import { copyText, Icon, Modal } from '@getpaseo/plugin/client/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { WorkReviewEvidence, WorkReviewVersion } from '../shared/report-contracts.ts';
import { formatRange } from '../shared/reporting-dates.ts';
import { filtersQuery, periodOf, type Filters } from '../shared/reporting-filters.ts';
import { colors } from '../shared/reporting-palette.ts';
import type { NativeRequest } from './native-api.ts';
import { PullRequestTitle } from './native-delivery.tsx';
import {
  deliveryScope,
  formatInstant,
  ReportSegments,
  usageScope,
} from './native-report-details.tsx';
import { hostQueryKey, ReportLoading, useDashboard } from './native-reporting.tsx';
import {
  cardShadow,
  NativeActions,
  NativeAppearance,
  NativeButton,
  NativeCard,
  NativeProblem,
  NativeRow,
  NativeText,
  useColors,
  useDashboardLayout,
} from './native-ui.tsx';

const sections = [
  ['shipped', 'Shipped'],
  ['team', 'Team merges'],
  ['progress', 'Other progress'],
  ['open', 'Still open'],
] as const;

type EvidenceContext = { hostId: string; request: NativeRequest };

function reviewScope(filters: Filters) {
  const { start, end, repos, provider, author } = filtersQuery(filters);
  return { start, end, ...(repos ? { repos } : {}), provider, author };
}

function useReview(version?: number) {
  const { hostId, request, filters, bootstrap } = useDashboard();
  const query = { ...reviewScope(filters), ...(version === undefined ? {} : { version }) };
  const followWeekly =
    version === undefined &&
    periodOf(filters, bootstrap) === 'this-week' &&
    filters.author === 'mine' &&
    filters.provider === 'all' &&
    filters.repos.length === 0;
  return useQuery({
    queryKey: [...hostQueryKey(hostId), 'workReview', query],
    queryFn: () => request('workReview', query),
    retry: false,
    refetchInterval: ({ state }) =>
      version === undefined && state.data?.status === 'running'
        ? 1_500
        : followWeekly && state.data
          ? 5 * 60_000
          : false,
  });
}

function EvidenceRow({ item, context }: { item: WorkReviewEvidence; context: EvidenceContext }) {
  const [open, setOpen] = useState(false);
  const { hostId, request } = context;
  const pullRequest = useQuery({
    queryKey: [...hostQueryKey(hostId), 'prDetail', { prId: item.id }],
    queryFn: () => request('prDetail', { prId: item.id }),
    enabled: open && item.kind === 'pr',
    retry: false,
  });
  return (
    <View style={{ gap: 4 }}>
      <NativeButton label={item.label} expanded={open} onPress={() => setOpen(!open)} />
      {open && (
        <NativeRow>
          <NativeText tone="foregroundMuted">
            {[
              item.kind === 'pr' ? 'Merged pull request' : 'Local session',
              item.repo,
              formatRange(item.date, item.date),
            ]
              .filter(Boolean)
              .join(' · ')}
          </NativeText>
          {item.notes?.map((note, index) => (
            <NativeText key={index}>• {note}</NativeText>
          ))}
          {item.kind === 'pr' &&
            (pullRequest.data?.pr ? (
              <PullRequestTitle pr={pullRequest.data.pr} />
            ) : (
              <ReportLoading
                label="pull request"
                error={pullRequest.error}
                retry={() => void pullRequest.refetch()}
              />
            ))}
        </NativeRow>
      )}
    </View>
  );
}

function ReviewReport({
  review,
  context,
  timezone,
}: {
  review: WorkReviewVersion;
  context: EvidenceContext;
  timezone?: string;
}) {
  function evidence(items: WorkReviewEvidence[]) {
    return items.map((item) => (
      <EvidenceRow key={`${item.kind}-${item.id}-${item.date}`} item={item} context={context} />
    ));
  }

  return (
    <View style={{ gap: 12 }}>
      {timezone && (
        <NativeText tone="foregroundMuted">
          Version {review.version} · Saved {formatInstant(review.createdAt, timezone)}
        </NativeText>
      )}
      <NativeText heading>{review.headline}</NativeText>
      {evidence(review.headlineEvidence)}
      {sections.map(([kind, title]) => {
        const bullets = review.bullets.filter((bullet) => bullet.kind === kind);
        if (!bullets.length) return null;
        return (
          <NativeRow key={kind}>
            <NativeText heading>{title}</NativeText>
            {bullets.map((bullet, index) => (
              <View key={index} style={{ gap: 4 }}>
                <NativeText>• {bullet.text}</NativeText>
                {evidence(bullet.evidence)}
              </View>
            ))}
          </NativeRow>
        );
      })}
      {review.coverage.length > 0 && (
        <NativeRow>
          <NativeText heading>Source coverage</NativeText>
          {review.coverage.map((note, index) => (
            <NativeText key={index}>• {note}</NativeText>
          ))}
        </NativeRow>
      )}
    </View>
  );
}

function CopyReview({ review, range }: { review: WorkReviewVersion; range: string }) {
  const [copy, setCopy] = useState<'ready' | 'done' | 'failed'>('ready');
  const text = [
    `Work Review · ${range}`,
    review.headline,
    ...sections.flatMap(([kind, title]) => {
      const bullets = review.bullets.filter((bullet) => bullet.kind === kind);
      return bullets.length
        ? [[title, ...bullets.map((bullet) => `- ${bullet.text}`)].join('\n')]
        : [];
    }),
  ].join('\n\n');

  async function copyUpdate() {
    try {
      await copyText(text);
      setCopy('done');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <>
      <NativeButton label="Copy update" onPress={() => void copyUpdate()} />
      {copy === 'done' && <NativeText announce>Copied to clipboard.</NativeText>}
      {copy === 'failed' && (
        <View style={{ gap: 4 }}>
          <NativeText announce>
            Clipboard access is unavailable. Select the update to copy it.
          </NativeText>
          <Text selectable style={{ color: colors.text }}>
            {text}
          </Text>
        </View>
      )}
    </>
  );
}

function ReviewContent({
  result,
  context,
  timezone,
  latest = true,
}: {
  result: ReturnType<typeof useReview>;
  context: EvidenceContext;
  timezone?: string;
  latest?: boolean;
}) {
  const state = result.data;
  return (
    <>
      {(!state || result.isError) && (
        <ReportLoading
          label="work review"
          error={result.error}
          retry={() => void result.refetch()}
        />
      )}
      {latest && state?.status === 'failed' && (
        <NativeProblem message={state.message ?? 'The work review couldn’t be generated.'} />
      )}
      {state?.review ? (
        <ReviewReport
          key={state.review.version}
          review={state.review}
          context={context}
          timezone={timezone}
        />
      ) : state?.status === 'running' ? (
        <NativeText announce>Generating the work review…</NativeText>
      ) : state?.status === 'idle' ? (
        <NativeText tone="foregroundMuted">No review has been saved for this scope.</NativeText>
      ) : null}
    </>
  );
}

export function NativeWorkReviewPreview() {
  const context = useDashboard();
  const { filters, bootstrap, navigate } = context;
  const result = useReview();
  const [open, setOpen] = useState(false);
  const theme = useColors();
  const layout = useDashboardLayout();
  const review = result.data?.review;
  const range = formatRange(filters.start, filters.end);
  const period = periodOf(filters, bootstrap);
  const title =
    period === 'today'
      ? 'Daily work review'
      : period.endsWith('week')
        ? 'Weekly work review'
        : period.endsWith('month')
          ? 'Monthly work review'
          : 'Work review';
  const summary =
    review?.headline ??
    (result.isError || result.data?.status === 'failed'
      ? 'The work review couldn’t be loaded or generated.'
      : result.isPending
        ? 'Loading the work review…'
        : result.data?.status === 'running'
          ? 'Generating the work review…'
          : 'No review has been saved for this scope.');
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Work Review, ${summary}`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          ...cardShadow,
          backgroundColor: pressed ? colors['surface-sunken'] : colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 8,
          padding: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <NativeText heading size={16}>
            Work Review
          </NativeText>
          <Text numberOfLines={2} style={{ color: colors['text-muted'] }}>
            {summary}
          </Text>
        </View>
        <Icon name="ChevronRight" size={19} color={colors.action} />
      </Pressable>
      {open && (
        <Modal title={title} open onOpenChange={setOpen}>
          <Modal.Content
            style={{ backgroundColor: theme.surface1 }}
            contentContainerStyle={{ gap: 12 }}
          >
            <NativeAppearance colors={theme} layout={layout}>
              <NativeText tone="foregroundMuted">{range}</NativeText>
              <ReviewContent result={result} context={context} />
              <NativeActions>
                <NativeButton
                  label="View saved reviews"
                  onPress={() => {
                    setOpen(false);
                    navigate('work-review');
                  }}
                />
                {review && <CopyReview key={review.version} review={review} range={range} />}
              </NativeActions>
            </NativeAppearance>
          </Modal.Content>
        </Modal>
      )}
    </>
  );
}

export function NativeWorkReview() {
  const { filters } = useDashboard();
  return <ReviewScope key={JSON.stringify(reviewScope(filters))} />;
}

function ReviewScope() {
  const context = useDashboard();
  const { filters, bootstrap } = context;
  const [version, setVersion] = useState<number>();
  const result = useReview(version);
  const { review, versions = [], changed, status, locked } = result.data ?? {};
  const options = versions.length ? versions : version === undefined ? [] : [version];
  return (
    <NativeCard title="Work Review">
      <NativeText tone="foregroundMuted">
        PRs: {deliveryScope(filters)} · Sessions: {usageScope(filters)}
      </NativeText>
      {(options.length > 1 || version !== undefined) && (
        <ReportSegments
          label="Review version"
          value={version === undefined ? 'latest' : String(version)}
          options={[
            { value: 'latest', label: 'Latest version' },
            ...options.map((value) => ({ value: String(value), label: `Version ${value}` })),
          ]}
          onChange={(value) => setVersion(value === 'latest' ? undefined : Number(value))}
        />
      )}
      {review && (
        <CopyReview
          key={review.version}
          review={review}
          range={formatRange(filters.start, filters.end)}
        />
      )}
      {review && changed && status === 'idle' && version === undefined && (
        <NativeText announce tone="foregroundMuted">
          {locked
            ? 'New evidence is available for this closed period.'
            : 'New evidence is available for this period.'}
        </NativeText>
      )}
      <ReviewContent
        result={result}
        context={context}
        timezone={bootstrap.timezone}
        latest={version === undefined}
      />
    </NativeCard>
  );
}
