import { describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS } from '../../src/shared/contracts/hq.ts';
import { buildHookCommand } from '../../src/server/integrations/claudeHooks/command.ts';
import {
  applyEntries,
  inspect,
  planEntries,
  type Json,
} from '../../src/server/integrations/claudeHooks/settings.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): HQ's entry is only "present" when it is a group that filters
// nothing, holds exactly HQ's one exact handler and has no other key; HQ's handler anywhere else is `needs_repair`. Removal takes out
// HQ's handler objects only: never the owner's handlers, matcher or keys; a group or event key goes only when it is HQ's shape and
// the removal left it empty.

const COMMAND = buildHookCommand('/n/node', '/d/claude-hooks/agent-productivity-hook.mjs');
const OLD = buildHookCommand('/n/node', '/old data/claude-hooks/agent-productivity-hook.mjs');
const hq = (over: Json = {}): Json => ({ type: 'command', command: COMMAND, timeout: 3, ...over });
const mine = (name: string): Json => ({ type: 'command', command: `owner-${name}` });
const settings = (hooks: Json): Json => ({ model: 'x', hooks });
const complete = (): Json =>
  Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [{ hooks: [hq()] }]]));

const groupsOf = (value: Json, event: string): Json[] =>
  (((value['hooks'] as Json | undefined)?.[event] as Json[] | undefined) ?? []) as Json[];
const handlersAt = (value: Json): { event: string; group: Json; handler: Json }[] =>
  Object.entries((value['hooks'] as Json | undefined) ?? {}).flatMap(([event, groups]) =>
    Array.isArray(groups)
      ? (groups as Json[]).flatMap((group) =>
          ((group['hooks'] as Json[] | undefined) ?? []).map((handler) => ({
            event,
            group,
            handler,
          })),
        )
      : [],
  );
const isHq = (handler: Json): boolean =>
  String(handler['command']).startsWith(': agent-productivity-hq-hook;');
const owners = (value: Json): string[] =>
  handlersAt(value)
    .filter((entry) => !isHq(entry.handler))
    .map((entry) => `${entry.event}:${String(entry.handler['command'])}`);

describe('what counts as HQ’s entry being there', () => {
  it('is present for the group HQ writes, and for a group whose matcher matches everything', () => {
    expect(inspect(settings(complete()), COMMAND)).toBe('present');
    for (const matcher of ['', '*']) {
      const hooks = complete();
      (hooks['Stop'] as Json[])[0]!['matcher'] = matcher;
      expect(inspect(settings(hooks), COMMAND), JSON.stringify(matcher)).toBe('present');
    }
  });

  const broken: [string, (hooks: Json) => void][] = [
    ['a matcher around HQ’s handler', (h) => ((h['Stop'] as Json[])[0]!['matcher'] = 'Bash')],
    [
      'a matcher that only looks like a wildcard',
      (h) => ((h['Stop'] as Json[])[0]!['matcher'] = '.*'),
    ],
    ['a matcher of a different type', (h) => ((h['Stop'] as Json[])[0]!['matcher'] = 5)],
    [
      'a matcher on the permission event',
      (h) => ((h['PermissionRequest'] as Json[])[0]!['matcher'] = 'Edit|Write'),
    ],
    [
      'HQ’s handler moved into the owner’s group',
      (h) => (h['Stop'] = [{ hooks: [mine('a'), hq()] }]),
    ],
    [
      'HQ’s handler moved into the owner’s group with a matcher',
      (h) => (h['Stop'] = [{ matcher: 'x', hooks: [hq()] }]),
    ],
    ['an extra key on HQ’s group', (h) => ((h['Stop'] as Json[])[0]!['description'] = 'mine')],
    ['a duplicate in another group', (h) => (h['Stop'] = [{ hooks: [hq()] }, { hooks: [hq()] }])],
    ['a duplicate in the same group', (h) => (h['Stop'] = [{ hooks: [hq(), hq()] }])],
    ['an altered timeout', (h) => (h['Stop'] = [{ hooks: [hq({ timeout: 4 })] }])],
    [
      'a missing timeout',
      (h) => (h['Stop'] = [{ hooks: [{ type: 'command', command: COMMAND }] }]),
    ],
    ['an altered type', (h) => (h['Stop'] = [{ hooks: [hq({ type: 'prompt' })] }])],
    ['an extra key on the handler', (h) => (h['Stop'] = [{ hooks: [hq({ async: true })] }])],
    [
      'a command from another data folder',
      (h) => (h['Stop'] = [{ hooks: [hq({ command: OLD })] }]),
    ],
    ['an event HQ no longer uses', (h) => (h['PostToolUse'] = [{ hooks: [hq()] }])],
    ['a missing event', (h) => delete h['SessionEnd']],
  ];
  it.each(broken)('is needs_repair for %s', (_name, mutate) => {
    const hooks = complete();
    mutate(hooks);
    expect(inspect(settings(hooks), COMMAND)).toBe('needs_repair');
  });

  it('is absent when there is no HQ handler, whatever the owner has', () => {
    expect(inspect(settings({ Stop: [{ matcher: 'Bash', hooks: [mine('a')] }] }), COMMAND)).toBe(
      'absent',
    );
    expect(inspect({ model: 'x' }, COMMAND)).toBe('absent');
  });
});

