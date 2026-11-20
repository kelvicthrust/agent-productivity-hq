import { describe, expect, it } from 'vitest';
import {
  deliveryScopeLabel,
  providersInScope,
  repoScopeLabel,
  resolveScope,
  usageScopeLabel,
} from '../../src/shared/domain/scope';

const ctx = {
  today: '2026-11-04',
  timezone: 'America/Los_Angeles',
  knownRepos: new Set(['kelvin/atlas-api', 'kelvin/atlas-web']),
};

describe('resolveScope', () => {
  it('defaults to the current Monday-start week, all providers and my PRs', () => {
    const result = resolveScope({}, ctx);
    expect(result).toEqual({
      ok: true,
      scope: {
        start: '2026-11-02',
        end: '2026-11-08',
        gran: 'day',
        repos: [],
        provider: 'all',
        author: 'mine',
        timezone: 'America/Los_Angeles',
      },
    });
  });

  it('chooses the granularity from the range, unless one is asked for', () => {
    const long = resolveScope({ start: '2025-11-04', end: '2026-11-04' }, ctx);
    expect(long).toMatchObject({ ok: true, scope: { gran: 'month' } });
    expect(resolveScope({ start: '2026-06-01', end: '2026-11-04' }, ctx)).toMatchObject({
      ok: true,
      scope: { gran: 'week' },
    });
    expect(
      resolveScope({ start: '2026-06-01', end: '2026-11-04', gran: 'day' }, ctx),
    ).toMatchObject({ ok: true, scope: { gran: 'day' } });
  });

  it('keeps known repos and echoes unknown ones, without duplicates', () => {
    const result = resolveScope(
      { repos: 'kelvin/atlas-api, nobody/nothing,kelvin/atlas-api,,x/y' },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      scope: { repos: ['kelvin/atlas-api'], ignoredRepos: ['nobody/nothing', 'x/y'] },
    });
    const none = resolveScope({ repos: '' }, ctx);
    expect(none.ok && 'ignoredRepos' in none.scope).toBe(false);
  });

  it('reports invalid values per field as invalid_input', () => {
    const result = resolveScope(
      { start: '2026-13-01', gran: 'year', provider: 'gemini', author: 'me' },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    if (!result.ok && result.code === 'invalid_input') {
      expect(Object.keys(result.fields).sort()).toEqual(['author', 'gran', 'provider', 'start']);
    }
  });

  it('reports a range outside the lookback or the current period as invalid_range', () => {
    expect(resolveScope({ start: '2025-01-01', end: '2025-02-01' }, ctx)).toMatchObject({
      ok: false,
      code: 'invalid_range',
    });
    expect(resolveScope({ start: '2026-11-05', end: '2026-11-01' }, ctx)).toMatchObject({
      ok: false,
      code: 'invalid_range',
    });
    expect(resolveScope({ start: '2026-11-02', end: '2026-12-31' }, ctx)).toMatchObject({
      ok: false,
      code: 'invalid_range',
    });
  });

  it('lets one missing bound take its week default', () => {
    expect(resolveScope({ start: '2026-10-01' }, ctx)).toMatchObject({
      ok: true,
      scope: { start: '2026-10-01', end: '2026-11-08' },
    });
  });
});

describe('scope labels', () => {
  it('word repos, delivery and usage scopes like the prototype', () => {
    expect(repoScopeLabel([])).toBe('All repos');
    expect(repoScopeLabel(['kelvin/atlas-api'])).toBe('kelvin/atlas-api');
    expect(repoScopeLabel(['a/b', 'c/d', 'e/f'])).toBe('3 repos');
    expect(deliveryScopeLabel({ repos: [], author: 'mine' })).toBe('All repos · Authored by you');
    expect(deliveryScopeLabel({ repos: ['a/b'], author: 'all' })).toBe('a/b · All authors');
    expect(usageScopeLabel({ repos: [], provider: 'all' })).toBe(
      'This machine · All repos · All providers',
    );
    expect(usageScopeLabel({ repos: ['a/b', 'c/d'], provider: 'claude' })).toBe(
      'This machine · 2 repos · Claude Code',
    );
  });

  it('selects the providers a filter covers', () => {
    expect(providersInScope('all')).toEqual(['codex', 'claude']);
    expect(providersInScope('codex')).toEqual(['codex']);
  });
});
