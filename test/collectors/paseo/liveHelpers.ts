import type { LiveAgent } from '../../../src/server/collectors/paseo/liveAgent.ts';
import type {
  PaseoLiveClientLike,
  PaseoLiveListOptions,
} from '../../../src/server/collectors/paseo/live.ts';
import type { Sleep } from '../../../src/server/lib/sleep.ts';
import { NOW } from '../../server/helpers.ts';

// Shared by the live Paseo feed, roster, gate and wiring tests. The daemon is a fake: nothing here opens a socket, reads a real
// Paseo or knows a real title, folder or id. The snapshots carry the fields the feed must NEVER read, set to SENTINEL_* strings, so
// a test can show they appear nowhere in what the service returns or logs.

export { NOW };

export const SENTINELS = [
  'SENTINEL_LASTERROR',
  'SENTINEL_PERMISSION_NAME',
  'SENTINEL_PERMISSION_INPUT',
  'SENTINEL_PERMISSION_DESCRIPTION',
  'SENTINEL_PERMISSION_TITLE',
  'SENTINEL_PERMISSION_DETAIL',
  'SENTINEL_PERMISSION_METADATA',
  'SENTINEL_NOTIFICATION_BODY',
  'SENTINEL_USAGE_MODEL',
] as const;

const MIN = 60_000;
export const minutesAgo = (minutes: number, now = NOW): string =>
  new Date(now - minutes * MIN).toISOString();

export interface SnapshotSpec {
  id: string;
  provider?: string;
  status?: string;
  title?: string | null;
  cwd?: string;
  sessionId?: string | null;
  parent?: string;
  workspaceName?: string | null;
  /** Kinds of pending permission requests, each carrying sentinel detail. */
  permissions?: string[];
  attentionReason?: 'finished' | 'error' | 'permission' | null;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  turnStartedAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
  archivedAt?: string | null;
  providerUnavailable?: boolean;
}

/** One `agents.list` entry shaped like the SDK's, with sentinel values in every field the feed must not read. */
export function entry(spec: SnapshotSpec): { agent: Record<string, unknown>; project: unknown } {
  const provider = spec.provider ?? 'codex';
  return {
    agent: {
      id: spec.id,
      provider,
      cwd: spec.cwd ?? '/work/invented/project',
      workspaceId: 'w-1',
      model: 'SENTINEL_USAGE_MODEL',
      createdAt: spec.createdAt ?? minutesAgo(40),
      updatedAt: spec.updatedAt ?? minutesAgo(1),
      lastUserMessageAt: null,
      status: spec.status ?? 'idle',
      activeTurn:
        spec.turnStartedAt === undefined ? null : { turnId: 't-1', startedAt: spec.turnStartedAt },
      capabilities: {},
      currentModeId: null,
      availableModes: [],
      pendingPermissions: (spec.permissions ?? []).map((kind, index) => ({
        id: `p-${index}`,
        provider,
        name: 'SENTINEL_PERMISSION_NAME',
        kind,
        title: 'SENTINEL_PERMISSION_TITLE',
        description: 'SENTINEL_PERMISSION_DESCRIPTION',
        input: { command: 'SENTINEL_PERMISSION_INPUT' },
        detail: { type: 'shell', command: 'SENTINEL_PERMISSION_DETAIL' },
        metadata: { note: 'SENTINEL_PERMISSION_METADATA' },
      })),
      persistence: null,
      runtimeInfo: { provider, sessionId: spec.sessionId ?? null },
      lastUsage: { inputTokens: 1, model: 'SENTINEL_USAGE_MODEL' },
      lastError: 'SENTINEL_LASTERROR',
      title: spec.title === undefined ? `title ${spec.id}` : spec.title,
      labels: spec.parent ? { 'paseo.parent-agent-id': spec.parent } : {},
      requiresAttention: spec.requiresAttention ?? false,
      attentionReason: spec.attentionReason ?? null,
      attentionTimestamp: spec.attentionTimestamp ?? null,
      archivedAt: spec.archivedAt ?? null,
      providerUnavailable: spec.providerUnavailable ?? false,
    },
    project: {
      projectKey: 'p',
      projectName: 'project',
      workspaceName: spec.workspaceName === undefined ? null : spec.workspaceName,
      checkout: {},
    },
  };
}

/** A `LiveAgent` (what the feed keeps), for the pure mapping and roster tests. Idle, updated a minute ago, unless overridden. */
export function liveAgent(over: Partial<LiveAgent> & { id: string }): LiveAgent {
  return {
    provider: 'codex',
    cwd: '/work/invented/project',
    title: null,
    workspaceName: null,
    parentAgentId: null,
    sessionId: null,
    status: 'idle',
    turnStartedAt: null,
    pendingPermissionKind: null,
    requiresAttention: false,
    attentionReason: null,
    attentionAt: null,
    updatedAt: NOW - MIN,
    createdAt: NOW - 40 * MIN,
    archived: false,
    providerUnavailable: false,
    ...over,
  };
}

