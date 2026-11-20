import { once } from 'node:events';
import { isAbsolute } from 'node:path';
import {
  AlreadyRunningError,
  DatabaseRecoveryError,
  PortInUseError,
  boot,
  packageVersion,
} from './boot.ts';
import { ConfigError, loadConfig } from './lib/config.ts';
import { liveBootDeps } from './live.ts';

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

function parseStart(value: unknown) {
  const message = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const { type, ownerLogin, remoteHost, version } = message;
  if (type !== 'start' || typeof version !== 'string' || !version.trim()) {
    throw new ConfigError(
      'Paseo must send a managed startup message with the installed application version.',
    );
  }
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
  return { version, remote: { host, ownerLogin } };
}

const send = process.send?.bind(process);
if (!send || !process.connected) {
  console.error(
    'Paseo must start the Agent Productivity HQ managed service with a parent connection.',
  );
  process.exit(1);
}

const reply = (
  message:
    | { type: 'ready'; version: string; port: number; remotePort: number }
    | { type: 'error'; code: ReturnType<typeof failureCode>; message: string },
) =>
  new Promise<void>((resolve, reject) => {
    send(message, (error) => (error ? reject(error) : resolve()));
  });

const stop = new AbortController();
const requestStop = () => stop.abort();
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
process.once('disconnect', requestStop);
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'stop') {
    requestStop();
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
  const server = await boot(config, { ...liveBootDeps(), version, remote: startup.remote });
  try {
    if (!server.remotePort) throw new Error('The Tailscale Serve listener did not start.');
    if (!stop.signal.aborted && process.connected) {
      await reply({
        type: 'ready',
        version,
        port: config.port,
        remotePort: server.remotePort,
      });
      if (!stop.signal.aborted) await once(stop.signal, 'abort');
    }
  } finally {
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
