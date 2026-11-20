import { describe, expect, it } from 'vitest';
import { buildHookCommand } from '../../src/server/integrations/claudeHooks/command.ts';
import { editSettingsText } from '../../src/server/integrations/claudeHooks/edit.ts';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/errors.ts';
import { inspect, parseSettings } from '../../src/server/integrations/claudeHooks/settings.ts';

// The one rule (data-and-sources › Claude Code hooks › Install and remove): HQ never rewrites a settings file from a parsed object.
// The only writer makes local edits to the file's own text; the result must read back (last key wins, as JSON.parse and Claude Code
// read it) as exactly the intended settings, with every byte outside HQ's own entries unchanged; else the file is refused
// (`unsupported_layout`, or the code of what is wrong with it) and nothing is written. For every file below, turning on and then off
// either gives back the original bytes or one of those refusals.

const COMMAND = buildHookCommand('/n/node', '/d/claude-hooks/agent-productivity-hook.mjs');
const BOM = '﻿';

type Outcome = { text: string } | { refused: string };
function edit(text: string | null, enabled: boolean): Outcome | null {
  try {
    const next = editSettingsText(text, COMMAND, enabled);
    return next === null ? null : { text: next };
  } catch (error) {
    if (!(error instanceof ClaudeHooksError)) throw error;
    return { refused: error.failure };
  }
}

/** On, then off: the bytes after the round trip, or the code of the refusal at either step. */
function roundTrip(original: string): { on: string; off: string } | { refused: string } {
  const on = edit(original, true);
  if (on === null) throw new Error('turning on changed nothing');
  if ('refused' in on) return on;
  const off = edit(on.text, false);
  if (off === null) throw new Error('turning off changed nothing');
  if ('refused' in off) return off;
  return { on: on.text, off: off.text };
}

const effective = (text: string): Record<string, unknown> =>
  JSON.parse(text.replace(BOM, '')) as Record<string, unknown>;

/** True when `small` is `big` with some text cut out and nothing added or changed. */
function isCutDownFrom(small: string, big: string): boolean {
  let at = 0;
  for (const char of small) {
    at = big.indexOf(char, at);
    if (at === -1) return false;
    at += char.length;
  }
  return true;
}

/** The settings with every empty list and object of `hooks` taken out, as `{}` and `[]` are the same to Claude Code as no entry. */
function withoutEmptyHooks(value: Record<string, unknown>): Record<string, unknown> {
  const hooks = value['hooks'];
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return value;
  const kept = Object.fromEntries(
    Object.entries(hooks).filter(([, list]) => !(Array.isArray(list) && list.length === 0)),
  );
  const rest = { ...value };
  if (Object.keys(kept).length === 0) delete rest['hooks'];
  else rest['hooks'] = kept;
  return rest;
}

/**
 * The round trip, judged: 'exact' (the original bytes), 'refused' (a fixed code, nothing written), or 'dropped': the owner had an EMPTY
 * `hooks` object or event list, which turning off removes (after HQ filled it, it cannot be told from one HQ made). Then the text is
 * the original with only that empty container cut out, and the effective settings are the same.
 */
function judge(original: string, label: string): 'exact' | 'refused' | 'dropped' {
  const result = roundTrip(original);
  if ('refused' in result) {
    expect(
      ['unsupported_layout', 'unsupported_shape', 'not_json', 'not_an_object', 'unreadable'],
      label,
    ).toContain(result.refused);
    return 'refused';
  }
  expect(inspect(parseSettings(result.on), COMMAND), label).toBe('present');
  expect(inspect(parseSettings(result.off), COMMAND), label).toBe('absent');
  if (result.off === original) return 'exact';
  expect(isCutDownFrom(result.off.replace(BOM, ''), original.replace(BOM, '')), label).toBe(true);
  expect(withoutEmptyHooks(effective(result.off)), label).toEqual(
    withoutEmptyHooks(effective(original)),
  );
  return 'dropped';
}

const exactOrRefused = (original: string, label: string): 'exact' | 'refused' => {
  const outcome = judge(original, label);
  expect(outcome, label).not.toBe('dropped');
  return outcome as 'exact' | 'refused';
};

