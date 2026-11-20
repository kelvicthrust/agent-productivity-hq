import { describe, expect, it } from 'vitest';
import { projectClaudeLine } from '../../../src/server/collectors/live/claudeActivity.ts';
import {
  FINISHED_VISIBLE_MS,
  PERMISSION_GUESS_MS,
  QUIET_IDLE_MS,
} from '../../../src/server/collectors/live/heuristics.ts';
import { createSessionMachine } from '../../../src/server/collectors/live/machine.ts';
import {
  SENTINELS,
  claudeApiErrorMessage,
  claudeApiRetry,
  claudeBookkeeping,
  claudeInterrupt,
  claudeMeta,
  claudePrompt,
  claudePromptBlocks,
  claudeText,
  claudeThinking,
  claudeToolResult,
  claudeToolUse,
  claudeTurnDuration,
  line,
} from './lines.ts';

// Claude Code lines, as a whitelist projection and as a session driven through the state machine. Every free-text, input and output
// field of every line holds a SENTINEL string; none may appear in what the projection returns.

const T = Date.parse('2026-11-19T10:00:00Z');
const at = (seconds: number) => T + seconds * 1000;
const ctx = { sessionId: 's-1' };
const sub = { sessionId: 's-1', sidechain: true, agentId: 'a1' };

const project = (row: unknown, sidechainFile = false) =>
  projectClaudeLine(JSON.parse(line(row)), sidechainFile);

/** Plays lines through the machine as the feed does, and returns it. */
function play(rows: unknown[], sidechainFile = false) {
  const machine = createSessionMachine();
  for (const row of rows) {
    const projected = project(row, sidechainFile);
    if (projected?.at != null) machine.apply(projected.events, projected.at);
  }
  return machine;
}

describe('what a line means', () => {
  it('a typed prompt is a prompt, whether its content is a string or a text block', () => {
    expect(project(claudePrompt(at(0), ctx))?.events).toEqual([{ kind: 'prompt' }]);
    expect(project(claudePromptBlocks(at(0), ctx))?.events).toEqual([{ kind: 'prompt' }]);
  });

  it('a meta user line (a hook or command notice) is not a prompt', () => {
    expect(project(claudeMeta(at(0), ctx))?.events).toEqual([]);
  });

  it('thinking, text and a tool call are what the assistant is doing, by the block type', () => {
    expect(project(claudeThinking(at(0), ctx))?.events).toEqual([{ kind: 'thinking' }]);
    expect(project(claudeText(at(0), ctx, null))?.events).toEqual([{ kind: 'responding' }]);
    expect(project(claudeToolUse(at(0), ctx, 'toolu_1', 'Edit'))?.events).toEqual([
      { kind: 'tool_start', id: 'toolu_1', category: 'editing', longRunning: false, wait: null },
    ]);
  });

  it('a tool result closes the call by id, an error flag or not', () => {
    expect(project(claudeToolResult(at(0), ctx, 'toolu_1'))?.events).toEqual([
      { kind: 'tool_end', id: 'toolu_1' },
    ]);
    expect(project(claudeToolResult(at(0), ctx, 'toolu_1', true))?.events).toEqual([
      { kind: 'tool_end', id: 'toolu_1' },
    ]);
  });

  it('a stop reason that ends the turn adds the end of the turn after the block', () => {
    expect(project(claudeText(at(0), ctx, 'end_turn'))?.events).toEqual([
      { kind: 'responding' },
      { kind: 'turn_end' },
    ]);
    expect(project(claudeThinking(at(0), ctx, 'tool_use'))?.events).toEqual([{ kind: 'thinking' }]);
  });

  it('a turn_duration record is the end of a turn; a retried API error only shows activity', () => {
    expect(project(claudeTurnDuration(at(0), ctx))?.events).toEqual([{ kind: 'turn_end' }]);
    expect(project(claudeApiRetry(at(0), ctx))?.events).toEqual([]);
  });

  it('an API error message is an error, not a reply', () => {
    expect(project(claudeApiErrorMessage(at(0), ctx))?.events).toEqual([{ kind: 'error' }]);
  });

  it('the one structural trace of an interruption is the interruptedMessageId key', () => {
    expect(project(claudeInterrupt(at(0), ctx))?.events).toEqual([{ kind: 'aborted' }]);
  });

  it('bookkeeping records (titles, attachments, queue operations, request logs) mean nothing', () => {
    for (const row of claudeBookkeeping(at(0), ctx)) expect(project(row)?.events).toEqual([]);
  });

  it('in a main transcript a sidechain line is a subagent’s: no event; in a subagent file it is its own work', () => {
    expect(project(claudeToolUse(at(0), sub, 'toolu_s', 'Bash'), false)?.events).toEqual([]);
    expect(project(claudeToolUse(at(0), sub, 'toolu_s', 'Bash'), true)?.events).toHaveLength(1);
  });

  it('takes the time and working directory from the line, and nothing from one that is not an object', () => {
    expect(
      project(claudePrompt(at(5), { sessionId: 's', cwd: '/work/invented/other' })),
    ).toMatchObject({
      at: at(5),
      cwd: '/work/invented/other',
    });
    expect(projectClaudeLine('not an object', false)).toBeNull();
    expect(projectClaudeLine(null, false)).toBeNull();
    expect(projectClaudeLine([1], false)).toBeNull();
    expect(project({ type: 'user', message: { role: 'user', content: 7 } })).toMatchObject({
      at: null,
      events: [],
    });
  });

  it('keeps nothing of the line: no sentinel appears in what it returns, for any line', () => {
    const rows = [
      claudePrompt(at(0), ctx),
      claudePromptBlocks(at(0), ctx),
      claudeMeta(at(0), ctx),
      claudeThinking(at(0), ctx),
      claudeText(at(0), ctx),
      claudeToolUse(at(0), ctx, 'toolu_1', 'Bash'),
      claudeToolResult(at(0), ctx, 'toolu_1', true),
      claudeTurnDuration(at(0), ctx),
      claudeApiRetry(at(0), ctx),
      claudeApiErrorMessage(at(0), ctx),
      claudeInterrupt(at(0), ctx),
      ...claudeBookkeeping(at(0), ctx),
    ];
    for (const row of rows) {
      const text = JSON.stringify(project(row));
      for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
    }
  });
});

