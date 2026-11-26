import { z } from 'zod';
import { Instant } from './common.ts';

// HQ: the coding agents running on this machine right now, grouped by the orchestrator that spawned them. The roster is
// held in memory and polled (docs/tech/local-api.md, GET /api/hq); nothing here is stored. By design no prompt, response,
// tool name or argument, permission detail or error text is part of it: `activity` is a coarse category, never a tool name.

export const HqProvider = z.enum(['codex', 'claude', 'other']);
export const HqState = z.enum(['starting', 'working', 'waiting', 'idle', 'error', 'finished']);
export const HqActivity = z.enum([
  'thinking',
  'responding',
  'reading',
  'editing',
  'command',
  'delegating',
  'planning',
  'tool',
  'none',
]);
export const HqWaitReason = z.enum(['permission', 'question', 'plan_approval']);

export const HqAgent = z.object({
  /** Opaque and stable for as long as the agent is on the roster. */
  id: z.string(),
  /** Selected daemon's agent identity, available to managed Paseo clients for navigation. */
  paseoAgentId: z.string().optional(),
  /** An unread Paseo result or error. An explicit false is a known acknowledged error. */
  reviewPending: z.boolean().optional(),
  /** Paseo reports work that continues outside the foreground turn. */
  backgroundWorkActive: z.boolean().optional(),
  /** The last task snapshot reported by Claude Code for this session. */
  backgroundWork: z
    .object({
      subagents: z.number().int().nonnegative(),
      shellJobs: z.number().int().nonnegative(),
      monitors: z.number().int().nonnegative(),
      reportedAt: Instant,
      stale: z.boolean(),
    })
    .optional(),
  /** The parent's recent snapshot includes this subagent. */
  backgroundSubagent: z.boolean().optional(),
  /** An empty thread retained in the roster to link descendants. */
  confirmedEmpty: z.boolean().optional(),
  provider: HqProvider,
  kind: z.enum(['root', 'child']),
  /** Only when the parent is on this roster; see `parentAway`. */
  parentId: z.string().nullable(),
  /** Where the parent link came from: the provider's own record, or Paseo. null when there is no parent. */
  parentBasis: z.enum(['native', 'paseo']).nullable(),
  /** The agent has a parent that is not on this roster. */
  parentAway: z.boolean(),
  /** Main Paseo workspace title, individual recorded title, or provider subagent label. */
  title: z.string().nullable(),
  /** `owner/name`. */
  repo: z.string().nullable(),
  workspace: z.string().nullable(),
  state: HqState,
  activity: HqActivity,
  waitReason: HqWaitReason.nullable(),
  /** `reported` by the provider or Paseo; `inferred` from a transcript's silence. */
  confidence: z.enum(['reported', 'inferred']),
  /** When `state` last changed. */
  since: Instant,
  lastActivityAt: Instant,
  startedAt: Instant.nullable(),
  seenBy: z.object({ paseo: z.boolean(), transcript: z.boolean() }),
});
export type HqAgent = z.infer<typeof HqAgent>;

export const HqFeed = z.object({
  id: z.enum(['paseo', 'claude', 'codex']),
  status: z.enum([
    'unavailable',
    'setup_incomplete',
    'starting',
    'live',
    'notrunning',
    'needspassword',
    'notfound',
    'denied',
    'failed',
  ]),
});
export type HqFeed = z.infer<typeof HqFeed>;

/** The roster as the live service builds it: the part of `GET /api/hq` that comes from the feeds. */
export const HqRoster = z.object({
  generatedAt: Instant,
  feeds: z.array(HqFeed),
  agents: z.array(HqAgent),
  /** The roster was cut to its cap. */
  truncated: z.boolean(),
});
export type HqRoster = z.infer<typeof HqRoster>;

/**
 * Whether Claude Code's hooks (the opt-in switch on the HQ page) tell HQ exactly when an agent outside Paseo is waiting: `off`
 * (the owner has not turned it on), `on`, `needs_repair` (HQ's entries are there but no longer match, e.g. after an upgrade or
 * a moved data folder) or `unavailable` (no Claude Code folder, or a settings file that cannot be changed).
 */
export const ExactPrompts = z.enum(['off', 'on', 'needs_repair', 'unavailable']);
export type ExactPrompts = z.infer<typeof ExactPrompts>;

export const HqResponse = HqRoster.extend({ exactPrompts: ExactPrompts });
export type HqResponse = z.infer<typeof HqResponse>;

// ---- Claude Code hooks (the opt-in switch) ------------------------------------------------------------------------------------

/** The Claude Code hook events HQ installs an entry for. The names are Claude Code's own (code.claude.com/docs/en/hooks). */
export const CLAUDE_HOOK_EVENTS = [
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionStart',
  'SessionEnd',
] as const;
export const ClaudeHookEventName = z.enum(CLAUDE_HOOK_EVENTS);

