import { describe, expect, it } from 'vitest';
import {
  parseTimestamp,
  sessionStart,
  tokenCount,
} from '../../../src/server/collectors/ingest/fields.ts';

describe('field readers', () => {
  it('reads a token count only from a whole non-negative number', () => {
    expect(tokenCount(0)).toBe(0);
    expect(tokenCount(1234)).toBe(1234);
    for (const bad of [-1, 1.5, '12', null, undefined, Number.NaN, Infinity, 2 ** 60]) {
      expect(tokenCount(bad), String(bad)).toBeNull();
    }
  });

  it('reads an ISO time or epoch seconds or milliseconds, and nothing else', () => {
    const ms = Date.parse('2026-11-04T17:00:00.250Z');
    expect(parseTimestamp('2026-11-04T17:00:00.250Z')).toBe(ms);
    expect(parseTimestamp('2026-11-04T10:00:00.250-07:00')).toBe(ms);
    expect(parseTimestamp(ms)).toBe(ms);
    expect(parseTimestamp(1_793_811_600)).toBe(1_793_811_600_000);
    for (const bad of ['', 'yesterday', null, undefined, 0, -5, Number.NaN, {}]) {
      expect(parseTimestamp(bad), String(bad)).toBeNull();
    }
  });

  it('prefers the source start and records which one it used', () => {
    expect(sessionStart(100, 200)).toEqual({ startedAt: 100, startedBasis: 'source_start' });
    expect(sessionStart(null, 200)).toEqual({ startedAt: 200, startedBasis: 'first_event' });
    expect(sessionStart(null, null)).toBeNull();
  });
});