describe('a session driven by its lines', () => {
  it('a full turn: prompt, thinking, a read, an edit, the answer, the end', () => {
    const machine = createSessionMachine();
    const feed = (row: unknown) => {
      const projected = project(row);
      machine.apply(projected?.events ?? [], projected?.at ?? 0);
    };
    feed(claudePrompt(at(0), ctx));
    expect(machine.evaluate(at(1))).toMatchObject({ state: 'working', activity: 'thinking' });
    feed(claudeThinking(at(2), ctx));
    feed(claudeToolUse(at(3), ctx, 'r', 'Read'));
    expect(machine.evaluate(at(4))).toMatchObject({ state: 'working', activity: 'reading' });
    feed(claudeToolResult(at(5), ctx, 'r'));
    feed(claudeToolUse(at(6), ctx, 'e', 'Edit'));
    expect(machine.evaluate(at(7))).toMatchObject({ state: 'working', activity: 'editing' });
    feed(claudeToolResult(at(8), ctx, 'e'));
    feed(claudeToolUse(at(9), ctx, 'b', 'Bash'));
    expect(machine.evaluate(at(30))).toMatchObject({ state: 'working', activity: 'command' });
    feed(claudeToolResult(at(31), ctx, 'b'));
    feed(claudeText(at(32), ctx, 'end_turn'));
    feed(claudeTurnDuration(at(33), ctx));
    expect(machine.evaluate(at(34))).toMatchObject({ state: 'finished', since: at(32) });
    expect(machine.evaluate(at(32) + FINISHED_VISIBLE_MS)).toMatchObject({ state: 'idle' });
  });

  it('an edit with no result for 10 s may be waiting for permission; Bash never is', () => {
    const edit = play([claudePrompt(at(0), ctx), claudeToolUse(at(1), ctx, 'e', 'Edit')]);
    expect(edit.evaluate(at(1) + PERMISSION_GUESS_MS)).toMatchObject({
      state: 'waiting',
      waitReason: 'permission',
    });
    const bash = play([claudePrompt(at(0), ctx), claudeToolUse(at(1), ctx, 'b', 'Bash')]);
    expect(bash.evaluate(at(1) + 5 * 60_000)).toMatchObject({
      state: 'working',
      activity: 'command',
    });
  });

  it('a question tool and a plan tool wait for the person at once, with their reasons', () => {
    const question = play([claudeToolUse(at(0), ctx, 'q', 'AskUserQuestion')]);
    expect(question.evaluate(at(1))).toMatchObject({ state: 'waiting', waitReason: 'question' });
    const plan = play([claudeToolUse(at(0), ctx, 'p', 'ExitPlanMode')]);
    expect(plan.evaluate(at(1))).toMatchObject({ state: 'waiting', waitReason: 'plan_approval' });
  });

  it('an API error is an error; an interruption is idle; a quiet turn is idle', () => {
    expect(
      play([claudePrompt(at(0), ctx), claudeApiErrorMessage(at(1), ctx)]).evaluate(at(2)),
    ).toMatchObject({
      state: 'error',
    });
    expect(
      play([claudePrompt(at(0), ctx), claudeInterrupt(at(1), ctx)]).evaluate(at(2)),
    ).toMatchObject({
      state: 'idle',
    });
    expect(
      play([claudePrompt(at(0), ctx), claudeThinking(at(1), ctx)]).evaluate(at(1) + QUIET_IDLE_MS),
    ).toMatchObject({
      state: 'idle',
    });
  });

  it('a subagent file is followed on its own', () => {
    const machine = play(
      [
        claudePrompt(at(0), sub),
        claudeToolUse(at(1), sub, 'x', 'Read'),
        claudeToolResult(at(2), sub, 'x'),
      ],
      true,
    );
    expect(machine.evaluate(at(3))).toMatchObject({ state: 'working', activity: 'thinking' });
  });

  it('bookkeeping after a finished turn does not make it work again, and does not keep the session on the roster past the 15 minutes', () => {
    const machine = play([
      claudePrompt(at(0), ctx),
      claudeText(at(1), ctx, 'end_turn'),
      ...claudeBookkeeping(at(60 * 10), ctx),
      ...claudeBookkeeping(at(60 * 16), ctx),
    ]);
    expect(machine.evaluate(at(60 * 10 + 1))).toMatchObject({
      state: 'idle',
      lastActivityAt: at(1),
    });
    expect(machine.evaluate(at(60 * 16 + 1))).toBeNull();
  });
});
