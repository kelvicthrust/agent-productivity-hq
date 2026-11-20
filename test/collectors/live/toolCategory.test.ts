import { describe, expect, it } from 'vitest';
import { claudeToolInfo, codexToolInfo } from '../../../src/server/collectors/live/toolCategory.ts';

// The fixed tables that turn a tool name into a coarse category. The name is looked up and dropped; only the category survives.

describe('Claude Code tools', () => {
  it.each([
    ['Read', 'reading'],
    ['Grep', 'reading'],
    ['Glob', 'reading'],
    ['Edit', 'editing'],
    ['MultiEdit', 'editing'],
    ['Write', 'editing'],
    ['NotebookEdit', 'editing'],
    ['Bash', 'command'],
    ['bash', 'command'],
    ['Agent', 'delegating'],
    ['Task', 'delegating'],
    ['SendMessage', 'delegating'],
    ['TodoWrite', 'planning'],
    ['ExitPlanMode', 'planning'],
    ['WebFetch', 'tool'],
    ['WebSearch', 'tool'],
    ['Skill', 'tool'],
    ['mcp__server__thing', 'tool'],
    ['SomeToolFromTheFuture', 'tool'],
  ])('maps %s to %s', (name, category) => {
    expect(claudeToolInfo(name).category).toBe(category);
  });

  it('marks shell commands, subagents and background output as long-running, and the rest not', () => {
    for (const name of ['Bash', 'Agent', 'Task', 'BashOutput', 'TaskOutput', 'Monitor'])
      expect(claudeToolInfo(name).longRunning, name).toBe(true);
    for (const name of ['Read', 'Edit', 'Write', 'WebFetch', 'mcp__a__b', 'Skill', 'Unknown'])
      expect(claudeToolInfo(name).longRunning, name).toBe(false);
  });

  it('knows which calls ask the person something', () => {
    expect(claudeToolInfo('AskUserQuestion').wait).toBe('question');
    expect(claudeToolInfo('ExitPlanMode').wait).toBe('plan_approval');
    expect(claudeToolInfo('Bash').wait).toBeNull();
  });

  it('treats a name that is not text as an ordinary tool', () => {
    expect(claudeToolInfo(undefined)).toMatchObject({
      category: 'tool',
      longRunning: false,
      wait: null,
    });
    expect(claudeToolInfo({ name: 'Bash' }).category).toBe('tool');
  });
});

describe('Codex tools', () => {
  it.each([
    ['exec', 'command'],
    ['exec_command', 'command'],
    ['shell', 'command'],
    ['local_shell_call', 'command'],
    ['apply_patch', 'editing'],
    ['read_file', 'reading'],
    ['spawn_agent', 'delegating'],
    ['wait_agent', 'delegating'],
    ['update_plan', 'planning'],
    ['js', 'tool'],
    ['something_new', 'tool'],
  ])('maps %s to %s', (name, category) => {
    expect(codexToolInfo(name).category).toBe(category);
  });

  it('marks commands and delegation as long-running, and questions as questions', () => {
    expect(codexToolInfo('exec').longRunning).toBe(true);
    expect(codexToolInfo('wait_agent').longRunning).toBe(true);
    expect(codexToolInfo('apply_patch').longRunning).toBe(false);
    expect(codexToolInfo('request_user_input').wait).toBe('question');
    expect(codexToolInfo('request_user_input_async').wait).toBe('question');
  });
});