describe('repeated keys: the last member is the effective one, and the only one HQ edits', () => {
  type Expected = 'exact' | 'dropped' | 'refused';
  const dupes: [string, string, Expected][] = [
    [
      'two hooks members, the last empty (the reviewer’s file)',
      '{"model":"first","hooks":{"Stop":[]},"model":"second","hooks":{}}',
      'exact',
    ],
    [
      'two hooks members, the last holding the owner’s hooks',
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"old"}]}]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}',
      'exact',
    ],
    [
      'two hooks members, the first holding HQ’s old entries (dead text)',
      `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":${JSON.stringify(COMMAND)}}]}]},"model":"x","hooks":{}}`,
      'exact',
    ],
    ['two hooks members, the last not an object', '{"hooks":{},"hooks":[]}', 'refused'],
    [
      'two hooks members, the first not an object (dead text), the last with an empty Stop list',
      '{"hooks":[],"hooks":{"Stop":[]}}',
      'dropped',
    ],
    [
      'two hooks members, the first not an object (dead text)',
      '{"hooks":[],"hooks":{"PreToolUse":[1]}}',
      'exact',
    ],
    ['two Stop members inside hooks', '{"hooks":{"Stop":[{"hooks":[]}],"Stop":[]}}', 'exact'],
    [
      'two Stop members, the last holding the owner’s group',
      '{"hooks":{"Stop":[],"Stop":[{"hooks":[{"type":"command","command":"keep"}]}]}}',
      'exact',
    ],
    [
      'two PreToolUse members around an HQ event',
      '{"hooks":{"PreToolUse":[1],"Stop":[],"PreToolUse":[2]}}',
      'dropped',
    ],
    [
      'two PreToolUse members around an HQ event with the owner’s group in it',
      '{"hooks":{"PreToolUse":[1],"Stop":[{"hooks":[]}],"PreToolUse":[2]}}',
      'exact',
    ],
    [
      'a group with two hooks lists',
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dead"}],"hooks":[{"type":"command","command":"live"}]}]}}',
      'exact',
    ],
    [
      'a group with two matchers',
      '{"hooks":{"Stop":[{"matcher":"Bash","matcher":"*","hooks":[{"type":"command","command":"x"}]}]}}',
      'exact',
    ],
    ['repeated keys everywhere else', '{"a":1,"a":2,"b":{"c":1,"c":[1,2],"c":{}}}', 'exact'],
    ['a repeated key that looks like an integer', '{"2":"x","10":"y","2":"z"}', 'exact'],
    ['a repeated __proto__ key', '{"__proto__":{"a":1},"__proto__":{"b":2}}', 'exact'],
    [
      'repeated keys everywhere else, and an empty hooks object',
      '{"a":1,"a":2,"b":{"c":1,"c":[1,2],"c":{}},"hooks":{}}',
      'dropped',
    ],
  ];
  for (const [name, text, expected] of dupes) {
    it(`${expected === 'refused' ? 'refuses' : expected === 'exact' ? 'gives back the bytes of' : 'gives back, but for an empty container of the owner’s,'} the file: ${name}`, () => {
      expect(judge(text, name)).toBe(expected);
    });
  }

  it('edits the last hooks member and leaves the earlier one’s text untouched', () => {
    const original =
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dead"}]}]},"hooks":{"PreToolUse":[]}}';
    const on = (edit(original, true) as { text: string }).text;
    expect(
      on.startsWith(
        '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dead"}]}]},"hooks":{"PreToolUse":[],',
      ),
    ).toBe(true);
    expect(Object.keys(effective(on)['hooks'] as object)).toEqual([
      'PreToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'SessionStart',
      'SessionEnd',
    ]);
  });

  it('never exposes an earlier member: removal that would empty the effective hooks leaves {} there', () => {
    const original =
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dead"}]}]},"hooks":{}}';
    const on = (edit(original, true) as { text: string }).text;
    const off = (edit(on, false) as { text: string }).text;
    expect(effective(off)['hooks']).toEqual({});
    expect(off).toBe(original);
  });

  it('refuses, writing nothing, a last hooks member that is not an object, whatever comes before', () => {
    for (const text of ['{"hooks":{},"hooks":5}', '{"hooks":{},"hooks":null}', '{"hooks":[]}']) {
      expect(edit(text, true), text).toEqual({ refused: 'unsupported_shape' });
      expect(edit(text, false), text).toEqual({ refused: 'unsupported_shape' });
    }
  });

  it('refuses an HQ event that is not a list (the last member), and leaves another event’s odd value alone', () => {
    expect(edit('{"hooks":{"Stop":{}}}', true)).toEqual({ refused: 'unsupported_shape' });
    expect(edit('{"hooks":{"Stop":[],"Stop":"x"}}', true)).toEqual({
      refused: 'unsupported_shape',
    });
    expect(edit('{"hooks":{"Stop":"x","Stop":[]}}', true)).toHaveProperty('text');
    const odd = '{"hooks":{"PreToolUse":5}}';
    expect(exactOrRefused(odd, odd)).toBe('exact');
  });

  it('does not delete a group that holds a repeated key’s dead text: it stays with an empty hooks list', () => {
    const owner = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dead"}],"hooks":[]}]}}';
    const on = (edit(owner, true) as { text: string }).text;
    // HQ's own group is appended; the owner's is untouched.
    expect(on).toContain('{"hooks":[{"type":"command","command":"dead"}],"hooks":[]}');
    // The case that matters: HQ's handler inside a group that repeats a key.
    const mixed = `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dead"}],"hooks":[{"type":"command","command":${JSON.stringify(COMMAND)}}]}]}}`;
    const off = (edit(mixed, false) as { text: string }).text;
    expect(off).toBe(
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dead"}],"hooks":[]}]}}',
    );
  });
});

