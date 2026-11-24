// Builders for transcript lines in the shapes E9 saw on a real machine (docs/tech/data-and-sources.md › Live roster (HQ) › What the
// transcripts show), with INVENTED values: every free-text, input and output field holds a SENTINEL_* string, so a test can prove none of
// them reaches the feed's output, the service's output or a log. Each function returns one line as an object; `line()` makes the text.

export const SENTINELS = [
  'SENTINEL_PROMPT_TEXT',
  'SENTINEL_ASSISTANT_TEXT',
  'SENTINEL_THINKING_TEXT',
  'SENTINEL_SIGNATURE',
  'SENTINEL_TOOL_INPUT',
  'SENTINEL_TOOL_PATH',
  'SENTINEL_TOOL_OUTPUT',
  'SENTINEL_TITLE',
  'SENTINEL_SUMMARY',
  'SENTINEL_ERROR_TEXT',
  'SENTINEL_ATTACHMENT_TEXT',
  'SENTINEL_MODEL',
  'SENTINEL_BRANCH',
  'SENTINEL_REPO_URL',
  'SENTINEL_INSTRUCTIONS',
  'SENTINEL_ENCRYPTED',
  'SENTINEL_ARGUMENTS',
  'SENTINEL_LAST_MESSAGE',
  'SENTINEL_DECISION',
  'SENTINEL_AGENT_NAME',
  'SENTINEL_USER_TYPE',
  'SENTINEL_INTERRUPT_ID',
] as const;

export const line = (value: unknown): string => JSON.stringify(value);
export const iso = (ms: number): string => new Date(ms).toISOString();

// ---- Claude Code ------------------------------------------------------------------------------------------------------------

export interface ClaudeCtx {
  sessionId: string;
  cwd?: string;
  sidechain?: boolean;
  agentId?: string;
}

const claudeBase = (at: number, ctx: ClaudeCtx) => ({
  parentUuid: null,
  isSidechain: ctx.sidechain === true,
  userType: 'external',
  entrypoint: 'cli',
  cwd: ctx.cwd ?? '/work/invented/project',
  sessionId: ctx.sessionId,
  version: '2.1.326',
  gitBranch: 'SENTINEL_BRANCH',
  uuid: `uuid-${at}`,
  timestamp: iso(at),
  ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
});

const usage = {
  input_tokens: 3,
  output_tokens: 9,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** A line the person typed (a plain-string user line). */
export const claudePrompt = (at: number, ctx: ClaudeCtx) => ({
  ...claudeBase(at, ctx),
  type: 'user',
  promptId: 'p-1',
  message: { role: 'user', content: 'SENTINEL_PROMPT_TEXT' },
});

/** A user line made of text blocks. */
export const claudePromptBlocks = (at: number, ctx: ClaudeCtx) => ({
  ...claudeBase(at, ctx),
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'SENTINEL_PROMPT_TEXT' }] },
});

/** A hook or command notice written as a user line. */
export const claudeMeta = (at: number, ctx: ClaudeCtx) => ({
  ...claudeBase(at, ctx),
  type: 'user',
  isMeta: true,
  message: { role: 'user', content: 'SENTINEL_ATTACHMENT_TEXT' },
});

const assistant = (
  at: number,
  ctx: ClaudeCtx,
  block: Record<string, unknown>,
  stop: string | null,
  extra: Record<string, unknown> = {},
) => ({
  ...claudeBase(at, ctx),
  type: 'assistant',
  requestId: `req-${at}`,
  message: {
    id: `msg_${at}`,
    type: 'message',
    role: 'assistant',
    model: 'SENTINEL_MODEL',
    content: [block],
    stop_reason: stop,
    usage,
  },
  ...extra,
});

export const claudeThinking = (at: number, ctx: ClaudeCtx, stop: string | null = 'tool_use') =>
  assistant(
    at,
    ctx,
    { type: 'thinking', thinking: 'SENTINEL_THINKING_TEXT', signature: 'SENTINEL_SIGNATURE' },
    stop,
  );

