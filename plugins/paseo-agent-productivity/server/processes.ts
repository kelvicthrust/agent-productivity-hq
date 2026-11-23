import { fork, type ChildProcess, type Serializable } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  nativeDashboard,
  type NativeRequest,
  type NativeResult,
  type PaseoRead,
} from '../shared/native.ts';
import { dashboardUnavailable, LaunchError, tailscaleUnavailable } from './errors.ts';
import { nodeEnvironment, resolveNodeExecutable } from './node-runtime.ts';
import { dashboardHttpsPort, type TailnetHost } from './tailscale.ts';

const versionPattern = /^\d+\.\d+\.\d+(?:[-+][\da-z.+-]+)?$/i;
const port = z.int().min(1).max(65535);
const dashboardReady = z.strictObject({
  type: z.literal('ready'),
  version: z.string(),
  port,
});
const id = z.int().positive();
const nativeResult = z.strictObject({
  type: z.literal('native-result'),
  id,
  result: nativeDashboard.output,
});
const remoteResult = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('remote-result'),
    id,
    ok: z.literal(true),
    port: port.optional(),
  }),
  z.strictObject({ type: z.literal('remote-result'), id, ok: z.literal(false) }),
]);
const commandReply = z.object({ type: z.enum(['native-result', 'remote-result']), id });
const paseoRead = z.strictObject({
  type: z.literal('paseo-read'),
  id,
  request: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('agents'), options: z.json() }),
    z.strictObject({ kind: z.literal('usage') }),
  ]),
});
const dashboardError = z.object({
  type: z.literal('error'),
  code: z.enum([
    'already-running',
    'port-in-use',
    'database-recovery',
    'config-invalid',
    'version-mismatch',
    'startup-failed',
  ]),
});

const startupMessages: Record<z.infer<typeof dashboardError>['code'], string> = {
  'already-running':
    'Stop the other Agent HQ process on the dashboard host before opening it from Paseo.',
  'port-in-use':
    'The local dashboard port is already in use. Free the port on the dashboard host or set AGENT_PRODUCTIVITY_PORT to a free port, then try again.',
  'database-recovery':
    'The Agent HQ database needs recovery. Start the dashboard locally on the host and follow its recovery page.',
  'config-invalid':
    'The dashboard host configuration is invalid. Check its Agent HQ environment variables and the Paseo plugin logs.',
  'version-mismatch':
    'The dashboard runtime version differs from the installed plugin. Reinstall the packaged Paseo plugin on the host.',
  'startup-failed': dashboardUnavailable().message,
};

export interface RuntimePaths {
  directory: string;
  version: string;
  node: string;
  entry: string;
  serveSession: string;
}

export async function runtimePaths(
  directory: string | undefined,
  signal: AbortSignal = new AbortController().signal,
  installRuntime = false,
): Promise<RuntimePaths> {
  if (!directory || !isAbsolute(directory)) {
    throw new LaunchError(
      'dashboard-unavailable',
      'Install the Agent HQ package under its default Paseo plugin ID.',
    );
  }
  const entry = join(directory, 'runtime', 'app', 'src', 'server', 'managed.js');
  const serveSession = join(directory, 'server', 'serve-session.mjs');
  let version: string;
  try {
    const [manifest] = await Promise.all([
      readFile(join(directory, 'package.json'), 'utf8'),
      access(entry, constants.R_OK),
      access(serveSession, constants.R_OK),
    ]);
    ({ version } = z
      .object({ version: z.string().regex(versionPattern) })
      .parse(JSON.parse(manifest)));
  } catch {
    throw new LaunchError(
      'dashboard-unavailable',
      'The installed Agent HQ runtime is missing or incomplete. Reinstall the packaged Paseo plugin on the dashboard host.',
    );
  }
  const node = await resolveNodeExecutable(directory, signal, installRuntime);
  return { directory, version, node, entry, serveSession };
}

export interface OwnedProcess {
  alive(): boolean;
  closed: Promise<void>;
  stop(): Promise<void>;
}

export interface DashboardProcess extends OwnedProcess {
  port: number;
  attachRemote(host: TailnetHost): Promise<number>;
  detachRemote(): Promise<void>;
  native(request: NativeRequest): Promise<NativeResult>;
}

function track(child: ChildProcess, stopMessage?: Serializable): OwnedProcess {
  let running = true;
  let stopped: Promise<void> | undefined;
  const closed = new Promise<void>((resolve) => {
    const exited = () => {
      running = false;
      resolve();
    };
    // The parent explicitly disconnects IPC during shutdown. Wait for process exit;
    // Node can omit 'close' for an IPC child with inherited stdio in this case.
    child.once('exit', exited);
    child.on('error', () => {
      if (child.pid === undefined) exited();
    });
  });
  return {
    alive: () => running && child.connected && child.exitCode === null && child.signalCode === null,
    closed,
    stop: () =>
      (stopped ??= (async () => {
        if (child.connected) {
          if (stopMessage) child.send(stopMessage, () => {});
          child.disconnect();
        }
        const wait = (milliseconds: number) =>
          Promise.race([closed, delay(milliseconds, undefined, { ref: false })]);
        await wait(stopMessage ? 5_500 : 2_000);
        if (running) child.kill('SIGTERM');
        await wait(800);
        if (running) child.kill('SIGKILL');
        await closed;
      })()),
  };
}

