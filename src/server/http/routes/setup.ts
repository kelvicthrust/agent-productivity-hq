import { Hono } from 'hono';
import { ApiError } from '../../../shared/contracts/errors.ts';
import { ResetRequest } from '../../../shared/contracts/sources.ts';
import { RESET_PATH, type ResetService } from '../../services/reset.ts';
import { createSetupService, type SetupDeps } from '../../services/setup.ts';
import type { HttpEnv } from '../errors.ts';

/**
 * First-launch Setup (local-api › M10 delta):
 *   POST /api/setup/discover  looks at this machine and answers `sources` and `accounts`. It writes only what each source's row says.
 *   POST /api/setup/complete  marks setup done and answers 202 with the refresh run it started (or, for a repeat, the one already
 *                             going or the latest: no second run).
 *
 * Discover and Complete never read the request: no body, no query and no path parameter, so no path, folder, key, password or token can reach
 * them, and a client that sent one would change nothing. The app header (CSRF) is the guard's job, as for every write.
 */
export function setupRoutes(deps: SetupDeps & { reset?: ResetService }): Hono<HttpEnv> {
  const service = createSetupService(deps);
  const app = new Hono<HttpEnv>();
  app.post('/api/setup/discover', async (c) => c.json(await service.discover()));
  app.post('/api/setup/complete', (c) => c.json(service.complete(), 202));
  const { reset } = deps;
  if (reset) {
    app.post(RESET_PATH, async (c) => {
      const body = await c.req.json().catch(() => null);
      if (!ResetRequest.safeParse(body).success) {
        throw new ApiError('invalid_input', 'Confirm that you want to reset the app.');
      }
      await reset.reset();
      return c.body(null, 204);
    });
  }
  return app;
}
