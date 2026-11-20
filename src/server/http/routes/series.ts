import { Hono } from 'hono';
import type { Db } from '../../db/open.ts';
import { buildSeries } from '../../services/metrics.ts';
import type { HttpEnv } from '../errors.ts';

/** GET /api/series: the aligned chart's buckets. Takes start, end, gran, repos, provider and author. */
export function seriesRoutes(deps: { db: Db; now: () => number; timezone: string }): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/series', (c) =>
    c.json(buildSeries(deps.db, c.req.query(), { nowMs: deps.now(), timezone: deps.timezone })),
  );
  return app;
}
