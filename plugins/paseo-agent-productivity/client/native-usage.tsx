import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type {
  Provider,
  Session,
  UsageCategoriesResponse,
  UsageFilters,
  UsageGroup,
} from '../shared/report-contracts.ts';
import { compactCount as compactNumber } from '../shared/reporting-chart-utils.ts';
import { colors } from '../shared/reporting-palette.ts';
import { NativeBuddy } from './native-hq-crew.tsx';
import {
  formatDay,
  formatInstant,
  int,
  measured,
  periodNotHappened,
  providerNames,
  providersInScope,
  reportCardStyle,
  usageScope,
} from './native-report-details.tsx';
import {
  hostQueryKey,
  ReportLoading,
  useDashboard,
  useDashboardQuery,
  useReportFilters,
} from './native-reporting.tsx';
import {
  linkLabels,
  ReportDisclosure,
  ReportIcon,
  ReportLinkBadge,
  ReportTable,
  ReportTableRow,
  ReportText,
  SessionIdentity,
  sessionName,
  type ReportColumn,
} from './native-session.tsx';
import { NativeSourceCoverage } from './native-sources.tsx';
import {
  NativeActions,
  NativeButton,
  NativeCard,
  NativeText,
  useDashboardLayout,
} from './native-ui.tsx';

const ROOTS_PAGE_SIZE = 15;
const count = (value: number, singular: string) =>
  `${int(value)} ${singular}${value === 1 ? '' : 's'}`;
const missingLinks = {
  repo_not_tracked: 'Repo not tracked, so PRs not checked',
  repo_unknown: 'No repo recorded, so PRs not checked',
  prs_not_collected: 'PRs for this repo aren’t collected yet',
} satisfies Record<Exclude<Session['linkStatus'], 'linked' | 'unlinked'>, string>;
const linkOrder = { evidence: 0, owner: 1, suggested: 2 } as const;

function usageColumns(expanded: boolean) {
  return [
    { label: 'Session', width: 224, flex: true },
    { label: 'Provider', width: expanded ? 104 : 70 },
    { label: 'Model', width: expanded ? 160 : 57 },
    { label: 'Started', width: expanded ? 123 : 70 },
    { label: 'Tokens', width: 82, right: true },
    { label: 'Linked PRs', width: expanded ? 194 : 92 },
  ] as const satisfies readonly ReportColumn[];
}