describe('taking HQ’s entries out', () => {
  it('takes out HQ’s handler object only, and leaves the owner’s group with its matcher and handlers', () => {
    const before = settings({
      Stop: [{ matcher: 'x', hooks: [mine('a'), hq(), mine('b')] }],
      Notification: [{ hooks: [mine('c'), hq()] }],
    });
    const after = applyEntries(before, COMMAND, false);
    expect(groupsOf(after, 'Stop')).toEqual([{ matcher: 'x', hooks: [mine('a'), mine('b')] }]);
    expect(groupsOf(after, 'Notification')).toEqual([{ hooks: [mine('c')] }]);
  });

  it('leaves an owner’s group the removal emptied (it has a matcher, or another key), as `hooks: []`', () => {
    for (const group of [
      { matcher: 'Bash', hooks: [hq()] },
      { description: 'mine', hooks: [hq()] },
    ]) {
      const after = applyEntries(settings({ Stop: [group] }), COMMAND, false);
      expect(groupsOf(after, 'Stop')).toEqual([{ ...group, hooks: [] }]);
      expect(after['hooks']).toBeDefined();
    }
  });

  it('deletes only what HQ made: its own plain group, then an event it left empty, then `hooks` it left empty', () => {
    const only = settings(complete());
    expect(applyEntries(only, COMMAND, false)).toEqual({ model: 'x' });
    const beside = settings({ ...complete(), PreToolUse: [{ hooks: [mine('p')] }] });
    expect(applyEntries(beside, COMMAND, false)).toEqual(
      settings({ PreToolUse: [{ hooks: [mine('p')] }] }),
    );
    // A list or an object the owner left empty is not HQ's to delete.
    expect(applyEntries({ hooks: { Stop: [] } }, COMMAND, false)).toEqual({ hooks: { Stop: [] } });
    expect(applyEntries({ hooks: {} }, COMMAND, false)).toEqual({ hooks: {} });
  });

  it('a plain group with a match-all matcher goes when HQ’s handler was all it held', () => {
    const after = applyEntries(
      settings({ Stop: [{ matcher: '*', hooks: [hq()] }] }),
      COMMAND,
      false,
    );
    expect(after).toEqual({ model: 'x' });
  });
});

describe('repairing', () => {
  it('writes HQ’s group beside the owner’s, whatever the owner has on the event', () => {
    const before = settings({ Stop: [{ matcher: 'x', hooks: [mine('a')] }] });
    const after = applyEntries(before, COMMAND, true);
    expect(inspect(after, COMMAND)).toBe('present');
    expect(groupsOf(after, 'Stop')).toEqual([
      { matcher: 'x', hooks: [mine('a')] },
      { hooks: [hq()] },
    ]);
  });
});

// Every combination of what the owner may have on an event next to HQ's handler, checked against the three laws below.
describe('over every combination of the owner’s groups and HQ’s handler', () => {
  const pieces: Json[] = [
    { hooks: [mine('1')] },
    { matcher: 'Bash', hooks: [mine('2')] },
    { matcher: '*', hooks: [mine('3')] },
    { description: 'x', hooks: [mine('4')] },
    { hooks: [hq()] },
    { matcher: '', hooks: [hq()] },
    { matcher: 'Bash', hooks: [hq()] },
    { description: 'x', hooks: [hq()] },
    { hooks: [mine('5'), hq()] },
    { matcher: 'x', hooks: [hq(), mine('6'), hq()] },
    { hooks: [hq({ timeout: 9 })] },
    { hooks: [hq({ type: 'http' })] },
    { hooks: [hq({ command: OLD })] },
    { hooks: [] },
    { matcher: 'Bash', hooks: [] },
  ];
  const combos: Json[][] = [[]];
  for (const a of pieces) {
    combos.push([a]);
    for (const b of pieces) {
      combos.push([a, b]);
      for (const c of pieces) combos.push([a, b, c]);
    }
  }

  it(`holds for ${combos.length} event lists`, () => {
    let present = 0;
    for (const groups of combos) {
      // A JSON round trip, as a file read from disk (structuredClone would keep two entries that are one object).
      const before = settings(
        JSON.parse(JSON.stringify({ Stop: groups, Elsewhere: [{ hooks: [hq()] }] })),
      );
      const label = JSON.stringify(groups);
      const snapshot = JSON.stringify(before);

      const off = applyEntries(before, COMMAND, false);
      // Removal: no HQ handler left, and every owner handler is where it was, in order.
      expect(
        handlersAt(off).filter((entry) => isHq(entry.handler)),
        label,
      ).toEqual([]);
      expect(owners(off), label).toEqual(owners(before));
      // Every group that was not HQ's plain shape is still there with its other keys.
      const kept = groupsOf(off, 'Stop').map((group) => ({ ...group, hooks: undefined }));
      const expectedKept = groups
        .filter(
          (group) =>
            !(
              isPlainShape(group) &&
              (group['hooks'] as Json[]).length > 0 &&
              (group['hooks'] as Json[]).every(isHq)
            ),
        )
        .map((group) => ({ ...group, hooks: undefined }));
      expect(kept, label).toEqual(expectedKept);

      const on = applyEntries(before, COMMAND, true);
      expect(inspect(on, COMMAND), label).toBe('present');
      expect(owners(on), label).toEqual(owners(before));
      expect(applyEntries(on, COMMAND, true), label).toEqual(on); // idempotent
      expect(inspect(applyEntries(on, COMMAND, false), COMMAND), label).toBe('absent');
      expect(owners(applyEntries(on, COMMAND, false)), label).toEqual(owners(before));
      if (inspect(before, COMMAND) === 'present') present += 1;
      expect(JSON.stringify(before), 'the input is never changed').toBe(snapshot);
      // The plan agrees with the value it describes.
      expect(planEntries(before, COMMAND, true).next, label).toEqual(on);
    }
    expect(present).toBe(0); // (Elsewhere always holds an HQ handler, so none is a complete install)
  });
});

function isPlainShape(group: Json): boolean {
  return Object.keys(group).every(
    (key) => key === 'hooks' || (key === 'matcher' && (group[key] === '' || group[key] === '*')),
  );
}
