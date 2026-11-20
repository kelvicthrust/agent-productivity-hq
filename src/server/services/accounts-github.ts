import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  GithubAppRequest,
  type ConnectPollResponse as ConnectPollSchema,
  type ConnectResponse as ConnectSchema,
} from '../../shared/contracts/accounts.ts';
import { ApiError } from '../../shared/contracts/errors.ts';
import type { AccountStatus } from '../../shared/contracts/sources.ts';
import {
  NO_CREDENTIAL_MESSAGE,
  createGithubAuth,
  deleteStoredToken,
  oauthErrorOf,
  oauthPost,
  readStoredToken,
  storedFromGrant,
  whoAmI,
  writeStoredToken,
  type StoredToken,
} from '../collectors/github/auth.ts';
import type {
  CredentialResult,
  GithubAccounts,
  GithubAuth,
  GithubDeps,
} from '../collectors/github/ports.ts';
import { formatWaitUntil } from '../collectors/github/sync.ts';
import type { Db } from '../db/open.ts';
import type { Sleep } from '../lib/sleep.ts';
import { getMeta, setMeta } from '../db/queries/meta.ts';

// The account service behind /api/accounts/github/* (TECH › GitHub delivery, owner choice P2). It owns what the owner can do
// about GitHub's sign-in: see which route is in use, save the App's client ID, start and watch a device flow, disconnect.
// The token logic itself (precedence, refresh, the Keychain secret) is collectors/github/auth.ts.
//
// Nothing token-like is written to SQLite. The database holds the login (not a secret), the App's client ID (not a secret)
// and two on/off notes about the sign-in; every token goes to the Keychain and stays out of messages, logs and responses.

type ConnectResponse = z.infer<typeof ConnectSchema>;
type ConnectPollResponse = z.infer<typeof ConnectPollSchema>;

const META_LOGIN = 'github_login';
const META_CLIENT_ID = 'github_app_client_id';
/** '1' after Disconnect on the gh route: `gh` is not read again until Connect is pressed (local-api › disconnect). */
const META_GH_OFF = 'github_gh_disconnected';
/** '1' while the saved App sign-in is known to be unusable (the Keychain entry was deleted): "Reconnect needed" stays shown. */
const META_RECONNECT = 'github_reconnect_needed';
/** The logins the two sign-ins belong to, as last seen (not secrets). Only to notice when they are two different people. */
const META_GH_LOGIN = 'github_gh_login';
const META_APP_LOGIN = 'github_app_login';

/** Where the one-time "Register your GitHub App" guide is shown (`details.guideUrl` of `github_app_required`). */
export const GITHUB_APP_GUIDE_URL = '/sources';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Polls that fail for a reason other than GitHub's answer (no network…) before the flow gives up. */
const MAX_POLL_FAILURES = 3;
/** How long a status answer is reused. `gh` and the Keychain are asked at most this often by the polling Sources page. */
export const STATUS_TTL_MS = 10_000;
/** Device flows kept for `poll` after they end. Only one runs at a time; the rest are answers still to be read. */
const KEEP_FLOWS = 5;

/** The designed messages for the way a device flow ends or cannot start (TECH › Failure modes). */
export const FLOW_MESSAGE = {
  expired: 'The code expired, start again',
  denied: 'Sign-in was cancelled',
  cancelled: 'Sign-in was cancelled',
  disabled:
    'Turn on “Enable Device Flow” in your GitHub App’s settings (github.com/settings/apps), then connect again.',
  wrongClient:
    'GitHub doesn’t recognise this client ID. Copy the Client ID from your GitHub App’s settings page (not the App ID, and no client secret), then connect again.',
  failed: 'GitHub didn’t complete the sign-in. Start again.',
  unreachable: 'GitHub couldn’t be reached. Try again in a moment.',
  limited: 'GitHub is limiting requests. Try again in a few minutes.',
  keychain:
    'Couldn’t save the GitHub sign-in to your Keychain. Allow access in the macOS prompt, then connect again.',
} as const;

/** Waits `ms`; resolves early when `signal` aborts. Handed in so a test runs a 15-minute flow without waiting. */
export type { Sleep };

