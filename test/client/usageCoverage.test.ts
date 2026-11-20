import { describe, expect, it } from 'vitest';
import { describeCoverage } from '../../src/client/components/coverageGroups';
import { usageCoverage } from '../../src/client/lib/usageCoverage';
import type { Repo } from '../../src/shared/contracts/repos';
import type { SourceStatus } from '../../src/shared/contracts/sources';

// The coverage strip on Usage is built from /api/sources and /api/repos (the Overview's server block arrives in M7). These
// check the builder, and, through `describeCoverage`, the words the strip ends up saying.

const WHEN = { today: '2026-11-04', timeZone: 'America/Los_Angeles' };

const source = (
  overrides: Partial<SourceStatus> & Pick<SourceStatus, 'id' | 'name'>,
): SourceStatus => ({
  status: 'ok',
  location: '~/somewhere',
  oldestDate: '2026-02-02',
  lastSuccessAt: '2026-11-04T17:42:00Z', // today, 9:42 AM in Los Angeles
  lastAttemptAt: '2026-11-04T17:42:00Z',
  lastAttemptResult: 'succeeded',
  consecutiveFailures: 0,
  ...overrides,
});
const repo = (id: string, accessState: Repo['accessState'] = 'ok'): Repo => ({
  id,
  displayName: id,
  trackingState: 'active',
  accessState,
});

const codex = source({ id: 'codex', name: 'Codex' });
const claude = source({ id: 'claude', name: 'Claude Code', oldestDate: '2026-03-14' });
const paseo = source({ id: 'paseo', name: 'Paseo', status: 'partial', unreadable: 3 });

describe('usageCoverage', () => {
  it('passes the sources through and counts tracked and inaccessible repos', () => {
    const coverage = usageCoverage(
      [codex, claude, paseo],
      [repo('kelvin/a'), repo('kelvin/b'), repo('kelvin/gone', 'inaccessible')],
    );
    expect(coverage.sources).toEqual([codex, claude, paseo]);
    expect(coverage.github).toEqual({ tracked: 3, inaccessible: 1 });
    expect(coverage.accounts).toBeUndefined(); // not served until M9
  });

  it('says when anything last succeeded while nothing is failing', () => {
    const older = source({
      id: 'claude',
      name: 'Claude Code',
      lastSuccessAt: '2026-11-03T20:00:00Z',
    });
    const coverage = usageCoverage([older, codex], []);
    expect(coverage.refreshFailed).toBe(false);
    expect(coverage.lastRefreshAt).toBe('2026-11-04T17:42:00Z');
  });

  it('says when the failing source last worked, not when the others did', () => {
    const failing = source({
      id: 'codex',
      name: 'Codex',
      status: 'failed',
      lastSuccessAt: '2026-11-04T02:12:00Z', // Nov 3, 6:12 PM in Los Angeles
      lastAttemptResult: 'failed',
      consecutiveFailures: 1,
    });
    const coverage = usageCoverage([failing, claude], []);
    expect(coverage.refreshFailed).toBe(true);
    expect(coverage.lastRefreshAt).toBe('2026-11-04T02:12:00Z');
  });

  it('with two failing sources takes the one that worked longest ago', () => {
    const a = source({
      id: 'codex',
      name: 'Codex',
      status: 'failed',
      lastAttemptResult: 'failed',
      lastSuccessAt: '2026-11-03T10:00:00Z',
    });
    const b = source({
      id: 'claude',
      name: 'Claude Code',
      status: 'failed',
      lastAttemptResult: 'failed',
      lastSuccessAt: '2026-11-02T10:00:00Z',
    });
    expect(usageCoverage([a, b], []).lastRefreshAt).toBe('2026-11-02T10:00:00Z');
  });

  it('falls back to the newest success of the others when the failing source never succeeded, and to nothing when none did', () => {
    const never = source({
      id: 'codex',
      name: 'Codex',
      status: 'failed',
      lastAttemptResult: 'failed',
      lastSuccessAt: null,
    });
    expect(usageCoverage([never, claude], []).lastRefreshAt).toBe('2026-11-04T17:42:00Z');
    expect(usageCoverage([never], []).lastRefreshAt).toBeNull();
  });

  it('draws nothing for sources nobody has checked: no sources, no refresh line, not failed', () => {
    const coverage = usageCoverage([], [repo('kelvin/a')]);
    expect(coverage).toMatchObject({ sources: [], lastRefreshAt: null, refreshFailed: false });
    expect(describeCoverage(coverage, [], WHEN).groups.map((group) => group.id)).toEqual([
      'delivery',
    ]);
  });
});

describe('what the strip says', () => {
  it('names each local source in the design’s order with its state in words, and the repos', () => {
    const summary = describeCoverage(
      usageCoverage(
        [paseo, codex, claude],
        [repo('kelvin/a'), repo('kelvin/gone', 'inaccessible')],
      ),
      [],
      WHEN,
    );
    const machine = summary.groups.find((group) => group.id === 'machine')!;
    expect(machine.items.map((item) => `${item.name} ${item.text}`)).toEqual([
      'Codex since Feb 2, 2026',
      'Claude Code since Mar 14, 2026',
      'Paseo partial · 3 unreadable',
    ]);
    const delivery = summary.groups.find((group) => group.id === 'delivery')!;
    expect(delivery.items.map((item) => `${item.name} ${item.text}`)).toEqual([
      'GitHub 2 repos tracked · 1 inaccessible',
    ]);
    expect(summary.groups.some((group) => group.id === 'accounts')).toBe(false);
    expect(summary.refreshed).toBe('Last successful refresh today, 9:42 AM');
  });

  it('while a refresh is failing says so on the source and gives the last successful refresh', () => {
    const failing = source({
      id: 'codex',
      name: 'Codex',
      status: 'failed',
      lastSuccessAt: '2026-11-04T02:12:00Z',
      lastAttemptResult: 'failed',
    });
    const summary = describeCoverage(usageCoverage([failing, claude], []), [], WHEN);
    const machine = summary.groups.find((group) => group.id === 'machine')!;
    expect(machine.items[0]).toMatchObject({
      name: 'Codex',
      state: 'failed',
      text: 'refresh failed',
    });
    expect(summary.refreshed).toBe('Last successful refresh Nov 3, 6:12 PM');
  });
});