function mergeDay(instant: string, timezone: string) {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const value = (key: Intl.DateTimeFormatPartTypes) =>
    date.find((part) => part.type === key)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function Ledger({
  provider,
  categories,
  scope,
}: {
  provider: Provider;
  categories: UsageCategoriesResponse;
  scope: string;
}) {
  const codex = categories.codex;
  const claude = categories.claude;
  const data = categories[provider];
  const rows =
    provider === 'codex'
      ? [
          { label: 'Input', value: codex?.input },
          { label: 'Cached input', value: codex?.cachedInput, subset: 'included in input' },
          { label: 'Output', value: codex?.output },
          { label: 'Reasoning', value: codex?.reasoning, subset: 'included in output' },
        ]
      : [
          { label: 'Input (uncached)', value: claude?.inputUncached },
          { label: 'Cache write', value: claude?.cacheWrite },
          { label: 'Cache read', value: claude?.cacheRead },
          { label: 'Output', value: claude?.output },
        ];
  const coverage = data?.coverage;
  return (
    <View style={[reportCardStyle, { flex: 1, minWidth: 0 }]}>
      <View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <NativeBuddy provider={provider} size={15} />
            <NativeText heading size={16}>
              {providerNames[provider]}
            </NativeText>
          </View>
          {measured(coverage) && data?.sessions !== undefined && (
            <ReportText muted size={12}>
              {count(data.sessions, 'session')}
            </ReportText>
          )}
        </View>
        <ReportText muted size={12}>
          {scope}
        </ReportText>
      </View>
      {measured(coverage) ? (
        <>
          <View>
            {rows.map(({ label, value, subset }, index) => (
              <View
                key={label}
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  paddingLeft: subset ? 28 : 0,
                  paddingVertical: 6,
                  borderBottomColor: colors.border,
                  borderBottomWidth: index < rows.length - 1 && !rows[index + 1]?.subset ? 1 : 0,
                }}
              >
                {subset && (
                  <View
                    style={{
                      position: 'absolute',
                      left: 10,
                      top: 0,
                      width: 10,
                      height: 15,
                      borderLeftWidth: 1,
                      borderBottomWidth: 1,
                      borderBottomLeftRadius: 5,
                      borderColor: colors['border-strong'],
                    }}
                  />
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <ReportText muted={Boolean(subset)}>{label}</ReportText>
                  {subset && (
                    <ReportText size={12} muted>
                      {subset}
                    </ReportText>
                  )}
                </View>
                <ReportText muted={Boolean(subset)}>{int(value ?? 0)}</ReportText>
              </View>
            ))}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                gap: 12,
                paddingVertical: 6,
                borderTopWidth: 1,
                borderTopColor: colors['border-strong'],
              }}
            >
              <ReportText strong>Provider total</ReportText>
              <ReportText strong>{int(data?.total ?? 0)}</ReportText>
            </View>
          </View>
          <ReportText size={12} muted>
            {provider === 'codex'
              ? 'Total = input + output. Cached input and reasoning are subsets and aren’t added again.'
              : 'Total = uncached input + cache write + cache read + output (separate categories, none counted twice).'}
            {coverage === 'partial' &&
              data?.coveredFrom &&
              ` Covers ${formatDay(data.coveredFrom)} onward only.`}
            {coverage === 'stale' && ' Cached; recent days missing.'}
          </ReportText>
        </>
      ) : (
        <NativeText tone="foregroundMuted">
          {coverage === 'future'
            ? periodNotHappened
            : coverage === 'unavailable'
              ? 'History unavailable for this period.'
              : 'No local records on this machine.'}
        </NativeText>
      )}
    </View>
  );
}

type TreeColumns = ReturnType<typeof usageColumns> | undefined;

