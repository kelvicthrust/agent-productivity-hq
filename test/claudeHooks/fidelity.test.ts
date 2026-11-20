import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHookCommand } from '../../src/server/integrations/claudeHooks/command.ts';
import {
  inspect,
  parseSettings,
  planEntries,
} from '../../src/server/integrations/claudeHooks/settings.ts';
import { spliceSettings } from '../../src/server/integrations/claudeHooks/splice.ts';
import { rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): a rewrite keeps everything about the file that HQ did not mean
// to change: byte-order mark, line endings, final newline (or none), indentation, key order, number and string spellings, the owner's
// own text of every other setting and hook, and the file's mode. Only the text of HQ's own change is touched.

const COMMAND = buildHookCommand('/n/node', '/d/claude-hooks/agent-productivity-hook.mjs');
const BOM = '﻿';

interface Style {
  bom: string;
  nl: string;
  unit: string | null;
  final: boolean;
}
const styles: Style[] = [];
for (const bom of ['', BOM])
  for (const nl of ['\n', '\r\n'])
    for (const unit of ['  ', '    ', '\t', null])
      for (const final of [true, false]) styles.push({ bom, nl, unit, final });

const pad = (style: Style, depth: number): string => (style.unit ?? '').repeat(depth);
const value = (v: unknown, style: Style, depth: number): string =>
  JSON.stringify(v, null, style.unit ?? undefined)
    .split('\n')
    .join(style.nl + pad(style, depth));
/** An object from members whose values are already text, laid out in `style`. */
function object(members: [string, string][], style: Style, depth: number): string {
  if (members.length === 0) return '{}';
  const text = (k: string, v: string) =>
    `${JSON.stringify(k)}${style.unit === null ? ':' : ': '}${v}`;
  if (style.unit === null) return `{${members.map(([k, v]) => text(k, v)).join(',')}}`;
  const lines = members.map(([k, v]) => pad(style, depth + 1) + text(k, v));
  return `{${style.nl}${lines.join(`,${style.nl}`)}${style.nl}${pad(style, depth)}}`;
}
const file = (members: [string, string][], style: Style): string =>
  style.bom + object(members, style, 0) + (style.final ? style.nl : '');

const mine = (name: string) => ({ type: 'command', command: `owner-${name}` });
const OTHERS: [string, string][] = [
  ['model', '"x"'],
  ['10', '1'],
  ['2', '{"nested":[1,2]}'],
  ['big', '12345678901234567890'],
  ['num', '1.50'],
  ['exp', '1E5'],
  ['esc', '"caf\\u00e9 \\/s"'],
  ['dup', '1'],
  ['dup', '2'],
];

type Base = [string, (style: Style) => [string, string][]];
const bases: Base[] = [
  ['an empty object', () => []],
  ['other settings only', () => OTHERS],
  [
    'the owner’s hooks on other events and on HQ’s',
    (style) => [
      ...OTHERS,
      [
        'hooks',
        object(
          [
            ['PreToolUse', value([{ matcher: 'Bash', hooks: [mine('pre')] }], style, 2)],
            [
              'Stop',
              value([{ hooks: [mine('stop')] }, { matcher: 'x', hooks: [mine('x')] }], style, 2),
            ],
          ],
          style,
          1,
        ),
      ],
    ],
  ],
  [
    'the owner’s event lists written on one line',
    (style) => [
      ['model', '"x"'],
      [
        'hooks',
        object(
          [
            [
              'Stop',
              '[{ "matcher": "x", "hooks": [{ "type": "command", "command": "say done" }] }]',
            ],
            ['Notification', '[{"hooks":[{"type":"command","command":"a,b"}]},{"hooks":[]}]'],
            ['PreToolUse', '[ ]'],
          ],
          style,
          1,
        ),
      ],
    ],
  ],
  [
    'hooks with HQ’s old entries and the owner’s',
    (style) => [
      ['model', '"x"'],
      [
        'hooks',
        object(
          [
            [
              'Stop',
              value(
                [
                  {
                    hooks: [
                      mine('stop'),
                      {
                        type: 'command',
                        command:
                          ': agent-productivity-hq-hook; if [ -x "/o/node" ] && [ -f "/o/agent-productivity-hook.mjs" ]; then "/o/node" "/o/agent-productivity-hook.mjs"; fi',
                        timeout: 5,
                      },
                    ],
                  },
                ],
                style,
                2,
              ),
            ],
            ['PostToolUse', value([{ hooks: [mine('post')] }], style, 2)],
          ],
          style,
          1,
        ),
      ],
      ['theme', '"dark"'],
    ],
  ],
];

const enable = (text: string) => {
  const parsed = parseSettings(text);
  const plan = planEntries(parsed, COMMAND, true);
  return { parsed, plan, text: spliceSettings(text, parsed, plan) };
};
const disable = (text: string) => {
  const parsed = parseSettings(text);
  const plan = planEntries(parsed, COMMAND, false);
  return { parsed, plan, text: spliceSettings(text, parsed, plan) };
};

