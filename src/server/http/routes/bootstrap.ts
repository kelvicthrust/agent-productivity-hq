import { Hono } from 'hono';
import type { Db } from '../../db/open.ts';
import { buildBootstrap } from '../../services/bootstrap.ts';
import type { HttpEnv } from '../errors.ts';

export function bootstrapRoutes(deps: {
  db: Db;
  now: () => number;
  timezone: string;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/bootstrap', (c) =>
    c.json(buildBootstrap(deps.db, { nowMs: deps.now(), timezone: deps.timezone })),
  );
  return app;
}