function waitForMessage<T>(
  child: ChildProcess,
  signal: AbortSignal,
  error: () => Error,
  accept: (message: unknown) => T | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => finish(error());
    const timeout = setTimeout(cancel, 8_000);
    function finish(reason: Error | null, value?: T) {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      child.off('message', message);
      child.off('error', cancel);
      child.off('disconnect', cancel);
      child.off('exit', cancel);
      if (reason) reject(reason);
      else resolve(value!);
    }
    function message(raw: unknown) {
      try {
        const result = accept(raw);
        if (result !== undefined) finish(null, result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Invalid child response'));
      }
    }
    child.on('message', message);
    child.once('error', cancel);
    child.once('disconnect', cancel);
    child.once('exit', cancel);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}

function spawnPackagedChild(paths: RuntimePaths, entry: string, args: string[]): ChildProcess {
  return fork(entry, args, {
    cwd: paths.directory,
    env: nodeEnvironment(),
    execPath: paths.node,
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}

export async function startDashboard(
  paths: RuntimePaths,
  expectedLocalPort: number,
  signal: AbortSignal,
  readPaseo?: PaseoRead,
): Promise<DashboardProcess> {
  if (signal.aborted) throw dashboardUnavailable();
  const child = spawnPackagedChild(paths, paths.entry, []);
  const owned = track(child, { type: 'stop' });
  const commands = dashboardCommands(child, owned, expectedLocalPort, readPaseo);
  const ready = waitForMessage(child, signal, dashboardUnavailable, (raw) => {
    if (paseoRead.safeParse(raw).success) return undefined;
    const serviceError = dashboardError.safeParse(raw);
    if (serviceError.success) {
      const { code } = serviceError.data;
      console.error('[Agent HQ] Managed dashboard failed:', code);
      throw new LaunchError('dashboard-unavailable', startupMessages[code]);
    }
    const result = dashboardReady.safeParse(raw);
    if (
      !result.success ||
      result.data.version !== paths.version ||
      result.data.port !== expectedLocalPort
    ) {
      throw dashboardUnavailable();
    }
    return result.data;
  });
  try {
    child.send(
      {
        type: 'start',
        version: paths.version,
      },
      (error) => {
        if (error && child.connected) child.disconnect();
      },
    );
    const { port } = await ready;
    return { ...owned, port, ...commands };
  } catch (error) {
    await owned.stop();
    throw error;
  }
}

function dashboardCommands(
  child: ChildProcess,
  owned: OwnedProcess,
  localPort: number,
  readPaseo?: PaseoRead,
): Pick<DashboardProcess, 'attachRemote' | 'detachRemote' | 'native'> {
  let nextRequestId = 0;
  const pending = new Map<number, (message?: unknown) => void>();
  function cancel() {
    for (const finish of pending.values()) finish();
  }
  function send(message: Serializable, failed: () => void) {
    if (!child.connected) {
      failed();
      return;
    }
    child.send(message, (error) => {
      if (error) failed();
    });
  }
  child.on('message', (raw: unknown) => {
    const read = paseoRead.safeParse(raw);
    if (read.success) {
      const { id, request } = read.data;
      void Promise.resolve()
        .then(() => readPaseo?.(request))
        .then(
          (raw) => {
            const value = z.json().safeParse(raw);
            send(
              value.success
                ? { type: 'paseo-read-result', id, ok: true, value: value.data }
                : { type: 'paseo-read-result', id, ok: false },
              () => {},
            );
          },
          () => send({ type: 'paseo-read-result', id, ok: false }, () => {}),
        );
      return;
    }
    const message = commandReply.safeParse(raw);
    if (message.success) pending.get(message.data.id)?.(raw);
  });
  child.once('disconnect', cancel);
  void owned.closed.then(cancel);

  function call(
    message: object,
    responseType: z.infer<typeof commandReply>['type'],
    timeoutMs = 12_000,
  ): Promise<unknown> {
    if (!owned.alive()) return Promise.reject(dashboardUnavailable());
    const requestId = ++nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(), timeoutMs).unref();
      function finish(response?: unknown) {
        if (response && (response as { type: string }).type !== responseType) return;
        clearTimeout(timer);
        pending.delete(requestId);
        if (response) resolve(response);
        else reject(dashboardUnavailable());
      }
      pending.set(requestId, finish);
      send({ ...message, id: requestId }, () => finish());
    });
  }
  return {
    async attachRemote(host) {
      const result = remoteResult.parse(
        await call(
          {
            type: 'attach-remote',
            ownerLogin: host.ownerLogin,
            remoteHost: host.authority,
          },
          'remote-result',
        ),
      );
      if (
        !result.ok ||
        !result.port ||
        result.port === localPort ||
        result.port === dashboardHttpsPort
      ) {
        throw dashboardUnavailable();
      }
      return result.port;
    },
    async detachRemote() {
      const result = remoteResult.parse(await call({ type: 'detach-remote' }, 'remote-result'));
      if (!result.ok || result.port !== undefined) throw dashboardUnavailable();
    },
    async native(request) {
      // Paseo's usage providers can take 20 seconds on a cold read.
      const usage = request.operation === 'usage' || request.operation === 'usageFallback';
      return nativeResult.parse(
        await call({ type: 'native', request }, 'native-result', usage ? 29_000 : 12_000),
      ).result;
    },
  };
}

export async function startServe(
  paths: RuntimePaths,
  binary: string,
  authority: string,
  remotePort: number,
  signal: AbortSignal,
): Promise<OwnedProcess> {
  if (signal.aborted) throw tailscaleUnavailable();
  const args = [binary, authority, String(dashboardHttpsPort), `http://127.0.0.1:${remotePort}`];
  const child = spawnPackagedChild(paths, paths.serveSession, args);
  const owned = track(child);
  const schema = z.object({ type: z.literal('ready') });
  try {
    await waitForMessage(child, signal, tailscaleUnavailable, (raw) => {
      if (!schema.safeParse(raw).success) throw tailscaleUnavailable();
      return true;
    });
    return owned;
  } catch (error) {
    await owned.stop();
    throw error;
  }
}
