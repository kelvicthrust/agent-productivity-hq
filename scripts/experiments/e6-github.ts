import { setTimeout as sleep } from 'node:timers/promises';
import { UsageError } from './lib/args.ts';
import { defineExperiment, runIfMain } from './lib/cli.ts';
import { safeText } from './lib/redact.ts';
import type { ExperimentContext } from './lib/types.ts';

// E6 · GitHub access, both routes (TECH › Feasibility experiments, data-and-sources › GitHub delivery).
//
// The gh route runs first: `gh auth token --hostname github.com`, then `GET /user` and the merged-PR GraphQL query. The App route runs next, only
// when --client-id is given: device flow, a round trip through the macOS Keychain, the same query with the App's token,
// a refresh with no client secret, and two repositories the App cannot read.
//
// Tokens live in local variables and request headers only. They are never printed, recorded, or put in an error: the
// findings carry booleans, HTTP statuses and counts. The one-time device code is the only value shown from a response,
// because the owner has to type it on github.com; it is checked against its fixed shape before it is printed.

const API = 'https://api.github.com';
const OAUTH = 'https://github.com';
const KEYRING_SERVICE = 'agent-productivity';
/** Not the product's own account name (`github-app-user-token`), so a later real connection is never overwritten. */
const KEYRING_ACCOUNT = 'github-app-user-token.e6-experiment';
const REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const CLIENT_ID = /^Iv[0-9A-Za-z.]{6,40}$/;
const REQUIRED_PERMISSIONS = ['metadata', 'pull_requests'];

