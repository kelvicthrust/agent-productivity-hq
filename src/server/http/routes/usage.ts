import { Hono } from 'hono';
import { ApiError } from '../../../shared/contracts/errors.ts';
import type { Db } from '../../db/open.ts';
import {
  DEFAULT_ROOTS_LIMIT,
  MAX_ROOTS_LIMIT,
  buildCategories,
  buildGroups,
  buildRoots,
  resolveUsageScope,
} from '../../services/usage.ts';
import type { HttpEnv } from '../errors.ts';

/** `limit` is a whole number from 1 to the route's maximum; absent means the default. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ROOTS_LIMIT;
  const limit = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= MAX_ROOTS_LIMIT)) {
    throw new ApiError('invalid_input', 'The page size is not valid.', {
      details: { fields: { limit: `Use a whole number from 1 to ${MAX_ROOTS_LIMIT}.` } },
    });
  }
  return limit;
}

/**
 * The Usage routes: GET /api/usage/categories, /api/usage/groups and /api/usage/groups/{groupKey}/roots. A repo group key
 * contains a slash, so a client sends it URL-encoded (`kelvin%2Fatlas-api`); the router hands it back decoded.
 */
export function usageRoutes(deps: { db: Db; now: () => number; timezone: string }): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  const context = () => ({ nowMs: deps.now(), timezone: deps.timezone });

  app.get('/api/usage/categories', (c) => {
    const ctx = context();
    return c.json(buildCategories(deps.db, resolveUsageScope(deps.db, c.req.query(), ctx), ctx));
  });

  app.get('/api/usage/groups', (c) =>
    c.json(buildGroups(deps.db, resolveUsageScope(deps.db, c.req.query(), context()))),
  );

  app.get('/api/usage/groups/:groupKey/roots', (c) => {
    const query = c.req.query();
    const limit = parseLimit(query['limit']);
    const scope = resolveUsageScope(deps.db, query, context());
    return c.json(
      buildRoots(deps.db, scope, {
        groupKey: c.req.param('groupKey'),
        cursor: query['cursor'],
        limit,
      }),
    );
  });

  return app;
}
