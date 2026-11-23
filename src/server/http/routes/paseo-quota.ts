import { Hono } from 'hono';
import { Provider } from '../../../shared/contracts/common.ts';
import { ApiError } from '../../../shared/contracts/errors.ts';
import type { PaseoQuotaService } from '../../services/paseo-quota.ts';
import type { HttpEnv } from '../errors.ts';

export function paseoQuotaRoutes(quota: PaseoQuotaService | undefined): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  const service = () => {
    if (!quota)
      throw new ApiError('not_found', 'Paseo quota reports are unavailable in this session.');
    return quota;
  };
  app.get('/api/paseo-quota', async (c) => c.json(await service().read()));
  app.post('/api/paseo-quota/:provider/check', async (c) => {
    const provider = Provider.safeParse(c.req.param('provider'));
    if (!provider.success)
      throw new ApiError('not_found', 'That provider has no weekly quota here.');
    return c.json(await service().check(provider.data));
  });
  return app;
}
