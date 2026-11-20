import { Hono } from 'hono';
import type { Db } from '../../db/open.ts';
import { buildYear } from '../../services/delivery.ts';
import type { HttpEnv } from '../errors.ts';

/** GET /api/year: daily merge counts for the 12-month grid. Takes the shared `repos` and `author` filters only. */
export function yearRoutes(deps: { db: Db; now: () => number; timezone: string }): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/year', (c) =>
    c.json(buildYear(deps.db, c.req.query(), { nowMs: deps.now(), timezone: deps.timezone })),
  );
  return app;
}
