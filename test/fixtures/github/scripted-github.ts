import type {
  GhRunner,
  Keyring,
  NetFetch,
  NetInit,
} from '../../../src/server/collectors/github/ports.ts';

// A scripted GitHub, an in-memory Keychain and a fake `gh`, for every M6 test and for the preview: no network, no Keychain,
// no `gh` program. The wire shapes follow docs/tech/data-and-sources.md › GitHub delivery (the device flow, the refresh
// request, the merged-PR GraphQL query) and GitHub's published REST shapes; every value is invented.
//
// Token-shaped values (gho_, ghu_, ghr_ followed by 36 characters) are BUILT AT RUN TIME from a prefix and a counter, so no
// literal token-shaped string is ever committed (they would trip secret scanners and blur what the ghu_/ghr_ scan proves).
// Tests that scan the database, the log or the API for a token read it from `github.tokens`.
//
// What is recorded about requests is deliberately small: method, host, path, which KIND of token was presented (never the
// token), and whether a client secret was sent. A test can assert on those without the double becoming a leak.

export type TokenKind = 'gh' | 'app' | 'none' | 'unknown';

export interface RecordedRequest {
  method: string;
  host: string;
  path: string;
  query: string;
  token: TokenKind;
  /** True when a form or JSON body carried a `client_secret` (the integration must never send one). */
  clientSecret: boolean;
  /** Time on the double's clock. */
  at: number;
}

export interface FakeRepo {
  /** As GitHub spells it, e.g. `Acme/Widgets`. */
  fullName: string;
  nodeId: string;
  pushedAt?: string;
  /** Other full names that answer with this repo (a rename). */
  aliases?: string[];
  /** Owners the GitHub App is installed on. A user token from the App sees a repo only when its owner is in here. */
  hidden?: boolean;
}

export interface FakePr {
  nodeId: string;
  number: number;
  title: string;
  /** ISO instant, or null for a PR that was closed without a merge. */
  mergedAt: string | null;
  state?: 'MERGED' | 'CLOSED' | 'OPEN';
  author: string | null;
  mergedBy: string | null;
  updatedAt?: string;
  headRef?: string;
  baseRef?: string;
  mergeCommit?: string;
  /** Commit shas, oldest first. More than 100 makes the GraphQL page carry the first 100 and `totalCount` the rest. */
  commits?: string[];
}

export type DeviceOutcome = 'approve' | 'deny' | 'expire';

export interface DeviceFlowScript {
  /** Seconds GitHub asks the client to wait between polls. */
  interval: number;
  /** How many polls answer `authorization_pending` before the outcome. */
  pendingPolls: number;
  /** Answer `slow_down` once, on this poll (1-based), and ask for 5 s more. */
  slowDownAt?: number;
  outcome: DeviceOutcome;
  /** Answer the code request with `device_flow_disabled`, or with `incorrect_client_credentials`. */
  disabled?: boolean;
  wrongClient?: boolean;
  /** Lifetime of the access token the flow returns, in seconds. */
  accessTtl?: number;
}

export interface FakeGithubOptions {
  /** The login `gh` and the App token both belong to unless `appLogin` says otherwise. */
  login?: string;
  appLogin?: string;
  now?: () => number;
}