/**
 * Why a settings file cannot be changed. A fixed code; the file's own text is never part of it. `unsupported_layout`: the file is
 * valid, but its text cannot be edited by a small local change that leaves every other byte alone and reads back as exactly the
 * intended settings (HQ never rewrites a settings file from a parsed copy), so HQ leaves it as it is. `backup_unusable`: the one-time
 * copy HQ keeps beside the file (the file's name with HQ's backup suffix) is empty or is not a settings file, so it is not taken for
 * a saved copy and the file is not replaced until the owner has looked at it.
 */
export const ClaudeHooksFileReason = z.enum([
  'unreadable',
  'not_json',
  'not_an_object',
  'unsupported_shape',
  'unsupported_layout',
  'not_writable',
  'backup_unusable',
]);
export type ClaudeHooksFileReason = z.infer<typeof ClaudeHooksFileReason>;

export const ClaudeHooksFile = z.object({
  /** Home-relative (starting with ~) when it is under the home folder, else absolute. */
  path: z.string(),
  /** Whether the file exists now. A missing file is created by turning the switch on. */
  exists: z.boolean(),
  /** `absent`: no HQ entry. `present`: HQ's five entries, exactly as previewed. `needs_repair`: some HQ entry that does not match. `blocked`: cannot be changed (see `reason`). */
  state: z.enum(['absent', 'present', 'needs_repair', 'blocked']),
  reason: ClaudeHooksFileReason.nullable(),
});
export type ClaudeHooksFile = z.infer<typeof ClaudeHooksFile>;

/** What the owner can confirm: turn it `on`, `repair` it, or turn it `off`. Each has its own plan and its own fingerprint. */
export const ClaudeHooksAction = z.enum(['on', 'off', 'repair']);
export type ClaudeHooksAction = z.infer<typeof ClaudeHooksAction>;

/** HQ's own files in its hook folder. */
export const ClaudeHooksOwnFile = z.enum(['script', 'registry']);
export type ClaudeHooksOwnFile = z.infer<typeof ClaudeHooksOwnFile>;

/**
 * The plan for ONE action: exactly what confirming it would do, computed from the files as they are now.
 *   - `files` are the settings files the action would write (turn on: every file that gets entries; repair: every file whose entries
 *     are replaced or added; turn off: only the files that hold HQ's entries), each with `reason` when HQ cannot make that change.
 *   - `ownFiles` are HQ's own files the action writes (on, repair) or deletes (off), under `ownFolder`.
 *   - `preview` is the fingerprint of this action's plan and of every byte of settings it was computed from. `PUT` must send back
 *     the fingerprint of the action it confirms; a fingerprint that is not this action's current one is refused (409
 *     `claude_hooks_stale`).
 */
export const ClaudeHooksPlan = z.object({
  preview: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(ClaudeHooksFile),
  ownFiles: z.array(ClaudeHooksOwnFile),
});
export type ClaudeHooksPlan = z.infer<typeof ClaudeHooksPlan>;

export const ClaudeHooksStatus = z.object({
  state: ExactPrompts,
  /**
   * Why the switch is `unavailable` (`no_claude_folder`; `settings_blocked`: see `files`; `unsupported_path`: HQ's data folder or
   * Node path holds a character HQ cannot put in a shell command and read back, so it installs nothing) or `needs_repair`
   * (`entries_changed`: HQ's entries are not exactly what this app writes; `script_missing`: the hook script is missing or
   * differs, or is not a file the hook can run; `node_missing`: the Node the command names cannot be run, which repair cannot fix
   * (restart HQ); `registry_unpublished`: the running app could not publish where it listens, or the registry is one the installed
   * hook script would refuse (it applies the same rules), so a hook could not reach it), or `off`
   * with `cleanup_incomplete` (HQ's entries are gone from the settings but its own files are still in `leftover.folder`). Null when
   * `off` with nothing left, or `on`.
   */
  reason: z
    .enum([
      'no_claude_folder',
      'settings_blocked',
      'unsupported_path',
      'entries_changed',
      'script_missing',
      'node_missing',
      'registry_unpublished',
      'cleanup_incomplete',
    ])
    .nullable(),
  /** The user-level settings files HQ looks at: one per Claude Code folder that exists, each in the state it is in now. */
  files: z.array(ClaudeHooksFile),
  /** The hook events that would get an entry. */
  events: z.array(ClaudeHookEventName),
  /** The exact command each entry runs. Empty when HQ cannot build one (`unsupported_path`). */
  command: z.string(),
  /**
   * The fingerprint of the action this state offers first (off: turn on; on: turn off; needs_repair: repair). The same value as
   * that action's `plans[...].preview`; any other action has its own, in `plans`.
   */
  preview: z.string().regex(/^[0-9a-f]{64}$/),
  /** The plan of every action offered in this state. A state offers: off, `on`; on, `off`; needs_repair, `repair` and `off`; off with leftovers, `off` (to try again); unavailable, none. */
  plans: z.object({
    on: ClaudeHooksPlan.optional(),
    off: ClaudeHooksPlan.optional(),
    repair: ClaudeHooksPlan.optional(),
  }),
  /** HQ's own files that are still in its hook folder while the switch is off (`reason: cleanup_incomplete`). `folder` is home-relative where it can be. */
  leftover: z.object({ folder: z.string(), items: z.array(ClaudeHooksOwnFile) }).nullable(),
  /** HQ's hook folder as the owner knows it (home-relative where it can be): where `ownFiles` and `leftover` are. */
  ownFolder: z.string(),
});
export type ClaudeHooksStatus = z.infer<typeof ClaudeHooksStatus>;

