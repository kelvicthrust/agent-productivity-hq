import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { ApiError } from '../../../shared/contracts/errors.ts';
import {
  CLAUDE_HOOK_EVENTS,
  ClaudeBackgroundWorkRequest,
  ClaudeHooksRequest,
  HqClaudeHookEvent,
  type ClaudeHooksFileReason,
  type ClaudeHooksStatus,
} from '../../../shared/contracts/hq.ts';
import {
  ClaudeHooksError,
  type ClaudeHooks,
  type LeftBehind,
} from '../../integrations/claudeHooks/index.ts';
import type { HookStore } from '../../services/hq/hookStore.ts';
import type { HttpEnv } from '../errors.ts';

// Claude Code hooks (the owner's opt-in switch), two groups of routes:
//   GET and PUT /api/hq/claude-hooks   the preview/status and the switch (the browser's; served on every listener, behind the same
//                                      guards as any other write).
//   POST /api/hq/hooks/claude          what the hook script posts. It is mounted ONLY on the loopback listener (app.ts), never on the
//                                      Tailscale one, and needs the random token of this server run.

/** The hook's message is five short fields; anything larger is not from the hook script. */
export const HOOK_BODY_MAX_BYTES = 8 * 1024;

const BLOCKED: Record<ClaudeHooksFileReason, string> = {
  unreadable: 'Claude Code’s settings file can’t be read, so HQ didn’t change it.',
  not_json: 'Claude Code’s settings file isn’t valid JSON, so HQ didn’t change it.',
  not_an_object: 'Claude Code’s settings file isn’t a JSON object, so HQ didn’t change it.',
  unsupported_shape:
    'Claude Code’s settings file has a hooks section HQ can’t add to safely, so HQ didn’t change it.',
  unsupported_layout:
    'Claude Code’s settings file is laid out in a way HQ can’t edit safely, so HQ left it exactly as it is.',
  not_writable: 'HQ can’t write to Claude Code’s settings, so it didn’t change them.',
  backup_unusable:
    'The copy of Claude Code’s settings that HQ keeps is empty or isn’t a settings file, so HQ didn’t change them. Look at that file, then delete or fix it.',
};

/** What a failed change left in place, in plain words (never a path). */
const LEFT: Record<LeftBehind, string> = {
  script: 'its hook script',
  registry: 'its registry file',
  backup: 'the copy of your settings it made',
  temp: 'a temporary file',
};

/** Said when a change failed and HQ could not take back everything it had made: it never deletes what it did not write. */
const leftSentence = (left: readonly LeftBehind[]): string =>
  left.length === 0
    ? ''
    : ` HQ left ${left.map((item) => LEFT[item]).join(', ')} where it is, because it was changed after HQ wrote it or could not be removed. You can delete it.`;

/** The code, sentence and details of a refusal, before what it left behind is added (see `hooksApiError`). */
function refusal(error: ClaudeHooksError): {
  code:
    | 'claude_settings_conflict'
    | 'claude_hooks_unavailable'
    | 'claude_hooks_stale'
    | 'claude_hooks_failed'
    | 'claude_hooks_blocked';
  message: string;
  details: Record<string, unknown> | undefined;
} {
  const reason = { reason: error.failure };
  switch (error.failure) {
    case 'conflict':
      return {
        code: 'claude_settings_conflict',
        message: 'Claude Code’s settings changed while HQ was updating them. Try again.',
        details: reason,
      };
    case 'no_folder':
      return {
        code: 'claude_hooks_unavailable',
        message: 'HQ couldn’t find a Claude Code folder on this computer.',
        details: undefined,
      };
    case 'stale_preview':
      return {
        code: 'claude_hooks_stale',
        message:
          'Claude Code’s settings are not what HQ showed you. Read what will change again, then confirm.',
        details: undefined,
      };
    case 'registry_failed':
      return {
        code: 'claude_hooks_failed',
        message:
          'HQ couldn’t make itself reachable by Claude Code’s hooks, so it left the settings as they were.',
        details: reason,
      };
    case 'rollback_failed':
      return {
        code: 'claude_hooks_failed',
        message: `A change to Claude Code’s settings failed and HQ couldn’t put back ${error.files.join(', ')}. Check that file; a copy of the original is saved beside it.`,
        details: { ...reason, files: [...error.files] },
      };
    case 'backup_unusable':
      return {
        code: 'claude_hooks_blocked',
        message:
          error.files.length === 0
            ? BLOCKED.backup_unusable
            : `The copy of Claude Code’s settings that HQ keeps, ${error.files.join(', ')}, is empty or isn’t a settings file, so HQ didn’t change them. Look at that file, then delete or fix it.`,
        details: { ...reason, files: [...error.files] },
      };
    case 'unsupported_path':
      return { code: 'claude_hooks_blocked', message: UNSUPPORTED_PATH, details: reason };
    default:
      return { code: 'claude_hooks_blocked', message: BLOCKED[error.failure], details: reason };
  }
}

