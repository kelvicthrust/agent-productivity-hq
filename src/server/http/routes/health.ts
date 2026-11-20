import { Hono } from 'hono';
import type { HealthResponse } from '../../../shared/contracts/bootstrap.ts';
import { getSchemaVersion } from '../../db/queries/meta.ts';
import type { Db } from '../../db/open.ts';
import type { HttpEnv } from '../errors.ts';

export function healthRoutes(deps: { db: Db; version: string }): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/health', (c) => {
    const body: HealthResponse = {
      status: 'ok',
      version: deps.version,
      schemaVersion: getSchemaVersion(deps.db),
    };
    return c.json(body);
  });
  return app;
}
