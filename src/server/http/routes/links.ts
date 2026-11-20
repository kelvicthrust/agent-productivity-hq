import { Hono } from 'hono';
import { ApiError } from '../../../shared/contracts/errors.ts';
import { LinkDecisionRequest } from '../../../shared/contracts/prs.ts';
import type { Db } from '../../db/open.ts';
import { buildPrDetail, removeLinkDecision, setLinkDecision } from '../../services/links.ts';
import type { HttpEnv } from '../errors.ts';

const DECISION_MESSAGE = 'Use confirmed, rejected or dismissed.';

/** The body's `decision`, or an `invalid_input` error that names the field. */
async function readDecision(request: Request) {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    throw new ApiError('invalid_input', 'The request body isn’t valid JSON.');
  }
  const parsed = LinkDecisionRequest.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_input', DECISION_MESSAGE, {
      details: { fields: { decision: DECISION_MESSAGE } },
    });
  }
  return parsed.data.decision;
}

/** A session id is a whole number; anything else is a malformed request, not an unknown session. */
function sessionIdOf(raw: string | undefined): number {
  const id = /^\d{1,15}$/.test(raw ?? '') ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(id)) {
    throw new ApiError('invalid_input', 'The session id must be a whole number.', {
      details: { fields: { sessionId: 'Use the id of a session.' } },
    });
  }
  return id;
}

/**
 * GET /api/prs/{prId} (the evidence and the candidate sessions of one PR), and PUT and DELETE /api/prs/{prId}/links/{sessionId}
 * (an owner decision, and taking it back). The merged-PR table is `prsRoutes`. The CSRF guard in front of every write is the app's.
 */
export function linksRoutes(deps: { db: Db; now: () => number; timezone: string }): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();

  app.get('/api/prs/:prId', (c) => c.json(buildPrDetail(deps.db, c.req.param('prId'))));

  app.put('/api/prs/:prId/links/:sessionId', async (c) => {
    const decision = await readDecision(c.req.raw);
    const item = setLinkDecision(
      deps.db,
      c.req.param('prId'),
      sessionIdOf(c.req.param('sessionId')),
      decision,
      { nowMs: deps.now() },
    );
    return c.json(item);
  });

  app.delete('/api/prs/:prId/links/:sessionId', (c) => {
    removeLinkDecision(deps.db, c.req.param('prId'), sessionIdOf(c.req.param('sessionId')), {
      nowMs: deps.now(),
    });
    return c.body(null, 204);
  });

  return app;
}
