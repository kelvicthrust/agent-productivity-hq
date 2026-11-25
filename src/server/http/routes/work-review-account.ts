import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ApiError } from '../../../shared/contracts/errors.ts';
import {
  WorkReviewConnectRequest,
  WorkReviewDisconnectRequest,
} from '../../../shared/contracts/work-review.ts';
import {
  WorkReviewAuthError,
  workReviewAccountUnavailable,
  type WorkReviewAuth,
} from '../../integrations/workReviewAuth/index.ts';
import type { Db } from '../../db/open.ts';
import { readSetupState } from '../../db/queries/setup.ts';
import type { HttpEnv } from '../errors.ts';

const limit = bodyLimit({
  maxSize: 1024,
  onError() {
    throw new ApiError('invalid_input', 'The Work Review sign-in request is too large.');
  },
});

function demand(auth: WorkReviewAuth | undefined): WorkReviewAuth {
  if (!auth) throw new ApiError('upstream_unavailable', workReviewAccountUnavailable.message!);
  return auth;
}

function authorizationError(error: unknown): never {
  if (error instanceof WorkReviewAuthError)
    throw new ApiError('upstream_unavailable', error.message);
  throw error;
}

export function workReviewAccountRoutes(
  db: Db,
  auth?: WorkReviewAuth,
  clearReviewConsent?: () => Promise<void>,
) {
  const app = new Hono<HttpEnv>();
  app.get('/api/work-review/account', (c) =>
    c.json(auth?.status() ?? workReviewAccountUnavailable),
  );
  app.post('/api/work-review/account/connect', limit, async (c) => {
    const input = WorkReviewConnectRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new ApiError('invalid_input', 'Use the Work Review sign-in control.');
    if (!readSetupState(db).complete)
      throw new ApiError('invalid_input', 'Finish setup before connecting Work Review.');
    const account = demand(auth);
    try {
      return c.json(await account.connect(input.data.newProfile, clearReviewConsent));
    } catch (error) {
      authorizationError(error);
    }
  });
  app.post('/api/work-review/account/disconnect', limit, async (c) => {
    const input = WorkReviewDisconnectRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      throw new ApiError('invalid_input', 'Use the Work Review sign-out control.');
    const account = demand(auth);
    try {
      return c.json(await account.disconnect(clearReviewConsent));
    } catch (error) {
      authorizationError(error);
    }
  });
  return app;
}
