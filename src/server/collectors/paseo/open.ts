import { randomUUID } from 'node:crypto';
import type { PaseoClientLike } from './agents.ts';
import type { PaseoLiveClientLike } from './live.ts';
import { allowlistTransport, LIVE_CAPABILITIES } from './liveTransport.ts';

// The one place the real Paseo SDK is touched. Everything else in this folder takes an opener (`PaseoOpen`), so tests hand it a
// fake client and no socket is opened.

/** Where the daemon listens (data-and-sources › Discovery). `PASEO_HOME` is for diagnostics only and is not read here. */
export const DEFAULT_PASEO_URL = 'ws://127.0.0.1:6767/ws';

/** Gives the collector a client that has not connected yet. May reject (for example when the SDK is missing). */
export type PaseoOpen = (url: string) => PaseoClientLike | Promise<PaseoClientLike>;

/** Gives the live feed a client that has not connected yet. May reject (for example when the SDK is missing). */
export type PaseoLiveOpen = (url: string) => PaseoLiveClientLike | Promise<PaseoLiveClientLike>;

const CONNECT_TIMEOUT_MS = 8_000;

/**
 * A client for the real daemon. No password and no auth header are ever given: the dashboard does not support a
 * password-protected daemon (P-41), and the daemon asking for one is a source state, not something to answer. Reconnecting is
 * off, so a daemon that is not there fails the attempt at once instead of retrying in the background.
 *
 * The SDK is loaded here, when first needed, so a machine that never refreshes Paseo never loads it, and a missing SDK is a failed
 * Paseo attempt (code `sdk_unavailable`) instead of a crash at startup.
 */
async function createSdkClient(url: string) {
  let sdk: typeof import('@getpaseo/client');
  try {
    sdk = await import('@getpaseo/client');
  } catch (cause) {
    throw Object.assign(new Error('The Paseo SDK could not be loaded', { cause }), {
      code: 'SDK_UNAVAILABLE',
    });
  }
  return sdk.createPaseoClient({
    url,
    reconnect: { enabled: false },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });
}

/** The batch collector's client. The SDK's `PaseoClient` must stay assignable to `PaseoClientLike`; this return type checks it. */
export const openPaseoClient: PaseoOpen = (url) => createSdkClient(url);

/** Drops every SDK log line. The SDK logs the daemon's raw error text (and agent ids) through its logger before HQ classifies it. */
const SILENT_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * The live feed's client: configured as the batch one (no password, reconnect off, 8 s connect timeout, `cli` client type), because
 * the feed owns reconnecting, with three differences:
 *   - SDK logging is silenced (`SILENT_LOGGER`), so a failing listing never reaches the console. The feed keeps a code only.
 *   - It is the SDK's `DaemonClient` itself, not the `createPaseoClient` wrapper, because the wrapper's configuration has no
 *     transport option (`PaseoClientConfig` lacks `webSocketFactory` and `transportFactory`). With no subscription in play the
 *     wrapper's `close()` would be prompt too, so the transport is the only reason. The package exports `DaemonClient` as
 *     `@getpaseo/client/internal/daemon-client`; the version is pinned exactly (package.json), so that path cannot move silently.
 *   - The transport is the SDK's own Node one (`createHostTransportFactory` from `@getpaseo/client/node`, a public export), not
 *     Node's global `WebSocket`. Its `close()` sends a close frame and then `terminate()`s the socket at once (`ws`, the SDK's own
 *     dependency; this package does not import it). The global `WebSocket` (undici) has no way to force a close and no close
 *     timeout: with a silent peer it stays in CLOSING, holding its connection, for as long as the peer says nothing (observed past
 *     125 s on Node 26.3.1), so `stop()` would leave a socket open that nobody was looking at.
 *
 * Whatever the transport, the client only ever sees the frames HQ's flow needs (`allowlistTransport`, liveTransport.ts): the daemon's
 * unsolicited messages are dropped before the SDK parses or caches them, and the hello offers no binary chunking so that every
 * frame that matters arrives whole.
 *
 * The SDK's `DaemonClient` must stay assignable to what `PaseoLiveClientLike` needs; the object returned here checks it.
 */
async function createSdkLiveClient(
  url: string,
  transportFor?: LiveTransportFor,
): Promise<PaseoLiveClientLike> {
  let sdk: typeof import('@getpaseo/client/internal/daemon-client');
  let transportFactory: DaemonTransportFactory;
  try {
    sdk = await import('@getpaseo/client/internal/daemon-client');
    transportFactory = transportFor
      ? transportFor(url)
      : (await import('@getpaseo/client/node')).createHostTransportFactory(url);
  } catch (cause) {
    throw Object.assign(new Error('The Paseo SDK could not be loaded', { cause }), {
      code: 'SDK_UNAVAILABLE',
    });
  }
  const client = new sdk.DaemonClient({
    url,
    clientId: `paseo-sdk-${randomUUID()}`,
    clientType: 'cli',
    reconnect: { enabled: false },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    logger: SILENT_LOGGER,
    transportFactory: allowlistTransport(transportFactory),
    capabilities: LIVE_CAPABILITIES,
  });
  return {
    connect: () => client.connect(),
    close: () => client.close(),
    getConnectionState: () => client.getConnectionState(),
    agents: { list: (options) => client.fetchAgents(options) },
  };
}

/** What the SDK's client takes as its transport. Named from the SDK's own type: a static import of its path is not allowed in server code. */
type DaemonTransportFactory = NonNullable<
  ConstructorParameters<
    typeof import('@getpaseo/client/internal/daemon-client').DaemonClient
  >[0]['transportFactory']
>;

/** A transport for one address. Only tests pass one, to put a fake socket under the SDK; the default is the SDK's Node transport. */
export type LiveTransportFor = (url: string) => DaemonTransportFactory;

/** The live feed's opener, over the SDK's Node transport unless a test supplies another. */
export const createPaseoLiveOpen =
  (transportFor?: LiveTransportFor): PaseoLiveOpen =>
  (url) =>
    createSdkLiveClient(url, transportFor);

export const openPaseoLiveClient: PaseoLiveOpen = createPaseoLiveOpen();
