import { Hono } from 'hono';
import { ApiError } from '../../../shared/contracts/errors.ts';
import { GenerateWorkReview, WorkReviewAutomation } from '../../../shared/contracts/work-review.ts';
import type { WorkReviewService } from '../../services/work-review/service.ts';
import type { HttpEnv } from '../errors.ts';

export function workReviewRoutes(service: WorkReviewService) {
  const app = new Hono<HttpEnv>();
  app.get('/api/work-review/automation', (c) => c.json(service.getAutomation()));
  app.post('/api/work-review/automation', async (c) => {
    const body = WorkReviewAutomation.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      throw new ApiError('invalid_input', 'Choose whether to keep this week up to date.');
    return c.json(await service.setAutomation(body.data.enabled));
  });
  app.get('/api/work-review', (c) => {
    const raw = c.req.query('version');
    const version = raw === undefined ? undefined : Number(raw);
    if (
      version !== undefined &&
      (!Number.isSafeInteger(version) || version < 1 || String(version) !== raw)
    )
      throw new ApiError('invalid_input', 'Select a valid version.');
    return c.json(service.read(c.req.query(), version));
  });
  app.post('/api/work-review/generate', async (c) => {
    const body = GenerateWorkReview.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      throw new ApiError(
        'invalid_input',
        'Confirm sending the selected evidence to OpenAI to generate this update.',
      );
    const state = service.generate(c.req.query(), body.data.revision === true);
    return c.json(state, state.status === 'running' ? 202 : 200);
  });
  return app;
}
