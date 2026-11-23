import { Hono } from 'hono';
import type { Db } from '../../db/open.ts';
import { buildBootstrap } from '../../services/bootstrap.ts';
import type { HttpEnv } from '../errors.ts';

export function bootstrapRoutes(deps: {
  db: Db;
  now: () => number;
  timezone: string;
  paseoManaged?: boolean;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/bootstrap', (c) => {
    const answer = buildBootstrap(deps.db, { nowMs: deps.now(), timezone: deps.timezone });
    return c.json(deps.paseoManaged ? { ...answer, paseoManaged: true } : answer);
  });
  return app;
}
