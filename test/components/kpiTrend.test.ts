import { describe, expect, it } from 'vitest';
import { kpiTrendQuery } from '../../src/client/lib/analytics';
import type { Filters } from '../../src/client/lib/filters';
import { bucketsFor, checkRange } from '../../src/shared/domain/periods';

const filters: Filters = {
  start: '2026-10-01',
  end: '2026-10-10',
  gran: 'day',
  repos: ['kelvin/atlas-api', 'kelvin/atlas-web'],
  provider: 'claude',
  author: 'all',
};

describe('the KPI trend query', () => {
  it('asks for the twelve Monday weeks that end with the current week, whatever the period is', () => {
    const query = kpiTrendQuery(filters, '2026-11-04');
    expect(query).toMatchObject({ start: '2026-08-17', end: '2026-11-08', gran: 'week' });
    const buckets = bucketsFor(String(query['start']), String(query['end']), 'week');
    expect(buckets).toHaveLength(12);
    expect(buckets[0]!.start).toBe('2026-08-17');
    expect(buckets.at(-1)!.start).toBe('2026-11-02');
    expect(checkRange(String(query['start']), String(query['end']), '2026-11-04')).toEqual({
      ok: true,
    });
  });

  it('keeps the repo, provider and author scope and drops the period', () => {
    const query = kpiTrendQuery(filters, '2026-11-04');
    expect(query).toMatchObject({
      repos: 'kelvin/atlas-api,kelvin/atlas-web',
      provider: 'claude',
      author: 'all',
    });
    expect(query['start']).not.toBe(filters.start);
  });

  it('follows the week when today is a Sunday', () => {
    expect(kpiTrendQuery(filters, '2026-11-08')).toMatchObject({
      start: '2026-08-17',
      end: '2026-11-08',
    });
  });
});