/**
 * The error a refused change is answered with: a fixed code and a fixed sentence, never the file's text or a path. ONE builder for
 * every code, so that whatever HQ made during the change and could not take back (`left`: its script, its registry, the copy of the
 * settings, a temporary file) is named the same way in all of them: the same `details.left` and the same closing sentence, which the
 * page shows as the error's message.
 */
export function hooksApiError(error: ClaudeHooksError): ApiError {
  const { code, message, details } = refusal(error);
  if (error.left.length === 0)
    return new ApiError(code, message, details === undefined ? undefined : { details });
  return new ApiError(code, `${message}${leftSentence(error.left)}`, {
    details: { ...(details ?? { reason: error.failure }), left: [...error.left] },
  });
}

/** Why HQ installs nothing when its data folder or Node path holds a character it cannot put in a shell command and read back. */
export const UNSUPPORTED_PATH =
  'HQ’s data folder or the Node it runs under has a character in its path that HQ can’t put safely in a shell command (a line break or other control character, or a path longer than 1,024 characters), so it changed nothing. Spaces, quotes, $, backticks, backslashes and any letters or symbols are fine.';

/** What the status says when this process has no switch (no Claude Code integration). */
export const unavailableHooks = (): ClaudeHooksStatus => ({
  state: 'unavailable',
  reason: 'no_claude_folder',
  files: [],
  events: [...CLAUDE_HOOK_EVENTS],
  command: '',
  preview: '0'.repeat(64),
  plans: {},
  leftover: null,
  ownFolder: '',
});

