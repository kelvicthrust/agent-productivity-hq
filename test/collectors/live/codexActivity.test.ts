import { describe, expect, it } from 'vitest';
import { projectCodexLine } from '../../../src/server/collectors/live/codexActivity.ts';
import { PERMISSION_GUESS_MS } from '../../../src/server/collectors/live/heuristics.ts';
import { createSessionMachine } from '../../../src/server/collectors/live/machine.ts';
import {
  SENTINELS,
  codexAssistantMessage,
  codexCustomOutput,
  codexCustomToolCall,
  codexDeveloperMessage,
  codexError,
  codexFunctionCall,
  codexFunctionOutput,
  codexItemCompleted,
  codexReasoning,
  codexSessionMeta,
  codexShellCall,
  codexTaskComplete,
  codexTaskStarted,
  codexTokenCount,
  codexTurnAborted,
  codexUserMessage,
  line,
  spawnedSource,
} from './lines.ts';

// Codex rollout lines, as a whitelist projection and as a session driven through the state machine. Every free-text, input and output
// field of every line holds a SENTINEL string; none may appear in what the projection returns.

const T = Date.parse('2026-11-19T10:00:00Z');
const at = (seconds: number) => T + seconds * 1000;

const project = (row: unknown) => projectCodexLine(JSON.parse(line(row)));

function play(rows: unknown[]) {
  const machine = createSessionMachine();
  for (const row of rows) {
    const projected = project(row);
    if (projected?.at != null) machine.apply(projected.events, projected.at);
  }
  return machine;
}

describe('what a line means', () => {
  it('a turn start and a user message are a prompt; the end of a turn is the end', () => {
    expect(project(codexTaskStarted(at(0)))?.events).toEqual([{ kind: 'prompt' }]);
    expect(project(codexUserMessage(at(0)))?.events).toEqual([{ kind: 'prompt' }]);
    expect(project(codexTaskComplete(at(0)))?.events).toEqual([{ kind: 'turn_end' }]);
  });

  it('reasoning is thinking, an assistant message is responding, a developer message nothing', () => {
    expect(project(codexReasoning(at(0)))?.events).toEqual([{ kind: 'thinking' }]);
    expect(project(codexAssistantMessage(at(0)))?.events).toEqual([{ kind: 'responding' }]);
    expect(project(codexDeveloperMessage(at(0)))?.events).toEqual([]);
  });

  it('a function, custom tool or shell call starts a call by its call id; its output ends it', () => {
    expect(project(codexCustomToolCall(at(0), 'c1', 'exec'))?.events).toEqual([
      { kind: 'tool_start', id: 'c1', category: 'command', longRunning: true, wait: null },
    ]);
    expect(project(codexFunctionCall(at(0), 'c2', 'request_user_input'))?.events).toEqual([
      { kind: 'tool_start', id: 'c2', category: 'tool', longRunning: false, wait: 'question' },
    ]);
    expect(project(codexShellCall(at(0), 'c3'))?.events).toEqual([
      { kind: 'tool_start', id: 'c3', category: 'command', longRunning: true, wait: null },
    ]);
    expect(project(codexFunctionOutput(at(0), 'c2'))?.events).toEqual([
      { kind: 'tool_end', id: 'c2' },
    ]);
    expect(project(codexCustomOutput(at(0), 'c1'))?.events).toEqual([
      { kind: 'tool_end', id: 'c1' },
    ]);
  });

  it('an abort and an error event are what they say; bookkeeping events mean nothing', () => {
    expect(project(codexTurnAborted(at(0)))?.events).toEqual([{ kind: 'aborted' }]);
    expect(project(codexError(at(0)))?.events).toEqual([{ kind: 'error' }]);
    expect(project(codexTokenCount(at(0)))?.events).toEqual([]);
    expect(project(codexItemCompleted(at(0)))?.events).toEqual([]);
  });

  it('session_meta gives the identity: id, start, working directory, and the parent of a spawned thread', () => {
    expect(
      project(codexSessionMeta(at(0), { id: 'thread-1', cwd: '/work/invented/a' })),
    ).toMatchObject({
      events: [],
      cwd: '/work/invented/a',
      meta: { id: 'thread-1', cwd: '/work/invented/a', startedAt: at(-1), parentId: null },
    });
    expect(
      project(codexSessionMeta(at(0), { id: 'thread-2', source: spawnedSource('thread-1') }))?.meta,
    ).toMatchObject({ id: 'thread-2', parentId: 'thread-1' });
    // A fork names its parent too, as the batch importer reads it.
    expect(
      project(codexSessionMeta(at(0), { id: 'thread-3', forkedFrom: 'thread-1' }))?.meta?.parentId,
    ).toBe('thread-1');
    // A thread that names itself as its parent has none.
    expect(
      project(codexSessionMeta(at(0), { id: 'thread-4', source: spawnedSource('thread-4') }))?.meta
        ?.parentId,
    ).toBeNull();
    expect(project({ type: 'session_meta', payload: {} })?.meta).toBeNull();
  });

  it('is null for a line that is not an object, and means nothing for one with no payload', () => {
    expect(projectCodexLine('x')).toBeNull();
    expect(project({ type: 'event_msg', timestamp: iso0() })).toMatchObject({ events: [] });
  });

  it('keeps nothing of the line: no sentinel appears in what it returns, for any line', () => {
    const rows = [
      codexSessionMeta(at(0), { id: 'thread-1', source: spawnedSource('thread-0') }),
      codexTaskStarted(at(0)),
      codexTaskComplete(at(0)),
      codexTurnAborted(at(0)),
      codexError(at(0)),
      codexTokenCount(at(0)),
      codexItemCompleted(at(0)),
      codexUserMessage(at(0)),
      codexAssistantMessage(at(0)),
      codexDeveloperMessage(at(0)),
      codexReasoning(at(0)),
      codexFunctionCall(at(0), 'c1', 'exec_command'),
      codexCustomToolCall(at(0), 'c2', 'apply_patch'),
      codexShellCall(at(0), 'c3'),
      codexFunctionOutput(at(0), 'c1'),
      codexCustomOutput(at(0), 'c2'),
    ];
    for (const row of rows) {
      const text = JSON.stringify(project(row));
      for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
    }
  });
});

