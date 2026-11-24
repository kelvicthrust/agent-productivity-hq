import { z } from 'zod';
import {
  AccountParam,
  CapturePreviewAction,
  ClaudePlanLimitsCheckRequest,
  ClaudePlanLimitsCheckResponse,
  ConnectPollResponse,
  ConnectResponse,
  DisconnectableAccount,
  GithubAppRequest,
  UsageCapturePreview,
  UsageCaptureRequest,
  UsageCaptureResponse,
} from './accounts.ts';
import { BootstrapResponse, HealthResponse } from './bootstrap.ts';
import {
  BrowserHandoffRequest,
  BrowserHandoffResponse,
  PASEO_HANDOFF_PATH,
} from './browser-handoff.ts';
import { Int, Provider } from './common.ts';
import { ErrorEnvelope } from './errors.ts';
import { FilterQuery, LimitQuery } from './filters.ts';
import { ClaudeHooksRequest, ClaudeHooksStatus, HqClaudeHookEvent, HqResponse } from './hq.ts';
import { OverviewResponse } from './overview.ts';
import { PaseoQuotaResponse } from './paseo-quota.ts';
import {
  LinkDecisionRequest,
  PrDetailResponse,
  PrsResponse,
  EvidenceItem,
  RecordsResponse,
} from './prs.ts';
import {
  AddRepoRequest,
  AddRepoResponse,
  GithubRepoAccount,
  Repo,
  RepoDiscoveryResponse,
  ReposResponse,
} from './repos.ts';
import { SeriesResponse, YearResponse } from './series.ts';
import {
  AccountStatus,
  RefreshRequest,
  RefreshRun,
  ResetRequest,
  SetupDiscoverResponse,
  SourcesResponse,
} from './sources.ts';
import {
  ModelsResponse,
  UsageCategoriesResponse,
  UsageGroupsResponse,
  UsageRootsResponse,
} from './usage.ts';

/**
 * One entry per route in docs/tech/local-api.md. The HTTP layer validates with these and the client parses with
 * these; test/contract/openapi.test.ts compares every entry with the OpenAPI copy and checks the implemented ones
 * against the running app. A route that is described here but not yet served is listed in PENDING_ROUTES
 * (test/contract/pending.ts) until its milestone builds it.
 */
export type HttpMethod = 'get' | 'put' | 'post' | 'delete';

export interface RouteContract {
  method: HttpMethod;
  /** The OpenAPI path template, e.g. `/api/prs/{prId}/links/{sessionId}`. */
  path: string;
  params?: Record<string, z.ZodType>;
  query?: Record<string, z.ZodType>;
  /** Non-GET routes must carry `X-Agent-Productivity-Request: 1` and a JSON content type. */
  csrf: boolean;
  body?: { schema: z.ZodType; required: boolean };
  /** status → body schema; null is an empty body. Error statuses use the error envelope. */
  responses: Record<string, z.ZodType | null>;
}

const E = ErrorEnvelope;
const filters = (...names: (keyof typeof FilterQuery)[]) =>
  Object.fromEntries(names.map((name) => [name, FilterQuery[name]]));
const limit = (max: number) => ({ limit: LimitQuery(max) });
const get = (
  path: string,
  response: z.ZodType,
  options: Partial<Pick<RouteContract, 'params' | 'query'>> & { errors?: string[] } = {},
): RouteContract => ({
  method: 'get',
  path,
  ...(options.params ? { params: options.params } : {}),
  ...(options.query ? { query: options.query } : {}),
  csrf: false,
  responses: { '200': response, ...Object.fromEntries((options.errors ?? []).map((s) => [s, E])) },
});

const prId = { prId: z.string() };
const repoPath = { owner: z.string(), name: z.string() };

