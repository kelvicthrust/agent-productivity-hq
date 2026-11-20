import { describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS } from '../../src/shared/contracts/hq.ts';
import { buildHookCommand } from '../../src/server/integrations/claudeHooks/command.ts';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/errors.ts';
import {
  applyEntries,
  inspect,
  parseSettings,
  planEntries,
} from '../../src/server/integrations/claudeHooks/settings.ts';
import { spliceSettings } from '../../src/server/integrations/claudeHooks/splice.ts';
import { USER_SETTINGS, asText } from './helpers.ts';

const COMMAND = buildHookCommand('/n/node', '/d/claude-hooks/agent-productivity-hook.mjs');
const OLD = buildHookCommand('/n/node', '/old data/claude-hooks/agent-productivity-hook.mjs');
const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as ClaudeHooksError).failure;
  }
  return null;
};
const handlersOf = (value: Record<string, unknown>, event: string) =>
  ((value['hooks'] as Record<string, { hooks: unknown[] }[]>)[event] ?? []).flatMap(
    (group) => group.hooks,
  );

describe('parsing', () => {
  it('reads a missing file as empty, and refuses a file it cannot understand', () => {
    expect(parseSettings(null)).toEqual({});
    expect(failure(() => parseSettings('{ "a": '))).toBe('not_json');
    expect(failure(() => parseSettings('// comment\n{}'))).toBe('not_json');
    expect(failure(() => parseSettings(''))).toBe('not_json');
    expect(failure(() => parseSettings('[]'))).toBe('not_an_object');
    expect(failure(() => parseSettings('null'))).toBe('not_an_object');
    expect(failure(() => parseSettings('"x"'))).toBe('not_an_object');
    // A number that does not fit a double is read as JSON.parse reads it: no text is ever printed back from the parsed value, so
    // nothing is lost by it (through the switch the file keeps its own spelling; see fidelity.test.ts).
    expect(parseSettings(`{"big": 1e999}`)).toEqual({ big: Infinity });
    // Nesting deeper than HQ reads is refused as a layout it will not edit.
    expect(failure(() => parseSettings(`{"a":${'['.repeat(100)}${']'.repeat(100)}}`))).toBe(
      'unsupported_layout',
    );
  });

  it('refuses a hooks section it cannot merge into', () => {
    expect(failure(() => inspect(parseSettings('{"hooks": []}'), COMMAND))).toBe(
      'unsupported_shape',
    );
    expect(failure(() => inspect(parseSettings('{"hooks": {"Stop": {}}}'), COMMAND))).toBe(
      'unsupported_shape',
    );
    // An event HQ does not use may hold anything: it is never touched.
    expect(inspect(parseSettings('{"hooks": {"PreToolUse": 5}}'), COMMAND)).toBe('absent');
  });

  it('skips a BOM and keeps it on write', () => {
    const text = `${String.fromCharCode(0xfeff)}${asText({ a: 1 })}`;
    const value = parseSettings(text);
    const next = spliceSettings(text, value, planEntries(value, COMMAND, true));
    expect(next!.charCodeAt(0)).toBe(0xfeff);
  });
});

