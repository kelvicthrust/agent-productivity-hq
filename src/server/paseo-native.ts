import { z } from 'zod';
import type { BootDeps, RunningServer } from './boot.ts';
import type { PaseoListOptions, PaseoListResult } from './collectors/paseo/agents.ts';
import type { ServerConfig } from './lib/config.ts';
import { Int, LinkClass, Provider } from '../shared/contracts/common.ts';
import { ErrorEnvelope } from '../shared/contracts/errors.ts';
import { FilterQuery, LimitQuery } from '../shared/contracts/filters.ts';
import { OverviewResponse } from '../shared/contracts/overview.ts';
import {
  EvidenceItem,
  LinkDecisionRequest,
  PrDetailResponse,
  PrsResponse,
  RecordsResponse,
} from '../shared/contracts/prs.ts';
import { AddRepoRequest, GithubRepoAccount } from '../shared/contracts/repos.ts';
import { SeriesResponse, YearResponse } from '../shared/contracts/series.ts';
import { RefreshRequest, RefreshRun } from '../shared/contracts/sources.ts';
import {
  ModelsResponse,
  UsageCategoriesResponse,
  UsageGroupsResponse,
  UsageRootsResponse,
} from '../shared/contracts/usage.ts';
import { WorkReviewState } from '../shared/contracts/work-review.ts';
import { CSRF_HEADER, CSRF_VALUE } from './http/guards.ts';
import { MAX_PRS_LIMIT, MAX_SEARCH_LENGTH } from './services/delivery.ts';
import { MAX_RECORDS_LIMIT } from './services/metrics.ts';
import { MAX_ROOTS_LIMIT } from './services/usage.ts';

const json = z.json();
type JsonValue = z.infer<typeof json>;
export type PaseoRead = (
  request: { kind: 'agents'; options: JsonValue } | { kind: 'usage' },
) => Promise<JsonValue>;
export type NativeResult =
  | { ok: true; data: JsonValue }
  | {
      ok: false;
      reason: string;
      message: string;
      retryable?: boolean;
      details?: { runId: number };
    };

