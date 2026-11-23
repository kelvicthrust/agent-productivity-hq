import type {
  AccountReport,
  AccountStatus as ReportAccount,
  SourceStatus as ReportSource,
} from '../shared/report-contracts.ts';

// Fields of the dashboard's allowlisted REST responses that the published client renders.
export interface NativeBootstrap {
  setupComplete: boolean;
  timezone: string;
  today: string;
  lookbackStart: string;
  githubLogin?: string | null;
  greetingName?: string | null;
  issues: Array<{ kind?: 'source' | 'account' | 'repo'; id?: string; label?: string }>;
}

export interface SourceStatus extends Omit<ReportSource, 'name'> {
  name?: string;
  records?: number;
}

export interface AccountStatus {
  id: 'github' | 'chatgpt' | 'claude';
  status:
    | 'existing'
    | 'connected'
    | 'notconnected'
    | 'needsapp'
    | 'reconnect'
    | 'unavailable'
    | 'connecting'
    | 'failed';
  statusText?: string;
  name?: string;
  login?: string | null;
  via?: 'gh' | 'app' | 'codex' | 'statusline' | 'claude_code' | null;
  planLimits?: ReportAccount['planLimits'];
}

export interface SourceReport {
  sources?: SourceStatus[];
  accounts?: AccountStatus[];
  chatgptCoverage?: Pick<AccountReport, 'unit' | 'bucketSpan' | 'stale'>;
  running?: number | null;
}

export interface ConnectResponse {
  loginId?: string | null;
  mode?: 'existing' | 'browser' | 'device';
  authUrl?: string | null;
  userCode?: string | null;
  verificationUri?: string | null;
}

export interface ConnectPollResponse {
  state?: 'pending' | 'connected' | 'failed' | 'expired' | 'cancelled';
  account?: AccountStatus;
  message?: string | null;
}

export interface RosterAgent {
  id: string;
  paseoAgentId?: string;
  provider: 'codex' | 'claude' | 'other';
  kind: 'root' | 'child';
  parentId: string | null;
  parentAway: boolean;
  title: string | null;
  repo: string | null;
  workspace: string | null;
  state: 'starting' | 'working' | 'waiting' | 'idle' | 'error' | 'finished';
  activity:
    | 'thinking'
    | 'responding'
    | 'reading'
    | 'editing'
    | 'command'
    | 'delegating'
    | 'planning'
    | 'tool'
    | 'none';
  since: string;
  startedAt: string | null;
  waitReason: 'permission' | 'question' | 'plan_approval' | null;
  confidence: 'reported' | 'inferred';
  seenBy: { paseo: boolean };
}

export interface NativeRoster {
  generatedAt?: string;
  agents: RosterAgent[];
  feeds: Array<{
    id: 'paseo' | 'claude' | 'codex';
    status:
      | 'unavailable'
      | 'setup_incomplete'
      | 'starting'
      | 'live'
      | 'notrunning'
      | 'needspassword'
      | 'notfound'
      | 'denied'
      | 'failed';
  }>;
  truncated: boolean;
  exactPrompts?: 'off' | 'on' | 'needs_repair' | 'unavailable';
}

export interface GithubRepoAccount {
  login: string;
  via: 'gh' | 'app';
}

export interface Repo {
  id: string;
  displayName: string;
  githubNodeId?: string | null;
  accessState: 'ok' | 'inaccessible' | 'unknown';
  accessError?: string | null;
  mergedPrsLast12Months?: number;
  backfillComplete?: boolean;
  lastSyncSuccessAt?: string | null;
  stoppedAt?: string | null;
}

export interface DiscoveredRepo {
  displayName: string;
  nodeId: string;
  visibility?: 'public' | 'private' | 'internal';
  trackingState?: 'untracked' | 'active' | 'stopped';
  trackedRepoId: string | null;
}

interface QuotaWindow {
  source: 'paseo' | 'direct';
  usedPercent: number;
  resetsAt: string | null;
  refreshedAt: string | null;
  stale: boolean;
}

export type NativeUsageProvider = 'codex' | 'claude';

export interface NativeQuota extends Omit<QuotaWindow, 'source' | 'usedPercent'> {
  provider: NativeUsageProvider;
  source: QuotaWindow['source'] | null;
  usedPercent: number | null;
  canCheck: boolean;
  windows: Array<QuotaWindow & { id: string; label: string }>;
}
