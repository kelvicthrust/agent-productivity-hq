import { describe, expect, it } from 'vitest';
import {
  addClaudeLine,
  addCodexLine,
  claudeOrigin,
  emptyCensus,
  inWindow,
  key,
} from '../../scripts/experiments/e9-live-activity.ts';

// E9's own pure helpers: the window, the folding of what may become a histogram key, the origin of a file.

const DAY = 24 * 3_600_000;

describe('the window', () => {
  it('counts a file written inside it, at its edge, and one from the future; not one past it', () => {
    const now = Date.parse('2026-11-19T10:00:00Z');
    expect(inWindow(now - 1000, now, DAY)).toBe(true);
    expect(inWindow(now - DAY, now, DAY)).toBe(true);
    expect(inWindow(now - DAY - 1, now, DAY)).toBe(false);
    expect(inWindow(now + 5000, now, DAY)).toBe(true);
  });
});

describe('key', () => {
  it('keeps type names and enum values, and folds ids, long text, MCP tool names and non-strings', () => {
    expect(key('assistant')).toBe('assistant');
    expect(key('tool_use')).toBe('tool_use');
    expect(key('Codex Desktop')).toBe('other-folded'); // a space: not identifier-shaped
    expect(key('mcp__someServer__tool')).toBe('mcp-tool');
    expect(key('0f9c2a7e-1b3d-4c5e-8f6a-123456789abc')).toBe('other-folded');
    expect(key('a'.repeat(41))).toBe('other-folded');
    expect(key('SENTINEL_TEXT with words')).toBe('other-folded');
    expect(key(42)).toBe('other-folded');
    expect(key(undefined)).toBe('absent-field');
    expect(key(null)).toBe('absent-field');
  });
});

describe('claudeOrigin', () => {
  it('sorts a path below projects/ into main, subagent or nothing', () => {
    expect(claudeOrigin('p/s.jsonl')).toBe('claude:main');
    expect(claudeOrigin('p/s/subagents/agent-1.jsonl')).toBe('claude:subagent');
    expect(claudeOrigin('p/s.orphaned-1.jsonl')).toBeNull();
    expect(claudeOrigin('p/s.jsonl.superseded-1')).toBeNull();
    expect(claudeOrigin('p/s/other/x.jsonl')).toBeNull();
    expect(claudeOrigin('s.jsonl')).toBeNull();
  });
});

describe('what the census keeps', () => {
  it('keeps only names and counts: no text, id or input of a line reaches a histogram', () => {
    const census = emptyCensus();
    const open = new Map<string, string>();
    addClaudeLine(
      census,
      { type: 'user', message: { role: 'user', content: 'SENTINEL_PROMPT' } },
      open,
    );
    addClaudeLine(
      census,
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'SENTINEL_INPUT' } },
          ],
        },
      },
      open,
    );
    addCodexLine(
      census,
      { type: 'session_meta', payload: { id: 'x', originator: 'codex_cli_rs', source: 'cli' } },
      open,
    );
    const everything = JSON.stringify(
      Object.values(census.h).map((histogram) => histogram.entries(1000)),
    );
    expect(everything).not.toContain('SENTINEL');
    expect(everything).toContain('Bash@1');
    expect(everything).not.toContain('toolu_1');
    expect(open.size).toBe(1); // pending ids are held only per file, and never reach a histogram
  });
});
