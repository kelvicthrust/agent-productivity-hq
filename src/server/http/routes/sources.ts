import { Hono } from 'hono';
import type { GithubAccounts } from '../../collectors/github/ports.ts';
import type { Db } from '../../db/open.ts';
import { buildChatgptReport, type ChatgptAccounts } from '../../services/accounts.ts';
import type { ClaudeAccounts } from '../../services/claude-account.ts';
import { buildSources } from '../../services/sources.ts';
import type { HttpEnv } from '../errors.ts';

/**
 * GET /api/sources: the local sources, the run in progress and the account cards this process has: GitHub (when it has the GitHub
 * integration) ChatGPT (when it has the Codex app-server integration) and Claude (when it has the plan-usage capture). `now` gives "History from" its today: a source's oldest imported date is never shown earlier
 * than what retention keeps.
 */
export function sourcesRoutes(deps: {
  db: Db;
  now?: () => number;
  timezone: string;
  github?: GithubAccounts | undefined;
  chatgpt?: ChatgptAccounts | undefined;
  claude?: ClaudeAccounts | undefined;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/sources', async (c) => {
    const sources = buildSources(deps.db, { timezone: deps.timezone, now: deps.now });
    const accounts = [
      ...(deps.github ? [await deps.github.status()] : []),
      ...(deps.chatgpt ? [deps.chatgpt.status()] : []),
      ...(deps.claude ? [await deps.claude.status()] : []),
    ];
    const report = deps.chatgpt ? buildChatgptReport(deps.db) : null;
    return c.json({
      ...sources,
      ...(accounts.length ? { accounts } : {}),
      ...(report
        ? {
            chatgptCoverage: {
              unit: report.unit,
              bucketSpan: report.bucketSpan,
              stale: report.stale,
            },
          }
        : {}),
    });
  });
  return app;
}