export const claudeText = (at: number, ctx: ClaudeCtx, stop: string | null = 'end_turn') =>
  assistant(at, ctx, { type: 'text', text: 'SENTINEL_ASSISTANT_TEXT' }, stop);

export const claudeToolUse = (at: number, ctx: ClaudeCtx, id: string, name: string) =>
  assistant(
    at,
    ctx,
    {
      type: 'tool_use',
      id,
      name,
      input: { command: 'SENTINEL_TOOL_INPUT', file_path: 'SENTINEL_TOOL_PATH' },
    },
    'tool_use',
  );

export const claudeToolResult = (at: number, ctx: ClaudeCtx, id: string, isError = false) => ({
  ...claudeBase(at, ctx),
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content: 'SENTINEL_TOOL_OUTPUT', is_error: isError },
    ],
  },
  toolUseResult: { stdout: 'SENTINEL_TOOL_OUTPUT', stderr: 'SENTINEL_ERROR_TEXT' },
  permissionDecision: { decision: 'SENTINEL_DECISION', source: 'SENTINEL_DECISION' },
  sourceToolAssistantUUID: 'uuid-source',
});

export const claudeTurnDuration = (at: number, ctx: ClaudeCtx) => ({
  ...claudeBase(at, ctx),
  type: 'system',
  subtype: 'turn_duration',
  durationMs: 1234,
});

export const claudeApiRetry = (at: number, ctx: ClaudeCtx) => ({
  ...claudeBase(at, ctx),
  type: 'system',
  subtype: 'api_error',
  level: 'error',
  error: 'SENTINEL_ERROR_TEXT',
  retryAttempt: 1,
  maxRetries: 10,
});

export const claudeApiErrorMessage = (at: number, ctx: ClaudeCtx) =>
  assistant(at, ctx, { type: 'text', text: 'SENTINEL_ERROR_TEXT' }, 'stop_sequence', {
    isApiErrorMessage: true,
    error: 'SENTINEL_ERROR_TEXT',
  });

/** The line Claude Code writes when the person interrupts: the one structural trace is the `interruptedMessageId` key. */
export const claudeInterrupt = (at: number, ctx: ClaudeCtx) => ({
  ...claudeBase(at, ctx),
  type: 'user',
  interruptedMessageId: 'SENTINEL_INTERRUPT_ID',
  message: { role: 'user', content: [{ type: 'text', text: 'SENTINEL_PROMPT_TEXT' }] },
});

/** Records that are not the conversation: titles, attachments, queue operations, a request log with the message repeated. */
export const claudeBookkeeping = (at: number, ctx: ClaudeCtx): Record<string, unknown>[] => [
  { type: 'custom-title', customTitle: 'SENTINEL_TITLE', sessionId: ctx.sessionId },
  { type: 'ai-title', aiTitle: 'SENTINEL_TITLE', sessionId: ctx.sessionId },
  { type: 'summary', summary: 'SENTINEL_SUMMARY', leafUuid: 'uuid-leaf' },
  { type: 'agent-name', agentName: 'SENTINEL_AGENT_NAME', sessionId: ctx.sessionId },
  {
    ...claudeBase(at, ctx),
    type: 'attachment',
    attachment: { type: 'hook_success', content: 'SENTINEL_ATTACHMENT_TEXT' },
  },
  {
    ...claudeBase(at, ctx),
    type: 'queue-operation',
    operation: 'enqueue',
    content: 'SENTINEL_PROMPT_TEXT',
  },
  {
    ...claudeBase(at, ctx),
    type: 'api-request-blob',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_blob',
          name: 'Bash',
          input: { command: 'SENTINEL_TOOL_INPUT' },
        },
      ],
    },
  },
];

// ---- Codex ------------------------------------------------------------------------------------------------------------------

export interface CodexMetaSpec {
  id: string;
  cwd?: string;
  source?: unknown;
  forkedFrom?: string;
  originator?: string;
}

const codexAt = (at: number) => ({ timestamp: iso(at) });