/** True when `given` is the token. Both sides are hashed first, so the comparison is over equal lengths and in constant time. */
export function tokenMatches(given: string, token: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/**
 * The token an `Authorization` header carries, or null. The rule is exact: one `Bearer` (capital B), one space, then token characters
 * (letters, digits, `-` and `_`, at most 200: what the app generates and the script sends). Anything else is null, so a header that was
 * sent twice (the platform joins the values with a comma), a list, a lowercase scheme, extra spaces or tabs, another scheme and a
 * token of any other alphabet are all refused the same way as a wrong token.
 */
export function bearerToken(header: string | null | undefined): string | null {
  const match = (header ?? '').match(/^Bearer ([A-Za-z0-9_-]{1,200})$/);
  return match?.[1] ?? null;
}

/** `application/json`, optionally with `; charset=utf-8` (any case), and nothing else. */
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i;

/** The strict reader: invalid UTF-8 throws, and a byte-order mark is kept (so the JSON that follows it is refused). */
const strictUtf8 = (): TextDecoder => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The body as text, or null when it is longer than `max` bytes (the rest is never read). Text that is not valid UTF-8 throws: it is
 * never turned into replacement characters.
 */
async function readBounded(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return strictUtf8().decode(Buffer.concat(chunks));
}

export interface HookIngest {
  store: HookStore;
  /** This server run's random token. Never logged and never returned. */
  token: string;
  /** Checked after reading the request so a late event cannot undo the owner's opt-out. */
  acceptsEvents?: () => boolean;
  /** Background metadata must come from the current opt-in period. */
  acceptsBackgroundWork?: (observedAt: number) => boolean;
}

export function hqHooksRoutes(deps: {
  hooks?: ClaudeHooks | undefined;
  /** Given only to the loopback listener's app. */
  ingest?: HookIngest | undefined;
}): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();

  // Whatever goes wrong inside the switch is a fixed answer, never an unhandled error with a path or a file's text in it.
  const failed = () =>
    new ApiError(
      'claude_hooks_failed',
      'HQ couldn’t read Claude Code’s settings just now. Try again.',
      {
        details: { reason: 'unreadable' },
      },
    );

  app.get('/api/hq/claude-hooks', async (c) => {
    if (!deps.hooks) return c.json(unavailableHooks());
    try {
      return c.json(await deps.hooks.status());
    } catch {
      throw failed();
    }
  });

  app.put('/api/hq/claude-hooks', async (c) => {
    if (!deps.hooks) {
      throw new ApiError(
        'claude_hooks_unavailable',
        'Claude Code hooks aren’t available in this session.',
      );
    }
    let body: unknown;
    try {
      body = JSON.parse((await readBounded(c.req.raw, 1024)) ?? 'null');
    } catch {
      body = null;
    }
    const request = ClaudeHooksRequest.safeParse(body);
    if (!request.success) {
      throw new ApiError(
        'invalid_input',
        'Send { "enabled": true or false, "preview": the fingerprint of the preview the owner confirmed }.',
      );
    }
    try {
      return c.json(
        await deps.hooks.set(request.data.enabled, { preview: request.data.preview ?? '' }),
      );
    } catch (error) {
      throw error instanceof ClaudeHooksError ? hooksApiError(error) : failed();
    }
  });

  const backgroundFailed = () =>
    new ApiError(
      'claude_hooks_failed',
      'HQ couldn’t update Claude Code background reporting. Try again.',
    );

  app.get('/api/hq/claude-hooks/background-work', async (c) => {
    try {
      return c.json(
        (await deps.hooks?.backgroundWorkStatus()) ?? { enabled: false, available: false },
      );
    } catch {
      throw new ApiError(
        'claude_hooks_failed',
        'HQ couldn’t read the Claude Code background reporting setting. Try again.',
      );
    }
  });

  app.put('/api/hq/claude-hooks/background-work', async (c) => {
    const unavailable = () =>
      new ApiError(
        'claude_hooks_unavailable',
        'Turn on or repair Claude Code’s wait hooks before enabling background reporting.',
      );
    if (!deps.hooks) throw unavailable();
    let body: unknown;
    try {
      body = JSON.parse((await readBounded(c.req.raw, 1024)) ?? 'null');
    } catch {
      body = null;
    }
    const request = ClaudeBackgroundWorkRequest.safeParse(body);
    if (!request.success) {
      throw new ApiError('invalid_input', 'Send an enabled setting of true or false.');
    }
    try {
      return c.json(await deps.hooks.setBackgroundWork(request.data.enabled));
    } catch (error) {
      if (error instanceof ClaudeHooksError && error.failure === 'no_folder') throw unavailable();
      throw backgroundFailed();
    }
  });

  if (deps.ingest) app.route('/', hqHookIngestRoutes(deps.ingest));
  return app;
}

export function hqHookIngestRoutes(ingest: HookIngest): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.post('/api/hq/hooks/claude', async (c) => {
    // No detail and no log line: a wrong token says nothing about why. A header that is not exactly `Bearer <token>` is a wrong token.
    const given = bearerToken(c.req.header('authorization'));
    if (given === null || !tokenMatches(given, ingest.token)) return c.body(null, 401);
    // Everything below is one answer: the message isn't valid. It says nothing of why and never echoes any of the request.
    const invalid = () => new ApiError('invalid_input', 'The hook message isn’t valid.');
    if (!JSON_CONTENT_TYPE.test(c.req.header('content-type') ?? '')) throw invalid();
    let text: string | null;
    try {
      text = await readBounded(c.req.raw, HOOK_BODY_MAX_BYTES);
    } catch {
      throw invalid();
    }
    if (text === null) return c.body(null, 413);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw invalid();
    }
    const event = HqClaudeHookEvent.safeParse(json);
    if (!event.success) throw invalid();
    if (ingest.acceptsEvents?.() !== false) {
      const observedAt = event.data.background_work?.observed_at;
      if (observedAt !== undefined && ingest.acceptsBackgroundWork?.(observedAt) !== true) {
        const waitEvent = { ...event.data };
        delete waitEvent.background_work;
        ingest.store.record(waitEvent);
      } else {
        ingest.store.record(event.data);
      }
    }
    return c.body(null, 204);
  });
  return app;
}