const MERGED_PRS = `query MergedPRs($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title url mergedAt updatedAt
        author { login } mergedBy { login }
        headRefName baseRefName mergeCommit { oid }
        commits(first: 100) { totalCount nodes { commit { oid } } }
      }
    }
  }
  rateLimit { remaining resetAt cost }
}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const dig = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), value);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// ---------------------------------------------------------------------------------------------------------------------
// The keyring, as an injectable. `native` is the real macOS Keychain through @napi-rs/keyring. `memory` is the self-test's
// in-memory store. `unavailable` stands in for a native binary that cannot load (the self-test's failure case).

export interface KeyringEntry {
  set(secret: string): void;
  get(): string | null;
  remove(): boolean;
}
type KeyringMode = 'native' | 'memory' | 'unavailable';

async function openKeyring(mode: KeyringMode): Promise<KeyringEntry> {
  if (mode === 'unavailable') throw new Error('the keyring binary is not available');
  if (mode === 'memory') {
    let stored: string | null = null;
    return {
      set: (secret) => {
        stored = secret;
      },
      get: () => stored,
      remove: () => {
        const had = stored !== null;
        stored = null;
        return had;
      },
    };
  }
  const { Entry } = await import('@napi-rs/keyring');
  const entry = new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
  return {
    set: (secret) => entry.setPassword(secret),
    get: () => entry.getPassword(),
    remove: () => entry.deletePassword(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP. Every request goes through ctx.fetch, which allows only the hosts in meta.network and, with --net-fixture, answers
// from a file. The token is passed in and only ever placed in the Authorization header.

interface Answer {
  status: number;
  body: unknown;
}

async function request(
  ctx: ExperimentContext,
  method: 'GET' | 'POST',
  url: string,
  options: { token?: string | null; json?: unknown; oauth?: boolean } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    Accept: options.oauth ? 'application/json' : 'application/vnd.github+json',
    'User-Agent': 'agent-productivity-e6',
  };
  if (!options.oauth) headers['X-GitHub-Api-Version'] = '2022-11-28';
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await ctx.fetch(url, {
    method,
    headers,
    ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
  });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

interface PrPage {
  ok: boolean;
  status: number;
  prs: number;
  withCommits: number;
  commits: number;
  remaining: number | null;
}

/** The merged-PR query from data-and-sources, one page, reduced to counts. */
async function mergedPrs(ctx: ExperimentContext, token: string, repo: string): Promise<PrPage> {
  const [owner, name] = repo.split('/');
  const answer = await request(ctx, 'POST', `${API}/graphql`, {
    token,
    json: { query: MERGED_PRS, variables: { owner, name, after: null } },
  });
  const nodes = dig(answer.body, 'data', 'repository', 'pullRequests', 'nodes');
  const list = Array.isArray(nodes) ? nodes : [];
  const withCommits = list.filter((n) => Array.isArray(dig(n, 'commits', 'nodes'))).length;
  const commits = list.reduce<number>(
    (sum, n) => sum + (num(dig(n, 'commits', 'totalCount')) ?? 0),
    0,
  );
  return {
    ok: answer.status === 200 && list.length > 0 && withCommits === list.length,
    status: answer.status,
    prs: list.length,
    withCommits,
    commits,
    remaining: num(dig(answer.body, 'data', 'rateLimit', 'remaining')),
  };
}

function recordPage(ctx: ExperimentContext, section: string, page: PrPage): void {
  ctx.findings.fact(section, 'GraphQL HTTP status', page.status);
  ctx.findings.fact(section, 'merged PRs returned', page.prs);
  ctx.findings.fact(section, 'PRs with a commit list', page.withCommits);
  ctx.findings.fact(section, 'commits counted by totalCount', page.commits);
  if (page.remaining !== null) ctx.findings.fact(section, 'rate limit remaining', page.remaining);
}

function parseRepo(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!REPO.test(value)) throw new UsageError(`--${flag} must look like owner/name`);
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// gh route

interface GhResult {
  token: string | null;
  login: string | null;
}

async function ghRoute(ctx: ExperimentContext, repo: string | undefined): Promise<GhResult> {
  const none: GhResult = { token: null, login: null };
  const version = await ctx.spawn('gh', ['--version'], { timeoutMs: 10_000 });
  if (!version.found) {
    ctx.findings.fact('gh route', 'gh installed', false);
    ctx.findings.criterion('gh-token-and-login', 'not-run', 'gh is not installed here.');
    ctx.findings.criterion('gh-graphql-merged-prs', 'not-run', 'gh is not installed here.');
    ctx.out.line('gh is not installed here: the gh route was skipped.');
    return none;
  }
  ctx.findings.fact('gh route', 'gh installed', true);
  const v = version.stdout.match(/gh version (\d+\.\d+\.\d+)/)?.[1];
  if (v) ctx.findings.tool('gh', v);

  // The token is held in this variable only. It is never printed, recorded or put in a message.
  // The same arguments the product runs (collectors/github/live.ts), so this proves what the product will ask `gh` for.
  const auth = await ctx.spawn('gh', ['auth', 'token', '--hostname', 'github.com'], {
    timeoutMs: 10_000,
  });
  const token =
    auth.status === 0 && /^\S{8,300}$/.test(auth.stdout.trim()) ? auth.stdout.trim() : null;
  ctx.findings.fact('gh route', 'gh auth token returned a token', token !== null);
  if (token === null) {
    ctx.findings.criterion(
      'gh-token-and-login',
      'fail',
      'gh auth token returned no token: gh is not signed in, so the App route would be used.',
    );
    ctx.out.line('gh route: gh auth token returned no token.');
    return none;
  }

  const user = await request(ctx, 'GET', `${API}/user`, { token });
  const login = text(dig(user.body, 'login'));
  ctx.findings.fact('gh route', 'GET /user HTTP status', user.status);
  ctx.findings.fact('gh route', 'GET /user returned a login', login !== null);
  ctx.out.line(safeText`gh route: token read (not shown); GET /user answered ${user.status}.`);
  if (user.status !== 200 || login === null) {
    ctx.findings.criterion(
      'gh-token-and-login',
      'fail',
      safeText`GET /user answered ${user.status}${user.status === 200 ? ' without a login' : ''}, so the gh token cannot be used.`,
    );
    return none;
  }
  ctx.findings.criterion(
    'gh-token-and-login',
    'pass',
    'gh auth token returned a token (not shown) and GET /user answered 200 with a login.',
  );

  if (!repo) {
    ctx.findings.criterion(
      'gh-graphql-merged-prs',
      'not-run',
      'Pass --repo owner/name (one private tracked repository) to run the query.',
    );
    return { token, login };
  }
  const page = await mergedPrs(ctx, token, repo);
  recordPage(ctx, 'gh route GraphQL', page);
  ctx.out.line(safeText`gh route: GraphQL answered ${page.status} with ${page.prs} merged PRs.`);
  ctx.findings.criterion(
    'gh-graphql-merged-prs',
    page.ok ? 'pass' : 'fail',
    page.ok
      ? safeText`${page.prs} merged PRs came back, each with a commit list (${page.commits} commits counted).`
      : safeText`GraphQL answered ${page.status} with ${page.prs} merged PRs, ${page.withCommits} of them with a commit list.`,
  );
  return { token, login };
}

// ---------------------------------------------------------------------------------------------------------------------
// App route

interface Tokens {
  access: string;
  refresh: string | null;
  expiresIn: number;
  refreshExpiresIn: number;
}

type DeviceOutcome = { kind: 'ok'; tokens: Tokens } | { kind: 'denied' | 'expired' | 'failed' };

const secretJson = (tokens: Tokens, nowMs: number): string =>
  JSON.stringify({
    access_token: tokens.access,
    expires_at: Math.floor(nowMs / 1000) + tokens.expiresIn,
    refresh_token: tokens.refresh,
    refresh_expires_at: Math.floor(nowMs / 1000) + tokens.refreshExpiresIn,
  });

function readTokens(body: unknown): Tokens | null {
  const access = text(dig(body, 'access_token'));
  if (!access) return null;
  return {
    access,
    refresh: text(dig(body, 'refresh_token')),
    expiresIn: num(dig(body, 'expires_in')) ?? 0,
    refreshExpiresIn: num(dig(body, 'refresh_token_expires_in')) ?? 0,
  };
}

async function deviceFlow(ctx: ExperimentContext, clientId: string): Promise<DeviceOutcome> {
  const start = await request(ctx, 'POST', `${OAUTH}/login/device/code`, {
    oauth: true,
    json: { client_id: clientId },
  });
  const deviceCode = text(dig(start.body, 'device_code'));
  const userCode = text(dig(start.body, 'user_code'));
  const uri = text(dig(start.body, 'verification_uri'));
  ctx.findings.fact('App route', 'device code request HTTP status', start.status);
  if (start.status !== 200 || !deviceCode || !userCode || !uri) return { kind: 'failed' };
  // The owner must type this code on github.com. It is a one-time pairing code, not a credential; its fixed shape and the
  // fixed address are checked first so nothing else from the response can reach the terminal.
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode) || uri !== `${OAUTH}/login/device`)
    return { kind: 'failed' };
  ctx.out.line(
    `Open ${uri} and enter the one-time code ${userCode} (use the GitHub account that owns the App's installation).`,
  );

  let interval = num(dig(start.body, 'interval')) ?? 5;
  const expiresIn = num(dig(start.body, 'expires_in')) ?? 900;
  const override = ctx.args.get('poll-interval-ms');
  let waited = 0;
  let polls = 0;
  let slowedDown = false;
  while (waited < expiresIn && polls < 200) {
    await sleep(override !== undefined ? Number(override) : interval * 1000);
    waited += interval;
    polls++;
    const poll = await request(ctx, 'POST', `${OAUTH}/login/oauth/access_token`, {
      oauth: true,
      json: {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
    });
    const error = text(dig(poll.body, 'error'));
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      slowedDown = true;
      interval = (num(dig(poll.body, 'interval')) ?? interval) + 5;
      continue;
    }
    ctx.findings.fact('Device flow', 'polls made', polls);
    ctx.findings.fact('Device flow', 'slow_down seen', slowedDown);
    if (error === 'access_denied') return { kind: 'denied' };
    if (error === 'expired_token') return { kind: 'expired' };
    const tokens = poll.status === 200 && !error ? readTokens(poll.body) : null;
    if (!tokens) return { kind: 'failed' };
    ctx.findings.fact('Device flow', 'token lifetime in seconds', tokens.expiresIn);
    ctx.findings.fact('Device flow', 'refresh token issued', tokens.refresh !== null);
    ctx.findings.fact('Device flow', 'refresh token lifetime in seconds', tokens.refreshExpiresIn);
    return { kind: 'ok', tokens };
  }
  ctx.findings.fact('Device flow', 'polls made', polls);
  return { kind: 'expired' };
}