export interface GithubAccountsDeps extends GithubDeps {
  db: Db;
  /** Epoch ms. */
  now: () => number;
  sleep: Sleep;
  /** The report timezone, so "GitHub is limiting requests until <time>" reads in the owner's time. Without it the sentence has no time. */
  timezone?: string;
}

/** The account service, and the auth it shares with the sync so both see the same sign-in state. */
export interface GithubAccountsService extends GithubAccounts {
  /**
   * `credential()` and `refreshAfter401()` for the sync and the repo check. Give the sync THIS auth rather than a second
   * `createGithubAuth`: it honours "Disconnect" on the gh route and it is what records "Reconnect needed" and the login.
   */
  readonly auth: GithubAuth;
  /** Cancels pending device authorization before the database is closed. */
  close(): void;
}

type FlowState = NonNullable<ConnectPollResponse['state']>;

interface Flow {
  readonly id: string;
  state: FlowState;
  message: string | null;
  readonly abort: AbortController;
}

export function createGithubAccounts(deps: GithubAccountsDeps): GithubAccountsService {
  const { db, net, keyring, now, sleep } = deps;

  const flag = (key: string): boolean => getMeta(db, key) === '1';
  const clientId = (): string | null => getMeta(db, META_CLIENT_ID) || null;
  const ghEnabled = (): boolean => !flag(META_GH_OFF);

  /** The last answer of `gh`, for the one answer that has to be given without asking it (saveClientId). */
  let ghSeen = false;
  const readGh = async (): Promise<string | null> => {
    let token: string | null;
    try {
      token = await deps.gh();
    } catch {
      token = null;
    }
    ghSeen = Boolean(token);
    return token;
  };

  // ---- the auth the sync shares ----

  const base = createGithubAuth({
    net,
    keyring,
    now,
    gh: readGh,
    ghEnabled,
    savedClientId: clientId,
  });

  /** The last answer of `status()` and when it was given. The sync's own sign-in checks refresh it through `noted`. */
  let cached: { at: number; value: AccountStatus } | null = null;

  /** Sets a note only when it changes, and drops the cached status when it did: the card may now read differently. */
  const note = (key: string, value: string): void => {
    if ((getMeta(db, key) ?? '') === value) return;
    setMeta(db, key, value);
    cached = null;
  };

  const noted = (result: CredentialResult): CredentialResult => {
    if (result.ok) {
      const { login, via } = result.credential;
      note(META_LOGIN, login);
      note(via === 'gh' ? META_GH_LOGIN : META_APP_LOGIN, login);
      note(META_RECONNECT, '0');
    } else if (result.reason === 'reconnect') {
      // The App sign-in was refused and its Keychain entry deleted: it no longer has a login either.
      note(META_RECONNECT, '1');
      note(META_APP_LOGIN, '');
    }
    return result;
  };
  const auth: GithubAuth = {
    credential: async () => noted(await base.credential()),
    refreshAfter401: async (used) => noted(await base.refreshAfter401(used)),
  };

  // ---- status ----

  let running: Flow | null = null;
  const flows = new Map<string, Flow>();

  /**
   * The App sign-in's login when it is a different person from the gh one, else null. The Keychain is read only when the two
   * saved logins already differ, to be sure that sign-in still exists (the owner may have removed the entry outside the app).
   */
  function appLoginIfDifferent(ghLogin: string | null): string | null {
    const appLogin = getMeta(db, META_APP_LOGIN) || null;
    if (!ghLogin || !appLogin || appLogin.toLowerCase() === ghLogin.toLowerCase()) return null;
    const stored = readStoredToken(keyring);
    if (stored.kind === 'token') return appLogin;
    if (stored.kind === 'none') setMeta(db, META_APP_LOGIN, '');
    return null;
  }

  /** The GitHub card. `ghSignedIn` is what `gh` said, already known to the caller. Reads the Keychain only without gh. */
  function describe(ghSignedIn: boolean): AccountStatus {
    const login = getMeta(db, META_LOGIN);
    const saved = clientId() !== null;
    const card = { id: 'github', name: 'GitHub', login, appClientIdSaved: saved } as const;

    if (running) {
      return { ...card, status: 'connecting', statusText: 'Waiting for sign-in…', via: 'app' };
    }
    if (ghSignedIn && ghEnabled()) {
      const ghLogin = getMeta(db, META_GH_LOGIN) || login;
      const mismatch = appLoginIfDifferent(ghLogin);
      return {
        ...card,
        login: ghLogin,
        status: 'existing',
        statusText: mismatch
          ? `Using your GitHub CLI sign-in as ${ghLogin}. Your saved GitHub App sign-in is for ${mismatch}; merged PRs are read as ${ghLogin}.`
          : 'Using your GitHub CLI sign-in',
        via: 'gh',
        ...(mismatch ? { reason: 'login_mismatch' } : {}),
      };
    }
    const stored = readStoredToken(keyring);
    if (stored.kind === 'refused') {
      return {
        ...card,
        status: 'failed',
        statusText: NO_CREDENTIAL_MESSAGE.keychain_refused,
        via: 'app',
        reason: 'keychain_refused',
      };
    }
    if (stored.kind === 'token' && !flag(META_RECONNECT)) {
      return {
        ...card,
        status: 'connected',
        statusText: 'Connected through your Agent Productivity HQ GitHub App',
        via: 'app',
      };
    }
    if (stored.kind !== 'none' || flag(META_RECONNECT)) {
      return {
        ...card,
        status: 'reconnect',
        statusText: NO_CREDENTIAL_MESSAGE.reconnect,
        via: 'app',
        reason: 'reconnect',
      };
    }
    return saved
      ? { ...card, status: 'notconnected', statusText: 'Not connected', via: null }
      : {
          ...card,
          status: 'needsapp',
          statusText: 'Set up your GitHub App to connect',
          via: null,
        };
  }

  const status = async (): Promise<AccountStatus> => {
    const at = now();
    if (cached && at - cached.at >= 0 && at - cached.at < STATUS_TTL_MS) return { ...cached.value };
    const ghToken = await readGh();
    if (ghToken && ghEnabled() && !running && !getMeta(db, META_GH_LOGIN)) {
      // An existing CLI sign-in on first launch has no saved identity yet. The picker binds searches to that identity.
      const result = await whoAmI(net, ghToken, now);
      if (result.kind === 'ok' && ghEnabled()) {
        noted({ ok: true, credential: { token: ghToken, login: result.login, via: 'gh' } });
      }
    }
    const value = describe(Boolean(ghToken));
    cached = { at, value };
    return { ...value };
  };

  // ---- the device flow ----

  function finish(flow: Flow, state: FlowState, message: string | null): void {
    if (flow.state !== 'pending') return;
    flow.state = state;
    flow.message = message;
    if (running === flow) running = null;
    cached = null;
  }

  /** Why GitHub refused to start or continue a flow, as the designed message and the API error's reason. */
  function explain(
    error: string,
  ): { reason: 'device_flow_disabled' | 'incorrect_client_credentials'; message: string } | null {
    if (error === 'device_flow_disabled') {
      return { reason: 'device_flow_disabled', message: FLOW_MESSAGE.disabled };
    }
    if (error === 'incorrect_client_credentials') {
      return { reason: 'incorrect_client_credentials', message: FLOW_MESSAGE.wrongClient };
    }
    return null;
  }

  /** Polls GitHub at its interval until the flow ends. Runs in the background; every path ends in `finish`. */
  async function watch(
    flow: Flow,
    start: { clientId: string; deviceCode: string; intervalSeconds: number; expiresAt: number },
  ): Promise<void> {
    let interval = start.intervalSeconds;
    let failures = 0;
    try {
      for (;;) {
        await sleep(interval * 1000, flow.abort.signal);
        if (flow.state !== 'pending') return;
        if (now() >= start.expiresAt) return finish(flow, 'expired', FLOW_MESSAGE.expired);

        const answer = await oauthPost(
          net,
          '/login/oauth/access_token',
          { client_id: start.clientId, device_code: start.deviceCode, grant_type: DEVICE_GRANT },
          flow.abort.signal,
        );
        if (flow.state !== 'pending') return;
        // No answer, a server error or a rate limit: GitHub could not be reached this time. Try again at the interval.
        if (answer.kind === 'unreachable' || answer.status >= 500 || answer.status === 429) {
          failures += 1;
          if (failures >= MAX_POLL_FAILURES)
            return finish(flow, 'failed', FLOW_MESSAGE.unreachable);
          continue;
        }
        const error = oauthErrorOf(answer.body);
        if (!error) {
          const stored = storedFromGrant(answer.body, start.clientId, now());
          if (!stored) {
            failures += 1;
            if (failures >= MAX_POLL_FAILURES) return finish(flow, 'failed', FLOW_MESSAGE.failed);
            continue;
          }
          return await complete(flow, stored);
        }
        failures = 0;
        switch (error.error) {
          case 'authorization_pending':
            break;
          case 'slow_down':
            // GitHub asks for 5 s more (and says the new interval); never go faster than either.
            interval = Math.max(interval + 5, error.interval ?? 0);
            break;
          case 'expired_token':
            return finish(flow, 'expired', FLOW_MESSAGE.expired);
          case 'access_denied':
            return finish(flow, 'failed', FLOW_MESSAGE.denied);
          default:
            return finish(flow, 'failed', explain(error.error)?.message ?? FLOW_MESSAGE.failed);
        }
      }
    } catch {
      // `sleep` was stopped, or something unexpected broke: a cancelled flow already has its state; any other ends as failed.
      finish(flow, 'failed', FLOW_MESSAGE.failed);
    }
  }

  /** GitHub issued the tokens: learn whose they are, save them in the Keychain, and only then say connected. */
  async function complete(flow: Flow, token: StoredToken): Promise<void> {
    const who = await whoAmI(net, token.access_token, now);
    if (flow.state !== 'pending') return;
    if (who.kind !== 'ok') {
      return finish(
        flow,
        'failed',
        who.kind === 'rejected'
          ? FLOW_MESSAGE.failed
          : who.kind === 'rate_limited'
            ? FLOW_MESSAGE.limited
            : FLOW_MESSAGE.unreachable,
      );
    }
    if (!writeStoredToken(keyring, token)) return finish(flow, 'failed', FLOW_MESSAGE.keychain);
    setMeta(db, META_LOGIN, who.login);
    setMeta(db, META_APP_LOGIN, who.login);
    setMeta(db, META_RECONNECT, '0');
    finish(flow, 'connected', null);
  }

  function cancelRunning(): void {
    if (!running) return;
    const flow = running;
    finish(flow, 'cancelled', FLOW_MESSAGE.cancelled);
    flow.abort.abort();
  }

  function remember(flow: Flow): void {
    flows.set(flow.id, flow);
    for (const id of [...flows.keys()].slice(0, Math.max(0, flows.size - KEEP_FLOWS)))
      flows.delete(id);
  }

  // ---- the service ----

  return {
    auth,
    status,
    close: cancelRunning,

    async connect(): Promise<ConnectResponse> {
      // Connect puts gh back in use after a Disconnect, then asks the sign-ins we already have (P-42: no prompt for one).
      cached = null;
      if (!ghEnabled()) setMeta(db, META_GH_OFF, '0');
      const existing = await auth.credential();
      if (existing.ok) return { loginId: null, mode: 'existing' };
      if (existing.reason === 'unreachable') {
        throw new ApiError('upstream_unavailable', existing.message);
      }
      if (existing.reason === 'rate_limited') {
        // The time GitHub gave, in the report timezone, instead of "couldn't be reached".
        throw new ApiError(
          'upstream_unavailable',
          existing.until !== undefined && deps.timezone
            ? `GitHub is limiting requests until ${formatWaitUntil(existing.until, now(), deps.timezone)}. Try again then.`
            : existing.message,
        );
      }
      if (existing.reason === 'keychain_refused') {
        throw new ApiError(
          'internal',
          `${existing.message}. Allow access in the macOS prompt, then connect again.`,
        );
      }

      const id = clientId();
      if (id === null) {
        throw new ApiError(
          'github_app_required',
          'GitHub isn’t signed in here. Register your GitHub App once (it takes a few minutes), paste its client ID, then connect.',
          { details: { guideUrl: GITHUB_APP_GUIDE_URL } },
        );
      }

      cancelRunning();
      const answer = await oauthPost(net, '/login/device/code', { client_id: id });
      if (answer.kind === 'unreachable' || answer.status >= 500 || answer.status === 429) {
        throw new ApiError('upstream_unavailable', FLOW_MESSAGE.unreachable);
      }
      const error = oauthErrorOf(answer.body);
      if (error) {
        const known = explain(error.error);
        if (known) {
          throw new ApiError('github_app_required', known.message, {
            details: { reason: known.reason, guideUrl: GITHUB_APP_GUIDE_URL },
          });
        }
        throw new ApiError('upstream_unavailable', FLOW_MESSAGE.failed);
      }
      const code = parseDeviceCode(answer.body);
      if (!code) throw new ApiError('upstream_unavailable', FLOW_MESSAGE.failed);

      const flow: Flow = {
        id: randomUUID(),
        state: 'pending',
        message: null,
        abort: new AbortController(),
      };
      // Another Connect may have started a watcher while this request waited for its device code.
      cancelRunning();
      running = flow;
      cached = null;
      remember(flow);
      const expiresAt = now() + code.expiresIn * 1000;
      void watch(flow, {
        clientId: id,
        deviceCode: code.deviceCode,
        intervalSeconds: code.interval,
        expiresAt,
      });
      return {
        loginId: flow.id,
        mode: 'device',
        userCode: code.userCode,
        verificationUri: code.verificationUri,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    async poll(loginId: string): Promise<ConnectPollResponse> {
      const flow = flows.get(loginId);
      if (!flow) throw new ApiError('not_found', 'That sign-in is not running here. Start again.');
      if (flow.state === 'pending') return { state: 'pending' };
      if (flow.state === 'connected') return { state: 'connected', account: await status() };
      return { state: flow.state, message: flow.message };
    },

    cancel(loginId: string): void {
      const flow = flows.get(loginId);
      if (!flow || flow.state !== 'pending') return;
      finish(flow, 'cancelled', FLOW_MESSAGE.cancelled);
      flow.abort.abort();
    },

    async disconnect(): Promise<AccountStatus> {
      cancelRunning();
      const token = await readGh();
      if (token && ghEnabled()) {
        // The gh route: gh itself stays signed in; the dashboard just stops reading it until Connect.
        setMeta(db, META_GH_OFF, '1');
      } else {
        if (!deleteStoredToken(keyring)) {
          throw new ApiError(
            'internal',
            'Couldn’t remove the saved GitHub sign-in from your Keychain. Allow access in the macOS prompt, then try again.',
          );
        }
        setMeta(db, META_APP_LOGIN, '');
      }
      setMeta(db, META_RECONNECT, '0');
      cached = null;
      return describe(Boolean(token));
    },

    saveClientId(value: string): AccountStatus {
      const parsed = GithubAppRequest.safeParse({ clientId: value });
      if (!parsed.success) {
        throw new ApiError(
          'invalid_input',
          'That doesn’t look like a client ID. Copy the Client ID (letters, digits and dots, up to 40 characters) from your GitHub App’s settings page.',
        );
      }
      if (clientId() !== parsed.data.clientId) cancelRunning();
      setMeta(db, META_CLIENT_ID, parsed.data.clientId);
      cached = null;
      return describe(ghSeen);
    },
  };
}

function parseDeviceCode(body: unknown): {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
} | null {
  if (typeof body !== 'object' || body === null) return null;
  const { device_code, user_code, verification_uri, expires_in, interval } = body as Record<
    string,
    unknown
  >;
  if (
    typeof device_code !== 'string' ||
    typeof user_code !== 'string' ||
    typeof verification_uri !== 'string' ||
    typeof expires_in !== 'number'
  ) {
    return null;
  }
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    expiresIn: expires_in,
    // GitHub's default when it says nothing: 5 seconds.
    interval: typeof interval === 'number' && interval > 0 ? interval : 5,
  };
}
