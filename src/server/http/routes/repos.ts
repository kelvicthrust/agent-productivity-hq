import { Hono } from 'hono';
import { ApiError } from '../../../shared/contracts/errors.ts';
import { AddRepoRequest, GithubRepoAccount } from '../../../shared/contracts/repos.ts';
import type { GithubAuth, NetFetch } from '../../collectors/github/ports.ts';
import type { Db } from '../../db/open.ts';
import {
  addRepo,
  discoverRepos,
  listRepos,
  recheckRepo,
  stopTracking,
  type RepoWriteDeps,
} from '../../services/repos.ts';
import type { HttpEnv } from '../errors.ts';

/** What adding and re-checking a repo reach GitHub with. Absent in a process that was given no GitHub ports. */
export interface RepoGithub {
  net: NetFetch;
  /** `accounts.auth` of the account service (the sync and the repo check share it). */
  auth: GithubAuth;
  /** Starts a GitHub refresh in the background once a repo became readable. Optional. */
  requestSync?: (() => void) | undefined;
}

const FIELD_MESSAGE = 'Enter a repository as owner/name or a GitHub URL.';

/** The add request, or an `invalid_input` error that names the field so the form keeps what was typed (P-16). */
async function readInput(request: Request): Promise<AddRepoRequest> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    throw new ApiError('invalid_input', 'The request body isn’t valid JSON.');
  }
  const parsed = AddRepoRequest.safeParse(body);
  if (!parsed.success) {
    const input = (body as { input?: unknown } | null)?.input;
    const tooLong = typeof input === 'string' && input.length > 300;
    const message = tooLong
      ? 'That is too long to be a repository. Use owner/name.'
      : FIELD_MESSAGE;
    throw new ApiError('invalid_input', message, { details: { fields: { input: message } } });
  }
  return parsed.data;
}

/**
 * GET and POST /api/repos, DELETE /api/repos/{owner}/{name} and POST /api/repos/{owner}/{name}/recheck.
 * Adding and re-checking need GitHub; without it (`github` not given) they answer `github_not_connected`. Stopping is local.
 */
export function repoRoutes(deps: {
  db: Db;
  now: () => number;
  timezone: string;
  github?: RepoGithub | undefined;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();

  const writes = (): RepoWriteDeps => {
    if (!deps.github) {
      throw new ApiError('github_not_connected', 'GitHub isn’t available in this session.');
    }
    return {
      db: deps.db,
      now: deps.now,
      timezone: deps.timezone,
      net: deps.github.net,
      auth: deps.github.auth,
      requestSync: deps.github.requestSync,
    };
  };

  app.get('/api/repos', (c) =>
    c.json(listRepos(deps.db, { nowMs: deps.now(), timezone: deps.timezone })),
  );

  app.get('/api/repos/discover', async (c) => {
    c.header('Cache-Control', 'no-store');
    const { login, via, page = '1' } = c.req.query();
    const account = GithubRepoAccount.safeParse({ login, via });
    if (
      !account.success ||
      !/^\d+$/.test(page) ||
      !Number.isSafeInteger(Number(page)) ||
      Number(page) < 1
    ) {
      throw new ApiError(
        'invalid_input',
        'A GitHub account and a valid repository page are required.',
      );
    }
    return c.json(await discoverRepos(writes(), account.data, Number(page), c.req.raw.signal));
  });

  app.post('/api/repos', async (c) => {
    const repoDeps = writes();
    const { input, githubAccount, repositoryNodeId } = await readInput(c.req.raw);
    const { repo, reactivated } = await addRepo(repoDeps, input, {
      githubAccount,
      repositoryNodeId,
    });
    return c.json({ ...repo, reactivated }, 201);
  });

  app.delete('/api/repos/:owner/:name', (c) => {
    stopTracking({ db: deps.db, now: deps.now }, c.req.param('owner'), c.req.param('name'));
    return c.body(null, 204);
  });

  app.post('/api/repos/:owner/:name/recheck', async (c) =>
    c.json(await recheckRepo(writes(), c.req.param('owner'), c.req.param('name'))),
  );

  return app;
}