function iso0(): string {
  return new Date(T).toISOString();
}

describe('a session driven by its lines', () => {
  it('a full turn: start, reasoning, a command, a patch, the answer, the end', () => {
    const machine = createSessionMachine();
    const feed = (row: unknown) => {
      const projected = project(row);
      machine.apply(projected?.events ?? [], projected?.at ?? 0);
    };
    feed(codexTaskStarted(at(0)));
    feed(codexUserMessage(at(0)));
    expect(machine.evaluate(at(1))).toMatchObject({
      state: 'working',
      activity: 'thinking',
      since: at(0),
    });
    feed(codexReasoning(at(2)));
    feed(codexCustomToolCall(at(3), 'x', 'exec'));
    expect(machine.evaluate(at(60))).toMatchObject({ state: 'working', activity: 'command' });
    feed(codexCustomOutput(at(61), 'x'));
    feed(codexCustomToolCall(at(62), 'p', 'apply_patch'));
    expect(machine.evaluate(at(63))).toMatchObject({ state: 'working', activity: 'editing' });
    feed(codexCustomOutput(at(64), 'p'));
    feed(codexAssistantMessage(at(65)));
    expect(machine.evaluate(at(66))).toMatchObject({ state: 'working', activity: 'responding' });
    feed(codexTaskComplete(at(67)));
    expect(machine.evaluate(at(68))).toMatchObject({ state: 'finished', since: at(67) });
  });

  it('a patch with no output for 10 s may be waiting for permission; a spawned agent never is', () => {
    const patch = play([codexTaskStarted(at(0)), codexCustomToolCall(at(1), 'p', 'apply_patch')]);
    expect(patch.evaluate(at(1) + PERMISSION_GUESS_MS)).toMatchObject({
      state: 'waiting',
      waitReason: 'permission',
    });
    const spawn = play([codexTaskStarted(at(0)), codexFunctionCall(at(1), 's', 'spawn_agent')]);
    expect(spawn.evaluate(at(1) + 5 * 60_000)).toMatchObject({
      state: 'working',
      activity: 'delegating',
    });
  });

  it('a pending request_user_input is a question, at once', () => {
    const machine = play([
      codexTaskStarted(at(0)),
      codexFunctionCall(at(1), 'q', 'request_user_input'),
    ]);
    expect(machine.evaluate(at(2))).toMatchObject({ state: 'waiting', waitReason: 'question' });
  });

  it('an abort is idle and an error event is an error', () => {
    expect(play([codexTaskStarted(at(0)), codexTurnAborted(at(1))]).evaluate(at(2))).toMatchObject({
      state: 'idle',
    });
    expect(play([codexTaskStarted(at(0)), codexError(at(1))]).evaluate(at(2))).toMatchObject({
      state: 'error',
    });
  });
});