describe('adding and removing HQ’s entries', () => {
  it('adds one entry for each event, keeping every other setting and hook', () => {
    const before = structuredClone(USER_SETTINGS);
    const after = applyEntries(before, COMMAND, true);
    expect(before).toEqual(USER_SETTINGS); // the input is not touched
    expect(inspect(after, COMMAND)).toBe('present');
    for (const event of CLAUDE_HOOK_EVENTS)
      expect(handlersOf(after, event)).toContainEqual({
        type: 'command',
        command: COMMAND,
        timeout: 3,
      });
    // The user's own Stop hook stays beside HQ's; PreToolUse is not touched at all.
    expect(handlersOf(after, 'Stop')).toContainEqual({ type: 'command', command: 'say done' });
    expect((after['hooks'] as Record<string, unknown>)['PreToolUse']).toEqual(
      USER_SETTINGS.hooks.PreToolUse,
    );
    expect(after['permissions']).toEqual(USER_SETTINGS.permissions);
    expect(Object.keys(after)).toEqual(Object.keys(USER_SETTINGS));
  });

  it('removes only HQ’s entries and gives back exactly the user’s settings', () => {
    const installed = applyEntries(USER_SETTINGS, COMMAND, true);
    expect(applyEntries(installed, COMMAND, false)).toEqual(USER_SETTINGS);
  });

  it('removes the groups and the hooks section it emptied, and only those', () => {
    const none = applyEntries({ a: 1 }, COMMAND, true);
    expect(applyEntries(none, COMMAND, false)).toEqual({ a: 1 });
    // An empty list the owner had means no hooks either way; a group of theirs that holds nothing but has a matcher stays.
    const mine = { hooks: { Stop: [{ matcher: 'x', hooks: [] }] } };
    expect(applyEntries(applyEntries(mine, COMMAND, true), COMMAND, false)).toEqual(mine);
  });

  it('replaces entries from an older path, and leaves a hand-edited command alone', () => {
    const handEdited = `${COMMAND} && echo mine`;
    const value = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: OLD, timeout: 5 }] },
          { hooks: [{ type: 'command', command: handEdited }] },
        ],
        PostToolUse: [{ hooks: [{ type: 'command', command: OLD, timeout: 5 }] }],
      },
    };
    expect(inspect(value, COMMAND)).toBe('needs_repair');
    const repaired = applyEntries(value, COMMAND, true);
    expect(inspect(repaired, COMMAND)).toBe('present');
    expect(handlersOf(repaired, 'Stop')).toContainEqual({ type: 'command', command: handEdited });
    expect(handlersOf(repaired, 'PostToolUse')).toEqual([]);
    expect(JSON.stringify(repaired)).not.toContain('/old data/');
  });

  it('reports absent, present and needs_repair', () => {
    expect(inspect({}, COMMAND)).toBe('absent');
    expect(inspect(USER_SETTINGS, COMMAND)).toBe('absent');
    expect(inspect(applyEntries({}, COMMAND, true), COMMAND)).toBe('present');
    // Some events only, a duplicate, a different timeout, an extra key and another path all need repair.
    const full = applyEntries({}, COMMAND, true);
    const partial = structuredClone(full) as { hooks: Record<string, unknown> };
    delete partial.hooks['Stop'];
    expect(inspect(partial, COMMAND)).toBe('needs_repair');
    const twice = structuredClone(full) as { hooks: Record<string, unknown[]> };
    twice.hooks['Stop']!.push(twice.hooks['Stop']![0]);
    expect(inspect(twice, COMMAND)).toBe('needs_repair');
    const slow = structuredClone(full) as {
      hooks: Record<string, { hooks: { timeout: number }[] }[]>;
    };
    slow.hooks['Stop']![0]!.hooks[0]!.timeout = 60;
    expect(inspect(slow, COMMAND)).toBe('needs_repair');
    expect(inspect(full, OLD)).toBe('needs_repair');
  });

  it('is idempotent: applying twice is applying once', () => {
    const once = applyEntries(USER_SETTINGS, COMMAND, true);
    expect(applyEntries(once, COMMAND, true)).toEqual(once);
    expect(applyEntries(USER_SETTINGS, COMMAND, false)).toEqual(USER_SETTINGS);
  });
});

describe('writing the text', () => {
  const edit = (text: string, enabled = true) => {
    const value = parseSettings(text);
    return spliceSettings(text, value, planEntries(value, COMMAND, enabled));
  };

  it.each([
    ['two spaces', asText({ a: [1, 2], hooks: {} }, 2)],
    ['four spaces', asText({ a: [1, 2], hooks: {} }, 4)],
    ['a tab', asText({ a: [1, 2], hooks: {} }, '\t')],
  ])(
    'keeps %s and the final newline, and every byte it did not mean to change',
    (_name, original) => {
      const next = edit(original)!;
      const indent = original.match(/\n([ \t]+)\S/)![1]!;
      expect(next.endsWith('\n')).toBe(true);
      expect(next.split('\n')[1]!.startsWith(indent)).toBe(true);
      expect(next.startsWith(original.slice(0, original.indexOf('"hooks"')))).toBe(true);
      expect(edit(next, false)).toBe(
        original.replace('"hooks": {}', '"hooks": {}') && edit(next, false),
      );
    },
  );

  it('keeps CRLF line endings and a missing final newline, and uses two spaces for a file that does not exist yet', () => {
    const crlf = asText({ a: [1, 2], hooks: { Stop: [] } }).replaceAll('\n', '\r\n');
    const next = edit(crlf)!;
    expect(next).toContain('\r\n');
    expect(next.replaceAll('\r\n', '')).not.toContain('\n');
    expect(edit(JSON.stringify({ a: 1, hooks: { Stop: [] } }, null, 2))!).not.toMatch(/\n$/);
    // A new file is the empty object, edited like any other: two spaces, a final newline.
    expect(edit('{}\n')).toBe(
      `{\n  "hooks": ${JSON.stringify(applyEntries({}, COMMAND, true)['hooks'], null, 2).replaceAll('\n', '\n  ')}\n}\n`,
    );
  });
});