/** Adapt the borrowed Paseo connection to the existing batch, live, and discovery collectors. */
export function paseoBootDeps(read: PaseoRead): Pick<BootDeps, 'paseo' | 'hq' | 'paseoUsage'> {
  const open = () => ({
    connect: async () => {},
    close: async () => {},
    getConnectionState: () => ({ status: 'connected' }),
    agents: {
      async list(options: PaseoListOptions) {
        return (await read({
          kind: 'agents',
          options: json.parse({ ...options }),
        })) as unknown as PaseoListResult;
      },
    },
  });

  return {
    paseo: { open },
    hq: { open },
    paseoUsage: () => read({ kind: 'usage' }),
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Route = { method: Method; path: string; body?: unknown; output?: z.ZodType };
const get = (path: string, output?: z.ZodType): Route => ({
  method: 'GET',
  path,
  ...(output ? { output } : {}),
});
const post = (path: string, body: unknown = {}, output?: z.ZodType): Route => ({
  method: 'POST',
  path,
  body,
  ...(output ? { output } : {}),
});
const empty = z.strictObject({}).default({});
const fixed = (route: Route) => (value: unknown) => {
  empty.parse(value);
  return route;
};
const login = z.strictObject({
  loginId: z
    .string()
    .max(256)
    .regex(/^[a-z0-9_-]+$/i),
});
const repoId = z
  .string()
  .max(300)
  .regex(/^[a-z0-9-]+\/[a-z0-9_.-]+$/i)
  .refine((id) => !/\/(?:\.|\.\.)$/.test(id));
const repo = z.strictObject({ id: repoId });
const discover = GithubRepoAccount.extend({ page: z.number().int().positive() }).strict();
const fallback = z.strictObject({ provider: Provider });
const repoPath = (value: unknown) =>
  '/api/repos/' + repo.parse(value).id.split('/').map(encodeURIComponent).join('/');

const dates = {
  start: FilterQuery.start.optional(),
  end: FilterQuery.end.optional(),
  repos: FilterQuery.repos.optional(),
};
const year = z.strictObject({
  repos: dates.repos,
  author: FilterQuery.author.optional(),
});
const usage = z.strictObject({ ...dates, provider: FilterQuery.provider.optional() });
const overview = usage.extend({ author: year.shape.author });
const series = overview.extend({ gran: FilterQuery.gran.optional() });
const records = overview.extend({ limit: LimitQuery(MAX_RECORDS_LIMIT).positive().optional() });
const prs = year.extend({
  ...dates,
  linkClass: z.union([z.literal('all'), LinkClass]).optional(),
  q: z.string().max(MAX_SEARCH_LENGTH).optional(),
  cursor: z.string().max(512).optional(),
  limit: LimitQuery(MAX_PRS_LIMIT).positive().optional(),
});
const groupRoots = usage.extend({
  groupKey: z.union([z.enum(['__untracked', '__unknown']), repoId]),
  cursor: z.string().max(200).optional(),
  limit: LimitQuery(MAX_ROOTS_LIMIT).positive().optional(),
});
// GitHub node IDs are opaque, and legacy IDs may contain URL-sensitive characters.
const prDetail = z.strictObject({
  prId: z
    .string()
    .min(1)
    .max(300)
    .refine((id) => id !== '.' && id !== '..'),
});
const prLink = prDetail.extend({ sessionId: Int.positive() });
const prLinkSet = prLink.extend(LinkDecisionRequest.shape);
const prDetailPath = (prId: string) => '/api/prs/' + encodeURIComponent(prId);
const prLinkPath = (prId: string, sessionId: number) => prDetailPath(prId) + '/links/' + sessionId;
const refresh = RefreshRequest.strict();
const refreshStatus = z.strictObject({ runId: Int.positive() });

type Query = Record<string, string | number | undefined>;
function withQuery(path: string, values: Query): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.size > 0 ? path + '?' + query : path;
}

const report = (path: string, query: z.ZodType<Query>, output: z.ZodType) => (value: unknown) =>
  get(withQuery(path, query.parse(value ?? {})), output);

const nativeRoutes = {
  bootstrap: fixed(get('/api/bootstrap')),
  roster: fixed(get('/api/hq')),
  discover: fixed(post('/api/setup/discover')),
  sources: fixed(get('/api/sources')),
  finish: fixed(post('/api/setup/complete')),
  githubConnect: fixed(post('/api/accounts/github/connect')),
  githubPoll: (value: unknown) =>
    get('/api/accounts/github/connect/' + encodeURIComponent(login.parse(value).loginId)),
  githubDisconnect: fixed(post('/api/accounts/github/disconnect')),
  githubApp: (value: unknown): Route => ({
    method: 'PUT',
    path: '/api/accounts/github/app',
    body: z.strictObject({ clientId: z.string().max(256) }).parse(value),
  }),
  chatgptConnect: fixed(post('/api/accounts/chatgpt/connect')),
  chatgptPoll: (value: unknown) =>
    get('/api/accounts/chatgpt/connect/' + encodeURIComponent(login.parse(value).loginId)),
  chatgptDisconnect: fixed(post('/api/accounts/chatgpt/disconnect')),
  repos: fixed(get('/api/repos')),
  repoDiscover: (value: unknown) => {
    const { login, via, page } = discover.parse(value);
    return get('/api/repos/discover?' + new URLSearchParams({ login, via, page: String(page) }));
  },
  repoAdd: (value: unknown) => post('/api/repos', AddRepoRequest.parse(value)),
  repoRecheck: (value: unknown) => post(repoPath(value) + '/recheck'),
  repoRemove: (value: unknown): Route => ({ method: 'DELETE', path: repoPath(value), body: null }),
  usage: fixed(get('/api/paseo-quota')),
  usageFallback: (value: unknown) =>
    post(`/api/paseo-quota/${fallback.parse(value).provider}/check`),
  overview: report('/api/overview', overview, OverviewResponse),
  workReview: report(
    '/api/work-review',
    overview.extend({ version: z.int().positive().optional() }),
    WorkReviewState,
  ),
  series: report('/api/series', series, SeriesResponse),
  year: report('/api/year', year, YearResponse),
  models: report('/api/models', usage, ModelsResponse),
  records: report('/api/records', records, RecordsResponse),
  prs: report('/api/prs', prs, PrsResponse),
  prDetail: (value: unknown) => get(prDetailPath(prDetail.parse(value).prId), PrDetailResponse),
  prLinkSet: (value: unknown): Route => {
    const { prId, sessionId, decision } = prLinkSet.parse(value);
    return {
      method: 'PUT',
      path: prLinkPath(prId, sessionId),
      body: { decision },
      output: EvidenceItem,
    };
  },
  prLinkRemove: (value: unknown): Route => {
    const { prId, sessionId } = prLink.parse(value);
    return { method: 'DELETE', path: prLinkPath(prId, sessionId), body: null };
  },
  usageCategories: report('/api/usage/categories', usage, UsageCategoriesResponse),
  usageGroups: report('/api/usage/groups', usage, UsageGroupsResponse),
  usageRoots: (value: unknown) => {
    const { groupKey, ...query } = groupRoots.parse(value);
    return get(
      withQuery('/api/usage/groups/' + encodeURIComponent(groupKey) + '/roots', query),
      UsageRootsResponse,
    );
  },
  refresh: (value: unknown) => post('/api/refresh', refresh.parse(value ?? {}), RefreshRun),
  refreshStatus: (value: unknown) =>
    get('/api/refresh/' + refreshStatus.parse(value).runId, RefreshRun),
} satisfies Record<string, (value: unknown) => Route>;
export type NativeOperation = keyof typeof nativeRoutes;
const request = z.strictObject({
  operation: z.enum(Object.keys(nativeRoutes) as NativeOperation[]),
  parameters: z.record(z.string(), json).optional(),
});

const rejected = {
  ok: false,
  reason: 'invalid_input',
  message: 'This Agent HQ action is invalid.',
} as const;
const unavailable = {
  ok: false,
  reason: 'dashboard-unavailable',
  message: 'The dashboard could not answer. Check the host and try again.',
} as const;

/** Reuse the same guarded handlers through a fixed set of in-process operations. */
export function createPaseoNative({
  server,
  config,
}: {
  server: Pick<RunningServer, 'app'>;
  config: Pick<ServerConfig, 'host' | 'port'>;
}) {
  const authority = `${config.host}:${config.port}`;
  return async (raw: unknown): Promise<NativeResult> => {
    const parsed = request.safeParse(raw);
    if (!parsed.success) return rejected;
    const { operation, parameters } = parsed.data;
    let route: Route;
    try {
      route = nativeRoutes[operation](parameters);
    } catch {
      return rejected;
    }

    try {
      const { method, path, body, output } = route;
      const response = await server.app.request(`http://${authority}${path}`, {
        method,
        headers: {
          host: authority,
          ...(method === 'GET'
            ? {}
            : {
                'content-type': 'application/json',
                [CSRF_HEADER]: CSRF_VALUE,
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 204) return { ok: true, data: null };
      const value: unknown = await response.json();
      if (response.ok) return { ok: true, data: json.parse(output ? output.parse(value) : value) };
      const error = ErrorEnvelope.safeParse(value);
      if (!error.success) return unavailable;
      const { code, message, retryable, details } = error.data.error;
      const activeRun = Int.positive().safeParse(details?.['runId']);
      return {
        ok: false,
        reason: code,
        message,
        retryable,
        ...(operation === 'refresh' && code === 'refresh_running' && activeRun.success
          ? { details: { runId: activeRun.data } }
          : {}),
      };
    } catch {
      return unavailable;
    }
  };
}
