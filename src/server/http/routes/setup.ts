import { Hono } from 'hono';
import { createSetupService, type SetupDeps } from '../../services/setup.ts';
import type { HttpEnv } from '../errors.ts';

/**
 * First-launch Setup (local-api › M10 delta):
 *   POST /api/setup/discover  looks at this machine and answers `sources` and `accounts`. It writes only what each source's row says.
 *   POST /api/setup/complete  marks setup done and answers 202 with the refresh run it started (or, for a repeat, the one already
 *                             going or the latest: no second run).
 *
 * Neither route reads the request: no body, no query and no path parameter, so no path, folder, key, password or token can reach
 * them, and a client that sent one would change nothing. The app header (CSRF) is the guard's job, as for every write.
 */
export function setupRoutes(deps: SetupDeps): Hono<HttpEnv> {
  const service = createSetupService(deps);
  const app = new Hono<HttpEnv>();
  app.post('/api/setup/discover', async (c) => c.json(await service.discover()));
  app.post('/api/setup/complete', (c) => c.json(service.complete(), 202));
  return app;
}
