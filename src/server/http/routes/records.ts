import { Hono } from 'hono';
import { ApiError } from '../../../shared/contracts/errors.ts';
import type { Db } from '../../db/open.ts';
import { buildRecords, DEFAULT_RECORDS_LIMIT, MAX_RECORDS_LIMIT } from '../../services/metrics.ts';
import type { HttpEnv } from '../errors.ts';

/** `limit` is a whole number from 1 to the maximum; absent means the default. It cuts each list, not the totals. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RECORDS_LIMIT;
  const limit = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= MAX_RECORDS_LIMIT)) {
    throw new ApiError('invalid_input', 'The page size is not valid.', {
      details: { fields: { limit: `Use a whole number from 1 to ${MAX_RECORDS_LIMIT}.` } },
    });
  }
  return limit;
}

/**
 * GET /api/records: the PRs and sessions inside ONE bucket. `start` and `end` are that bucket's dates (as the series gives them),
 * with repos, provider and author as in the rest of the scope, and `limit`.
 */
export function recordsRoutes(deps: {
  db: Db;
  now: () => number;
  timezone: string;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/records', (c) => {
    const query = c.req.query();
    const limit = parseLimit(query['limit']);
    return c.json(
      buildRecords(deps.db, query, { limit }, { nowMs: deps.now(), timezone: deps.timezone }),
    );
  });
  return app;
}
