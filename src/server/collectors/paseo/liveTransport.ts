// An inbound allowlist for the live feed's connection (data-and-sources › Live roster (HQ)).
//
// HQ asks the daemon one question: the plain agent listing. The SDK, though, parses and keeps what a daemon pushes on its own. A
// daemon that advertises background workspaces without owned subscriptions (or without workspace multiplicity) makes SDK 0.15.3
// activate its legacy workspace adapter (`connection/legacy-workspaces.js`), which caches every `agent_update` it is handed, agent
// error text and permission details included. A denylist of known message types would miss the next one, so this is an allowlist at
// the transport boundary: a frame that is not on the list is dropped before the SDK parses, validates or stores it.
//
// What passes, and why (every frame is a text frame holding one JSON message; the SDK's own wire shapes are cited):
//   - `{"type":"pong"}`                          the answer to the SDK's liveness `ping` (`daemon-client.js` handleJsonPayload).
//   - `{"type":"hello.rejected", ...}`           a refused handshake, so a password-protected daemon is still reported as such.
//   - `{"type":"session","message":{"type":"status","payload":{"status":"server_info",...}}}`
//                                                the handshake reply: it is what moves the client to `connected` (`deliverSessionMessage`).
//                                                It is rebuilt, not forwarded (`serverInfoFrame`): the SDK keeps the parsed frame for the
//                                                life of the connection (`lastServerInfoMessage`), so only the fields it needs reach it.
//                                                Other `status` payloads (`agent_created`, ...) are not let through.
//   - `... "fetch_agents_response"` and `... "rpc_error"` whose `payload.requestId` is one HQ itself sent in a
//                                                `fetch_agents_request` that has not been answered yet: the listing and its failure
//                                                (`fetchAgents` selects on `fetch_agents_response` / `rpc_error` by request id).
// Everything else is dropped: every other `session` message (`agent_update`, `agent_stream`, `workspace_update`, permission and
// attention messages, `providers_snapshot_update`, ...), a response or error for a request HQ did not send or has already had
// answered, any frame that is not text (terminal output, file transfer, host routing and the SDK's chunk frames: HQ does not offer
// chunking, see `LIVE_CAPABILITIES`), and anything that is not JSON.
//
// The same boundary covers the text a peer can put into a connection failure. The SDK keeps a close reason or an error message in
// `lastErrorValue` and in its disconnected state, so `onClose` and `onError` events are rebuilt too (`normalisedClose`,
// `normalisedError`): the numeric close code stays and the text becomes one of a few fixed strings.
//
// The roster itself is read only from the answer to HQ's own listing, through `readLiveAgent`.

/** The part of the SDK's transport the filter touches. The object it is given is wrapped, not copied: its other members pass through. */
interface FilterableTransport {
  send: (data: string | Uint8Array | ArrayBuffer) => void | Promise<void>;
  onMessage: (handler: (data: unknown, isBinary: boolean) => void) => () => void;
  onClose: (handler: (event?: unknown) => void) => () => void;
  onError: (handler: (event?: unknown) => void) => () => void;
}

/**
 * Hello capabilities HQ overrides. The SDK sends `binary_chunking_v1` by default and a daemon that sees it may split a large frame
 * into binary chunks. A chunk is opaque until the SDK reassembles it, so it could not be told apart from a frame to drop. HQ never
 * offers chunking, so every frame it can accept arrives whole as text, and all binary frames are dropped.
 */
export const LIVE_CAPABILITIES = { binary_chunking_v1: false } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The close reasons that may reach the SDK. `daemon-client.js` `authFailureFromLegacyClose` compares `event.reason` with exactly these two
 * strings to recognise a password-protected daemon (reported as `needspassword`, errors.ts `isPasswordError`). Any other reason becomes
 * empty, which makes the SDK describe the close by its code alone (`Transport closed (code 1006)`, what errors.ts `connectFailure` reads).
 */
const PASSWORD_CLOSE_REASONS: ReadonlySet<unknown> = new Set([
  'Password required',
  'Incorrect password',
]);

/** A close event with its numeric code and one of the fixed reasons; whatever else the peer or socket put in it is dropped. */
function normalisedClose(event: unknown): { code?: number; reason: string } {
  const record = isRecord(event) ? event : {};
  const raw = typeof event === 'number' ? event : record.code;
  const reason = PASSWORD_CLOSE_REASONS.has(record.reason) ? (record.reason as string) : '';
  return typeof raw === 'number' && Number.isFinite(raw) ? { code: raw, reason } : { reason };
}

/**
 * A transport error with a fixed message. The SDK treats `Transport error` as a socket error without details and waits for the close
 * event (`daemon-client.js` `transport.onError`). A plain machine code (`ECONNREFUSED`, the shape errors.ts `codeOf` accepts) is kept.
 */
