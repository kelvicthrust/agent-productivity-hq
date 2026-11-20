import { Hono } from 'hono';
import type { ErrorEnvelope } from '../../shared/contracts/errors.ts';
import type { Logger } from '../lib/logger.ts';
import type { HttpEnv } from './errors.ts';
import { csrfGuard, hostGuard, securityHeaders } from './guards.ts';
import {
  alreadyRunningPage,
  databaseRecoveryPage,
  diskFullPage,
  type AlreadyRunningInfo,
  type DatabaseRecoveryReason,
} from './recovery/index.ts';

// When the database is corrupt, a migration fails, the disk is full, or another copy already holds this data folder, the server
// still starts and says so, instead of crashing or "fixing" anything. It never deletes, moves or rewrites the file: the owner
// decides (TECH › Failure modes). The pages themselves are pure renderers in ./recovery/; this file puts guards and headers
// around them and chooses which one to show.

export type RecoveryReason = DatabaseRecoveryReason | 'disk_full';

export interface RecoveryInfo {
  reason: RecoveryReason;
  dbPath: string;
  /** One short, safe sentence about what failed. */
  detail: string;
  /** The migration file that failed, when one did. */
  migrationFile?: string;
  /** The data folder, for the not-enough-disk page; the database file's folder when not given. */
  dataDir?: string;
}

const dataDirOf = (info: RecoveryInfo): string =>
  info.dataDir ?? info.dbPath.replace(/[\\/][^\\/]*$/, '');

/** The page for this reason: the not-enough-disk page for a full disk, the database page for everything else. */
export function recoveryPage(info: RecoveryInfo): string {
  if (info.reason === 'disk_full')
    return diskFullPage({ dataDir: dataDirOf(info), detail: info.detail });
  return databaseRecoveryPage({
    reason: info.reason,
    dbPath: info.dbPath,
    detail: info.detail,
    ...(info.migrationFile ? { migrationFile: info.migrationFile } : {}),
  });
}

/** The app served in place of the real one while the database is unusable. Guards and headers stay on. */
export function createRecoveryApp(options: {
  port: number;
  info: RecoveryInfo;
  logger: Logger;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.use('*', securityHeaders());
  app.use('*', hostGuard(options.port, options.logger));
  app.use('*', csrfGuard(options.logger));

  const diskFull = options.info.reason === 'disk_full';
  const body: ErrorEnvelope = {
    error: {
      code: 'internal',
      message: diskFull
        ? `There isn’t enough disk space to use the database: ${options.info.detail}`
        : `The database can’t be used: ${options.info.detail}`,
      retryable: false,
      details: {
        recovery: true,
        reason: options.info.reason,
        dbPath: options.info.dbPath,
      },
    },
  };
  app.all('/api/*', (c) => c.json(body, 503));
  app.all('*', (c) =>
    c.req.method === 'GET' ? c.html(recoveryPage(options.info), 503) : c.json(body, 503),
  );
  return app;
}

/**
 * What another copy's lock turns this process into when its own port is free: a page that points to the running copy. It never
 * opens the database (the database has one writer) and answers every API request with a plain refusal.
 */
export function createAlreadyRunningApp(options: {
  port: number;
  info: AlreadyRunningInfo;
  logger: Logger;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.use('*', securityHeaders());
  app.use('*', hostGuard(options.port, options.logger));
  app.use('*', csrfGuard(options.logger));

  const body: ErrorEnvelope = {
    error: {
      code: 'internal',
      message: `Agent Productivity HQ is already running at ${options.info.url}`,
      retryable: false,
      details: { alreadyRunning: true, url: options.info.url },
    },
  };
  app.all('/api/*', (c) => c.json(body, 503));
  app.all('*', (c) =>
    c.req.method === 'GET' ? c.html(alreadyRunningPage(options.info), 503) : c.json(body, 503),
  );
  return app;
}
