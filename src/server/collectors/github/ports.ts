import type { z } from 'zod';
import type {
  ConnectPollResponse as ConnectPollSchema,
  ConnectResponse as ConnectSchema,
} from '../../../shared/contracts/accounts.ts';
import type { AccountStatus } from '../../../shared/contracts/sources.ts';

type ConnectResponse = z.infer<typeof ConnectSchema>;
type ConnectPollResponse = z.infer<typeof ConnectPollSchema>;

// The seams of the GitHub integration (TECH › GitHub delivery, M6). Everything that reaches GitHub, the Keychain or the `gh`
// program does so through one of these three functions, handed in by whoever builds the app:
//   `pnpm start`   the live ones (src/server/lib/net.ts over global fetch, the real Keychain entry, `gh` run without a shell)
//   the preview and every test   the scripted ones in test/fixtures/github (no network, no Keychain, no `gh`)
// Nothing under src/ reads a token from anywhere else, calls `fetch`, or imports node:http, node:https or undici outside
// lib/net.ts (ESLint and test/lint/outbound.test.ts enforce it). Tokens are held in memory for one request or one sync, never
// written to SQLite, a log or an API response; App tokens live only in the Keychain (service `agent-productivity`, account
// `github-app-user-token`).

/** The part of `fetch` init the integration uses. Anything else is refused by the live implementation. */
export interface NetInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Sends one HTTPS request. The live implementation (lib/net.ts, written in A21) allows api.github.com (GET, and POST /graphql)
 * and github.com only for POST /login/device/code and /login/oauth/access_token, and refuses every other host, path, method,
 * scheme and redirect with a rejection that names the host and path but never a header or a body.
 */
export type NetFetch = (url: string, init?: NetInit) => Promise<Response>;

/** The OS credential store, by service and account. Methods throw when the store refuses or is locked. */
export interface Keyring {
  get(service: string, account: string): string | null;
  set(service: string, account: string, secret: string): void;
  /** True when an entry existed. */
  delete(service: string, account: string): boolean;
}

/** Runs `gh auth token`: the trimmed token, or null when `gh` is not installed or not signed in. Never a shell, never stored. */
export type GhRunner = () => Promise<string | null>;

/** What `boot`, `createApp` and the GitHub services are given. */
export interface GithubDeps {
  net: NetFetch;
  keyring: Keyring;
  gh: GhRunner;
}

export const KEYCHAIN_SERVICE = 'agent-productivity';
export const KEYCHAIN_ACCOUNT = 'github-app-user-token';

/** Which sign-in a token came from. `gh` always wins when it is signed in (precedence is fixed). */
export type GithubRoute = 'gh' | 'app';

/** A token ready for one request or one sync, with the login it belongs to. Never persisted, never logged. */
export interface GithubCredential {
  token: string;
  via: GithubRoute;
  /** `GET /user` → login. */
  login: string;
}

/** Why there is no credential, as the Sources row and the API errors tell it. */
export type NoCredential =
  /** Neither route is connected (and no App client ID is saved, or none is needed to say so). */
  | 'not_connected'
  /** `gh` is not signed in and no App token is stored; a client ID is saved, so Connect can start the device flow. */
  | 'needs_connect'
  /** `gh` is not signed in and no GitHub App client ID is saved yet: show the one-time setup guide. */
  | 'needs_app'
  /** The App token could not be refreshed or was refused: "Reconnect needed". The Keychain entry is gone. */
  | 'reconnect'
  /** The Keychain refused or is locked: "Couldn't read the saved GitHub sign-in from your Keychain". */
  | 'keychain_refused'
  /** GitHub could not be reached or answered with a server error. */
  | 'unreachable'
  /** GitHub is limiting requests (a rate limit on the sign-in check itself): `until` says when to try again. */
  | 'rate_limited';

export type CredentialResult =
  | { ok: true; credential: GithubCredential }
  | {
      ok: false;
      reason: NoCredential;
      message: string;
      /** Epoch ms. Only with reason `rate_limited`: the time GitHub said to try again, never lost on the way to the screen. */
      until?: number;
    };

/**
 * Token precedence (collectors/github/auth.ts, A21). `credential()` is called at the start of each sync and each repo check:
 * `gh auth token` confirmed by `GET /user`, else the Keychain App token, refreshed first when it expires in under 5 minutes.
 * `refreshAfter401()` is called once when a request answered 401 with the credential it used: it re-reads `gh`, or
 * refreshes the App token (refresh token only, no client secret; on `bad_refresh_token` it deletes the Keychain entry and
 * answers `reconnect`).
 */
export interface GithubAuth {
  credential(): Promise<CredentialResult>;
  refreshAfter401(used: GithubCredential): Promise<CredentialResult>;
}

/**
 * The account service behind /api/accounts/github/* (services/accounts-github.ts, A21). M6wire1 writes the routes over it.
 *
 * Errors are `ApiError`s from shared/contracts/errors.ts, thrown on purpose:
 *   connect, no gh and no saved client ID   github_app_required (details.guideUrl)
 *   device flow disabled / wrong client ID  github_app_required with details.reason `device_flow_disabled` or
 *                                           `incorrect_client_credentials` and a message that names the App setting to change
 *   GitHub unreachable                      upstream_unavailable
 * A device flow that ends badly is not an error: `poll` answers state `expired`, `failed` (access denied) or `cancelled`
 * with a plain sentence, and stores nothing.
 */
export interface GithubAccounts {
  /** The GitHub entry of GET /api/sources `accounts`: status, login, via, appClientIdSaved and the sentence to show. */
  status(): Promise<AccountStatus>;
  /** `{mode: 'existing'}` when gh is signed in; otherwise starts the device flow (`mode: 'device'`, userCode, verificationUri). */
  connect(): Promise<ConnectResponse>;
  /** One poll of a device flow this process started; the server itself polls GitHub no faster than its interval. */
  poll(loginId: string): Promise<ConnectPollResponse>;
  /** Cancels a running device flow (nothing is stored). */
  cancel(loginId: string): void;
  /** Deletes the Keychain entry (App route) or stops reading gh until Connect is pressed again (gh route). */
  disconnect(): Promise<AccountStatus>;
  /** Saves the App's client ID (not a secret) in app_meta.github_app_client_id; shape errors are `invalid_input`. */
  saveClientId(clientId: string): AccountStatus;
}