/**
 * `preview` is the fingerprint `GET` returned for the plan of the action the owner was shown and confirms: `enabled: false` is turn
 * off; `enabled: true` is turn on when no file holds HQ's entries, else repair. It is optional in the schema only so that a request
 * without one gets the same fixed refusal as a stale one (409 `claude_hooks_stale`) rather than a different answer.
 */
export const ClaudeHooksRequest = z
  .object({ enabled: z.boolean(), preview: z.string().max(200).optional() })
  .strict();
export type ClaudeHooksRequest = z.infer<typeof ClaudeHooksRequest>;

export const ClaudeBackgroundWorkStatus = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
});
export type ClaudeBackgroundWorkStatus = z.infer<typeof ClaudeBackgroundWorkStatus>;

export const ClaudeBackgroundWorkRequest = z.strictObject({ enabled: z.boolean() });

/** The most a hook's working directory may hold (UTF-16 units). */
export const HOOK_CWD_MAX = 1024;
/**
 * Text a hook field may not hold, in a path or anywhere: a control character (U+0000-U+001F, U+007F, U+0080-U+009F), a line or paragraph
 * separator (U+2028, U+2029) or a lone surrogate (what is left when text was cut in the middle of a character). The same rule is
 * written in `claude-hook.mjs`, which is plain JavaScript that cannot import this file; a test holds the two together.
 */
// eslint-disable-next-line no-control-regex
export const HOOK_TEXT_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u;
/** A POSIX absolute path, or a Windows one with a drive letter (`C:\` or `C:/`). A relative path, a UNC path and a bare name are not. */
export const HOOK_ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
/** An event name: letters only (`PermissionRequest`). */
export const isHookEventName = (value: string): boolean => /^[A-Za-z]{1,40}$/.test(value);
/** A short word of a hook: `notification_type` and `reason` (`permission_prompt`, `clear`): letters, digits and `._:-`. */
export const isHookWord = (value: string): boolean => /^[A-Za-z0-9._:-]{1,64}$/.test(value);
/** Whether `value` is a working directory a hook may name: absolute, 1 to 1024 long, no forbidden character. */
export const isHookCwd = (value: string): boolean =>
  value.length >= 1 &&
  value.length <= HOOK_CWD_MAX &&
  HOOK_ABSOLUTE_PATH.test(value) &&
  !HOOK_TEXT_FORBIDDEN.test(value);

/**
 * What Claude Code's hook script posts to `POST /api/hq/hooks/claude`, built field by field. A Stop may carry a bounded task
 * snapshot after the owner opts in. Extra keys are refused. The base fields are an event name of letters, a session id and
 * the two short words of letters, digits and `._:-`, and a working directory that is an absolute path with no control character. An event
 * name HQ does not use is accepted and ignored (204).
 */
export const HqClaudeHookEvent = z
  .object({
    hook_event_name: z.string().min(1).max(40).refine(isHookEventName),
    session_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    notification_type: z.string().min(1).max(64).refine(isHookWord).optional(),
    reason: z.string().min(1).max(64).refine(isHookWord).optional(),
    cwd: z.string().min(1).max(HOOK_CWD_MAX).refine(isHookCwd).optional(),
    background_work: z
      .strictObject({
        observed_at: z.number().int().positive(),
        tasks: z
          .array(
            z.strictObject({
              id: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[A-Za-z0-9._:-]+$/),
              type: z.enum(['subagent', 'shell', 'monitor']),
              status: z.enum(['running', 'pending']),
            }),
          )
          .max(24)
          .nullable(),
      })
      .optional(),
  })
  .strict()
  .refine((event) => event.background_work === undefined || event.hook_event_name === 'Stop');
export type HqClaudeHookEvent = z.infer<typeof HqClaudeHookEvent>;
export type HqProvider = z.infer<typeof HqProvider>;
export type HqState = z.infer<typeof HqState>;
export type HqActivity = z.infer<typeof HqActivity>;
export type HqWaitReason = z.infer<typeof HqWaitReason>;
