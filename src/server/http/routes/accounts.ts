import { Hono } from 'hono';
import { ApiError } from '../../../shared/contracts/errors.ts';
import type { GithubAccounts } from '../../collectors/github/ports.ts';
import {
  CapturePreviewAction,
  ClaudePlanLimitsCheckRequest,
  UsageCaptureRequest,
} from '../../../shared/contracts/accounts.ts';
import type { ChatgptAccounts } from '../../services/accounts.ts';
import type { ClaudeAccounts } from '../../services/claude-account.ts';
import type { HttpEnv } from '../errors.ts';

// The account routes (local-api › Accounts). M6 serves GitHub: connect (gh, or the App device flow), poll, disconnect, and the
// App's client ID. M9 serves ChatGPT: connect (Codex's own browser sign-in), poll and disconnect, over services/accounts.ts, and the Claude
// plan-usage capture (preview and the manual setup and removal actions). A process that was given no ChatGPT service (the integration is not there) answers
// with a plain 422, not a guess, and Claude has no sign-in at all. None of these routes takes, returns or logs a token: GitHub's live in the Keychain, and ChatGPT's are Codex's own.

type Account = 'github' | 'chatgpt' | 'claude';
const ACCOUNTS: readonly Account[] = ['github', 'chatgpt', 'claude'];

function accountOf(raw: string | undefined): Account {
  const found = ACCOUNTS.find((account) => account === raw);
  if (!found) throw new ApiError('not_found', 'There is no account with that name.');
  return found;
}

/** `github_not_connected` for a session that was started without the GitHub integration (no ports were given). */
function githubOf(github: GithubAccounts | undefined): GithubAccounts {
  if (!github) {
    throw new ApiError('github_not_connected', 'GitHub sign-in isn’t available in this session.');
  }
  return github;
}

/** The body, or `{}` when there is none. The wrong shape is the caller's to fix, so it says so in plain words. */
async function readJson(request: Request): Promise<unknown> {
  const body = await request.text();
  if (body.trim() === '') return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError('invalid_input', 'The request body isn’t valid JSON.');
  }
}

const notYet = (name: string): ApiError =>
  new ApiError('invalid_input', `${name} sign-in isn’t available yet.`, { status: 422 });

export function accountRoutes(deps: {
  github?: GithubAccounts | undefined;
  /** The ChatGPT account service (services/accounts.ts). Without it the ChatGPT routes answer as before M9. */
  chatgpt?: ChatgptAccounts | undefined;
  /** The Claude plan-usage capture (services/claude-account.ts). Without it the two capture routes say so. */
  claude?: ClaudeAccounts | undefined;
  paseoManaged?: boolean;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();

  app.post('/api/accounts/:account/connect', async (c) => {
    switch (accountOf(c.req.param('account'))) {
      case 'github':
        return c.json(await githubOf(deps.github).connect());
      case 'chatgpt':
        if (!deps.chatgpt) throw notYet('ChatGPT');
        return c.json(await deps.chatgpt.connect());
      case 'claude':
        throw new ApiError(
          'invalid_input',
          'Use Sources to check plan limits with your Claude Code sign-in.',
          { status: 422 },
        );
    }
  });

  app.get('/api/accounts/:account/connect/:loginId', async (c) => {
    const account = accountOf(c.req.param('account'));
    if (account === 'chatgpt' && deps.chatgpt) {
      return c.json(deps.chatgpt.poll(c.req.param('loginId')));
    }
    if (account !== 'github') {
      throw new ApiError('not_found', 'That sign-in is not running here. Start again.');
    }
    return c.json(await githubOf(deps.github).poll(c.req.param('loginId')));
  });

  app.post('/api/accounts/:account/disconnect', async (c) => {
    switch (accountOf(c.req.param('account'))) {
      case 'github':
        return c.json(await githubOf(deps.github).disconnect());
      case 'chatgpt':
        if (!deps.chatgpt) throw notYet('ChatGPT');
        return c.json(deps.chatgpt.disconnect());
      case 'claude':
        throw new ApiError('invalid_input', 'Claude has no sign-in to disconnect here.', {
          status: 422,
        });
    }
  });

  // The protected POST is the only entry point for a Claude Code OAuth read and plan check.
  const claudeOf = (): ClaudeAccounts => {
    if (!deps.claude) {
      throw new ApiError('invalid_input', 'Claude plan limits aren’t available in this session.', {
        status: 422,
      });
    }
    return deps.claude;
  };
  app.post('/api/accounts/claude/plan-limits/check', async (c) => {
    if (deps.paseoManaged) {
      throw new ApiError('invalid_input', 'Use the weekly quota check in this Paseo session.', {
        status: 422,
      });
    }
    const request = ClaudePlanLimitsCheckRequest.safeParse(
      Object.keys(c.req.query()).length === 0 ? await readJson(c.req.raw) : null,
    );
    if (!request.success) {
      throw new ApiError(
        'invalid_input',
        'Send an empty body for a plan check, or set mode to refresh for previously checked limits.',
      );
    }
    return c.json(await claudeOf().check(request.data.mode));
  });

  app.get('/api/accounts/claude/usage-capture/preview', async (c) => {
    const claude = claudeOf();
    const action = CapturePreviewAction.safeParse(c.req.query('action') ?? 'remove');
    if (!action.success)
      throw new ApiError('invalid_input', 'Only the legacy capture removal preview is available.');
    return c.json(await claude.preview(action.data));
  });
  app.put('/api/accounts/claude/usage-capture', async (c) => {
    const claude = claudeOf();
    const parsed = UsageCaptureRequest.safeParse(await readJson(c.req.raw));
    if (!parsed.success) {
      throw new ApiError('invalid_input', 'Some values are not valid.', {
        details: {
          fields: {
            action: 'Send begin_remove or verify_remove for legacy capture.',
          },
        },
      });
    }
    return c.json(await claude.change(parsed.data));
  });

  // The App's client ID is not a secret, but nothing else belongs here: any other field, a client secret above all, is refused.
  app.put('/api/accounts/github/app', async (c) => {
    const github = githubOf(deps.github);
    const body = await readJson(c.req.raw);
    const fields =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    if (fields === null || Object.keys(fields).some((key) => key !== 'clientId')) {
      throw new ApiError(
        'invalid_input',
        'Send only the client ID. This app never needs a client secret and never accepts one.',
        { details: { fields: { clientId: 'Send {"clientId": "…"} and nothing else.' } } },
      );
    }
    if (typeof fields['clientId'] !== 'string') {
      throw new ApiError('invalid_input', 'Some values are not valid.', {
        details: {
          fields: { clientId: 'Paste the Client ID from your GitHub App’s settings page.' },
        },
      });
    }
    return c.json(github.saveClientId(fields['clientId']));
  });

  return app;
}
