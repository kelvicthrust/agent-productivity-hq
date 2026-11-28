// The installed plugin cannot import the runtime's source. These wire types are checked against
// the local API codecs in test/server/paseo-native.test.ts.
export type Provider = 'codex' | 'claude';
export type ProviderFilter = 'all' | Provider;
export type AuthorFilter = 'mine' | 'all';
export type Granularity = 'day' | 'week' | 'month';
export type LinkClass = 'evidence' | 'owner' | 'suggested' | 'unlinked';
export type LinkDecision = 'confirmed' | 'rejected' | 'dismissed';
export type LinkAction = 'confirm' | 'dismiss' | 'reject' | 'restore' | 'remove';
export type UsageCoverage = 'ok' | 'partial' | 'unavailable' | 'stale' | 'none' | 'future';
export type DeliveryCoverage = 'ok' | 'syncing' | 'none' | 'future';
export type RefreshSource = 'codex' | 'claude' | 'paseo' | 'github' | 'chatgpt_account';

type DateRepoFilters = {
  start?: string | undefined;
  end?: string | undefined;
  repos?: string | undefined;
};
export type UsageFilters = DateRepoFilters & { provider?: ProviderFilter | undefined };
export type OverviewFilters = UsageFilters & { author?: AuthorFilter | undefined };
export type DeliveryFilters = DateRepoFilters & { author?: AuthorFilter | undefined };
type Page = { cursor?: string | undefined; limit?: number | undefined };
type PrSession = { prId: string; sessionId: number };

export interface ReportInputs {
  overview: OverviewFilters;
  workReview: OverviewFilters & { version?: number | undefined };
  series: OverviewFilters & { gran?: Granularity | undefined };
  year: Pick<OverviewFilters, 'repos' | 'author'>;
  models: UsageFilters;
  records: OverviewFilters & Pick<Page, 'limit'>;
  prs: DeliveryFilters &
    Page & { linkClass?: 'all' | LinkClass | undefined; q?: string | undefined };
  prDetail: { prId: string };
  prLinkSet: PrSession & { decision: LinkDecision };
  prLinkRemove: PrSession;
  usageCategories: UsageFilters;
  usageGroups: UsageFilters;
  usageRoots: UsageFilters & Page & { groupKey: string };
  refresh: { sources?: RefreshSource[] | undefined };
  refreshStatus: { runId: number };
}

export const reportOperations = [
  'overview',
  'workReview',
  'series',
  'year',
  'models',
  'records',
  'prs',
  'prDetail',
  'prLinkSet',
  'prLinkRemove',
  'usageCategories',
  'usageGroups',
  'usageRoots',
  'refresh',
  'refreshStatus',
] as const satisfies readonly (keyof ReportInputs)[];

export interface Scope {
  start: string;
  end: string;
  gran: Granularity;
  repos: string[];
  ignoredRepos?: string[] | undefined;
  provider: ProviderFilter;
  author: AuthorFilter;
  timezone: string;
}

export interface LinkHealth {
  state: 'fresh' | 'stale' | 'unavailable';
  lastSuccessfulAt: string | null;
}

export interface PullRequest {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  author: string | null;
  mergedBy: string | null;
  authoredByMe: boolean;
  linkClass: LinkClass;
  linkedSessionCount: number;
  suggestedCount: number;
  providers: Provider[];
}

export interface Session {
  id: number;
  provider: Provider;
  kind: 'root' | 'child' | 'unknown';
  relationshipLabel?:
    'Root session' | 'Native subagent' | 'Paseo child agent' | 'Unknown relationship' | undefined;
  nameLead: string;
  named: boolean;
  nameSource?: 'provider_title' | 'paseo' | null | undefined;
  paseo?:
    { agentId?: string | undefined; workspace?: string | null | undefined } | null | undefined;
  providerSessionRef: string;
  repo?: string | null | undefined;
  repoGroup?: 'tracked' | 'untracked' | 'unknown' | undefined;
  model?: string | undefined;
  tokens: number;
  startedAt: string;
  startedBasis: 'source_start' | 'first_event';
  firstEventAt: string;
  lastEventAt: string;
  parentId?: number | null | undefined;
  childCount?: number | undefined;
  linkStatus: 'linked' | 'unlinked' | 'repo_not_tracked' | 'repo_unknown' | 'prs_not_collected';
  linkedPrs: {
    prId: string;
    repo: string;
    number: number;
    mergedAt: string;
    class: 'evidence' | 'owner' | 'suggested';
  }[];
}