function LinkedPullRequests({ session, phone }: { session: Session; phone: boolean }) {
  const { bootstrap, changeFilters, navigate } = useDashboard();
  if (session.linkStatus === 'unlinked') return <ReportLinkBadge kind="unlinked" />;
  if (session.linkStatus !== 'linked') {
    return (
      <ReportText muted size={12}>
        {missingLinks[session.linkStatus]}
      </ReportText>
    );
  }
  return (
    <View style={{ gap: 2, minWidth: 0 }}>
      {[...session.linkedPrs]
        .sort((a, b) => linkOrder[a.class] - linkOrder[b.class])
        .map((pr) => (
          <Pressable
            key={pr.prId}
            accessibilityRole="link"
            accessibilityLabel={`#${pr.number} ${linkLabels[pr.class]}, view ${pr.repo} in Delivery`}
            onPress={() => {
              const day = mergeDay(pr.mergedAt, bootstrap.timezone);
              const range = { start: day, end: day };
              changeFilters({ range });
              changeFilters({ author: 'all' });
              navigate('delivery', { ...range, prId: pr.prId });
            }}
            style={({ pressed }) => ({
              minHeight: phone ? 44 : 22,
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 6,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <ReportText color={colors.action} strong>
              #{pr.number}
            </ReportText>
            <ReportLinkBadge kind={pr.class} />
          </Pressable>
        ))}
    </View>
  );
}

function SessionRow({
  session,
  columns,
  children = [],
  parentOutside = false,
  nested = false,
}: {
  session: Session;
  columns: TreeColumns;
  children?: Session[];
  parentOutside?: boolean;
  nested?: boolean;
}) {
  const { bootstrap } = useDashboard();
  const [expanded, setExpanded] = useState(false);
  const timezone = bootstrap.timezone;
  const phone = !columns;
  const details = [
    ...(children.length ? [count(children.length, 'child agent')] : []),
    ...(parentOutside ? ['parent outside current filters'] : []),
  ];
  const identity = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
        paddingLeft: columns ? (nested ? 52 : 24) : nested ? 14 : 0,
      }}
    >
      {children.length > 0 ? (
        <ReportDisclosure
          label={`${expanded ? 'Hide' : 'Show'} ${count(children.length, 'child agent')} of ${sessionName(session)}, ${session.providerSessionRef}`}
          open={expanded}
          onPress={() => setExpanded(!expanded)}
          compact={phone}
        />
      ) : (
        <View style={{ width: 24 }} />
      )}
      <View style={{ paddingTop: 2 }}>
        <NativeBuddy
          provider={session.kind === 'unknown' ? 'other' : session.provider}
          size={session.kind === 'root' ? 16 : 13}
        />
      </View>
      <SessionIdentity session={session} timezone={timezone} details={details} showMeta={phone} />
    </View>
  );
  const tokens = <ReportText right={Boolean(columns)}>{compactNumber(session.tokens)}</ReportText>;
  const linked = <LinkedPullRequests session={session} phone={phone} />;
  return (
    <>
      {columns ? (
        <ReportTableRow
          columns={columns}
          cells={[
            identity,
            <ReportText>{providerNames[session.provider]}</ReportText>,
            <ReportText size={12} mono>
              {session.model ?? '—'}
            </ReportText>,
            <ReportText>{formatInstant(session.startedAt, timezone)}</ReportText>,
            tokens,
            linked,
          ]}
        />
      ) : (
        <View
          style={{
            paddingVertical: 8,
            paddingLeft: nested ? 8 : 0,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            gap: 4,
          }}
        >
          {identity}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
              <ReportText size={12} muted>
                Tokens
              </ReportText>
              {tokens}
            </View>
            <View
              style={{
                flex: 1,
                minWidth: 0,
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <ReportText size={12} muted>
                Linked PRs
              </ReportText>
              {linked}
            </View>
          </View>
        </View>
      )}
      {expanded &&
        children.map((child) => (
          <SessionRow key={child.id} session={child} columns={columns} nested />
        ))}
    </>
  );
}

function GroupRoots({
  groupKey,
  parameters,
  columns,
}: {
  groupKey: string;
  parameters: UsageFilters;
  columns: TreeColumns;
}) {
  const { hostId, request } = useDashboard();
  const [showUnknown, setShowUnknown] = useState(false);
  const query = { ...parameters, groupKey, limit: ROOTS_PAGE_SIZE };
  const sessions = useInfiniteQuery({
    queryKey: [...hostQueryKey(hostId), 'usageRoots', query],
    queryFn: ({ pageParam }) =>
      request('usageRoots', {
        ...query,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  if (!sessions.data) {
    return (
      <View style={{ padding: 10 }}>
        <ReportLoading
          label="sessions"
          error={sessions.error}
          retry={() => void sessions.refetch()}
        />
      </View>
    );
  }
  const { pages } = sessions.data;
  const unknown = pages[0]?.unknownRelationship ?? [];
  const orphans = pages[0]?.orphans ?? [];
  const more = pages.at(-1)?.remaining ?? 0;
  const unknownHeading = (
    <View style={{ flexDirection: 'row', gap: 6, paddingLeft: columns ? 24 : 0 }}>
      <ReportDisclosure
        label={`${showUnknown ? 'Hide' : 'Show'} sessions with unknown relationship`}
        open={showUnknown}
        onPress={() => setShowUnknown(!showUnknown)}
        compact={!columns}
      />
      <View style={{ flex: 1 }}>
        <ReportText strong>Unknown relationship ({int(unknown.length)})</ReportText>
        <ReportText muted size={12}>
          Parent not recorded, so these aren’t counted as roots or children
        </ReportText>
      </View>
    </View>
  );
  return (
    <View>
      {sessions.error && !sessions.isFetchNextPageError && (
        <ReportLoading
          label="sessions"
          error={sessions.error}
          retry={() => void sessions.refetch()}
        />
      )}
      {pages
        .flatMap((page) => page.roots ?? [])
        .map((root) => (
          <SessionRow key={root.id} session={root} children={root.children} columns={columns} />
        ))}
      {sessions.isFetchNextPageError && (
        <ReportLoading
          label="more sessions"
          error={sessions.error}
          retry={() => void sessions.fetchNextPage()}
        />
      )}
      {sessions.hasNextPage && !sessions.isFetchNextPageError && (
        <View
          style={{
            padding: 8,
            paddingLeft: columns ? 34 : 8,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          <NativeActions>
            <NativeButton
              label={
                sessions.isFetchingNextPage
                  ? 'Loading…'
                  : `Show ${count(Math.min(more, ROOTS_PAGE_SIZE), 'more root')}`
              }
              disabled={sessions.isFetching}
              onPress={() => void sessions.fetchNextPage()}
            />
            <ReportText muted size={12}>
              {int(more)} not shown
            </ReportText>
          </NativeActions>
        </View>
      )}
      {orphans.map((orphan) => (
        <SessionRow key={orphan.id} session={orphan} columns={columns} parentOutside />
      ))}
      {unknown.length > 0 && (
        <>
          {columns ? (
            <ReportTableRow columns={columns} cells={[unknownHeading]} fill />
          ) : (
            <View style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
              {unknownHeading}
            </View>
          )}
          {showUnknown &&
            unknown.map((session) => (
              <SessionRow key={session.id} session={session} columns={columns} nested />
            ))}
        </>
      )}
    </View>
  );
}

function Group({
  group,
  groupKey,
  providers,
  data,
  parameters,
  columns,
  expanded,
  toggle,
  first,
}: {
  group: UsageGroup;
  groupKey: string;
  providers: Provider[];
  data?: UsageCategoriesResponse;
  parameters: UsageFilters;
  columns: TreeColumns;
  expanded: boolean;
  toggle(): void;
  first: boolean;
}) {
  const label = group.label ?? groupKey;
  const summary = (
    <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
      {(group.sessions ?? 0) > 0 ? (
        <ReportDisclosure
          label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
          open={expanded}
          onPress={toggle}
          compact={!columns}
        />
      ) : (
        <View style={{ width: 24 }} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <ReportText strong>{label}</ReportText>
        <ReportText size={12} muted>
          {count(group.roots ?? 0, 'root')} · {count(group.sessions ?? 0, 'session')}
          {group.note ? ` · ${group.note}` : ''}
        </ReportText>
      </View>
    </View>
  );
  const tokenStack = (
    <View style={{ alignItems: 'flex-end', gap: 2 }}>
      {providers.map((provider) => {
        const tokens = compactNumber(
          data && !measured(data[provider]?.coverage)
            ? null
            : (group.tokens?.[provider] ?? (data ? 0 : null)),
        );
        return (
          <View key={provider} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <NativeBuddy provider={provider} size={15} />
            <ReportText accessibilityLabel={`${providerNames[provider]}: ${tokens}`}>
              {tokens}
            </ReportText>
          </View>
        );
      })}
    </View>
  );
  return (
    <>
      {columns ? (
        <ReportTableRow columns={columns} cells={[summary, null, null, null, tokenStack]} fill />
      ) : (
        <View
          style={{
            paddingTop: first ? 0 : 8,
            paddingBottom: 8,
            borderTopWidth: first ? 0 : 1,
            borderTopColor: colors.border,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              gap: 6,
              padding: 8,
              backgroundColor: colors.canvas,
              borderRadius: 6,
            }}
          >
            {summary}
            {tokenStack}
          </View>
        </View>
      )}
      {expanded && <GroupRoots groupKey={groupKey} parameters={parameters} columns={columns} />}
    </>
  );
}

function UsageNotice({ text, warning }: { text: string; warning?: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 8,
        alignItems: 'flex-start',
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: warning ? colors['warning-surface'] : colors['surface-sunken'],
      }}
    >
      {warning && <ReportIcon name="alert" color={colors.warning} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <ReportText size={12}>{text}</ReportText>
      </View>
    </View>
  );
}

export function NativeUsage({ compact = true }: { compact?: boolean }) {
  const { filters, navigate } = useDashboard();
  const { width: viewportWidth } = useDashboardLayout();
  const [width, setWidth] = useState(0);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const phone = viewportWidth ? viewportWidth < 640 : compact;
  const columns = phone ? undefined : usageColumns(expandedGroups.size > 0);
  const scope = usageScope(filters);
  const { start, end, repos, provider } = useReportFilters();
  const parameters: UsageFilters = { start, end, provider, ...(repos ? { repos } : {}) };
  const categories = useDashboardQuery('usageCategories', parameters);
  const data = categories.data;
  const noRecords =
    provider === 'all' && data?.codex?.coverage === 'none' && data.claude?.coverage === 'none';
  const groups = useDashboardQuery('usageGroups', parameters, { enabled: !noRecords });
  const providers = providersInScope(provider);
  const history = providers.flatMap((id) => {
    const from = data?.[id]?.coveredFrom;
    return from && start < from ? [`${providerNames[id]} from ${formatDay(from)}`] : [];
  });
  const rows = (groups.data?.groups ?? []).flatMap((group, index) =>
    group.key ? (
      <Group
        key={group.key}
        group={group}
        groupKey={group.key}
        data={data}
        providers={providers}
        parameters={parameters}
        columns={columns}
        expanded={expandedGroups.has(group.key)}
        toggle={() => {
          const key = group.key;
          if (!key) return;
          setExpandedGroups((previous) => {
            const next = new Set(previous);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
        }}
        first={index === 0}
      />
    ) : (
      []
    ),
  );

  return (
    <View
      style={{ gap: 16 }}
      onLayout={({ nativeEvent }) => setWidth(Math.floor(nativeEvent.layout.width))}
    >
      <NativeSourceCoverage compact={compact} pill={width >= 900} />
      {noRecords ? (
        <NativeCard title="No session detail on this machine">
          <NativeText tone="foregroundMuted">
            No supported Codex, Claude Code or Paseo records were found here. Account-reported
            totals appear on Overview, but they can’t be broken down by repo, session, agent or PR.
          </NativeText>
          <NativeActions>
            <NativeButton
              label="View account-reported usage"
              onPress={() => navigate('overview')}
            />
            <NativeButton label="Check sources" onPress={() => navigate('sources')} />
          </NativeActions>
        </NativeCard>
      ) : (
        <>
          {history.length > 0 && (
            <UsageNotice text={`Local history starts later · ${history.join(' · ')}`} />
          )}
          {repos && (
            <UsageNotice text="The repository filter excludes local usage with no matching repo." />
          )}
          {data?.paseoNote && <UsageNotice warning text={data.paseoNote} />}
          {(categories.error || !data) && (
            <ReportLoading
              label="usage"
              error={categories.error}
              retry={() => void categories.refetch()}
            />
          )}
          {data && (
            <View style={{ flexDirection: viewportWidth >= 1024 ? 'row' : 'column', gap: 16 }}>
              {providers.map((id) => (
                <Ledger key={id} provider={id} categories={data} scope={scope} />
              ))}
            </View>
          )}
          <NativeCard title="Sessions by repository">
            <ReportText muted size={12}>
              {scope} · Repo → root session → child agents, where relationships are recorded. Paseo
              adds agent and workspace identity to provider sessions; it isn’t counted as extra
              usage.
            </ReportText>
            {(groups.error || !groups.data) && (
              <ReportLoading
                label="repository groups"
                error={groups.error}
                retry={() => void groups.refetch()}
              />
            )}
            {groups.data?.groups?.length === 0 && (
              <NativeText tone="foregroundMuted">No sessions in scope.</NativeText>
            )}
            {rows.length > 0 &&
              (columns ? (
                <ReportTable label="Usage by repository" width={width - 34} columns={columns}>
                  {rows}
                </ReportTable>
              ) : (
                <View>{rows}</View>
              ))}
          </NativeCard>
        </>
      )}
    </View>
  );
}