export const codexSessionMeta = (at: number, spec: CodexMetaSpec) => ({
  ...codexAt(at),
  type: 'session_meta',
  payload: {
    id: spec.id,
    timestamp: iso(at - 1000),
    cwd: spec.cwd ?? '/work/invented/project',
    originator: spec.originator ?? 'codex_cli_rs',
    cli_version: '0.1.0',
    source: spec.source ?? 'vscode',
    ...(spec.forkedFrom === undefined ? {} : { forked_from_id: spec.forkedFrom }),
    base_instructions: { text: 'SENTINEL_INSTRUCTIONS' },
    git: {
      repository_url: 'SENTINEL_REPO_URL',
      branch: 'SENTINEL_BRANCH',
      commit_hash: 'SENTINEL_BRANCH',
    },
  },
});

/** A spawned thread's `source`, the documented shape `subagent.thread_spawn.parent_thread_id`. */
export const spawnedSource = (parentThreadId: string) => ({
  subagent: {
    thread_spawn: {
      parent_thread_id: parentThreadId,
      depth: 1,
      description: 'SENTINEL_AGENT_NAME',
    },
  },
});

const event = (at: number, payload: Record<string, unknown>) => ({
  ...codexAt(at),
  type: 'event_msg',
  payload,
});
const item = (at: number, payload: Record<string, unknown>) => ({
  ...codexAt(at),
  type: 'response_item',
  payload,
});

export const codexTaskStarted = (at: number) =>
  event(at, { type: 'task_started', turn_id: 'turn-1', model_context_window: 1000 });
export const codexTaskComplete = (at: number) =>
  event(at, {
    type: 'task_complete',
    turn_id: 'turn-1',
    last_agent_message: 'SENTINEL_LAST_MESSAGE',
  });
export const codexTurnAborted = (at: number) =>
  event(at, { type: 'turn_aborted', turn_id: 'turn-1', reason: 'SENTINEL_ERROR_TEXT' });
export const codexError = (at: number) =>
  event(at, { type: 'error', message: 'SENTINEL_ERROR_TEXT' });
export const codexTokenCount = (at: number) =>
  event(at, {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
  });
export const codexItemCompleted = (at: number) =>
  event(at, {
    type: 'item_completed',
    item: { type: 'AgentMessage', text: 'SENTINEL_ASSISTANT_TEXT' },
  });

export const codexUserMessage = (at: number) =>
  item(at, {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'SENTINEL_PROMPT_TEXT' }],
  });
export const codexAssistantMessage = (at: number) =>
  item(at, {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'SENTINEL_ASSISTANT_TEXT' }],
  });
export const codexDeveloperMessage = (at: number) =>
  item(at, {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'SENTINEL_INSTRUCTIONS' }],
  });
export const codexReasoning = (at: number) =>
  item(at, {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'SENTINEL_SUMMARY' }],
    encrypted_content: 'SENTINEL_ENCRYPTED',
  });
export const codexFunctionCall = (at: number, callId: string, name: string) =>
  item(at, {
    type: 'function_call',
    name,
    call_id: callId,
    arguments: '{"cmd":"SENTINEL_ARGUMENTS"}',
  });
export const codexCustomToolCall = (at: number, callId: string, name: string) =>
  item(at, {
    type: 'custom_tool_call',
    name,
    call_id: callId,
    input: 'SENTINEL_TOOL_INPUT',
    status: 'completed',
  });
export const codexShellCall = (at: number, callId: string) =>
  item(at, {
    type: 'local_shell_call',
    call_id: callId,
    status: 'in_progress',
    action: { type: 'exec', command: ['SENTINEL_TOOL_INPUT'] },
  });
export const codexFunctionOutput = (at: number, callId: string) =>
  item(at, { type: 'function_call_output', call_id: callId, output: 'SENTINEL_TOOL_OUTPUT' });
export const codexCustomOutput = (at: number, callId: string) =>
  item(at, { type: 'custom_tool_call_output', call_id: callId, output: 'SENTINEL_TOOL_OUTPUT' });
