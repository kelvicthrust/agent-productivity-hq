import { describe, expect, it } from 'vitest';
import {
  DROP_AFTER_MS,
  FINISHED_VISIBLE_MS,
  MAX_PENDING_TOOLS,
  PERMISSION_GUESS_MS,
  QUIET_IDLE_MS,
} from '../../../src/server/collectors/live/heuristics.ts';
import {
  createSessionMachine,
  type MachineEvent,
} from '../../../src/server/collectors/live/machine.ts';

// The shared state machine: every transition and every timer. Events are made by hand here; the providers' own tests drive it with
// transcript lines.

const T = Date.parse('2026-11-19T10:00:00Z');
const S = 1000;

const tool = (
  id: string,
  over: Partial<Extract<MachineEvent, { kind: 'tool_start' }>> = {},
): MachineEvent => ({
  kind: 'tool_start',
  id,
  category: 'reading',
  longRunning: false,
  wait: null,
  ...over,
});

function machineWith(...steps: [number, MachineEvent[]][]) {
  const machine = createSessionMachine();
  for (const [at, events] of steps) machine.apply(events, T + at);
  return machine;
}

describe('before and after the session says anything', () => {
  it('has no state until a line has been seen', () => {
    expect(createSessionMachine().evaluate(T)).toBeNull();
  });

  it('has no state when only bookkeeping lines were seen: they are not a conversation', () => {
    const machine = machineWith([0, []], [S, [{ kind: 'other' }]]);
    expect(machine.evaluate(T + 2 * S)).toBeNull();
  });

  it(`drops the session ${DROP_AFTER_MS / 60_000} minutes after its last conversation line, whatever bookkeeping follows`, () => {
    const machine = machineWith([0, [{ kind: 'prompt' }]], [S, [{ kind: 'turn_end' }]]);
    // Bookkeeping lines with a real time, written every minute after the turn ended, do not keep it.
    for (let minute = 1; minute <= 20; minute += 1) machine.apply([], T + S + minute * 60 * S);
    expect(machine.evaluate(T + S + DROP_AFTER_MS - 1)).not.toBeNull();
    expect(machine.evaluate(T + S + DROP_AFTER_MS)).toBeNull();
  });

  it('keeps a session whose turn is open on the roster while the provider keeps writing, even bookkeeping', () => {
    const machine = machineWith([0, [{ kind: 'prompt' }, tool('a', { longRunning: true })]]);
    machine.apply([], T + DROP_AFTER_MS - S);
    machine.apply([{ kind: 'other' }], T + DROP_AFTER_MS + S);
    expect(machine.evaluate(T + DROP_AFTER_MS + 2 * S)).toMatchObject({ state: 'working' });
  });

  it('bookkeeping after an ended or an interrupted turn does not move the last activity either', () => {
    const machine = machineWith([0, [{ kind: 'prompt' }, { kind: 'turn_end' }]]);
    machine.apply([], T + 5 * 60 * S);
    expect(machine.evaluate(T + 5 * 60 * S + S)).toMatchObject({
      state: 'idle',
      lastActivityAt: T,
    });
  });
});

describe('a turn', () => {
  it('a prompt starts working, thinking', () => {
    const machine = machineWith([0, [{ kind: 'prompt' }]]);
    expect(machine.evaluate(T + S)).toEqual({
      state: 'working',
      activity: 'thinking',
      waitReason: null,
      since: T,
      lastActivityAt: T,
    });
  });

  it('a thinking block keeps it thinking, text is responding', () => {
    const machine = machineWith([0, [{ kind: 'prompt' }]], [S, [{ kind: 'thinking' }]]);
    expect(machine.evaluate(T + 2 * S)).toMatchObject({ state: 'working', activity: 'thinking' });
    machine.apply([{ kind: 'responding' }], T + 3 * S);
    expect(machine.evaluate(T + 4 * S)).toMatchObject({
      state: 'working',
      activity: 'responding',
      since: T,
    });
  });

  it.each([
    ['reading', 'reading'],
    ['editing', 'editing'],
    ['command', 'command'],
    ['delegating', 'delegating'],
    ['planning', 'planning'],
    ['tool', 'tool'],
  ] as const)('a pending %s tool call is %s activity', (category, activity) => {
    const machine = machineWith(
      [0, [{ kind: 'prompt' }]],
      [S, [tool('t1', { category, longRunning: true })]],
    );
    expect(machine.evaluate(T + 2 * S)).toMatchObject({ state: 'working', activity });
  });

  it('a result puts it back to thinking, and the state does not change (since stays)', () => {
    const machine = machineWith(
      [0, [{ kind: 'prompt' }]],
      [S, [tool('t1')]],
      [2 * S, [{ kind: 'tool_end', id: 't1' }]],
    );
    expect(machine.evaluate(T + 3 * S)).toMatchObject({
      state: 'working',
      activity: 'thinking',
      since: T,
    });
  });

  it('shows the newest pending call when several run at once, and thinking again once all have ended', () => {
    const machine = machineWith(
      [0, [{ kind: 'prompt' }]],
      [S, [tool('a', { category: 'reading' }), tool('b', { category: 'editing' })]],
    );
    expect(machine.evaluate(T + 2 * S)).toMatchObject({ activity: 'editing' });
    machine.apply([{ kind: 'tool_end', id: 'b' }], T + 3 * S);
    expect(machine.evaluate(T + 4 * S)).toMatchObject({ activity: 'reading' });
    machine.apply([{ kind: 'tool_end', id: 'a' }], T + 5 * S);
    expect(machine.evaluate(T + 6 * S)).toMatchObject({ activity: 'thinking' });
  });

  it('ignores a result it never saw the call for, as a call that began before its window', () => {
    const machine = machineWith([0, [{ kind: 'tool_end', id: 'unseen' }]]);
    expect(machine.evaluate(T + S)).toMatchObject({
      state: 'working',
      activity: 'thinking',
      since: T,
    });
  });
});