export interface EvidenceItem {
  session: Session;
  effectiveClass: 'evidence' | 'owner' | 'suggested' | 'rejected';
  sourceClass?: 'evidence' | 'suggested' | null | undefined;
  basis: 'pr_reference' | 'commit_match' | 'same_branch' | 'same_repo_window' | 'owner';
  basisText: string;
  actions: LinkAction[];
}

export interface PrsResponse {
  scope?: Scope | undefined;
  linkHealth: LinkHealth;
  counts?: Partial<Record<'all' | LinkClass, number | undefined>> | undefined;
  items?: PullRequest[] | undefined;
  nextCursor?: string | null | undefined;
  inaccessibleRepos?: string[] | undefined;
}

export interface PrDetailResponse {
  pr?: PullRequest | undefined;
  evidence?: EvidenceItem[] | undefined;
  candidates?: Session[] | undefined;
}

export interface RecordsResponse {
  scope?: Scope | undefined;
  prs?: PullRequest[] | undefined;
  prTotal?: number | undefined;
  sessions?: Session[] | undefined;
  sessionTotal?: number | undefined;
  coverage?:
    | {
        codex?: UsageCoverage | undefined;
        claude?: UsageCoverage | undefined;
        delivery?: DeliveryCoverage | undefined;
      }
    | undefined;
}

export interface SourceStatus {
  id: 'codex' | 'claude' | 'paseo' | 'github';
  name: string;
  status:
    | 'checking'
    | 'ok'
    | 'partial'
    | 'failed'
    | 'notfound'
    | 'denied'
    | 'notrunning'
    | 'needspassword';
  location?: string | null | undefined;
  oldestDate?: string | null | undefined;
  sessions?: number | null | undefined;
  hasRetainedData?: boolean | undefined;
  unreadable?: number | undefined;
  unsupported?: number | undefined;
  lastSuccessAt?: string | null | undefined;
  lastAttemptAt?: string | null | undefined;
  lastAttemptResult?: 'succeeded' | 'partial' | 'failed' | null | undefined;
  consecutiveFailures?: number | undefined;
  staleAfter?: string | null | undefined;
  message?: string | null | undefined;
  retentionNote?: string | null | undefined;
}

export interface AccountReport {
  account: 'chatgpt' | 'claude';
  unit: 'tokens' | 'percent';
  periodTokens?: number | null | undefined;
  bucketSpan?: { start?: string | undefined; end?: string | undefined } | null | undefined;
  rateLimits?:
    | {
        limitId: string;
        label?: string | null | undefined;
        usedPercent: number;
        windowMinutes?: number | null | undefined;
        resetsAt?: string | null | undefined;
      }[]
    | undefined;
  scopeLabel: string;
  localSameWindow?: number | null | undefined;
  windowDiffers?: boolean | undefined;
  refreshedAt: string;
  stale?: boolean | undefined;
  provenance?: 'claude_code_oauth' | 'claude_statusline' | undefined;
}