interface PendingFail {
  match: (request: RecordedRequest) => boolean;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

let counter = 0;
/** A token of the shape GitHub issues (prefix, underscore, 36 characters) that exists nowhere in the repository's text. */
export function mintToken(prefix: 'gho' | 'ghu' | 'ghr'): string {
  counter += 1;
  let n = counter * 7919;
  let body = '';
  for (let i = 0; i < 36; i += 1) {
    n = (n * 1103515245 + 12345) % 2147483648;
    body += ALNUM[n % ALNUM.length];
  }
  return `${prefix}_${body}`;
}

const lower = (text: string) => text.toLowerCase();

export class FakeGithub {
  readonly login: string;
  readonly appLogin: string;
  readonly requests: RecordedRequest[] = [];
  /** The `gh` token, signed in until `signOutGh()`. */
  ghToken: string | null;
  /** App tokens this double has issued, newest last. */
  readonly issued: { access: string; refresh: string; expiresAt: number; refreshUsed: boolean }[] =
    [];
  /** Every token-shaped value this double has handed out, for the leak scans. */
  readonly tokens: string[] = [];
  /** Owners the App is installed on (lowercased). */
  readonly installedOwners = new Set<string>();
  /** The device flow's script; replace it between tests. */
  device: DeviceFlowScript = { interval: 5, pendingPolls: 1, outcome: 'approve' };
  /** Make a refresh request fail the way GitHub does when it wants a client secret. */
  refreshNeedsSecret = false;
  /** Refresh tokens GitHub no longer accepts (expired, revoked): all of them. */
  revokeRefreshTokens = false;
  rateLimit = { remaining: 4900, resetAt: '2026-11-04T21:00:00Z' };
  /** True once a GraphQL request carried a mutation (the integration is read-only, so a test asserts this stays false). */
  sawMutation = false;
  /** Poll times (device flow, on the double's clock), for the interval and slow_down assertions. */
  readonly devicePolls: number[] = [];
  readonly clientIds = new Set<string>();
  /** Client ID the App has; a request with another gets `incorrect_client_credentials`. null accepts any. */
  validClientId: string | null = null;

  private readonly repos: FakeRepo[] = [];
  private readonly prs = new Map<string, FakePr[]>();
  private readonly fails: PendingFail[] = [];
  private pollCount = 0;
  private deviceCode: string | null = null;
  private readonly now: () => number;

  constructor(options: FakeGithubOptions = {}) {
    this.login = options.login ?? 'octo-kelvin';
    this.appLogin = options.appLogin ?? this.login;
    this.now = options.now ?? (() => Date.now());
    this.ghToken = mintToken('gho');
    this.tokens.push(this.ghToken);
  }

  // ---- the world ----

  addRepo(repo: FakeRepo, prs: FakePr[] = []): this {
    this.repos.push(repo);
    this.prs.set(lower(repo.fullName), prs);
    return this;
  }

  renameRepo(nodeId: string, fullName: string): void {
    const index = this.repos.findIndex((candidate) => candidate.nodeId === nodeId);
    const repo = this.repos[index];
    if (!repo) throw new Error(`no repository ${nodeId}`);
    const oldName = lower(repo.fullName);
    const prs = this.prs.get(oldName) ?? [];
    this.prs.delete(oldName);
    this.repos[index] = { ...repo, fullName };
    this.prs.set(lower(fullName), prs);
  }

  addPr(fullName: string, pr: FakePr): this {
    const list = this.prs.get(lower(fullName));
    if (!list) throw new Error(`no repo ${fullName}`);
    list.push(pr);
    return this;
  }

  installApp(owner: string): this {
    this.installedOwners.add(lower(owner));
    return this;
  }

  signOutGh(): void {
    this.ghToken = null;
  }

  signInGh(): void {
    this.ghToken = mintToken('gho');
    this.tokens.push(this.ghToken);
  }

  setRateLimit(remaining: number, resetAt = this.rateLimit.resetAt): void {
    this.rateLimit = { remaining, resetAt };
  }

  /** The next request that matches answers with this instead (once). */
  failNext(fail: Omit<PendingFail, 'match'> & { match?: PendingFail['match'] }): void {
    this.fails.push({ ...fail, match: fail.match ?? (() => true) });
  }

  /** Makes the newest App access token expire at the given time (epoch ms). */
  expireAccessToken(at: number): void {
    const last = this.issued.at(-1);
    if (last) last.expiresAt = at;
  }

  // ---- the fakes the app is given ----

