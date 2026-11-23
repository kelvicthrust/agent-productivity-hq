import { once } from 'node:events';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  AlreadyRunningError,
  DatabaseRecoveryError,
  PortInUseError,
  boot,
  packageVersion,
} from './boot.ts';
import { ConfigError, loadConfig } from './lib/config.ts';
import { liveBootDeps } from './live.ts';
import {
  createPaseoNative,
  paseoBootDeps,
  type NativeResult,
  type PaseoRead,
} from './paseo-native.ts';

class VersionMismatchError extends Error {
  constructor() {
    super(
      'The installed Agent Productivity HQ runtime version does not match the Paseo plugin. Reinstall the plugin and try again.',
    );
    this.name = 'VersionMismatchError';
  }
}

function failureCode(error: unknown) {
  if (error instanceof AlreadyRunningError) return 'already-running';
  if (error instanceof PortInUseError) return 'port-in-use';
  if (error instanceof DatabaseRecoveryError) return 'database-recovery';
  if (error instanceof ConfigError) return 'config-invalid';
  if (error instanceof VersionMismatchError) return 'version-mismatch';
  return 'startup-failed';
}

function parseRemote(ownerLogin: unknown, remoteHost: unknown) {
  if (typeof ownerLogin !== 'string' || !/^[!-~]+$/.test(ownerLogin) || ownerLogin.includes(',')) {
    throw new ConfigError(
      'Paseo must supply a Tailscale owner login as a single printable ASCII value.',
    );
  }
  const host = typeof remoteHost === 'string' ? remoteHost.toLowerCase() : '';
  const match = host.match(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net(?::([1-9]\d{0,4}))?$/,
  );
  if (!match || (match[1] && Number(match[1]) > 65_535)) {
    throw new ConfigError(
      'Paseo must supply the Tailscale Serve hostname and its port when applicable.',
    );
  }
  return { host, ownerLogin };
}

function parseStart(value: unknown) {
  const message = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const { type, ownerLogin, remoteHost, version } = message;
  if (type !== 'start' || typeof version !== 'string' || !version.trim()) {
    throw new ConfigError(
      'Paseo must send a managed startup message with the installed application version.',
    );
  }
  const remote =
    ownerLogin === undefined && remoteHost === undefined
      ? undefined
      : parseRemote(ownerLogin, remoteHost);
  return { version, remote };
}

const send = process.send?.bind(process);
if (!send || !process.connected) {
  console.error(
    'Paseo must start the Agent Productivity HQ managed service with a parent connection.',
  );
  process.exit(1);
}

const reply = (message: Parameters<NonNullable<typeof process.send>>[0]) =>
  new Promise<void>((resolve, reject) => {
    send(message, (error) => (error ? reject(error) : resolve()));
  });

const id = z.int().positive();
const readResult = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('paseo-read-result'),
    id,
    ok: z.literal(true),
    value: z.json(),
  }),
  z.strictObject({ type: z.literal('paseo-read-result'), id, ok: z.literal(false) }),
]);
const operation = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('native'), id, request: z.json() }),
  z.strictObject({
    type: z.literal('attach-remote'),
    id,
    ownerLogin: z.string(),
    remoteHost: z.string(),
  }),
  z.strictObject({ type: z.literal('detach-remote'), id }),
]);

const stop = new AbortController();
const requestStop = () => stop.abort();
const pendingReads = new Map<number, (result?: z.infer<typeof readResult>) => void>();
let nextReadId = 0;
const readPaseo: PaseoRead = (request) =>
  new Promise((resolve, reject) => {
    const readId = ++nextReadId;
    const timer = setTimeout(() => finish(), request.kind === 'usage' ? 24_000 : 8_000).unref();
    function finish(result?: z.infer<typeof readResult>) {
      clearTimeout(timer);
      pendingReads.delete(readId);
      if (result?.ok) resolve(result.value);
      else reject(new Error('The Paseo host read did not complete.'));
    }
    if (stop.signal.aborted || !process.connected) {
      finish();
      return;
    }
    pendingReads.set(readId, finish);
    void reply({ type: 'paseo-read', id: readId, request }).catch(() => finish());
  });
