import { Hono } from 'hono';
import type { ExactPrompts, HqResponse } from '../../../shared/contracts/hq.ts';
import { unavailableRoster, type HqService } from '../../services/hq/service.ts';
import type { HttpEnv } from '../errors.ts';

/**
 * GET /api/hq: the live roster of coding agents on this machine. Without a roster service (a process with no live feeder) it
 * answers 200 with every feed `unavailable` and no agents, so the page can say so. The roster is memory-only: this route reads
 * it and writes nothing. `exactPrompts` says whether Claude Code's hooks (the owner's opt-in switch) are on, for the page's wording.
 */
export function hqRoutes(deps: {
  now: () => number;
  hq?: HqService | undefined;
  exactPrompts?: (() => Promise<ExactPrompts>) | undefined;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.get('/api/hq', async (c) => {
    const roster = deps.hq ? await deps.hq.snapshot() : unavailableRoster(deps.now());
    let exactPrompts: ExactPrompts = 'unavailable';
    try {
      exactPrompts = (await deps.exactPrompts?.()) ?? 'unavailable';
    } catch {
      // The switch's state is a nicety: a settings file that cannot be read now never fails the roster.
    }
    const body: HqResponse = { ...roster, exactPrompts };
    return c.json(body);
  });
  return app;
}