export interface AccountStatus {
  id: 'github' | 'chatgpt' | 'claude';
  name: string;
  status:
    | 'existing'
    | 'connected'
    | 'notconnected'
    | 'needsapp'
    | 'reconnect'
    | 'unavailable'
    | 'connecting'
    | 'failed';
  statusText?: string | undefined;
  login?: string | null | undefined;
  via?: 'gh' | 'app' | 'codex' | 'statusline' | 'claude_code' | null | undefined;
  appClientIdSaved?: boolean | null | undefined;
  planLimits?:
    | {
        state:
          | 'unchecked'
          | 'ok'
          | 'signed_out'
          | 'credential_denied'
          | 'unsupported'
          | 'reconnect'
          | 'limited'
          | 'failed';
        lastCheckedAt: string | null;
        retryAt: string | null;
        report: AccountReport | null;
      }
    | undefined;
  captureEnabled?: boolean | null | undefined;
  captureHealth?:
    | {
        phase: 'off' | 'awaiting_edit' | 'active' | 'awaiting_removal' | 'needs_attention';
        recorded: boolean;
        state:
          | 'off'
          | 'awaiting_edit'
          | 'awaiting_removal'
          | 'waiting'
          | 'ok'
          | 'no_limits'
          | 'idle'
          | 'replaced'
          | 'node_missing'
          | 'settings_unreadable'
          | 'profile_changed'
          | 'state_unreadable'
          | 'legacy_unverified';
        lastInvokedAt?: string | null | undefined;
        capturedAt?: string | null | undefined;
        settingsPath?: string | null | undefined;
        projectOverrides?: number | undefined;
        backupPath?: string | null | undefined;
      }
    | null
    | undefined;
  reason?: string | null | undefined;
}

export interface ProviderKpi {
  coverage: UsageCoverage;
  value?: number | null | undefined;
  note?: 'From <date> only' | 'Cached; recent days missing' | null | undefined;
  coveredFrom?: string | null | undefined;
}

export interface OverviewResponse {
  scope: Scope;
  linkHealth: LinkHealth;
  kpis: {
    mergedPrs?:
      | {
          value?: number | null | undefined;
          delivery?: DeliveryCoverage | undefined;
          previous?:
            | {
                label?: string | undefined;
                value?: number | null | undefined;
                outsideLookback?: boolean | undefined;
              }
            | undefined;
        }
      | undefined;
    linkedPrs?:
      | {
          value?: number | null | undefined;
          of?: number | null | undefined;
          suggestedOnly?: number | undefined;
        }
      | undefined;
    localTokens?: Partial<Record<Provider, ProviderKpi | undefined>> | undefined;
    rootSessions?:
      | {
          value?: number | null | undefined;
          unknownRelationship?: number | undefined;
          crew?: Provider[] | undefined;
        }
      | undefined;
    childAgents?:
      | {
          value?: number | null | undefined;
          paseo?: number | undefined;
          native?: number | undefined;
          crew?: Provider[] | undefined;
        }
      | undefined;
  };
  coverage: {
    sources?: SourceStatus[] | undefined;
    github?: { tracked?: number | undefined; inaccessible?: number | undefined } | undefined;
    accounts?: AccountStatus[] | undefined;
    lastRefreshAt?: string | null | undefined;
    refreshFailed?: boolean | undefined;
  };
  accounts: AccountReport[];
  repoRows: {
    group?: 'tracked' | 'untracked' | 'unknown' | undefined;
    repo?: string | null | undefined;
    accessState?: string | undefined;
    mergedPrs?: number | null | undefined;
    linkedPrs?: number | null | undefined;
    tokens?: Partial<Record<Provider, number | null | undefined>> | undefined;
    rootSessions?: number | undefined;
  }[];
  recentPrs: PullRequest[];
  periodMergedCount?: number | undefined;
  trueZero?: boolean | undefined;
}

export interface Bucket {
  start: string;
  end: string;
  label: string;
  short: string;
  partOfRange?: boolean | undefined;
  prs: number | null;
  delivery: DeliveryCoverage;
  tokens: Partial<Record<Provider, number | null | undefined>>;
  usage: Partial<Record<Provider | 'rail', UsageCoverage | undefined>>;
}

export interface SeriesResponse {
  scope: Scope;
  buckets: Bucket[];
  unavailableText?: string | null | undefined;
}

