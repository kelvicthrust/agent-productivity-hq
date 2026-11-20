import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import type { GithubAccounts } from '../../src/server/collectors/github/ports.ts';
import type { RepoGithub } from '../../src/server/http/routes/repos.ts';
import type { ChatgptAccounts } from '../../src/server/services/accounts.ts';
import type { ClaudeAccounts } from '../../src/server/services/claude-account.ts';
import type { HookIngest } from '../../src/server/http/routes/hqHooks.ts';
import type { ClaudeHooks } from '../../src/server/integrations/claudeHooks/index.ts';
import type { HqService } from '../../src/server/services/hq/service.ts';
import { createRunner } from '../../src/server/collectors/runner.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { createApp } from '../../src/server/http/app.ts';
import { loadConfig, type ServerConfig } from '../../src/server/lib/config.ts';
import { createLogger, type Logger } from '../../src/server/lib/logger.ts';

export const PORT = 4317;
/** 2026-11-04 12:00 in Los Angeles (20:00 UTC), a Wednesday. */
export const NOW = Date.parse('2026-11-04T20:00:00Z');
export const TZ = 'America/Los_Angeles';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp directory, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-test-'));
  dirs.push(dir);
  return dir;
}

/** A config pointing at a fresh data directory. */
export function tempConfig(port = PORT): ServerConfig {
  return loadConfig(
    { AGENT_PRODUCTIVITY_DATA_DIR: join(tempDir(), 'data'), AGENT_PRODUCTIVITY_PORT: String(port) },
    { staticDir: join(tempDir(), 'no-spa') },
  );
}

export function memoryLogger(level: 'debug' | 'info' = 'info'): {
  logger: Logger;
  entries: Record<string, unknown>[];
} {
  const entries: Record<string, unknown>[] = [];
  return {
    logger: createLogger({ sink: (_line, entry) => entries.push(entry), level, now: () => NOW }),
    entries,
  };
}

/** A migrated in-memory database. */
export function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function testApp(
  overrides: {
    db?: DatabaseSync;
    staticDir?: string | null;
    previewLabel?: string;
    /** The GitHub account service; without it GitHub is not available in this session. */
    github?: GithubAccounts;
    /** What adding and re-checking a repo reach GitHub with; without it adding says GitHub is not available. */
    repos?: RepoGithub;
    /** The ChatGPT account service; without it the ChatGPT routes say so. */
    chatgpt?: ChatgptAccounts;
    /** The Claude plan-usage capture; without it the two capture routes say so. */
    claude?: ClaudeAccounts;
    /** The live HQ roster; without it GET /api/hq says every feed is unavailable. */
    hq?: HqService;
    /** The owner's switch for Claude Code hooks, and what the hook script posts to (loopback only). */
    claudeHooks?: ClaudeHooks;
    hookIngest?: HookIngest;
    /** Builds the app as the Tailscale listener's: owner guard on, and no hook endpoint whatever `hookIngest` is. */
    remote?: { host: string; ownerLogin: string };
  } = {},
) {
  const db = overrides.db ?? memoryDb();
  const logs = memoryLogger();
  const app = createApp({
    db,
    logger: logs.logger,
    runner: createRunner({ db, now: () => NOW, logger: logs.logger, adapters: [] }),
    port: PORT,
    now: () => NOW,
    timezone: TZ,
    version: '0.0.0-test',
    staticDir: overrides.staticDir ?? null,
    previewLabel: overrides.previewLabel,
    github: overrides.github,
    repos: overrides.repos,
    chatgpt: overrides.chatgpt,
    claude: overrides.claude,
    hq: overrides.hq,
    claudeHooks: overrides.claudeHooks,
    hookIngest: overrides.hookIngest,
    ...(overrides.remote ? { remote: overrides.remote } : {}),
  });
  return { app, db, ...logs };
}

export const HOST = { host: `127.0.0.1:${PORT}` };
export const WRITE = {
  host: `127.0.0.1:${PORT}`,
  'x-agent-productivity-request': '1',
  'content-type': 'application/json',
};

/** Request through the app without a socket. The URL host is irrelevant; the Host header is what the guard reads. */
export const call = (
  app: ReturnType<typeof testApp>['app'],
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) => app.request(`http://127.0.0.1:${PORT}${path}`, init);