export const ROUTES: readonly RouteContract[] = [
  get('/api/health', HealthResponse),
  get('/api/bootstrap', BootstrapResponse),
  {
    method: 'post',
    path: PASEO_HANDOFF_PATH,
    csrf: true,
    body: { schema: BrowserHandoffRequest, required: true },
    responses: {
      '200': BrowserHandoffResponse,
      '400': E,
      '401': E,
      '403': E,
      '413': E,
      '421': E,
      '503': E,
    },
  },
  get('/api/overview', OverviewResponse, {
    query: filters('start', 'end', 'repos', 'provider', 'author'),
    errors: ['400'],
  }),
  get('/api/paseo-quota', PaseoQuotaResponse, { errors: ['404'] }),
  {
    method: 'post',
    path: '/api/paseo-quota/{provider}/check',
    params: { provider: Provider },
    csrf: true,
    responses: { '200': PaseoQuotaResponse, '404': E },
  },
  get('/api/series', SeriesResponse, {
    query: filters('start', 'end', 'gran', 'repos', 'provider', 'author'),
    errors: ['400'],
  }),
  get('/api/year', YearResponse, { query: filters('repos', 'author') }),
  get('/api/records', RecordsResponse, {
    query: { ...filters('start', 'end', 'repos', 'provider', 'author'), ...limit(100) },
    errors: ['400'],
  }),
  get('/api/prs', PrsResponse, {
    query: {
      ...filters('start', 'end', 'repos', 'author'),
      linkClass: z.enum(['all', 'evidence', 'owner', 'suggested', 'unlinked']),
      q: z.string().max(200),
      cursor: z.string(),
      ...limit(200),
    },
  }),
  get('/api/prs/{prId}', PrDetailResponse, { params: prId, errors: ['404'] }),
  {
    method: 'put',
    path: '/api/prs/{prId}/links/{sessionId}',
    params: { ...prId, sessionId: Int },
    csrf: true,
    body: { schema: LinkDecisionRequest, required: true },
    responses: { '200': EvidenceItem, '400': E, '404': E },
  },
  {
    method: 'delete',
    path: '/api/prs/{prId}/links/{sessionId}',
    params: { ...prId, sessionId: Int },
    csrf: true,
    responses: { '204': null },
  },
  get('/api/usage/categories', UsageCategoriesResponse, {
    query: filters('start', 'end', 'repos', 'provider'),
  }),
  get('/api/usage/groups', UsageGroupsResponse, {
    query: filters('start', 'end', 'repos', 'provider'),
  }),
  get('/api/usage/groups/{groupKey}/roots', UsageRootsResponse, {
    params: { groupKey: z.string() },
    query: { ...filters('start', 'end', 'repos', 'provider'), cursor: z.string(), ...limit(100) },
  }),
  get('/api/models', ModelsResponse, {
    query: filters('start', 'end', 'repos', 'provider'),
    errors: ['400'],
  }),
  get('/api/sources', SourcesResponse),
  get('/api/hq', HqResponse),
  get('/api/hq/claude-hooks', ClaudeHooksStatus, { errors: ['500'] }),
  {
    method: 'put',
    path: '/api/hq/claude-hooks',
    csrf: true,
    body: { schema: ClaudeHooksRequest, required: true },
    responses: { '200': ClaudeHooksStatus, '400': E, '409': E, '422': E, '500': E },
  },
  {
    method: 'post',
    path: '/api/hq/hooks/claude',
    csrf: true,
    body: { schema: HqClaudeHookEvent, required: true },
    responses: { '204': null, '400': E, '401': null, '413': null },
  },
  {
    method: 'post',
    path: '/api/refresh',
    csrf: true,
    body: { schema: RefreshRequest, required: false },
    responses: { '202': RefreshRun, '409': E },
  },
  get('/api/refresh/{runId}', RefreshRun, { params: { runId: Int }, errors: ['404'] }),
  get('/api/repos', ReposResponse),
  get('/api/repos/discover', RepoDiscoveryResponse, {
    query: { ...GithubRepoAccount.shape, page: Int.positive().optional() },
    errors: ['400', '409', '422', '502'],
  }),
  {
    method: 'post',
    path: '/api/repos',
    csrf: true,
    body: { schema: AddRepoRequest, required: true },
    responses: { '201': AddRepoResponse, '400': E, '409': E, '422': E, '502': E },
  },
  {
    method: 'delete',
    path: '/api/repos/{owner}/{name}',
    params: repoPath,
    csrf: true,
    responses: { '204': null, '404': E },
  },
  {
    method: 'post',
    path: '/api/repos/{owner}/{name}/recheck',
    params: repoPath,
    csrf: true,
    responses: { '200': Repo },
  },
  {
    method: 'post',
    path: '/api/accounts/{account}/connect',
    params: { account: AccountParam },
    csrf: true,
    responses: { '200': ConnectResponse, '422': E, '502': E },
  },
  {
    method: 'put',
    path: '/api/accounts/github/app',
    csrf: true,
    body: { schema: GithubAppRequest, required: true },
    responses: { '200': AccountStatus, '400': E },
  },
  {
    method: 'post',
    path: '/api/accounts/claude/plan-limits/check',
    csrf: true,
    body: { schema: ClaudePlanLimitsCheckRequest, required: false },
    responses: { '200': ClaudePlanLimitsCheckResponse, '400': E, '422': E },
  },
  get('/api/accounts/claude/usage-capture/preview', UsageCapturePreview, {
    query: { action: CapturePreviewAction.optional() },
    errors: ['400', '409', '422'],
  }),
  {
    method: 'put',
    path: '/api/accounts/claude/usage-capture',
    csrf: true,
    body: { schema: UsageCaptureRequest, required: true },
    responses: { '200': UsageCaptureResponse, '400': E, '409': E, '422': E },
  },
  get('/api/accounts/{account}/connect/{loginId}', ConnectPollResponse, {
    params: { account: z.string(), loginId: z.string() },
  }),
  {
    method: 'post',
    path: '/api/accounts/{account}/disconnect',
    params: { account: DisconnectableAccount },
    csrf: true,
    responses: { '200': AccountStatus },
  },
  {
    method: 'post',
    path: '/api/setup/discover',
    csrf: true,
    responses: { '200': SetupDiscoverResponse },
  },
  {
    method: 'post',
    path: '/api/setup/complete',
    csrf: true,
    responses: { '202': RefreshRun },
  },
  {
    method: 'post',
    path: '/api/setup/reset',
    csrf: true,
    body: { schema: ResetRequest, required: true },
    responses: { '204': null, '400': E, '409': E, '422': E, '500': E },
  },
];

/** `GET /api/health` style key, the same text the test uses for the pending list. */
export const routeKey = (route: Pick<RouteContract, 'method' | 'path'>) =>
  `${route.method.toUpperCase()} ${route.path}`;
