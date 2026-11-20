import { Hono } from 'hono';
import { ApiError } from '../../../shared/contracts/errors.ts';
import { RefreshRequest } from '../../../shared/contracts/sources.ts';
import type { Runner } from '../../collectors/runner.ts';
import type { Db } from '../../db/open.ts';
import { getRefreshRun, toRefreshRun } from '../../services/sources.ts';
import type { HttpEnv } from '../errors.ts';

/** The body, or `{}` when there is none (the button sends `{}`; a bare `curl -X POST` sends nothing). */
async function readBody(request: Request): Promise<unknown> {
  const body = await request.text();
  if (body.trim() === '') return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError('invalid_input', 'The request body isn’t valid JSON.');
  }
}

/**
 * POST /api/refresh starts a run (202) or, while one is going, answers 409 refresh_running with `details.runId` so the
 * client attaches to it. GET /api/refresh/{runId} is the run as it stands: the client polls it every second and reads
 * "Retrying…" and the outcome from it.
 */
export function refreshRoutes(deps: { db: Db; runner: Runner }): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();

  app.post('/api/refresh', async (c) => {
    const { sources } = RefreshRequest.parse(await readBody(c.req.raw));
    if (sources?.length === 0) {
      throw new ApiError('invalid_input', 'Some values are not valid.', {
        details: {
          fields: { sources: 'Pick at least one source, or leave it out to refresh all.' },
        },
      });
    }
    const started = deps.runner.start({
      trigger: 'manual',
      ...(sources ? { sources: [...new Set(sources)] } : {}),
    });
    if (!started.started) {
      throw new ApiError('refresh_running', 'A refresh is already running.', {
        details: { runId: started.runId },
      });
    }
    return c.json(toRefreshRun(started.run), 202);
  });

  app.get('/api/refresh/:runId', (c) => {
    const raw = c.req.param('runId');
    if (!/^[1-9][0-9]*$/.test(raw)) {
      throw new ApiError('invalid_input', 'Some values are not valid.', {
        details: { fields: { runId: 'Use the number a refresh was started with.' } },
      });
    }
    const run = getRefreshRun(deps.db, Number(raw));
    if (!run) throw new ApiError('not_found', 'There is no refresh with that number.');
    return c.json(run);
  });

  return app;
}