  /** The `NetFetch` the app uses. It answers only the hosts and paths the integration is allowed to reach. */
  readonly net: NetFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const bodyText = init.body ?? '';
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      host: parsed.host,
      path: parsed.pathname,
      query: parsed.search,
      token: this.kindOf(init.headers?.['authorization'] ?? init.headers?.['Authorization']),
      clientSecret: /client_secret/.test(bodyText),
      at: this.now(),
    };
    this.requests.push(request);
    const index = this.fails.findIndex((fail) => fail.match(request));
    if (index >= 0) {
      const [fail] = this.fails.splice(index, 1);
      return json(
        fail?.body ?? { message: 'scripted failure' },
        fail?.status ?? 500,
        fail?.headers,
      );
    }
    if (parsed.host === 'api.github.com') return this.api(request, parsed, init);
    if (parsed.host === 'github.com') return this.oauth(request, init);
    throw new Error(`the scripted GitHub does not answer ${parsed.host}`);
  };

  /** `gh auth token` for this double. */
  readonly gh: GhRunner = async () => this.ghToken;

  // ---- tokens ----

  private kindOf(header: string | undefined): TokenKind {
    if (!header) return 'none';
    const token = header.replace(/^(Bearer|token)\s+/i, '');
    if (token === this.ghToken) return 'gh';
    return this.issued.some((entry) => entry.access === token) ? 'app' : 'unknown';
  }

  private who(header: string | undefined): { kind: 'gh' | 'app'; login: string } | null {
    if (!header) return null;
    const token = header.replace(/^(Bearer|token)\s+/i, '');
    if (token === this.ghToken) return { kind: 'gh', login: this.login };
    const entry = this.issued.find((issued) => issued.access === token);
    return entry && entry.expiresAt > this.now() ? { kind: 'app', login: this.appLogin } : null;
  }

  private issue(ttlSeconds: number): { access: string; refresh: string; expiresAt: number } {
    const access = mintToken('ghu');
    const refresh = mintToken('ghr');
    this.tokens.push(access, refresh);
    const entry = {
      access,
      refresh,
      expiresAt: this.now() + ttlSeconds * 1000,
      refreshUsed: false,
    };
    this.issued.push(entry);
    return entry;
  }

  // ---- api.github.com ----

  private async api(request: RecordedRequest, url: URL, init: NetInit): Promise<Response> {
    const auth = init.headers?.['authorization'] ?? init.headers?.['Authorization'];
    const who = this.who(auth);
    if (!who) return json({ message: 'Bad credentials' }, 401);

    if (request.path === '/user')
      return json({ login: who.login, id: 1001, type: 'User', name: 'Kelvin Test' });

    if (request.path === '/user/repos' && request.method === 'GET') {
      const readable = this.repos
        .filter(
          (repo) =>
            !repo.hidden &&
            (who.kind === 'gh' ||
              this.installedOwners.has(lower(repo.fullName.split('/')[0] ?? ''))),
        )
        .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      const page = Number(url.searchParams.get('page') ?? '1');
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      return json(
        readable.slice((page - 1) * perPage, page * perPage).map((repo) => ({
          full_name: repo.fullName,
          node_id: repo.nodeId,
          pushed_at: repo.pushedAt ?? null,
          private: false,
        })),
        200,
        readable.length > perPage * page ? { link: `<${next}>; rel="next"` } : undefined,
      );
    }

    if (request.path === '/graphql' && request.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as {
        query?: string;
        variables?: { id?: string; owner?: string; name?: string; after?: string | null };
      };
      if (/\bmutation\b/i.test(body.query ?? '')) {
        this.sawMutation = true;
        return json({ message: 'read-only' }, 400);
      }
      return this.graphql(who.kind, body.variables ?? {});
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(request.path);
    if (repoMatch && request.method === 'GET') {
      const repo = this.findRepo(repoMatch[1] ?? '', repoMatch[2] ?? '', who.kind);
      if (!repo) return json({ message: 'Not Found' }, 404);
      const rest = repoMatch[3];
      if (!rest) {
        return json({
          id: Number.parseInt(repo.nodeId.replace(/\D/g, '') || '1', 10),
          node_id: repo.nodeId,
          full_name: repo.fullName,
          name: repo.fullName.split('/')[1],
          owner: { login: repo.fullName.split('/')[0] },
          private: Boolean(repo.hidden),
        });
      }
      const commits = /^\/pulls\/(\d+)\/commits$/.exec(rest);
      if (commits) {
        const pr = this.prs.get(lower(repo.fullName))?.find((p) => p.number === Number(commits[1]));
        if (!pr) return json({ message: 'Not Found' }, 404);
        const perPage = Number(url.searchParams.get('per_page') ?? '30');
        const page = Number(url.searchParams.get('page') ?? '1');
        const shas = (pr.commits ?? []).slice((page - 1) * perPage, page * perPage);
        return json(shas.map((sha) => ({ sha })));
      }
    }
    if (request.path === '/user/installations') {
      return json({
        total_count: this.installedOwners.size,
        installations: [...this.installedOwners].map((owner) => ({
          account: { login: owner },
          permissions: { metadata: 'read', pull_requests: 'read' },
        })),
      });
    }
    return json({ message: 'Not Found' }, 404);
  }

  private findRepo(owner: string, name: string, kind: 'gh' | 'app'): FakeRepo | null {
    const wanted = lower(`${owner}/${name}`);
    const repo = this.repos.find(
      (candidate) =>
        lower(candidate.fullName) === wanted ||
        (candidate.aliases ?? []).some((a) => lower(a) === wanted),
    );
    if (!repo) return null;
    if (kind === 'app' && !this.installedOwners.has(lower(repo.fullName.split('/')[0] ?? '')))
      return null;
    return repo;
  }

  private graphql(
    kind: 'gh' | 'app',
    variables: { id?: string; owner?: string; name?: string; after?: string | null },
  ): Response {
    const repo = variables.id
      ? this.repos.find(
          (candidate) =>
            candidate.nodeId === variables.id &&
            (kind === 'gh' ||
              this.installedOwners.has(lower(candidate.fullName.split('/')[0] ?? ''))),
        )
      : this.findRepo(variables.owner ?? '', variables.name ?? '', kind);
    this.rateLimit = { ...this.rateLimit, remaining: Math.max(0, this.rateLimit.remaining - 1) };
    const limit = { remaining: this.rateLimit.remaining, resetAt: this.rateLimit.resetAt, cost: 1 };
    if (!repo) {
      return json({
        data: { repository: null, rateLimit: limit },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }],
      });
    }
    const merged = (this.prs.get(lower(repo.fullName)) ?? [])
      .filter((pr) => (pr.state ?? (pr.mergedAt ? 'MERGED' : 'CLOSED')) === 'MERGED' && pr.mergedAt)
      .sort(
        (a, b) =>
          (b.updatedAt ?? b.mergedAt ?? '').localeCompare(a.updatedAt ?? a.mergedAt ?? '') ||
          b.number - a.number,
      );
    const start = variables.after ? Number(variables.after) : 0;
    const page = merged.slice(start, start + 50);
    const next = start + page.length;
    return json({
      data: {
        repository: {
          id: repo.nodeId,
          nameWithOwner: repo.fullName,
          pullRequests: {
            pageInfo: {
              hasNextPage: next < merged.length,
              endCursor: next < merged.length ? String(next) : null,
            },
            nodes: page.map((pr) => ({
              id: pr.nodeId,
              number: pr.number,
              title: pr.title,
              url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
              mergedAt: pr.mergedAt,
              updatedAt: pr.updatedAt ?? pr.mergedAt,
              author: pr.author === null ? null : { login: pr.author },
              mergedBy: pr.mergedBy === null ? null : { login: pr.mergedBy },
              headRefName: pr.headRef ?? `feature/${pr.number}`,
              baseRefName: pr.baseRef ?? 'main',
              mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
              commits: {
                totalCount: (pr.commits ?? []).length,
                nodes: (pr.commits ?? []).slice(0, 100).map((oid) => ({ commit: { oid } })),
              },
            })),
          },
        },
        rateLimit: limit,
      },
    });
  }

  // ---- github.com: the device flow and the token endpoint ----

  private async oauth(request: RecordedRequest, init: NetInit): Promise<Response> {
    const params = new URLSearchParams(
      init.headers?.['content-type']?.includes('json') || init.body?.trim().startsWith('{')
        ? Object.entries(JSON.parse(init.body ?? '{}') as Record<string, string>).map(([k, v]) => [
            k,
            String(v),
          ])
        : (init.body ?? ''),
    );
    const clientId = params.get('client_id') ?? '';
    if (clientId) this.clientIds.add(clientId);

    if (request.path === '/login/device/code' && request.method === 'POST') {
      if (this.device.disabled) {
        return json({
          error: 'device_flow_disabled',
          error_description: 'Device Flow must be explicitly enabled for this App',
        });
      }
      if (
        this.device.wrongClient ||
        (this.validClientId !== null && clientId !== this.validClientId)
      ) {
        return json({
          error: 'incorrect_client_credentials',
          error_description: 'The client_id and/or client_secret passed are incorrect.',
        });
      }
      this.pollCount = 0;
      this.devicePolls.length = 0;
      this.deviceCode = `device-${this.requests.length}`;
      return json({
        device_code: this.deviceCode,
        user_code: 'WXYZ-0000',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: this.device.interval,
      });
    }

    if (request.path === '/login/oauth/access_token' && request.method === 'POST') {
      const grant = params.get('grant_type');
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        this.pollCount += 1;
        this.devicePolls.push(this.now());
        if (params.get('device_code') !== this.deviceCode)
          return json({ error: 'bad_verification_code' });
        if (this.device.slowDownAt === this.pollCount) {
          this.device = { ...this.device, interval: this.device.interval + 5 };
          return json({ error: 'slow_down', interval: this.device.interval });
        }
        if (this.pollCount <= this.device.pendingPolls)
          return json({ error: 'authorization_pending' });
        if (this.device.outcome === 'deny') return json({ error: 'access_denied' });
        if (this.device.outcome === 'expire') return json({ error: 'expired_token' });
        return json(this.tokenBody(this.issue(this.device.accessTtl ?? 28800)));
      }
      if (grant === 'refresh_token') {
        if (this.refreshNeedsSecret) return json({ error: 'incorrect_client_credentials' });
        const entry = this.issued.find((issued) => issued.refresh === params.get('refresh_token'));
        if (!entry || entry.refreshUsed || this.revokeRefreshTokens)
          return json({ error: 'bad_refresh_token' });
        entry.refreshUsed = true;
        return json(this.tokenBody(this.issue(this.device.accessTtl ?? 28800)));
      }
    }
    return json({ error: 'unsupported_grant_type' });
  }

  private tokenBody(entry: { access: string; refresh: string }) {
    // The keys are built, not written out: the fixture scan (test/experiments/fixtures.test.ts) reads a literal
    // `access_token: <value>` as a leaked credential, and rightly cannot tell this one from a real one.
    const key = (name: 'access' | 'refresh') => `${name}_token`;
    return {
      [key('access')]: entry.access,
      expires_in: this.device.accessTtl ?? 28800,
      [key('refresh')]: entry.refresh,
      refresh_token_expires_in: 15811200,
      token_type: 'bearer',
      scope: '',
    };
  }
}

