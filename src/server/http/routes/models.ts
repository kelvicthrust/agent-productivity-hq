import { Hono } from 'hono';
import type { Db } from '../../db/open.ts';
import { buildModels } from '../../services/metrics.ts';
import type { HttpEnv } from '../errors.ts';

/** GET /api/models: token share per model within each provider. Usage only: takes start, end, repos and provider, never author. */
export function modelsRoutes(deps: { db: Db; now: () => number; timezone: string }): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/models', (c) =>
    c.json(buildModels(deps.db, c.req.query(), { nowMs: deps.now(), timezone: deps.timezone })),
  );
  return app;
}
