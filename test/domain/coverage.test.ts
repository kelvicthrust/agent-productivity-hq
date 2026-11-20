import { describe, expect, it } from 'vitest';
import {
  deliveryCoverage,
  isTrueZero,
  prValue,
  providerCoverage,
  railCoverage,
  tokenValue,
  unavailableText,
} from '../../src/shared/domain/coverage';

const today = '2026-11-04';
const codex = { found: true, oldestDate: '2026-02-02' };

describe('providerCoverage', () => {
  const bucket = (start: string, end = start) => ({ start, end });

  it('classifies a bucket against the source history', () => {
    expect(providerCoverage(bucket('2026-11-05'), codex, today)).toBe('future');
    expect(providerCoverage(bucket('2026-11-02', '2026-11-08'), codex, today)).toBe('ok');
    expect(providerCoverage(bucket('2026-01-05', '2026-01-11'), codex, today)).toBe('unavailable');
    expect(providerCoverage(bucket('2026-01-26', '2026-02-01'), codex, today)).toBe('unavailable'); // ends the day before
    expect(providerCoverage(bucket('2026-01-26', '2026-02-02'), codex, today)).toBe('partial'); // ends on the oldest day
    expect(providerCoverage(bucket('2026-02-02'), codex, today)).toBe('ok'); // starts on the oldest day
  });

  it('says none when the source was never found, or has no records', () => {
    expect(providerCoverage(bucket('2026-11-02'), undefined, today)).toBe('none');
    expect(providerCoverage(bucket('2026-11-02'), { found: false }, today)).toBe('none');
    expect(providerCoverage(bucket('2026-11-02'), { found: true, oldestDate: null }, today)).toBe(
      'none',
    );
  });

  it('says stale only after the last fully collected day, and future wins over none', () => {
    const failed = { ...codex, staleAfter: '2026-11-03' };
    expect(providerCoverage(bucket('2026-11-03'), failed, today)).toBe('ok');
    expect(providerCoverage(bucket('2026-11-04'), failed, today)).toBe('stale');
    expect(providerCoverage(bucket('2026-11-02', '2026-11-08'), failed, today)).toBe('stale');
    expect(providerCoverage(bucket('2026-11-05'), undefined, today)).toBe('future');
  });
});

describe('railCoverage', () => {
  it('combines in-scope providers the way the prototype strip does', () => {
    expect(railCoverage(['ok', 'ok'])).toBe('ok');
    expect(railCoverage(['future', 'future'])).toBe('future');
    expect(railCoverage(['unavailable', 'none'])).toBe('unavailable');
    expect(railCoverage(['none'])).toBe('unavailable');
    expect(railCoverage(['ok', 'unavailable'])).toBe('partial');
    expect(railCoverage(['ok', 'stale'])).toBe('partial');
    expect(railCoverage(['partial'])).toBe('partial');
    expect(railCoverage([])).toBe('none');
  });
});

describe('deliveryCoverage', () => {
  it('is none without tracked repos, syncing during backfill, future after today', () => {
    const ok = { activeRepos: 3, backfillIncomplete: false };
    expect(deliveryCoverage({ start: today }, ok, today)).toBe('ok');
    expect(deliveryCoverage({ start: '2026-11-05' }, ok, today)).toBe('future');
    expect(
      deliveryCoverage({ start: today }, { activeRepos: 0, backfillIncomplete: false }, today),
    ).toBe('none');
    expect(deliveryCoverage({ start: today }, { ...ok, backfillIncomplete: true }, today)).toBe(
      'syncing',
    );
    expect(
      deliveryCoverage(
        { start: '2026-11-05' },
        { activeRepos: 0, backfillIncomplete: false },
        today,
      ),
    ).toBe('future');
  });
});

describe('what a total means', () => {
  it('keeps a covered zero as 0 and an uncovered bucket as null, never zero', () => {
    expect(tokenValue('ok', 0)).toBe(0);
    expect(tokenValue('partial', 5)).toBe(5);
    expect(tokenValue('stale', 0)).toBe(0);
    expect(tokenValue('unavailable', 0)).toBeNull();
    expect(tokenValue('none', 0)).toBeNull();
    expect(tokenValue('future', 0)).toBeNull();
    expect(prValue('ok', 0)).toBe(0);
    expect(prValue('syncing', 2)).toBe(2);
    expect(prValue('none', 0)).toBeNull();
    expect(prValue('future', 0)).toBeNull();
  });

  it('words the earliest unavailable boundary, or the empty case', () => {
    expect(unavailableText(['2026-03-14', '2026-02-02'])).toBe(
      'History unavailable before Feb 2, 2026',
    );
    expect(unavailableText([null, undefined])).toBe('No local records on this machine');
    expect(unavailableText([])).toBe('No local records on this machine');
  });
});

describe('isTrueZero (the quiet panel)', () => {
  const base = {
    range: { start: '2026-11-01', end: '2026-11-01' },
    today,
    providers: ['codex', 'claude'] as const,
    sources: { codex, claude: { found: true, oldestDate: '2026-03-14' } },
    delivery: 'ok' as const,
    events: 0,
    merges: 0,
  };

  it('needs every in-scope provider ok, delivery ok, and no events or merges', () => {
    expect(isTrueZero(base)).toBe(true);
    expect(isTrueZero({ ...base, events: 1 })).toBe(false);
    expect(isTrueZero({ ...base, merges: 1 })).toBe(false);
    expect(isTrueZero({ ...base, delivery: 'none' })).toBe(false);
    expect(isTrueZero({ ...base, delivery: 'syncing' })).toBe(false);
  });

  it('is not zero when history is unavailable, stale, or the range has not begun', () => {
    expect(isTrueZero({ ...base, range: { start: '2026-03-01', end: '2026-03-01' } })).toBe(false); // before Claude history
    expect(
      isTrueZero({
        ...base,
        sources: { ...base.sources, codex: { ...codex, staleAfter: '2026-10-01' } },
      }),
    ).toBe(false);
    expect(isTrueZero({ ...base, range: { start: '2026-11-05', end: '2026-11-08' } })).toBe(false);
    expect(isTrueZero({ ...base, providers: [] })).toBe(false);
  });

  it('judges only the elapsed part of a range that runs past today', () => {
    expect(isTrueZero({ ...base, range: { start: '2026-11-02', end: '2026-11-08' } })).toBe(true);
  });

  it('respects the provider filter', () => {
    const onlyCodex = { ...base, providers: ['codex'] as const, sources: { codex } };
    expect(isTrueZero({ ...onlyCodex, range: { start: '2026-02-10', end: '2026-02-10' } })).toBe(
      true,
    );
    expect(isTrueZero({ ...base, range: { start: '2026-02-10', end: '2026-02-10' } })).toBe(false); // claude has no history yet
  });
});