export interface YearResponse {
  start: string;
  today: string;
  counts: Record<string, number>;
  total: number;
  daysWithMerge: number;
  busiestDay?: { date?: string | undefined; count?: number | undefined } | null | undefined;
  delivery?: DeliveryCoverage | undefined;
}

export interface UsageCategoriesResponse {
  scope?: Scope | undefined;
  codex?:
    | {
        coverage?: UsageCoverage | undefined;
        coveredFrom?: string | null | undefined;
        sessions?: number | undefined;
        input?: number | undefined;
        cachedInput?: number | undefined;
        output?: number | undefined;
        reasoning?: number | undefined;
        total?: number | undefined;
      }
    | undefined;
  claude?:
    | {
        coverage?: UsageCoverage | undefined;
        coveredFrom?: string | null | undefined;
        sessions?: number | undefined;
        inputUncached?: number | undefined;
        cacheWrite?: number | undefined;
        cacheRead?: number | undefined;
        output?: number | undefined;
        total?: number | undefined;
      }
    | undefined;
  paseoNote?: string | null | undefined;
}

export interface UsageGroup {
  key?: string | undefined;
  label?: string | undefined;
  note?: string | null | undefined;
  roots?: number | undefined;
  sessions?: number | undefined;
  tokens?: Partial<Record<Provider, number | undefined>> | undefined;
}

export interface UsageGroupsResponse {
  scope?: Scope | undefined;
  groups?: UsageGroup[] | undefined;
}

export type UsageRoot = Session & { children?: Session[] | undefined };

export interface UsageRootsResponse {
  roots?: UsageRoot[] | undefined;
  orphans?: Session[] | undefined;
  unknownRelationship?: Session[] | undefined;
  nextCursor?: string | null | undefined;
  remaining?: number | undefined;
}

export interface ModelShare {
  coverage?: UsageCoverage | undefined;
  rows?:
    | {
        model?: string | undefined;
        tokens?: number | undefined;
        sessions?: number | undefined;
        sharePercent?: number | undefined;
      }[]
    | undefined;
}

export type ModelsResponse = Partial<Record<Provider, ModelShare | undefined>>;

export interface RefreshRun {
  id: number;
  state: 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt?: string | null | undefined;
  linkRebuild: 'pending' | 'succeeded' | 'failed' | 'interrupted' | null;
  sources: Record<
    string,
    {
      state?: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped' | undefined;
      imported?: number | undefined;
      duplicatesSkipped?: number | undefined;
      unreadable?: number | undefined;
      message?: string | null | undefined;
    }
  >;
}

export interface ReportOutputs {
  workReview: WorkReviewState;
  overview: OverviewResponse;
  series: SeriesResponse;
  year: YearResponse;
  models: ModelsResponse;
  records: RecordsResponse;
  prs: PrsResponse;
  prDetail: PrDetailResponse;
  prLinkSet: EvidenceItem;
  prLinkRemove: null;
  usageCategories: UsageCategoriesResponse;
  usageGroups: UsageGroupsResponse;
  usageRoots: UsageRootsResponse;
  refresh: RefreshRun;
  refreshStatus: RefreshRun;
}

export interface WorkReviewEvidence {
  kind: 'pr' | 'session';
  id: string;
  label: string;
  date: string;
  repo: string | null;
  notes?: string[] | undefined;
}

export interface WorkReviewVersion {
  version: number;
  createdAt: string;
  headline: string;
  headlineEvidence: WorkReviewEvidence[];
  bullets: {
    kind: 'shipped' | 'team' | 'progress' | 'open';
    text: string;
    evidence: WorkReviewEvidence[];
  }[];
  coverage: string[];
}

export interface WorkReviewState {
  status: 'idle' | 'running' | 'failed';
  message: string | null;
  review: WorkReviewVersion | null;
  versions: number[];
  changed: boolean;
  locked: boolean;
}
