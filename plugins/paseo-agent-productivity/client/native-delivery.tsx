import * as paseo from '@getpaseo/plugin/client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type {
  EvidenceItem,
  LinkAction,
  LinkDecision,
  PullRequest,
  Session,
} from '../shared/report-contracts.ts';
import { colors } from '../shared/reporting-palette.ts';
import { NativeRequestError, useNativeAction } from './native-api.ts';
import { NativeBuddy } from './native-hq-crew.tsx';
import {
  deliveryScope,
  formatInstant,
  int,
  noTrackedRepos,
  periodNotHappened,
  providerNames,
  ReportNotice,
} from './native-report-details.tsx';
import {
  hostQueryKey,
  ReportLoading,
  useDashboard,
  useDashboardQuery,
  useRefreshDashboardData,
  useReportFilters,
} from './native-reporting.tsx';
import {
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
import {
  NativeActions,
  NativeButton,
  NativeCard,
  NativeInput,
  NativeProblem,
  NativeRow,
  NativeText,
  useDashboardLayout,
} from './native-ui.tsx';

const linkFilters = {
  all: 'All',
  evidence: 'Evidence',
  owner: 'Owner-confirmed',
  suggested: 'Suggested only',
  unlinked: 'Unlinked',
} as const;
type LinkFilter = keyof typeof linkFilters;
type Action = LinkAction | 'add';
const actionLabels: Record<Action, string> = {
  confirm: 'Confirm link',
  dismiss: 'Dismiss',
  reject: 'Mark incorrect',
  restore: 'Restore',
  remove: 'Remove link',
  add: 'Add link',
};
const actionMessages: Record<Action, string> = {
  confirm: 'Link confirmed and labeled Owner-confirmed.',
  dismiss: 'Suggestion dismissed.',
  reject: 'Marked incorrect. The source’s claim is kept but not counted.',
  restore: 'Evidence link restored.',
  remove: 'Your link was removed.',
  add: 'Session linked and labeled Owner-confirmed.',
};
const decisions: Record<Action, LinkDecision | null> = {
  confirm: 'confirmed',
  add: 'confirmed',
  dismiss: 'dismissed',
  reject: 'rejected',
  restore: null,
  remove: null,
};

interface LinkChange {
  prId: string;
  sessionId: number;
  decision: LinkDecision | null;
}

type PerformAction = (
  action: Action,
  prId: string,
  sessionId: number,
  evidence?: EvidenceItem,
) => void;

const PAGE_SIZE = 50;
const UNDO_MS = 8000;
const columns = [
  { label: 'Pull request', width: 256, flex: true },
  { label: 'Merged', width: 123 },
  { label: 'Author', width: 64 },
  { label: 'Merged by', width: 84 },
  { label: 'Linked sessions', width: 176 },
  { label: 'Link basis', width: 164 },
] as const satisfies readonly ReportColumn[];

function priorDecision(evidence?: EvidenceItem): LinkDecision | null {
  if (evidence?.effectiveClass === 'owner') return 'confirmed';
  if (evidence?.effectiveClass === 'rejected') return 'rejected';
  return null;
}

function useLinkActions() {
  const { request } = useDashboard();
  const refresh = useRefreshDashboardData();
  const action = useNativeAction();
  const [feedback, setFeedback] = useState<{ text: string; previous?: LinkChange }>();

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(undefined), feedback.previous ? UNDO_MS : 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  async function save({ prId, sessionId, decision }: LinkChange) {
    if (decision === null) {
      await request('prLinkRemove', { prId, sessionId });
    } else {
      await request('prLinkSet', { prId, sessionId, decision });
    }
    await refresh();
  }

  const perform: PerformAction = (verb, prId, sessionId, evidence) => {
    void action.run(async (signal) => {
      await save({ prId, sessionId, decision: decisions[verb] });
      if (!signal.aborted) {
        setFeedback({
          text: actionMessages[verb],
          previous: { prId, sessionId, decision: priorDecision(evidence) },
        });
      }
    });
  };

  function undo() {
    const previous = feedback?.previous;
    if (!previous) return;
    void action.run(async (signal) => {
      await save(previous);
      if (!signal.aborted) setFeedback({ text: 'Change undone.' });
    });
  }

  return { ...action, feedback, perform, undo };
}

export function PullRequestTitle({ pr }: { pr: PullRequest }) {
  const open = useNativeAction();
  let href: string | undefined;
  try {
    const target = new URL(pr.url);
    if (
      target.protocol === 'https:' &&
      target.origin === 'https://github.com' &&
      !target.username &&
      !target.password
    ) {
      href = target.href;
    }
  } catch {
    // A malformed URL has no external action.
  }
  const title = <ReportText strong>{pr.title}</ReportText>;
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      {href ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${pr.title} (opens GitHub)`}
          disabled={open.busy}
          onPress={() =>
            void open.run(async () => {
              try {
                await paseo.openExternalUrl(href);
              } catch {
                throw new NativeRequestError('open-failed', 'Couldn’t open GitHub. Try again.');
              }
            })
          }
          hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 4,
            alignSelf: 'flex-start',
            opacity: pressed ? 0.65 : 1,
            maxWidth: '100%',
          })}
        >
          <View style={{ flexShrink: 1 }}>{title}</View>
          <ReportIcon name="external" size={12} />
        </Pressable>
      ) : (
        title
      )}
      <ReportText size={12} muted>
        {pr.repo} #{pr.number}
      </ReportText>
      <NativeProblem message={open.problem} />
    </View>
  );
}

function CandidateList({
  pr,
  sessions,
  timezone,
  busy,
  perform,
}: {
  pr: PullRequest;
  sessions: Session[];
  timezone: string;
  busy: boolean;
  perform: PerformAction;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <NativeActions>
        <NativeButton label={open ? 'Close' : 'Link a session'} onPress={() => setOpen(!open)} />
      </NativeActions>
      {open && (
        <>
          <NativeText>Session in {pr.repo}, up to 3 days before the merge</NativeText>
          <NativeText tone="foregroundMuted">
            Your link is labeled Owner-confirmed and can be removed later. It doesn’t change what
            the source recorded.
          </NativeText>
          {sessions.map((session) => (
            <NativeRow key={session.id}>
              <SessionIdentity session={session} timezone={timezone} />
              <NativeText>Session tokens: {int(session.tokens)}</NativeText>
              <NativeActions>
                <NativeButton
                  label="Add link"
                  accessibilityLabel={`Add link for ${sessionName(session)}, ${session.providerSessionRef}`}
                  disabled={busy}
                  onPress={() => perform('add', pr.id, session.id)}
                />
              </NativeActions>
            </NativeRow>
          ))}
        </>
      )}
    </View>
  );
}

function PullRequestDetail({
  prId,
  timezone,
  busy,
  perform,
  showPr = false,
}: {
  prId: string;
  timezone: string;
  busy: boolean;
  perform: PerformAction;
  showPr?: boolean;
}) {
  const detail = useDashboardQuery('prDetail', { prId });
  const pr = detail.data?.pr;
  if (!pr) {
    return (
      <ReportLoading
        label="link evidence"
        error={detail.error}
        retry={() => void detail.refetch()}
      />
    );
  }
  const evidence = detail.data?.evidence ?? [];
  const candidates = detail.data?.candidates ?? [];
  return (
    <View style={{ gap: 12, padding: 12, borderRadius: 8, backgroundColor: colors.canvas }}>
      {showPr && (
        <>
          <PullRequestTitle pr={pr} />
          <NativeText tone="foregroundMuted">{formatInstant(pr.mergedAt, timezone)}</NativeText>
        </>
      )}
      <NativeText heading size={16}>
        Link evidence
      </NativeText>
      {detail.error && (
        <ReportLoading
          label="link evidence"
          error={detail.error}
          retry={() => void detail.refetch()}
        />
      )}
      {evidence.length === 0 && (
        <NativeText tone="foregroundMuted">
          {!pr.authoredByMe && pr.author
            ? `Authored by ${pr.author}. No sessions from this machine are linked.`
            : candidates.length > 0
              ? 'No session evidence found for this PR. You can link a session yourself.'
              : 'No session evidence found for this PR. No local sessions were recorded in this repo in the 3 days before the merge.'}
        </NativeText>
      )}
      {evidence.map((item) => (
        <NativeRow key={item.session.id}>
          <SessionIdentity session={item.session} timezone={timezone} />
          <ReportText>Session tokens: {int(item.session.tokens)}</ReportText>
          <ReportLinkBadge kind={item.effectiveClass} />
          <NativeText tone="foregroundMuted">Basis: {item.basisText}</NativeText>
          <NativeActions>
            {item.actions.map((verb) => (
              <NativeButton
                key={verb}
                label={actionLabels[verb]}
                accessibilityLabel={`${actionLabels[verb]} for ${sessionName(item.session)}, ${item.session.providerSessionRef}`}
                disabled={busy}
                primary={verb === 'confirm'}
                onPress={() => perform(verb, pr.id, item.session.id, item)}
              />
            ))}
          </NativeActions>
        </NativeRow>
      ))}
      {candidates.length > 0 && (
        <CandidateList
          pr={pr}
          sessions={candidates}
          timezone={timezone}
          busy={busy}
          perform={perform}
        />
      )}
      {evidence.length > 0 && (
        <NativeText tone="foregroundMuted" size={13}>
          A linked session is recorded evidence of involvement, not proof it produced the PR alone.
          Token counts belong to each session and stay on the dates they were used.
        </NativeText>
      )}
    </View>
  );
}

function LinkedSessions({ pr, right }: { pr: PullRequest; right: boolean }) {
  const { linkedSessionCount, suggestedCount } = pr;
  if (!linkedSessionCount) {
    return (
      <ReportText size={12} muted right={right} singleLine={!right}>
        {suggestedCount ? `${int(suggestedCount)} suggested` : 'None'}
      </ReportText>
    );
  }
  return (
    <View style={{ alignItems: right ? 'flex-end' : 'flex-start' }}>
      {pr.providers.map((provider) => (
        <View key={provider} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <NativeBuddy provider={provider} size={13} />
          <ReportText>{providerNames[provider]}</ReportText>
        </View>
      ))}
      <ReportText size={12} muted right={right}>
        {int(linkedSessionCount)} {linkedSessionCount === 1 ? 'session' : 'sessions'}
        {suggestedCount > 0 && ` · +${int(suggestedCount)} suggested`}
      </ReportText>
    </View>
  );
}

function PullRequestRow({
  pr,
  timezone,
  open,
  toggle,
  busy,
  perform,
  phone,
  login,
  first,
}: {
  pr: PullRequest;
  timezone: string;
  open: boolean;
  toggle(): void;
  busy: boolean;
  perform: PerformAction;
  phone: boolean;
  login?: string | null;
  first: boolean;
}) {
  const title = (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
      <ReportDisclosure
        label={`${open ? 'Hide' : 'Show'} link evidence for ${pr.title}`}
        open={open}
        onPress={toggle}
        compact={phone}
      />
      <PullRequestTitle pr={pr} />
    </View>
  );
  const cells = [
    <ReportText right={phone}>{formatInstant(pr.mergedAt, timezone)}</ReportText>,
    <ReportText right={phone}>{pr.authoredByMe ? 'You' : (pr.author ?? '—')}</ReportText>,
    <ReportText right={phone}>
      {pr.mergedBy && pr.mergedBy.toLowerCase() === login?.toLowerCase()
        ? 'You'
        : (pr.mergedBy ?? '—')}
    </ReportText>,
    <LinkedSessions pr={pr} right={phone} />,
    <ReportLinkBadge kind={pr.linkClass} />,
  ];
  const detail = open && (
    <PullRequestDetail prId={pr.id} timezone={timezone} busy={busy} perform={perform} />
  );
  if (!phone) {
    return (
      <>
        <ReportTableRow columns={columns} cells={[title, ...cells]} />
        {detail && (
          <View role="row">
            <View role="cell">{detail}</View>
          </View>
        )}
      </>
    );
  }
  return (
    <View
      style={{
        gap: 8,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.border,
        paddingTop: first ? 0 : 12,
        paddingBottom: 12,
      }}
    >
      {title}
      <View style={{ paddingLeft: 30, gap: 4 }}>
        {columns.slice(1).map((column, index) => (
          <View
            key={column.label}
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <ReportText size={12} muted>
              {column.label}
            </ReportText>
            <View style={{ flexShrink: 1, alignItems: 'flex-end', minWidth: 0 }}>
              {cells[index]}
            </View>
          </View>
        ))}
      </View>
      {detail}
    </View>
  );
}

export function NativeDelivery({ compact = true }: { compact?: boolean }) {
  const { hostId, request, filters, navigate, drill, bootstrap } = useDashboard();
  const { width: viewportWidth } = useDashboardLayout();
  const [width, setWidth] = useState(0);
  const phone = viewportWidth ? viewportWidth < 640 : compact;
  const { start, end, repos, author, timezone } = useReportFilters();
  const focusedPr = drill?.prId;
  const [open, setOpen] = useState<Set<string>>(() => new Set(focusedPr ? [focusedPr] : []));
  const [linkClass, setLinkClass] = useState<LinkFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(searchText.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchText]);
  const parameters = {
    start,
    end,
    author,
    linkClass,
    limit: PAGE_SIZE,
    ...(repos ? { repos } : {}),
    ...(q ? { q } : {}),
  };
  const activeRepos = useDashboardQuery('repos');
  const links = useLinkActions();
  const prs = useInfiniteQuery({
    queryKey: [...hostQueryKey(hostId), 'prs', parameters],
    queryFn: ({ pageParam }) =>
      request('prs', {
        ...parameters,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const pages = prs.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items ?? []);
  const headline = pages[0];
  const total = q ? undefined : headline?.counts?.[linkClass];
  const remaining = total === undefined ? null : Math.max(0, total - items.length);
  const inaccessible = headline?.inaccessibleRepos ?? [];
  const noRepos = Array.isArray(activeRepos.data?.active) && activeRepos.data.active.length === 0;
  const showFocused = focusedPr && open.has(focusedPr) && !items.some((pr) => pr.id === focusedPr);
  const rows = items.map((pr, index) => (
    <PullRequestRow
      key={pr.id}
      pr={pr}
      timezone={timezone}
      open={open.has(pr.id)}
      toggle={() => toggle(pr.id)}
      busy={links.busy}
      perform={links.perform}
      phone={phone}
      login={bootstrap.githubLogin}
      first={index === 0}
    />
  ));

  function toggle(id: string) {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!activeRepos.data) {
    return (
      <ReportLoading
        label="tracked repositories"
        error={activeRepos.error}
        retry={() => void activeRepos.refetch()}
      />
    );
  }

  if (noRepos) {
    return (
      <NativeCard title={noTrackedRepos}>
        <NativeText>
          Choose the repositories whose merged pull requests you want to track.
        </NativeText>
        <NativeActions>
          <NativeButton label="Manage sources & repos" onPress={() => navigate('sources')} />
        </NativeActions>
      </NativeCard>
    );
  }

  return (
    <View
      style={{ gap: 16 }}
      onLayout={({ nativeEvent }) => setWidth(Math.floor(nativeEvent.layout.width))}
    >
      {headline?.linkHealth.state === 'stale' && (
        <ReportNotice
          warning
          text="Pull request links are out of date. Showing the last successful rebuild."
        />
      )}
      {headline?.linkHealth.state === 'unavailable' && (
        <ReportNotice
          warning
          text="Links between pull requests and agent sessions haven’t been calculated yet. Imported pull requests can still appear."
        />
      )}
      {inaccessible.length > 0 && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 8,
            backgroundColor: colors['warning-surface'],
          }}
        >
          <ReportIcon name="alert" color={colors.warning} />
          <View style={{ flex: 1 }}>
            <ReportText size={12}>
              {`${inaccessible.join(', ')} ${inaccessible.length === 1 ? 'is inaccessible. Its' : 'are inaccessible. Their'} PRs are excluded until access is restored. `}
              <Text
                accessibilityRole="link"
                onPress={() => navigate('sources')}
                style={{ color: colors.action, fontWeight: '600' }}
              >
                Fix in Sources &amp; repos
              </Text>
            </ReportText>
          </View>
        </View>
      )}
      {links.feedback && (
        <NativeActions>
          <NativeText announce>{links.feedback.text}</NativeText>
          {links.feedback.previous && (
            <NativeButton label="Undo" disabled={links.busy} onPress={links.undo} />
          )}
        </NativeActions>
      )}
      <NativeProblem message={links.problem} />
      <NativeCard title="Merged pull requests">
        <ReportText size={12} muted>
          {deliveryScope(filters)} · counted on merge date · each PR counts once, however many
          sessions link to it
        </ReportText>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <View
            accessibilityRole="tablist"
            accessibilityLabel="Filter by link basis"
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              borderRadius: compact ? 15 : 16,
              backgroundColor: colors['surface-sunken'],
              maxWidth: '100%',
            }}
          >
            {(Object.keys(linkFilters) as LinkFilter[]).map((id) => {
              const count = headline?.counts?.[id];
              const selected = linkClass === id;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="tab"
                  aria-selected={selected}
                  onPress={() => setLinkClass(id)}
                  style={({ pressed }) => ({
                    minHeight: 31,
                    paddingHorizontal: 12,
                    justifyContent: 'center',
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: selected ? colors.action : 'transparent',
                    backgroundColor: selected
                      ? colors['selection-surface']
                      : pressed
                        ? colors.border
                        : 'transparent',
                  })}
                >
                  <ReportText
                    size={14}
                    strong={selected}
                    color={selected ? colors.action : colors['text-muted']}
                  >
                    {count === undefined ? linkFilters[id] : `${linkFilters[id]} ${int(count)}`}
                  </ReportText>
                </Pressable>
              );
            })}
          </View>
          <View style={{ width: compact ? '100%' : 288, maxWidth: '100%' }}>
            <NativeInput
              accessibilityLabel="Search pull requests"
              placeholder="Search title, repo or #"
              maxLength={200}
              value={searchText}
              onChangeText={setSearchText}
              returnKeyType="search"
              style={{
                minHeight: compact ? 44 : 32,
                backgroundColor: colors.surface,
                color: colors.text,
                borderColor: colors['border-strong'],
                borderWidth: 1,
                borderRadius: 8,
                paddingHorizontal: 8,
                fontSize: compact ? 16 : 14,
              }}
            />
          </View>
        </View>
        {!prs.data && (
          <ReportLoading label="pull requests" error={prs.error} retry={() => void prs.refetch()} />
        )}
        {prs.data && prs.error && !prs.isFetchNextPageError && (
          <ReportLoading label="pull requests" error={prs.error} retry={() => void prs.refetch()} />
        )}
        {prs.data && items.length === 0 && !showFocused && (
          <NativeText tone="foregroundMuted">
            {headline?.counts?.all === 0
              ? start > bootstrap.today
                ? periodNotHappened
                : `No merged PRs in this period${author === 'mine' ? ' authored by you' : ''}.`
              : 'No PRs match these filters.'}
          </NativeText>
        )}
        {showFocused && prs.data && (
          <NativeRow>
            <PullRequestDetail
              prId={focusedPr}
              timezone={timezone}
              busy={links.busy}
              perform={links.perform}
              showPr
            />
            <NativeActions>
              <NativeButton label="Close link evidence" onPress={() => toggle(focusedPr)} />
            </NativeActions>
          </NativeRow>
        )}
        {items.length > 0 &&
          (phone ? (
            <View>{rows}</View>
          ) : (
            <ReportTable
              label="Merged pull requests with linked sessions and link basis"
              columns={columns}
              width={width - 34}
            >
              {rows}
            </ReportTable>
          ))}
        {prs.isFetchNextPageError && (
          <ReportLoading
            label="more pull requests"
            error={prs.error}
            retry={() => void prs.fetchNextPage()}
          />
        )}
        {prs.hasNextPage && !prs.isFetchNextPageError && (
          <NativeActions>
            <NativeButton
              label={
                prs.isFetchingNextPage
                  ? 'Loading…'
                  : remaining === null
                    ? 'Show more'
                    : `Show ${int(Math.min(remaining, PAGE_SIZE))} more`
              }
              disabled={prs.isFetching}
              onPress={() => void prs.fetchNextPage()}
            />
            {remaining !== null && remaining > 0 && (
              <NativeText tone="foregroundMuted">{int(remaining)} not shown</NativeText>
            )}
          </NativeActions>
        )}
      </NativeCard>
    </View>
  );
}