function normalisedError(event: unknown): Error {
  const code = (event as { code?: unknown } | null | undefined)?.code;
  const error = new Error('Transport error');
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(code)
    ? Object.assign(error, { code })
    : error;
}

/**
 * Feature flags the SDK reads for HQ's flow: `backgroundWorkspaces`, which `fetchAgents` requires (`requireBackgroundWorkspaces`) because
 * HQ lists with `includeBackground`; and `ownedSubscriptions` / `workspaceMultiplicity`, which `connection/index.js` `restore` and
 * `legacy.js` read to choose how subscriptions are routed.
 */
const KEPT_FEATURES = [
  'backgroundWorkspaces',
  'ownedSubscriptions',
  'workspaceMultiplicity',
] as const;

/**
 * The handshake frame as the SDK gets it. `daemon-client.js` `deliverSessionMessage` needs a `server_info` status with a `serverId`
 * (`ServerInfoStatusPayloadSchema`) to reach `connected`, and HQ's listing reads three feature flags (`KEPT_FEATURES`).
 * `fetchAgents` without `subscribe` consults nothing else. SDK 0.15.3 keeps the parsed frame in
 * `lastServerInfoMessage`, so the frame is built here field by field from that list: no `permissions` (the connection's grants), no
 * `hostname`, `version`, `sourceId` or `capabilities`, no other feature flag (so `binaryChunkingV1` is never on). Returns `undefined`
 * when there is no usable `serverId`, which the SDK would have rejected too.
 */
function serverInfoFrame(payload: Record<string, unknown>): string | undefined {
  const { serverId, features } = payload;
  if (typeof serverId !== 'string' || serverId.trim().length === 0) return undefined;
  const kept: Record<string, true> = {};
  if (isRecord(features))
    for (const name of KEPT_FEATURES) if (features[name] === true) kept[name] = true;
  return JSON.stringify({
    type: 'session',
    message: { type: 'status', payload: { status: 'server_info', serverId, features: kept } },
  });
}

/** The id of a session request the SDK is sending, if it is a listing request. Anything else HQ sends has no answer to let in. */
function listingRequestId(frame: unknown): string | undefined {
  if (typeof frame !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(frame);
    if (!isRecord(parsed) || parsed.type !== 'session' || !isRecord(parsed.message))
      return undefined;
    const { type, requestId } = parsed.message;
    return type === 'fetch_agents_request' && typeof requestId === 'string' ? requestId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps `factory` so each transport it makes only delivers the allowlisted frames (see the top of this file). Outbound frames are
 * passed on untouched; only the listing request ids in them are noted. The set of open ids belongs to one transport, so a new
 * connection starts with none.
 */
export function allowlistTransport<Options, Transport extends FilterableTransport>(
  factory: (options: Options) => Transport,
): (options: Options) => Transport {
  return (options) => {
    const transport = factory(options);
    const open = new Set<string>();

    /** The frame the SDK may see for `data`, or `undefined` to drop it; settles the request id of a listing answer. */
    const admit = (data: unknown): string | undefined => {
      if (typeof data !== 'string') return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return undefined;
      }
      if (!isRecord(parsed)) return undefined;
      if (parsed.type === 'pong' || parsed.type === 'hello.rejected') return data;
      if (parsed.type !== 'session' || !isRecord(parsed.message)) return undefined;
      const { type, payload } = parsed.message;
      if (type === 'status')
        return isRecord(payload) && payload.status === 'server_info'
          ? serverInfoFrame(payload)
          : undefined;
      if (type !== 'fetch_agents_response' && type !== 'rpc_error') return undefined;
      const requestId = isRecord(payload) ? payload.requestId : undefined;
      if (typeof requestId !== 'string' || !open.has(requestId)) return undefined;
      open.delete(requestId);
      return data;
    };

    // A Proxy, not a copy: the SDK's Node transport exposes `supportsDrain` and `maxFrameBytes` as getters that must stay live.
    return new Proxy(transport, {
      get(target, property) {
        if (property === 'send')
          return (data: Parameters<Transport['send']>[0]) => {
            const id = listingRequestId(data);
            if (id !== undefined) open.add(id);
            return target.send(data);
          };
        if (property === 'onMessage')
          return (handler: Parameters<Transport['onMessage']>[0]) =>
            target.onMessage((data, isBinary) => {
              const frame = admit(data);
              if (frame !== undefined) handler(frame, isBinary);
            });
        if (property === 'onClose')
          return (handler: Parameters<Transport['onClose']>[0]) =>
            target.onClose((event) => handler(normalisedClose(event)));
        if (property === 'onError')
          return (handler: Parameters<Transport['onError']>[0]) =>
            target.onError((event) => handler(normalisedError(event)));
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  };
}
