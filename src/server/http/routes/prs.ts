import { Hono } from 'hono';
import type { Db } from '../../db/open.ts';
import { buildPrs } from '../../services/delivery.ts';
import type { HttpEnv } from '../errors.ts';

/**
 * GET /api/prs: the merged-PR table. Filters are the shared `start`, `end`, `repos` and `author`, plus `linkClass`, `q`,
 * `cursor` and `limit`. The detail and link-decision routes under /api/prs/{prId} belong to the link engine (M8).
 */
export function prsRoutes(deps: { db: Db; now: () => number; timezone: string }): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/prs', (c) =>
    c.json(buildPrs(deps.db, c.req.query(), { nowMs: deps.now(), timezone: deps.timezone })),
  );
  return app;
}