// ---- a sleep the test releases ----------------------------------------------------------------------------------------------

export interface ManualSleep extends Sleep {
  /** Every wait asked for, in order, with the length asked for. */
  readonly asked: number[];
  /** Waits that are still going. */
  readonly pending: number;
  /** Ends the oldest wait still going. */
  release(): void;
  /** Ends the oldest wait still going whose length is `ms`. */
  releaseMs(ms: number): void;
}

export function manualSleep(): ManualSleep {
  const waits: { ms: number; done: () => void }[] = [];
  const asked: number[] = [];
  const sleep: Sleep = (ms, signal) =>
    new Promise<void>((resolve) => {
      asked.push(ms);
      if (signal?.aborted) return resolve();
      const wait = {
        ms,
        done: () => {
          signal?.removeEventListener('abort', wait.done);
          const at = waits.indexOf(wait);
          if (at >= 0) waits.splice(at, 1);
          resolve();
        },
      };
      waits.push(wait);
      signal?.addEventListener('abort', wait.done, { once: true });
    });
  return Object.defineProperties(sleep, {
    asked: { value: asked },
    pending: { get: () => waits.length },
    release: { value: () => waits[0]?.done() },
    releaseMs: { value: (ms: number) => waits.find((wait) => wait.ms === ms)?.done() },
  }) as ManualSleep;
}

/** Lets promises settle: enough turns of the loop for the feed's awaits to run. */
export const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ---- the fake daemon ------------------------------------------------------------------------------------------------------

/** How a connect ends: fine, with a failure, or never (until the client is closed, which fails it like a real socket). */
export type ConnectScript = 'ok' | 'hang' | Error;

/** How a listing ends: with the daemon's entries, with a failure, or never (as the SDK does when the socket drops under it). */
export type ListScript = 'ok' | 'hang' | Error;

export interface FakeLiveClient {
  closed: boolean;
}

export interface FakeLiveDaemon {
  open: (url: string) => PaseoLiveClientLike;
  /** Every address a client was opened for, and every client. */
  opened: string[];
  clients: FakeLiveClient[];
  /** Every `agents.list` request, as the feed sent it. */
  lists: PaseoLiveListOptions[];
  /** How many clients are connected and not closed. */
  readonly connected: number;
  /** Scripts the next connects (first in, first used); once empty, connects succeed. */
  script(...results: ConnectScript[]): void;
  /** Scripts the next listings (first in, first used); once empty, listings answer with `entries`. */
  scriptLists(...results: ListScript[]): void;
  /** What every listing answers: the daemon's whole current state. Change it to change what the next poll sees. */
  entries: unknown[];
  hasMore: boolean;
  /** The socket goes away without a word, as with the SDK's reconnect off: only the connection state changes. */
  drop(): void;
}

export function fakeLiveDaemon(initial: unknown[] = []): FakeLiveDaemon {
  const scripted: ConnectScript[] = [];
  const scriptedLists: ListScript[] = [];
  const live = new Set<FakeLiveClient & { connectedNow: boolean }>();
  const daemon: FakeLiveDaemon = {
    opened: [],
    clients: [],
    lists: [],
    entries: initial,
    hasMore: false,
    get connected() {
      return [...live].filter((client) => client.connectedNow && !client.closed).length;
    },
    script: (...results) => {
      scripted.push(...results);
    },
    scriptLists: (...results) => {
      scriptedLists.push(...results);
    },
    drop: () => {
      for (const client of live) client.connectedNow = false;
    },
    open: (url) => {
      daemon.opened.push(url);
      let rejectHang: ((error: Error) => void) | null = null;
      const state: FakeLiveClient & { connectedNow: boolean } = {
        closed: false,
        connectedNow: false,
      };
      daemon.clients.push(state);
      live.add(state);
      const client: PaseoLiveClientLike = {
        connect: async () => {
          const result = scripted.shift() ?? 'ok';
          if (result instanceof Error) throw result;
          if (result === 'hang')
            await new Promise<void>((_resolve, reject) => {
              rejectHang = reject;
            });
          state.connectedNow = true;
        },
        close: () => {
          state.closed = true;
          state.connectedNow = false;
          rejectHang?.(new Error('Transport closed (code 1000)'));
          return Promise.resolve();
        },
        getConnectionState: () => ({ status: state.connectedNow ? 'connected' : 'disconnected' }),
        agents: {
          list: (options) => {
            daemon.lists.push(structuredClone(options));
            const result = scriptedLists.shift() ?? 'ok';
            if (result instanceof Error) return Promise.reject(result);
            if (result === 'hang') return new Promise(() => undefined);
            return Promise.resolve({
              entries: structuredClone(daemon.entries),
              pageInfo: { hasMore: daemon.hasMore },
            });
          },
        },
      };
      return client;
    },
  };
  return daemon;
}