describe('what is not JSON, is not edited', () => {
  it.each([
    ['a comment', '// note\n{}'],
    ['a block comment', '{ /* x */ }'],
    ['a trailing comma', '{"a":1,}'],
    ['single quotes', "{'a':1}"],
    ['an unquoted key', '{a:1}'],
    ['nothing', ''],
    ['text that stops short', '{"a":'],
  ])('refuses %s as not JSON and writes nothing', (_name, text) => {
    expect(edit(text, true)).toEqual({ refused: 'not_json' });
    expect(edit(text, false)).toEqual({ refused: 'not_json' });
  });

  it.each([
    ['an array', '[]', 'not_an_object'],
    ['null', 'null', 'not_an_object'],
    ['a string', '"x"', 'not_an_object'],
  ])('refuses %s as not an object', (_name, text, code) => {
    expect(edit(text, true)).toEqual({ refused: code });
  });
});

describe('bounded: a hostile file is refused or edited, never a crash', () => {
  it('refuses nesting deeper than HQ reads, however deep', () => {
    for (const depth of [65, 200, 100_000]) {
      const deep = `{"a":${'['.repeat(depth)}${']'.repeat(depth)},"hooks":{}}`;
      expect(edit(deep, true), String(depth)).toEqual({ refused: 'unsupported_layout' });
      expect(edit(deep, false), String(depth)).toEqual({ refused: 'unsupported_layout' });
    }
    const shallow = `{"a":${'['.repeat(40)}${']'.repeat(40)}}`;
    expect(exactOrRefused(shallow, 'depth 40')).toBe('exact');
  });

  it('refuses a file over the size HQ reads', () => {
    const huge = `{"a":"${'x'.repeat(4 * 1024 * 1024 + 10)}"}`;
    expect(edit(huge, true)).toEqual({ refused: 'unreadable' });
  });

  it('edits a large file with many members in one pass, keeping every byte of them', () => {
    const members = Array.from({ length: 20_000 }, (_, i) => `"k${i}": ${i}`).join(',\n  ');
    const original = `{\n  ${members}\n}\n`;
    const started = Date.now();
    expect(exactOrRefused(original, 'many members')).toBe('exact');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('text outside HQ’s entries is the owner’s, byte for byte', () => {
  const kept: [string, string][] = [
    ['1e400', '{"big": 1e400}'],
    ['negative zero', '{"z": -0}'],
    ['-0.0 and 1E+2 and 0.10', '{"a": -0.0, "b": 1E+2, "c": 0.10}'],
    ['a 20-digit integer', '{"n": 12345678901234567890}'],
    ['escapes', '{"s": "caf\\u00e9 \\/ \\n \\"q\\" \\\\"}'],
    ['a surrogate pair written as escapes', '{"s": "\\ud83d\\ude00"}'],
    ['a lone surrogate escape', '{"s": "\\ud800"}'],
    ['raw astral characters and U+2028', '{"s": "😀   日本語"}'],
    ['a key that is the empty string', '{"": 1}'],
  ];
  for (const [name, text] of kept) {
    it(`keeps ${name}, and the round trip gives the bytes back`, () => {
      expect(exactOrRefused(text, name)).toBe('exact');
      const on = (edit(text, true) as { text: string }).text;
      // the owner's text is in the result as it was, not as a parsed copy would print it
      expect(on.startsWith(text.replace(/\}\s*$/, ''))).toBe(true);
    });
  }

  it('keeps a number that does not fit a double inside a group HQ removes its handler from', () => {
    const original = `{"hooks":{"Stop":[{"matcher":"x","big":1e400,"zero":-0,"hooks":[{"type":"command","command":${JSON.stringify(COMMAND)}},{"type":"command","command":"keep"}]}]}}`;
    const off = (edit(original, false) as { text: string }).text;
    expect(off).toBe(
      '{"hooks":{"Stop":[{"matcher":"x","big":1e400,"zero":-0,"hooks":[{"type":"command","command":"keep"}]}]}}',
    );
  });
});

// ---- a seeded generator of unusual settings files ----------------------------------------------------------------------------

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OWNER_COMMANDS = ['say done', '/bin/check.sh', 'a,b', 'q"uote', 'back\\slash'];
const EVENTS = [
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
];
const NUMBERS = [
  '0',
  '-0',
  '1',
  '1.50',
  '1E5',
  '1e400',
  '-1e400',
  '12345678901234567890',
  '0.1e-5',
];
const STRINGS = ['"x"', '"caf\\u00e9"', '"\\ud83d\\ude00"', '"\\ud800"', '"😀"', '"a\\"b"', '""'];

function generate(rand: () => number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const chance = (p: number) => rand() < p;
  const nl = chance(0.2) ? '\r\n' : '\n';
  const unit = pick(['  ', '    ', '\t', null, null]);
  const pad = (depth: number) => (unit === null ? '' : unit.repeat(depth));
  const sep = (depth: number) => (unit === null ? (chance(0.3) ? ' ' : '') : nl + pad(depth));
  const colon = () => (unit === null ? ':' : chance(0.9) ? ': ' : ':');

  const scalar = (): string => pick([pick(NUMBERS), pick(STRINGS), 'true', 'false', 'null']);
  const object = (members: [string, string][], depth: number): string => {
    if (members.length === 0)
      return chance(0.2) && unit !== null ? `{${nl}${pad(depth)}}` : chance(0.2) ? '{ }' : '{}';
    const inline = chance(0.1);
    const parts = members.map(([k, v]) => `${JSON.stringify(k)}${colon()}${v}`);
    if (inline || unit === null)
      return `{${chance(0.3) ? ' ' : ''}${parts.join(chance(0.5) ? ', ' : ',')}${chance(0.3) ? ' ' : ''}}`;
    return `{${sep(depth + 1)}${parts.join(`,${sep(depth + 1)}`)}${sep(depth)}}`;
  };
  const list = (items: string[], depth: number): string => {
    if (items.length === 0)
      return chance(0.2) ? '[ ]' : chance(0.1) && unit !== null ? `[${nl}${pad(depth)}]` : '[]';
    if (chance(0.25) || unit === null)
      return `[${chance(0.3) ? ' ' : ''}${items.join(chance(0.5) ? ', ' : ',')}${chance(0.3) ? ' ' : ''}]`;
    return `[${sep(depth + 1)}${items.join(`,${sep(depth + 1)}`)}${sep(depth)}]`;
  };
  const handler = (depth: number): string => {
    const members: [string, string][] = [
      ['type', '"command"'],
      ['command', JSON.stringify(pick(OWNER_COMMANDS))],
    ];
    if (chance(0.3)) members.push(['timeout', pick(NUMBERS)]);
    if (chance(0.1)) members.push(['command', JSON.stringify(pick(OWNER_COMMANDS))]);
    return object(members, depth);
  };
  const group = (depth: number): string => {
    const members: [string, string][] = [];
    if (chance(0.3)) members.push(['matcher', pick(['"*"', '""', '"Bash"'])]);
    members.push([
      'hooks',
      list(
        Array.from({ length: Math.floor(rand() * 3) }, () => handler(depth + 3)),
        depth + 2,
      ),
    ]);
    if (chance(0.1)) members.push(['hooks', list([handler(depth + 3)], depth + 2)]);
    if (chance(0.1)) members.push(['note', scalar()]);
    return object(members, depth + 1);
  };
  const events = (depth: number): string => {
    const members: [string, string][] = [];
    for (const event of EVENTS) {
      if (!chance(0.45)) continue;
      const value = chance(0.05)
        ? scalar()
        : list(
            Array.from({ length: Math.floor(rand() * 3) }, () => group(depth + 1)),
            depth + 1,
          );
      members.push([event, value]);
      if (chance(0.08)) members.push([event, list([group(depth + 1)], depth + 1)]);
    }
    return object(members, depth);
  };
  const top: [string, string][] = [];
  for (let i = 0; i < Math.floor(rand() * 4); i += 1)
    top.push([
      pick(['model', 'env', 'a', '10', '2', '', 'x y']),
      chance(0.3) ? object([['k', scalar()]], 1) : scalar(),
    ]);
  const hooksCount = chance(0.85) ? 1 : chance(0.5) ? 2 : 0;
  const at = Math.floor(rand() * (top.length + 1));
  const hooks: [string, string][] = Array.from({ length: hooksCount }, () => [
    'hooks',
    chance(0.03) ? scalar() : events(1),
  ]);
  top.splice(at, 0, ...hooks);
  const body = object(top, 0);
  return (chance(0.1) ? BOM : '') + body + (chance(0.7) ? nl : '');
}

describe('a seeded sweep over unusual files (every layout, repeated keys, odd numbers and strings)', () => {
  it('on then off gives back the bytes (but for an empty container of the owner’s), or refuses; nothing in between', () => {
    const counts = { exact: 0, dropped: 0, refused: 0 };
    for (let seed = 1; seed <= 4000; seed += 1) {
      const original = generate(random(seed));
      try {
        parseSettings(original);
      } catch {
        continue;
      }
      counts[judge(original, `seed ${seed}`)] += 1;
    }
    expect(counts.exact).toBeGreaterThan(500);
    expect(counts.dropped).toBeGreaterThan(50);
    expect(counts.refused).toBeGreaterThan(0);
  });
});

// ---- files that already hold entries of HQ's (an older install, a hand edit, a repair) ------------------------------------------

const OLD = buildHookCommand(
  '/old data/node',
  '/old data/claude-hooks/agent-productivity-hook.mjs',
);

/** The settings as the owner meant them: HQ's handlers taken out, and what that leaves empty (and HQ writes) gone. */
function ownersSettings(value: Record<string, unknown>): Record<string, unknown> {
  const hooks = value['hooks'];
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return value;
  const kept: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const left = groups.flatMap((group: unknown) => {
      if (
        typeof group !== 'object' ||
        group === null ||
        !Array.isArray((group as { hooks?: unknown }).hooks)
      )
        return [group];
      const record = group as Record<string, unknown> & { hooks: unknown[] };
      const handlers = record.hooks.filter(
        (handler) =>
          !(
            typeof handler === 'object' &&
            handler !== null &&
            [COMMAND, OLD].includes((handler as { command?: string }).command ?? '')
          ),
      );
      const plain = Object.keys(record).every(
        (key) => key === 'hooks' || (key === 'matcher' && ['', '*'].includes(String(record[key]))),
      );
      if (handlers.length === 0 && plain) return [];
      return [{ ...record, hooks: handlers }];
    });
    if (left.length > 0) kept[event] = left;
  }
  const rest = { ...value };
  if (Object.keys(kept).length === 0) delete rest['hooks'];
  else rest['hooks'] = kept;
  return rest;
}

function withHqEntries(rand: () => number): string {
  const text = generate(rand);
  const hq = (command: string) =>
    `{"type":"command","command":${JSON.stringify(command)}${rand() < 0.5 ? ',"timeout":3' : ',"timeout":9'}}`;
  // Put a handler of HQ's (this app's or an older one's) first in the first list of handlers the file has.
  return text
    .replace(
      /"hooks"(\s*:\s*)\[/,
      (_found: string, colon: string) =>
        `"hooks"${colon}[${hq(rand() < 0.5 ? COMMAND : OLD)}${rand() < 0.5 ? ',' : ''}`,
    )
    .replace(/,\s*\]/, ']');
}

describe('a seeded sweep over files that already hold entries of HQ’s', () => {
  it('turning on gives the complete entries and keeps the owner’s settings; turning off leaves only the owner’s', () => {
    let checked = 0;
    for (let seed = 5001; seed <= 8000; seed += 1) {
      const original = withHqEntries(random(seed));
      let before: Record<string, unknown>;
      try {
        before = parseSettings(original);
      } catch {
        continue;
      }
      const on = edit(original, true);
      if (on !== null && 'refused' in on) continue;
      const turned = on === null ? original : on.text;
      expect(inspect(parseSettings(turned), COMMAND), `seed ${seed}`).toBe('present');
      expect(ownersSettings(effective(turned)), `seed ${seed}`).toEqual(ownersSettings(before));
      const off = edit(turned, false);
      expect(off, `seed ${seed}`).not.toBeNull();
      if (off === null || 'refused' in off) throw new Error(`seed ${seed}: ${JSON.stringify(off)}`);
      expect(inspect(parseSettings(off.text), COMMAND), `seed ${seed}`).toBe('absent');
      expect(ownersSettings(effective(off.text)), `seed ${seed}`).toEqual(ownersSettings(before));
      // Turning on twice is turning on once: HQ never adds a second entry.
      expect(edit(turned, true), `seed ${seed}`).toBeNull();
      checked += 1;
    }
    expect(checked).toBeGreaterThan(500);
  });
});