describe('the end of a turn', () => {
  const ended = () => machineWith([0, [{ kind: 'prompt' }]], [S, [{ kind: 'turn_end' }]]);

  it(`is finished for ${FINISHED_VISIBLE_MS / 1000} s, then idle`, () => {
    const machine = ended();
    expect(machine.evaluate(T + S + FINISHED_VISIBLE_MS - 1)).toMatchObject({
      state: 'finished',
      since: T + S,
    });
    expect(machine.evaluate(T + S + FINISHED_VISIBLE_MS)).toMatchObject({
      state: 'idle',
      activity: 'none',
      since: T + S + FINISHED_VISIBLE_MS,
    });
  });

  it('a new prompt starts a new turn, with its own since', () => {
    const machine = ended();
    machine.apply([{ kind: 'prompt' }], T + 10 * S);
    expect(machine.evaluate(T + 11 * S)).toMatchObject({ state: 'working', since: T + 10 * S });
  });

  it('clears the waiting tool calls: a turn that ended with one is not "waiting"', () => {
    const machine = machineWith([0, [{ kind: 'prompt' }, tool('t1')]], [S, [{ kind: 'turn_end' }]]);
    expect(machine.evaluate(T + 30 * S)).toMatchObject({ state: 'finished' });
  });
});

describe('errors and interruptions', () => {
  it('an API error is an error until something else is written', () => {
    const machine = machineWith([0, [{ kind: 'prompt' }]], [S, [{ kind: 'error' }]]);
    expect(machine.evaluate(T + 5 * 60_000)).toMatchObject({
      state: 'error',
      activity: 'none',
      since: T + S,
    });
    machine.apply([{ kind: 'prompt' }], T + 6 * 60_000);
    expect(machine.evaluate(T + 6 * 60_000 + S)).toMatchObject({ state: 'working' });
  });

  it('an interruption is idle, at once', () => {
    const machine = machineWith([0, [{ kind: 'prompt' }, tool('t1')]], [S, [{ kind: 'aborted' }]]);
    expect(machine.evaluate(T + 2 * S)).toMatchObject({ state: 'idle', since: T + S });
  });
});