describe('writing HQ’s change into the file’s own text', () => {
  for (const [name, members] of bases) {
    it(`keeps everything else, byte for byte, in a file with ${name}, in every layout (${styles.length})`, () => {
      for (const style of styles) {
        const original = file(members(style), style);
        const label = `${name} ${JSON.stringify(style)}`;
        const on = enable(original);
        // Never the fallback (printing the whole file): the splice itself must have worked.
        expect(on.text, label).not.toBeNull();
        const after = on.text!;
        expect(JSON.parse(after.replace(BOM, '')), label).toEqual(on.plan.next);
        expect(inspect(parseSettings(after), COMMAND), label).toBe('present');
        // byte-order mark, line endings, final newline
        expect(after.startsWith(BOM), label).toBe(style.bom === BOM);
        expect(/\r?\n$/.test(after), label).toBe(style.final);
        // (`{}` with no line break at all says nothing of its line endings, so a new one is LF.)
        const unknowable = name === 'an empty object' && !style.final;
        if (unknowable) void 0;
        else if (style.nl === '\r\n')
          expect(after.replace(/\r\n/g, ''), label).not.toMatch(/[\r\n]/);
        else expect(after, label).not.toContain('\r');
        // indentation: the file's own, in the new text too
        if (style.unit === null && name !== 'an empty object')
          expect(after.replace(/\r?\n$/, ''), label).not.toMatch(/[\r\n]/);
        else if (name !== 'an empty object')
          for (const line of after.split(style.nl).slice(1))
            if (/^\s/.test(line)) expect(line, label).toMatch(new RegExp(`^(${style.unit})+\\S`));
        // every other setting and hook: the owner's text, untouched
        const hooksAt = original.indexOf('"hooks"');
        if (hooksAt === -1) {
          const lastMember = original.replace(/\s*\}\s*$/, '');
          const tail = original.slice(lastMember.length);
          expect(after.startsWith(lastMember), label).toBe(true);
          expect(after.endsWith(tail), label).toBe(true);
        } else {
          expect(after.startsWith(original.slice(0, hooksAt)), label).toBe(true);
        }
        for (const [, raw] of OTHERS)
          if (original.includes(raw)) expect(after, label).toContain(raw);

        // Turning it off again gives back the file as it was (where HQ made everything it removes).
        const off = disable(after);
        expect(off.text, label).not.toBeNull();
        expect(inspect(parseSettings(off.text!), COMMAND), label).toBe('absent');
        if (name !== 'hooks with HQ’s old entries and the owner’s')
          expect(off.text, label).toBe(original);
        expect(off.text!.startsWith(BOM), label).toBe(style.bom === BOM);
      }
    });
  }

  it('leaves the owner’s text of a group alone when HQ’s handler is not in it, and rewrites only the group it was in', () => {
    const style: Style = { bom: '', nl: '\n', unit: '  ', final: true };
    const original = file(
      [
        [
          'hooks',
          object(
            [
              [
                'Stop',
                '[\n      { "hooks": [ { "type":"command", "command":"keep   spacing" } ] }, {"hooks":[{"type":"command","command":"x"}]}\n    ]',
              ],
            ],
            style,
            1,
          ),
        ],
      ],
      style,
    );
    const on = enable(original).text!;
    expect(on).toContain('{ "hooks": [ { "type":"command", "command":"keep   spacing" } ] }');
    expect(on).toContain('{"hooks":[{"type":"command","command":"x"}]}');
  });
});

describe('through the switch, on files on disk', () => {
  const cases: [string, string][] = [
    ['a BOM', BOM + '{\n  "a": 1\n}\n'],
    ['CRLF line endings', '{\r\n  "a": 1\r\n}\r\n'],
    ['no final newline', '{\n  "a": 1\n}'],
    ['tab indentation', '{\n\t"a": 1\n}\n'],
    ['a minified file', '{"a":1,"b":[1,2]}'],
    ['a BOM, CRLF, tabs and no final newline', BOM + '{\r\n\t"a": 1,\r\n\t"z": 2\r\n}'],
    [
      'keys that look like numbers, in the owner’s order',
      '{\n  "10": 1,\n  "2": 2,\n  "a": 12345678901234567890\n}\n',
    ],
  ];
  for (const [name, text] of cases) {
    it(`keeps ${name} on turning on, and gives the file back on turning off`, async () => {
      const r = rig({ settings: text });
      chmodSync(r.settings, 0o640);
      const status = await r.hooks.set(true);
      expect(status.state).toBe('on');
      const on = readFileSync(r.settings, 'utf8');
      expect(on.startsWith(BOM)).toBe(text.startsWith(BOM));
      expect(on.includes('\r\n')).toBe(text.includes('\r\n'));
      expect(/\n$/.test(on)).toBe(/\n$/.test(text));
      expect(on.startsWith(text.replace(/\s*\}\s*$/, ''))).toBe(true);
      expect(statSync(r.settings).mode & 0o777).toBe(0o640);
      await r.hooks.set(false);
      expect(readFileSync(r.settings)).toEqual(Buffer.from(text, 'utf8'));
      expect(statSync(r.settings).mode & 0o777).toBe(0o640);
    });
  }

  it('preserves repeated hooks keys and unrelated settings when removing HQ’s last group', async () => {
    const original = '{"model":"first","hooks":{"Stop":[]},"model":"second","hooks":{}}';
    const r = rig({ settings: original });
    const preview = await r.hooks.status();
    const enabled = await r.hooks.set(true, { preview: preview.preview });
    expect(enabled.state).toBe('on');

    await r.hooks.set(false, { preview: enabled.preview });

    expect(readFileSync(r.settings, 'utf8')).toBe(original);
  });

  it('refuses a file that is not valid UTF-8 as unreadable, and never rewrites it', async () => {
    for (const bytes of [
      Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
      Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{}', 'utf16le')]),
    ]) {
      const r = rig({ settings: null });
      writeFileSync(r.settings, bytes);
      const before = readFileSync(r.settings);
      await expect(r.hooks.set(true)).rejects.toMatchObject({ failure: 'unreadable' });
      await expect(r.hooks.set(false)).rejects.toMatchObject({ failure: 'unreadable' });
      expect(readFileSync(r.settings)).toEqual(before);
      expect((await r.hooks.status()).files[0]).toMatchObject({
        state: 'blocked',
        reason: 'unreadable',
      });
    }
  });
});