async function appRoute(
  ctx: ExperimentContext,
  options: {
    clientId: string;
    repo: string | undefined;
    uninstalled: string | undefined;
    inaccessible: string | undefined;
    keyringMode: KeyringMode;
    ghLogin: string | null;
  },
): Promise<void> {
  const { clientId, repo, uninstalled, inaccessible, keyringMode, ghLogin } = options;

  // 2a. The native binary. Independent of the sign-in, so it is checked first.
  let entry: KeyringEntry | null = null;
  // Only an entry this run wrote is removed at the end: a run that never stored anything never touches the Keychain.
  let wroteEntry = false;
  try {
    entry = await openKeyring(keyringMode);
    ctx.findings.fact('Keychain', 'keyring binary loaded', true);
    ctx.findings.fact('Keychain', 'keyring mode', keyringMode);
    ctx.findings.criterion(
      'keyring-binary-loads',
      'pass',
      safeText`The @napi-rs/keyring native binary loaded (${keyringMode}).`,
    );
  } catch {
    ctx.findings.fact('Keychain', 'keyring binary loaded', false);
    ctx.findings.criterion(
      'keyring-binary-loads',
      'fail',
      'The @napi-rs/keyring native binary did not load here. Return to the owner before choosing another store.',
    );
  }

  try {
    // 1. Device flow.
    const device = await deviceFlow(ctx, clientId);
    if (device.kind !== 'ok') {
      ctx.findings.criterion(
        'app-device-flow',
        'fail',
        safeText`The device flow ended as ${device.kind}, so no token was issued.`,
      );
      return;
    }
    let tokens = device.tokens;
    ctx.findings.criterion(
      'app-device-flow',
      'pass',
      'The device flow completed and GitHub issued a token pair (not shown).',
    );

    // 2b. Keychain round trip with the real JSON secret shape.
    if (entry) {
      ctx.out.line(
        keyringMode === 'native'
          ? `Will write only one temporary Keychain entry (${KEYRING_SERVICE} / ${KEYRING_ACCOUNT}), read it back, and delete it.`
          : 'Will keep the token pair in this process only (self-test keyring, no Keychain).',
      );
      try {
        const secret = secretJson(tokens, ctx.now());
        wroteEntry = true; // set before the write: a write that fails half way still gets a cleanup attempt
        entry.set(secret);
        const back = entry.get();
        ctx.findings.fact('Keychain', 'read back equal to what was stored', back === secret);
        ctx.findings.criterion(
          'keychain-round-trip',
          back === secret ? 'pass' : 'fail',
          back === secret
            ? 'The token JSON was stored in the Keychain and read back unchanged.'
            : 'The value read back from the Keychain differs from what was stored.',
        );
      } catch {
        ctx.findings.criterion(
          'keychain-round-trip',
          'fail',
          'The Keychain refused the write or the read (a locked keychain or a declined prompt).',
        );
      }
    } else {
      ctx.findings.criterion('keychain-round-trip', 'not-run', 'The keyring binary did not load.');
    }

    // Who the App token belongs to, compared with the gh login without ever printing either.
    const me = await request(ctx, 'GET', `${API}/user`, { token: tokens.access });
    const appLogin = text(dig(me.body, 'login'));
    ctx.findings.fact('App route', 'GET /user HTTP status', me.status);
    if (ghLogin !== null && appLogin !== null)
      ctx.findings.fact('App route', 'same login as the gh route', ghLogin === appLogin);

    // 3. The same query with only Pull requests and Metadata read permissions.
    if (!repo) {
      ctx.findings.criterion(
        'app-minimal-permissions',
        'not-run',
        'Pass --repo owner/name to run the query with the App token.',
      );
    } else {
      const page = await mergedPrs(ctx, tokens.access, repo);
      recordPage(ctx, 'App route GraphQL', page);
      const installs = await request(ctx, 'GET', `${API}/user/installations`, {
        token: tokens.access,
      });
      const list = dig(installs.body, 'installations');
      const permissions = (Array.isArray(list) ? list : [])
        .map((i) => dig(i, 'permissions'))
        .filter(isRecord);
      const granted = [...new Set(permissions.flatMap((p) => Object.keys(p)))].sort();
      const extra = granted.filter((p) => !REQUIRED_PERMISSIONS.includes(p));
      const readOnly = permissions.every((p) => REQUIRED_PERMISSIONS.every((r) => p[r] === 'read'));
      ctx.findings.fact(
        'App permissions',
        'installations visible to the token',
        permissions.length,
      );
      ctx.findings.fact(
        'App permissions',
        'permission names granted',
        granted.length > 0 ? granted : ['none'],
      );
      ctx.findings.fact(
        'App permissions',
        'permissions beyond the two required',
        extra.length > 0 ? extra : ['none'],
      );
      const minimal = page.ok && permissions.length > 0 && extra.length === 0 && readOnly;
      ctx.findings.criterion(
        'app-minimal-permissions',
        minimal ? 'pass' : 'fail',
        minimal
          ? safeText`The query returned ${page.prs} merged PRs with commits, and the App holds only metadata and pull_requests read.`
          : !page.ok
            ? safeText`The query did not work with the App token (HTTP ${page.status}, ${page.prs} PRs).`
            : permissions.length === 0
              ? 'No installation of the App is visible to this token, so its permissions could not be read.'
              : safeText`The App holds permissions beyond the two required (${extra.length > 0 ? extra : ['none']}) or one of the two is not read-only.`,
      );
    }

    // 4. A forced refresh with no client secret.
    if (!tokens.refresh) {
      ctx.findings.criterion(
        'app-refresh-no-secret',
        'not-run',
        'GitHub issued no refresh token: expiring user tokens are off for this App, so there is nothing to refresh.',
      );
    } else {
      const refreshed = await request(ctx, 'POST', `${OAUTH}/login/oauth/access_token`, {
        oauth: true,
        json: { client_id: clientId, grant_type: 'refresh_token', refresh_token: tokens.refresh },
      });
      const error = text(dig(refreshed.body, 'error'));
      const next = refreshed.status === 200 && !error ? readTokens(refreshed.body) : null;
      ctx.findings.fact('Refresh', 'HTTP status', refreshed.status);
      if (!next || !next.refresh) {
        ctx.findings.criterion(
          'app-refresh-no-secret',
          'fail',
          error
            ? safeText`The refresh without a client secret was refused (${error}).`
            : safeText`The refresh answered ${refreshed.status} without a new token pair.`,
        );
      } else {
        const rotatedBoth = next.access !== tokens.access && next.refresh !== tokens.refresh;
        ctx.findings.fact('Refresh', 'both tokens rotated', rotatedBoth);
        tokens = next;
        // Identifier-shaped outcome words, so they can be recorded as they are.
        let stored = 'not-stored-no-keyring';
        if (entry) {
          try {
            const secret = secretJson(tokens, ctx.now());
            entry.set(secret);
            stored = entry.get() === secret ? 'replaced-and-read-back' : 'read-back-differs';
          } catch {
            stored = 'keychain-refused';
          }
          ctx.findings.fact('Refresh', 'rotated pair stored', stored);
        }
        ctx.findings.criterion(
          'app-refresh-no-secret',
          rotatedBoth ? 'pass' : 'fail',
          rotatedBoth
            ? safeText`A refresh with no client secret succeeded and rotated both tokens; Keychain: ${stored}.`
            : 'The refresh succeeded but did not rotate both tokens.',
        );
      }
    }

    // 5 and 6. Repositories the App cannot read, with the (possibly refreshed) token.
    const repoStatus = async (target: string): Promise<number> =>
      (await request(ctx, 'GET', `${API}/repos/${target}`, { token: tokens.access })).status;
    if (!uninstalled) {
      ctx.findings.criterion(
        'app-uninstalled-owner-404',
        'not-run',
        'Pass --uninstalled-repo owner/name: a repo you can read whose owner has not installed the App.',
      );
    } else {
      const status = await repoStatus(uninstalled);
      ctx.findings.fact('Uninstalled owner', 'GET /repos HTTP status', status);
      ctx.findings.criterion(
        'app-uninstalled-owner-404',
        status === 404 ? 'pass' : 'fail',
        status === 404
          ? 'The repo answered 404 with the App token, which the product maps to the install message.'
          : safeText`The repo answered ${status}, not the 404 the install message relies on.`,
      );
    }
    if (!inaccessible) {
      ctx.findings.criterion(
        'app-inaccessible-repo',
        'not-run',
        'Pass --inaccessible-repo owner/name: a repo you cannot read at all.',
      );
    } else {
      const status = await repoStatus(inaccessible);
      ctx.findings.fact('Inaccessible repo', 'GET /repos HTTP status', status);
      const handled = status === 404 || status === 403;
      ctx.findings.criterion(
        'app-inaccessible-repo',
        handled ? 'pass' : 'fail',
        handled
          ? safeText`The repo answered ${status} and no data, which the product shows as inaccessible (P-16).`
          : safeText`The repo answered ${status}, not the 404 or 403 that means inaccessible.`,
      );
    }
  } finally {
    if (entry && wroteEntry) {
      try {
        ctx.findings.fact('Keychain', 'temporary entry removed', entry.remove());
      } catch {
        ctx.findings.note(
          'The temporary Keychain entry could not be removed; delete it in Keychain Access.',
        );
      }
    }
  }
}

