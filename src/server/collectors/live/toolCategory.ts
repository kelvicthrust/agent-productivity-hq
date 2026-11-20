import type { HqActivity, HqWaitReason } from '../../../shared/contracts/hq.ts';

// What a tool call means for the roster. The tool's name is looked up here the moment it is read and then dropped: only the coarse
// category (never the name, an input or an output) is kept, logged or returned. The tables are fixed; a name that is not in them is
// `tool`, so a new provider tool is shown as "Using a tool" rather than guessed at. Names come from E9 on a real machine
// (data-and-sources › Live roster (HQ) › What the transcripts show) and the providers' documented tool sets.

export type ToolCategory = Exclude<HqActivity, 'thinking' | 'responding' | 'none'>;

export interface ToolInfo {
  category: ToolCategory;
  /**
   * A kind of call that is expected to take a long time with nothing written meanwhile (a shell command, a subagent, background
   * output): silence on it is not read as "may be waiting for you".
   */
  longRunning: boolean;
  /** The call asks the person something: it is a wait for sure, not a guess from silence. */
  wait: Extract<HqWaitReason, 'question' | 'plan_approval'> | null;
}

const info = (
  category: ToolCategory,
  longRunning = false,
  wait: ToolInfo['wait'] = null,
): ToolInfo => Object.freeze({ category, longRunning, wait });

const READ = info('reading');
const EDIT = info('editing');
const COMMAND = info('command', true);
const DELEGATE = info('delegating', true);
const PLAN = info('planning');
const OTHER = info('tool');
const BACKGROUND = info('tool', true);

const CLAUDE_TOOLS: ReadonlyMap<string, ToolInfo> = new Map([
  ['Read', READ],
  ['Grep', READ],
  ['Glob', READ],
  ['LS', READ],
  ['NotebookRead', READ],
  ['Edit', EDIT],
  ['MultiEdit', EDIT],
  ['Write', EDIT],
  ['NotebookEdit', EDIT],
  ['Bash', COMMAND],
  ['bash', COMMAND],
  ['PowerShell', COMMAND],
  ['KillShell', COMMAND],
  ['BashOutput', BACKGROUND],
  ['TaskOutput', BACKGROUND],
  ['Monitor', BACKGROUND],
  ['Agent', DELEGATE],
  ['Task', DELEGATE],
  ['SendMessage', DELEGATE],
  ['TodoWrite', PLAN],
  ['TaskCreate', PLAN],
  ['TaskUpdate', PLAN],
  ['TaskList', PLAN],
  ['TaskGet', PLAN],
  ['EnterPlanMode', PLAN],
  ['ExitPlanMode', info('planning', false, 'plan_approval')],
  ['AskUserQuestion', info('tool', false, 'question')],
]);

const CODEX_TOOLS: ReadonlyMap<string, ToolInfo> = new Map([
  ['read_file', READ],
  ['list_dir', READ],
  ['grep_files', READ],
  ['view_image', READ],
  ['apply_patch', EDIT],
  ['exec', COMMAND],
  ['shell', COMMAND],
  ['shell_command', COMMAND],
  ['local_shell_call', COMMAND],
  ['exec_command', COMMAND],
  ['write_stdin', COMMAND],
  ['spawn_agent', DELEGATE],
  ['wait_agent', DELEGATE],
  ['wait', DELEGATE],
  ['send_message', DELEGATE],
  ['send_input', DELEGATE],
  ['followup_task', DELEGATE],
  ['list_agents', DELEGATE],
  ['close_agent', DELEGATE],
  ['resume_agent', DELEGATE],
  ['update_plan', PLAN],
  ['request_user_input', info('tool', false, 'question')],
  ['request_user_input_async', info('tool', false, 'question')],
]);

/** The category of a Claude Code tool call. An unknown name, or one that is not text, is `tool`. */
export function claudeToolInfo(name: unknown): ToolInfo {
  return (typeof name === 'string' ? CLAUDE_TOOLS.get(name) : undefined) ?? OTHER;
}

/** The category of a Codex tool call (a `function_call`, `custom_tool_call` or `local_shell_call`). */
export function codexToolInfo(name: unknown): ToolInfo {
  return (typeof name === 'string' ? CODEX_TOOLS.get(name) : undefined) ?? OTHER;
}