describe('quiet and waiting', () => {
  it(`a turn quiet for ${QUIET_IDLE_MS / 1000} s with no tool call waiting is idle, since the quiet began`, () => {
    const machine = machineWith([0, [{ kind: 'prompt' }]], [S, [{ kind: 'thinking' }]]);
    expect(machine.evaluate(T + S + QUIET_IDLE_MS - 1)).toMatchObject({ state: 'working' });
    expect(machine.evaluate(T + S + QUIET_IDLE_MS)).toMatchObject({
      state: 'idle',
      since: T + S + QUIET_IDLE_MS,
    });
  });

  it('a new event after the quiet starts a new turn', () => {
    const machine = machineWith([0, [{ kind: 'prompt' }]]);
    machine.apply([{ kind: 'responding' }], T + 10 * 60_000);
    expect(machine.evaluate(T + 10 * 60_000 + S)).toMatchObject({
      state: 'working',
      since: T + 10 * 60_000,
    });
  });

  it(`a call that is not long-running, with no result after ${PERMISSION_GUESS_MS / 1000} s, may be waiting for permission`, () => {
    const machine = machineWith(
      [0, [{ kind: 'prompt' }]],
      [S, [tool('t1', { category: 'editing' })]],
    );
    expect(machine.evaluate(T + S + PERMISSION_GUESS_MS - 1)).toMatchObject({ state: 'working' });
    expect(machine.evaluate(T + S + PERMISSION_GUESS_MS)).toEqual({
      state: 'waiting',
      activity: 'none',
      waitReason: 'permission',
      since: T + S + PERMISSION_GUESS_MS,
      lastActivityAt: T + S,
    });
    // A result ends the guess.
    machine.apply([{ kind: 'tool_end', id: 't1' }], T + S + 20 * S);
    expect(machine.evaluate(T + S + 21 * S)).toMatchObject({ state: 'working' });
  });

  it('a session whose hooks speak (guessPermission: false) is never guessed to be waiting, and still shows the call it is on', () => {
    const machine = machineWith(
      [0, [{ kind: 'prompt' }]],
      [S, [tool('t1', { category: 'editing' })]],
    );
    const late = T + S + 10 * PERMISSION_GUESS_MS;
    expect(machine.evaluate(late, { guessPermission: false })).toMatchObject({
      state: 'working',
      activity: 'editing',
      waitReason: null,
    });
    // A call that asks the person something is a wait for sure, hooks or not.
    const asking = machineWith(
      [0, [{ kind: 'prompt' }]],
      [S, [tool('t2', { category: 'planning', wait: 'question' })]],
    );
    expect(asking.evaluate(T + 2 * S, { guessPermission: false })).toMatchObject({
      state: 'waiting',
      waitReason: 'question',
    });
    // Asked to guess (or not asked), nothing changes.
    expect(machine.evaluate(late, { guessPermission: true })).toMatchObject({ state: 'waiting' });
    expect(machine.evaluate(late)).toMatchObject({ state: 'waiting' });
  });

  it('a long-running call is never guessed to be waiting, however long it takes', () => {
    const machine = machineWith(
      [0, [{ kind: 'prompt' }]],
      [S, [tool('t1', { category: 'command', longRunning: true })]],
    );
    expect(machine.evaluate(T + S + 10 * 60_000)).toMatchObject({
      state: 'working',
      activity: 'command',
    });
  });

  it('a call that asks a question or for a plan decision is waiting at once, with its reason', () => {
    const asking = machineWith(
      [0, [{ kind: 'prompt' }]],
      [S, [tool('q', { category: 'tool', wait: 'question' })]],
    );
    expect(asking.evaluate(T + S)).toMatchObject({
      state: 'waiting',
      waitReason: 'question',
      since: T + S,
    });
    const plan = machineWith([0, [tool('p', { category: 'planning', wait: 'plan_approval' })]]);
    expect(plan.evaluate(T + 5 * S)).toMatchObject({
      state: 'waiting',
      waitReason: 'plan_approval',
    });
  });

  it('a pending question stays a wait through the quiet window', () => {
    const machine = machineWith([0, [tool('q', { category: 'tool', wait: 'question' })]]);
    expect(machine.evaluate(T + QUIET_IDLE_MS * 3)).toMatchObject({ state: 'waiting' });
  });
});

describe('a line too long to read', () => {
  it('counts as activity and clears the waiting calls, so it can never read as "waiting"', () => {
    const machine = machineWith([0, [{ kind: 'prompt' }, tool('t1', { category: 'editing' })]]);
    machine.overlong(T + 5 * S);
    // Past the guess time of the cleared call, and still working.
    expect(machine.evaluate(T + 30 * S)).toMatchObject({ state: 'working', activity: 'thinking' });
    // It was activity: the quiet window runs from the dropped line.
    expect(machine.evaluate(T + 5 * S + QUIET_IDLE_MS)).toMatchObject({ state: 'idle' });
  });
});

describe('bounds', () => {
  it('remembers at most MAX_PENDING_TOOLS waiting calls, forgetting the oldest', () => {
    const machine = createSessionMachine();
    machine.apply([{ kind: 'prompt' }], T);
    for (let index = 0; index <= MAX_PENDING_TOOLS; index += 1)
      machine.apply([tool(`t${index}`, { longRunning: true })], T + S);
    // The oldest was forgotten, so its result changes nothing; the rest are still waiting.
    machine.apply([{ kind: 'tool_end', id: 't0' }], T + 2 * S);
    for (let index = 1; index <= MAX_PENDING_TOOLS; index += 1)
      machine.apply([{ kind: 'tool_end', id: `t${index}` }], T + 3 * S);
    expect(machine.evaluate(T + 4 * S)).toMatchObject({ activity: 'thinking' });
  });
});
