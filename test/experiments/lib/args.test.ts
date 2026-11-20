import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../../../scripts/experiments/lib/args.ts';

describe('parseArgs', () => {
  it('reads --name value, --name=value, switches and repeats', () => {
    const args = parseArgs([
      '--out',
      'a.md',
      '--bin=gh=/x/gh',
      '--bin',
      'codex=/y',
      '--list-reads',
      '--now',
      '2026-01-01',
    ]);
    expect(args.get('out')).toBe('a.md');
    expect(args.all('bin')).toEqual(['gh=/x/gh', 'codex=/y']);
    expect(args.get('list-reads')).toBe('true');
    expect(args.has('help')).toBe(false);
    expect(args.names()).toEqual(['bin', 'list-reads', 'now', 'out']);
  });

  it('refuses positional arguments', () => {
    expect(() => parseArgs(['file.jsonl'])).toThrow(UsageError);
    expect(() => parseArgs(['--'])).toThrow(UsageError);
  });
});