export const experiment = defineExperiment({
  meta: {
    id: 'E6',
    script: 'scripts/experiments/e6-github.ts',
    title: 'GitHub access, both routes',
    question:
      'Can the dashboard read merged PRs with commits for a private tracked repo through the gh route and through a GitHub App, including device flow, the Keychain, refresh without a client secret and the two 404 cases?',
    criteria: [
      {
        id: 'gh-token-and-login',
        text: '**gh route:** `gh auth token` returns a token and `GET /user` returns a `login`.',
      },
      {
        id: 'gh-graphql-merged-prs',
        text: '**gh route:** the GraphQL query returns merged PRs, with commits, for one private tracked repo.',
      },
      { id: 'app-device-flow', text: '**App route 1:** the device flow completes.' },
      {
        id: 'keyring-binary-loads',
        text: '**App route 2:** the `@napi-rs/keyring` native binary loads on Node 26 (arm64).',
      },
      {
        id: 'keychain-round-trip',
        text: '**App route 2:** the token is stored in and read back from the Keychain via `@napi-rs/keyring`.',
      },
      {
        id: 'app-minimal-permissions',
        text: '**App route 3:** the same query works with only Pull requests and Metadata read permissions.',
      },
      {
        id: 'app-refresh-no-secret',
        text: '**App route 4:** a forced refresh with no client secret succeeds and rotates both tokens.',
      },
      {
        id: 'app-uninstalled-owner-404',
        text: "**App route 5:** a repo whose owner hasn't installed the App returns 404 and maps to the install message.",
      },
      {
        id: 'app-inaccessible-repo',
        text: '**App route 6:** an inaccessible repo is handled as expected.',
      },
    ],
    reads: [
      'The GitHub CLI token: the output of `gh auth token`, held in memory to sign two requests and never printed or stored',
      'GitHub API answers from https://api.github.com: GET /user (whether a login came back), the merged-PR GraphQL page for --repo (counts only), GET /user/installations (permission names) and GET /repos/{owner}/{name} for --uninstalled-repo and --inaccessible-repo (the HTTP status only)',
      'GitHub device-flow answers from https://github.com, only with --client-id: the one-time user code (printed so you can type it at github.com/login/device) and the token pair (held in memory, never printed)',
      'One temporary macOS Keychain entry (service agent-productivity, account github-app-user-token.e6-experiment), read back after it is written',
    ],
    prints: [
      'Which program and hosts it will contact, the one-time device code and github.com/login/device, then HTTP statuses, counts of merged PRs and commits, permission names and verdicts. Never a token, a login, a repository name or a PR title',
    ],
    writes: [
      'docs/implementation/experiments/E6.md (the findings)',
      'One temporary macOS Keychain entry (service agent-productivity, account github-app-user-token.e6-experiment) holding the token pair, written, read back and deleted; only on the App route, and never with --keyring memory',
    ],
    network: ['api.github.com', 'github.com'],
    spawns: ['gh'],
    example:
      'node scripts/experiments/e6-github.ts --repo <owner/name> --client-id <App client ID> --uninstalled-repo <owner/name> --inaccessible-repo <owner/name>',
    selftest: [
      {
        name: 'both routes work end to end',
        args: [
          '--bin',
          'gh={fixtures}/github/fake-gh.ts',
          '--net-fixture',
          '{fixtures}/github/net-ok.json',
          '--keyring',
          'memory',
          '--poll-interval-ms',
          '0',
          '--repo',
          'acme-crew/widgets',
          '--client-id',
          'Iv1.fixture00client01',
          '--uninstalled-repo',
          'acme-crew/not-installed',
          '--inaccessible-repo',
          'acme-crew/no-access',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'gh-token-and-login': 'pass',
            'gh-graphql-merged-prs': 'pass',
            'app-device-flow': 'pass',
            'keyring-binary-loads': 'pass',
            'keychain-round-trip': 'pass',
            'app-minimal-permissions': 'pass',
            'app-refresh-no-secret': 'pass',
            'app-uninstalled-owner-404': 'pass',
            'app-inaccessible-repo': 'pass',
          },
          stdoutIncludes: ['Will start: gh auth token', 'one-time code WXYZ-0000'],
        },
      },
      {
        name: 'gh is signed out, the App route still works',
        args: [
          '--bin',
          'gh={fixtures}/github/fake-gh.ts',
          '--net-fixture',
          '{fixtures}/github/net-ok.json',
          '--keyring',
          'memory',
          '--poll-interval-ms',
          '0',
          '--repo',
          'acme-crew/widgets',
          '--client-id',
          'Iv1.fixture00client01',
          '--uninstalled-repo',
          'acme-crew/not-installed',
          '--inaccessible-repo',
          'acme-crew/no-access',
        ],
        env: { FAKE_GH_SCENARIO: 'signed-out' },
        expect: {
          exit: 1,
          verdicts: {
            'gh-token-and-login': 'fail',
            'gh-graphql-merged-prs': 'not-run',
            'app-device-flow': 'pass',
            'keyring-binary-loads': 'pass',
            'keychain-round-trip': 'pass',
            'app-minimal-permissions': 'pass',
            'app-refresh-no-secret': 'pass',
            'app-uninstalled-owner-404': 'pass',
            'app-inaccessible-repo': 'pass',
          },
        },
      },
      {
        name: 'gh is not installed',
        args: [
          '--bin',
          'gh={tmp}/no-such-gh',
          '--net-fixture',
          '{fixtures}/github/net-ok.json',
          '--keyring',
          'memory',
          '--poll-interval-ms',
          '0',
          '--repo',
          'acme-crew/widgets',
          '--client-id',
          'Iv1.fixture00client01',
          '--uninstalled-repo',
          'acme-crew/not-installed',
          '--inaccessible-repo',
          'acme-crew/no-access',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'gh-token-and-login': 'not-run',
            'gh-graphql-merged-prs': 'not-run',
            'app-device-flow': 'pass',
            'keyring-binary-loads': 'pass',
            'keychain-round-trip': 'pass',
            'app-minimal-permissions': 'pass',
            'app-refresh-no-secret': 'pass',
            'app-uninstalled-owner-404': 'pass',
            'app-inaccessible-repo': 'pass',
          },
        },
      },
      {
        name: 'the owner denies the device flow',
        args: [
          '--bin',
          'gh={fixtures}/github/fake-gh.ts',
          '--net-fixture',
          '{fixtures}/github/net-denied.json',
          '--keyring',
          'memory',
          '--poll-interval-ms',
          '0',
          '--repo',
          'acme-crew/widgets',
          '--client-id',
          'Iv1.fixture00client01',
          '--uninstalled-repo',
          'acme-crew/not-installed',
          '--inaccessible-repo',
          'acme-crew/no-access',
        ],
        expect: {
          exit: 1,
          verdicts: {
            'gh-token-and-login': 'pass',
            'gh-graphql-merged-prs': 'pass',
            'app-device-flow': 'fail',
            'keyring-binary-loads': 'pass',
            'keychain-round-trip': 'not-run',
            'app-minimal-permissions': 'not-run',
            'app-refresh-no-secret': 'not-run',
            'app-uninstalled-owner-404': 'not-run',
            'app-inaccessible-repo': 'not-run',
          },
        },
      },
      {
        name: 'the keyring binary cannot load',
        args: [
          '--bin',
          'gh={fixtures}/github/fake-gh.ts',
          '--net-fixture',
          '{fixtures}/github/net-ok.json',
          '--keyring',
          'unavailable',
          '--poll-interval-ms',
          '0',
          '--repo',
          'acme-crew/widgets',
          '--client-id',
          'Iv1.fixture00client01',
          '--uninstalled-repo',
          'acme-crew/not-installed',
          '--inaccessible-repo',
          'acme-crew/no-access',
        ],
        expect: {
          exit: 1,
          verdicts: {
            'gh-token-and-login': 'pass',
            'gh-graphql-merged-prs': 'pass',
            'app-device-flow': 'pass',
            'keyring-binary-loads': 'fail',
            'keychain-round-trip': 'not-run',
            'app-minimal-permissions': 'pass',
            'app-refresh-no-secret': 'pass',
            'app-uninstalled-owner-404': 'pass',
            'app-inaccessible-repo': 'pass',
          },
        },
      },
      {
        name: 'the App needs a client secret to refresh, holds extra permissions and is installed on the "uninstalled" owner',
        args: [
          '--bin',
          'gh={fixtures}/github/fake-gh.ts',
          '--net-fixture',
          '{fixtures}/github/net-app-problems.json',
          '--keyring',
          'memory',
          '--poll-interval-ms',
          '0',
          '--repo',
          'acme-crew/widgets',
          '--client-id',
          'Iv1.fixture00client01',
          '--uninstalled-repo',
          'acme-crew/not-installed',
          '--inaccessible-repo',
          'acme-crew/no-access',
        ],
        expect: {
          exit: 1,
          verdicts: {
            'gh-token-and-login': 'pass',
            'gh-graphql-merged-prs': 'pass',
            'app-device-flow': 'pass',
            'keyring-binary-loads': 'pass',
            'keychain-round-trip': 'pass',
            'app-minimal-permissions': 'fail',
            'app-refresh-no-secret': 'fail',
            'app-uninstalled-owner-404': 'fail',
            'app-inaccessible-repo': 'pass',
          },
        },
      },
      {
        name: 'the gh route only, with no App client ID',
        args: [
          '--bin',
          'gh={fixtures}/github/fake-gh.ts',
          '--net-fixture',
          '{fixtures}/github/net-ok.json',
          '--repo',
          'acme-crew/widgets',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'gh-token-and-login': 'pass',
            'gh-graphql-merged-prs': 'pass',
            'app-device-flow': 'not-run',
            'keyring-binary-loads': 'not-run',
            'keychain-round-trip': 'not-run',
            'app-minimal-permissions': 'not-run',
            'app-refresh-no-secret': 'not-run',
            'app-uninstalled-owner-404': 'not-run',
            'app-inaccessible-repo': 'not-run',
          },
        },
      },
      {
        name: 'a repository flag that is not owner/name',
        args: ['--net-fixture', '{fixtures}/github/net-ok.json', '--repo', 'not a repo'],
        expect: { exit: 2, verdicts: {} },
      },
    ],
  },

  async run(ctx) {
    const repo = parseRepo(ctx.args.get('repo'), 'repo');
    const uninstalled = parseRepo(ctx.args.get('uninstalled-repo'), 'uninstalled-repo');
    const inaccessible = parseRepo(ctx.args.get('inaccessible-repo'), 'inaccessible-repo');
    const clientId = ctx.args.get('client-id');
    if (clientId !== undefined && !CLIENT_ID.test(clientId))
      throw new UsageError('--client-id must be the App client ID (it starts with Iv)');
    const mode = ctx.args.get('keyring') ?? 'native';
    if (mode !== 'native' && mode !== 'memory' && mode !== 'unavailable')
      throw new UsageError('--keyring must be native, memory or unavailable');
    const pollOverride = ctx.args.get('poll-interval-ms');
    if (pollOverride !== undefined && !/^\d{1,6}$/.test(pollOverride))
      throw new UsageError('--poll-interval-ms must be a whole number of milliseconds');

    // gh first (P2): the route the product uses when it is signed in.
    const gh = await ghRoute(ctx, repo);

    if (clientId === undefined) {
      ctx.findings.note(
        'The App route was not run: pass --client-id <the App client ID> to run it.',
      );
      return;
    }
    await appRoute(ctx, {
      clientId,
      repo,
      uninstalled,
      inaccessible,
      keyringMode: mode,
      ghLogin: gh.login,
    });
  },
});

runIfMain(import.meta, experiment);