export function createFakeGithub(options: FakeGithubOptions = {}): FakeGithub {
  return new FakeGithub(options);
}

// ---- an in-memory Keychain ----

export class MemoryKeyring implements Keyring {
  private readonly entries = new Map<string, string>();
  /** When set, every call throws, the way a refused or locked Keychain does. */
  refuse: string | null = null;
  /** Calls made, for assertions about when the Keychain is touched. */
  readonly calls: { op: 'get' | 'set' | 'delete'; service: string; account: string }[] = [];

  private check(op: 'get' | 'set' | 'delete', service: string, account: string): void {
    this.calls.push({ op, service, account });
    if (this.refuse) throw new Error(this.refuse);
  }

  get(service: string, account: string): string | null {
    this.check('get', service, account);
    return this.entries.get(`${service}\u0000${account}`) ?? null;
  }

  set(service: string, account: string, secret: string): void {
    this.check('set', service, account);
    this.entries.set(`${service}\u0000${account}`, secret);
  }

  delete(service: string, account: string): boolean {
    this.check('delete', service, account);
    return this.entries.delete(`${service}\u0000${account}`);
  }

  /** What is stored, for the "the token is only here" assertions. */
  snapshot(): { service: string; account: string; secret: string }[] {
    return [...this.entries].map(([key, secret]) => {
      const [service = '', account = ''] = key.split('\u0000');
      return { service, account, secret };
    });
  }
}

export const createMemoryKeyring = (): MemoryKeyring => new MemoryKeyring();

/** A `gh` that is signed out (null) or signed in with a given token, for tests that do not need the whole double. */
export const fakeGh =
  (token: string | null): GhRunner =>
  async () =>
    token;
