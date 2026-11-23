import { Hono } from 'hono';
import type { Db } from '../../db/open.ts';
import type { ClaudeAccounts } from '../../services/claude-account.ts';
import { buildOverview } from '../../services/metrics.ts';
import type { HttpEnv } from '../errors.ts';

/** GET /api/overview: the KPIs, coverage strip, repository table and recent merges. Takes start, end, repos, provider and author. */
export function overviewRoutes(deps: {
  db: Db;
  now: () => number;
  timezone: string;
  claude?: ClaudeAccounts | undefined;
  paseoManaged?: boolean;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/overview', (c) => {
    const answer = buildOverview(
      deps.db,
      c.req.query(),
      { nowMs: deps.now(), timezone: deps.timezone },
      deps.claude?.planStatus(),
    );
    return c.json(deps.paseoManaged ? { ...answer, accounts: [] } : answer);
  });
  return app;
}
