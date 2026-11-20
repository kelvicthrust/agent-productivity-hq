import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The only address this server ever binds. It is a constant, never read from the environment. */
export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4317;
export const APP_DIR_NAME = 'agent-productivity';

export interface ServerConfig {
  /** Always the loopback address. */
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly logDir: string;
  readonly lockPath: string;
  /** Where the built SPA is served from. */
  readonly staticDir: string;
}

/** A setting this server will not accept. The message is plain English and is shown to the owner. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function defaultDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR_NAME);
  const xdg = env['XDG_DATA_HOME'];
  return join(xdg && xdg.length > 0 ? xdg : join(home, '.local', 'share'), APP_DIR_NAME);
}

/**
 * Reads AGENT_PRODUCTIVITY_PORT and AGENT_PRODUCTIVITY_DATA_DIR. An AGENT_PRODUCTIVITY_HOST value
 * other than the loopback address causes startup to fail, protecting the local dashboard.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; home?: string; staticDir?: string } = {},
): ServerConfig {
  const host = env['AGENT_PRODUCTIVITY_HOST'];
  if (host !== undefined && host !== '' && host !== LOOPBACK_HOST) {
    throw new ConfigError(
      `Agent Productivity HQ only listens on ${LOOPBACK_HOST}, so AGENT_PRODUCTIVITY_HOST="${host.slice(0, 80)}" is refused. Unset AGENT_PRODUCTIVITY_HOST.`,
    );
  }

  const rawPort = env['AGENT_PRODUCTIVITY_PORT'];
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || port < 1 || port > 65_535) {
      throw new ConfigError(
        `AGENT_PRODUCTIVITY_PORT must be a whole number from 1 to 65535, got "${rawPort.slice(0, 40)}".`,
      );
    }
  }

  const rawDir = env['AGENT_PRODUCTIVITY_DATA_DIR'];
  const dataDir =
    rawDir !== undefined && rawDir !== ''
      ? resolve(rawDir)
      : defaultDataDir(options.platform ?? process.platform, env, options.home ?? homedir());

  return {
    host: LOOPBACK_HOST,
    port,
    dataDir,
    dbPath: join(dataDir, 'agent-productivity.db'),
    logDir: join(dataDir, 'logs'),
    lockPath: join(dataDir, 'agent-productivity.lock'),
    staticDir: options.staticDir ?? resolve(import.meta.dirname, '../../../dist/client'),
  };
}

export const baseUrl = (port: number): string => `http://${LOOPBACK_HOST}:${port}`;
