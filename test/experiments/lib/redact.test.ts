import { describe, expect, it } from 'vitest';
import {
  identifierOrMarker,
  isFieldName,
  isIdentifier,
  marker,
  redactValue,
  safeText,
} from '../../../scripts/experiments/lib/redact.ts';
import { FieldInventory } from '../../../scripts/experiments/lib/shape.ts';

describe('identifiers', () => {
  it('accepts versions, model names and short ids, and nothing that reads like text', () => {
    for (const ok of [
      '2.1.0',
      'gpt-5-codex',
      'claude-sonnet-5-5',
      'a1b2c3d4',
      'api.github.com',
      'org/repo',
      'v1.2.3+build.5',
    ])
      expect(isIdentifier(ok), ok).toBe(true);
    for (const bad of [
      '',
      'two words',
      'a path/with space',
      'hello, world',
      'x'.repeat(81),
      'line\nbreak',
      '-leading',
      `ghp_${'A'.repeat(36)}`,
      'Bearer abcdefghijkl',
    ])
      expect(isIdentifier(bad), bad).toBe(false);
  });

  it('turns anything else into a marker that gives only the length', () => {
    expect(identifierOrMarker('2.1.0')).toBe('2.1.0');
    expect(identifierOrMarker('please fix the build')).toBe('[string:20]');
    expect(marker('abc')).toBe('[string:3]');
  });
});

describe('safeText', () => {
  it('writes numbers and identifiers and withholds other strings', () => {
    const prompt = 'Write me a poem about SENTINEL_PROMPT_1';
    expect(safeText`${3} of ${5} match on ${'darwin'} with ${prompt}`).toBe(
      '3 of 5 match on darwin with [string:39]',
    );
    expect(safeText`${Number.NaN} ${true} ${['a', 'two words']} ${{ a: 1 }}`).toBe(
      'n/a true a, [string:9] [value]',
    );
  });
});

describe('redactValue', () => {
  it('keeps numbers, booleans and identifier values of known keys; withholds every other string', () => {
    const out = redactValue({
      type: 'assistant',
      model: 'claude-sonnet-5-5',
      content: 'SENTINEL_PROMPT_TEXT',
      title: 'SENTINEL_TITLE',
      note: 'type',
      usage: { input_tokens: 12, flag: true, nothing: null },
      list: ['SENTINEL_ITEM', 4],
      'SENTINEL key with spaces': 'x',
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain('SENTINEL');
    expect(out).toMatchObject({
      type: 'assistant',
      model: 'claude-sonnet-5-5',
      usage: { input_tokens: 12, flag: true, nothing: null },
    });
  });

  it('does not keep a known key whose value is not identifier-shaped', () => {
    expect(redactValue({ model: 'a model with spaces' })).toEqual({ model: '[string:19]' });
  });
});

describe('field names', () => {
  it('tells a field name from data', () => {
    for (const ok of ['usage', 'input_tokens', 'cache_creation', 'rate_limits'])
      expect(isFieldName(ok), ok).toBe(true);
    for (const bad of [
      '/Users/x/project',
      '3f786850-e387-450f-a836-ed7e6dc881de',
      '12345678',
      'two words',
      `ghp_${'A'.repeat(36)}`,
      'a'.repeat(30) + '0123456789abcdef0123456789',
    ])
      expect(isFieldName(bad), bad).toBe(false);
  });
});

describe('FieldInventory', () => {
  const records = [
    {
      type: 'assistant',
      message: {
        id: 'x',
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [{ type: 'text', text: 'SENTINEL_BODY_1' }],
      },
    },
    { type: 'user', message: { content: 'SENTINEL_BODY_2' }, title: null },
    { type: 'assistant', message: { usage: { input_tokens: 5 } } },
  ];

  it('lists paths, types, counts and presence without a single value', () => {
    const inventory = new FieldInventory();
    records.forEach((r) => inventory.add(r));
    const text = JSON.stringify(inventory.entries());
    expect(text).not.toContain('SENTINEL');
    expect(inventory.recordCount).toBe(3);
    expect(inventory.presence('message.usage.input_tokens')).toBe(2);
    expect(inventory.presence('message.usage.output_tokens')).toBe(1);
    expect(inventory.has('message.content[].text')).toBe(true);
    expect(inventory.entries().find((e) => e.path === 'message.content')?.types).toEqual([
      'array',
      'string',
    ]);
    expect(inventory.entries().find((e) => e.path === 'title')?.types).toEqual(['null']);
    expect(inventory.paths()).toEqual([...inventory.paths()].sort());
  });

  it('folds data-like keys and runaway key sets into *, so a map of session ids leaks no id', () => {
    const inventory = new FieldInventory({ maxChildren: 3 });
    inventory.add({
      sessions: {
        '3f786850-e387-450f-a836-ed7e6dc881de': { n: 1 },
        '/Users/x/proj': { n: 2 },
        a: 1,
        b: 2,
        c: 3,
        d: 4,
        e: 5,
      },
    });
    const paths = inventory.paths();
    expect(paths.filter((p) => p.startsWith('sessions.')).sort()).toEqual([
      'sessions.*',
      'sessions.*.n',
      'sessions.a',
      'sessions.b',
      'sessions.c',
    ]);
    expect(JSON.stringify(paths)).not.toMatch(/3f786850|Users/);
  });

  it('stops at the depth limit', () => {
    const inventory = new FieldInventory({ maxDepth: 2 });
    inventory.add({ a: { b: { c: { d: 1 } } } });
    expect(inventory.paths()).toEqual(['a', 'a.b']);
  });
});