stop.signal.addEventListener(
  'abort',
  () => {
    for (const finish of pendingReads.values()) finish();
  },
  { once: true },
);
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
process.once('disconnect', requestStop);
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'stop') {
    requestStop();
  } else {
    const read = readResult.safeParse(message);
    if (read.success) pendingReads.get(read.data.id)?.(read.data);
  }
});

let exitCode = 0;
try {
  const [message] = await once(process, 'message', { signal: stop.signal });
  stop.signal.throwIfAborted();
  const startup = parseStart(message);
  const version = packageVersion();
  if (!version || version !== startup.version) throw new VersionMismatchError();
  const dataDir = process.env['AGENT_PRODUCTIVITY_DATA_DIR'];
  if (dataDir && !isAbsolute(dataDir)) {
    throw new ConfigError(
      'Use an absolute AGENT_PRODUCTIVITY_DATA_DIR for the managed installation.',
    );
  }
  const config = loadConfig();
  const server = await boot(config, {
    ...liveBootDeps(),
    ...(startup.remote ? {} : paseoBootDeps(readPaseo)),
    version,
    managed: true,
    remote: startup.remote,
  });
  let remote: Awaited<ReturnType<NonNullable<typeof server.attachRemote>>> | undefined;
  let remoteOperation = Promise.resolve();
  const native = createPaseoNative({ server, config });
  function handle(raw: unknown) {
    if (stop.signal.aborted) return;
    const parsed = operation.safeParse(raw);
    if (!parsed.success) return;
    const command = parsed.data;
    const respond = (
      value:
        | { type: 'native-result'; result: NativeResult }
        | { type: 'remote-result'; ok: boolean; port?: number },
    ) => reply({ id: command.id, ...value }).catch(() => undefined);
    async function run() {
      if (command.type === 'native') {
        try {
          await respond({ type: 'native-result', result: await native(command.request) });
        } catch {
          await respond({
            type: 'native-result',
            result: {
              ok: false,
              reason: 'dashboard-unavailable',
              message: 'Agent HQ could not complete the request.',
            },
          });
        }
        return;
      }
      try {
        if (command.type === 'attach-remote') {
          const access = parseRemote(command.ownerLogin, command.remoteHost);
          if (remote || !server.attachRemote || startup.remote || stop.signal.aborted) {
            throw new Error('Cannot attach the Tailscale Serve listener.');
          }
          remote = await server.attachRemote(access);
          await respond({ type: 'remote-result', ok: true, port: remote.port });
        } else {
          await remote?.close();
          remote = undefined;
          await respond({ type: 'remote-result', ok: true });
        }
      } catch {
        await respond({ type: 'remote-result', ok: false });
      }
    }
    const work = command.type === 'native' ? run() : (remoteOperation = remoteOperation.then(run));
    server.trackManagedOperation?.(work);
  }
  try {
    if (startup.remote && !server.remotePort)
      throw new Error('The Tailscale Serve listener did not start.');
    if (!stop.signal.aborted && process.connected) {
      process.on('message', handle);
      await reply({
        type: 'ready',
        version,
        port: config.port,
        ...(server.remotePort === undefined ? {} : { remotePort: server.remotePort }),
      });
      if (!stop.signal.aborted) await once(stop.signal, 'abort');
    }
  } finally {
    process.off('message', handle);
    await server.shutdown();
  }
} catch (error) {
  if (!stop.signal.aborted && process.connected) {
    exitCode = 1;
    const detail = error instanceof Error ? error.message : String(error);
    const message =
      error instanceof AlreadyRunningError
        ? `${detail} Stop the existing Agent Productivity HQ process before starting it from Paseo.`
        : detail;
    await reply({ type: 'error', code: failureCode(error), message }).catch(() =>
      console.error(message),
    );
  }
} finally {
  if (process.connected) process.disconnect?.();
}
process.exit(exitCode);
